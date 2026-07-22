import { describe, expect, it } from 'vitest'
import type { SeriesBucket } from '~/lib/services/sensor'
import {
  colorForIndex,
  DEVICE_COLORS,
  niceYScale,
  timeDomain,
  toDeviceSeries,
  valueRange,
} from './chartData'

// A tick step is "nice" when it is 1, 2, or 5 × 10ⁿ — the increments axes read in.
function niceFractionOf(step: number): number {
  return step / 10 ** Math.floor(Math.log10(step))
}

describe('niceYScale', () => {
  it('turns a narrow range into round, evenly-spaced, single-value ticks', () => {
    // The bug: 24.49–24.60 got equal-divided into 24.48/24.51/24.54/… (step
    // 0.03). Nice ticks land on a round 0.05 step instead.
    const { ticks, decimals, domain } = niceYScale(24.49, 24.6)
    expect(decimals).toBe(2)
    expect(ticks).toEqual([24.45, 24.5, 24.55, 24.6])
    expect(domain).toEqual([24.45, 24.6])
    expect(niceFractionOf(0.05)).toBeCloseTo(5)
  })

  it('always produces distinct labels once formatted', () => {
    const { ticks, decimals } = niceYScale(24.49, 24.6)
    const labels = ticks.map((t) => t.toFixed(decimals))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('uses whole numbers for a wide range', () => {
    const { ticks, decimals } = niceYScale(-10, 30)
    expect(decimals).toBe(0)
    expect(ticks).toEqual([-10, 0, 10, 20, 30])
  })

  it('pads a flat series into a one-unit band around the value', () => {
    const { ticks, domain } = niceYScale(24.5, 24.5)
    expect(domain[0]).toBeLessThanOrEqual(24.5)
    expect(domain[1]).toBeGreaterThanOrEqual(24.5)
    expect(new Set(ticks).size).toBe(ticks.length)
  })

  it('brackets the data so no reading sits off the chart', () => {
    const { domain } = niceYScale(24.49, 24.6)
    expect(domain[0]).toBeLessThanOrEqual(24.49)
    expect(domain[1]).toBeGreaterThanOrEqual(24.6)
  })

  it('spaces ticks on a genuinely nice step', () => {
    for (const [lo, hi] of [
      [24.49, 24.6],
      [0.1, 0.35],
      [980, 1030],
      [-3.2, 4.8],
    ]) {
      const { ticks } = niceYScale(lo, hi)
      const step = ticks[1] - ticks[0]
      expect(niceFractionOf(step)).toBeCloseTo(Math.round(niceFractionOf(step)))
      expect([1, 2, 5]).toContain(Math.round(niceFractionOf(step)))
    }
  })
})

describe('valueRange', () => {
  it('spans only visible devices, reading each value under its own id key', () => {
    expect(
      valueRange([
        {
          id: 'a',
          points: [
            { t: 1, a: 20 },
            { t: 2, a: 22 },
          ],
        },
        { id: 'b', points: [{ t: 1, b: 5 }] },
      ]),
    ).toEqual([5, 22])
  })

  it('ignores hidden devices and null/break markers', () => {
    expect(
      valueRange([
        {
          id: 'a',
          points: [
            { t: 1, a: 20 },
            { t: 2, a: null },
          ],
        },
        { id: 'b', hidden: true, points: [{ t: 1, b: 99 }] },
      ]),
    ).toEqual([20, 20])
  })

  it('returns undefined when nothing is visible', () => {
    expect(valueRange([{ id: 'a', hidden: true, points: [{ t: 1, a: 1 }] }])).toBeUndefined()
    expect(valueRange([{ id: 'a', points: [] }])).toBeUndefined()
  })
})

describe('colorForIndex', () => {
  it('wraps around the palette', () => {
    expect(colorForIndex(0)).toBe(DEVICE_COLORS[0])
    expect(colorForIndex(DEVICE_COLORS.length)).toBe(DEVICE_COLORS[0])
    expect(colorForIndex(DEVICE_COLORS.length + 1)).toBe(DEVICE_COLORS[1])
  })
})

// Bucket timestamps are epoch MILLISECONDS (Date.getTime()) but bucketSec/
// cadenceSec are seconds, so the gap threshold is `maxGapBuckets * bucketSec`
// seconds → ×1000 ms. These fixtures use S to express bucket times in whole
// seconds-worth-of-ms, mirroring production units.
const S = 1000
// opts that put us in "break" mode: bucketSec >= cadenceSec → threshold =
// 2 buckets × 1s = 2s = 2000 ms.
const BREAK = { bucketSec: 1, cadenceSec: 1, maxGapBuckets: 2 }
// opts finer than the cadence (the 24h case) → connect across any gap.
const CONNECT_ALL = { bucketSec: 1, cadenceSec: 5, maxGapBuckets: 2 }

function bucket(
  t: number,
  perDevice: Record<string, { tempAvg: number | null; humAvg: number | null }>,
): SeriesBucket {
  return { t, perDevice }
}

describe('toDeviceSeries', () => {
  it('connects readings hours apart on a coarse range (epoch-ms gap threshold)', () => {
    // Regression: `b.t` is epoch ms but the threshold was compared as seconds,
    // so every realistic gap "broke" and non-24h ranges rendered disconnected
    // dots. On the 1m range (3h buckets, 4-bucket = 12h tolerance) two readings
    // 3h apart must stay one connected line — neither isolated, no null marker.
    const HOUR = 3_600_000
    const t0 = 1_784_000_000_000
    const buckets = [
      bucket(t0, { a: { tempAvg: 14.5, humAvg: 80 } }),
      bucket(t0 + 3 * HOUR, { a: { tempAvg: 14.4, humAvg: 79 } }),
    ]
    expect(
      toDeviceSeries(buckets, 'temp', { bucketSec: 3 * 3600, maxGapBuckets: 4, cadenceSec: 7200 }),
    ).toEqual([
      {
        id: 'a',
        points: [
          { t: t0, a: 14.5 },
          { t: t0 + 3 * HOUR, a: 14.4 },
        ],
      },
    ])
  })

  it('connects readings within the gap threshold', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(2 * S, { a: { tempAvg: 21, humAvg: 41 } }), // Δ2s = the tolerance, not > it → connected
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 20 },
          { t: 2 * S, a: 21 },
        ],
      },
    ])
  })

  it('inserts a break marker when silence exceeds the threshold', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(5 * S, { a: { tempAvg: 25, humAvg: 45 } }), // Δ5s > 2s → break
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 20, isolated: true },
          { t: 2.5 * S, a: null },
          { t: 5 * S, a: 25, isolated: true },
        ],
      },
    ])
  })

  it('connects across any gap when the bucket is finer than the cadence (24h)', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(100, { a: { tempAvg: 21, humAvg: 41 } }),
    ]
    expect(toDeviceSeries(buckets, 'temp', CONNECT_ALL)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 20 },
          { t: 100, a: 21 },
        ],
      },
    ])
  })

  it('marks a lone reading isolated so it renders a dot', () => {
    expect(toDeviceSeries([bucket(5, { a: { tempAvg: 20, humAvg: 40 } })], 'temp', BREAK)).toEqual([
      { id: 'a', points: [{ t: 5, a: 20, isolated: true }] },
    ])
  })

  it('skips a null metric reading (no point at that bucket)', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: null, humAvg: 40 } }),
      bucket(1, { a: { tempAvg: 21, humAvg: 41 } }),
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      { id: 'a', points: [{ t: 1, a: 21, isolated: true }] },
    ])
  })

  it('keeps devices in first-appearance order', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 1, humAvg: 0 } }),
      bucket(1, { b: { tempAvg: 2, humAvg: 0 }, a: { tempAvg: 3, humAvg: 0 } }),
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('selects the humidity metric', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(1, { a: { tempAvg: 21, humAvg: 41 } }),
    ]
    expect(toDeviceSeries(buckets, 'hum', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 40 },
          { t: 1, a: 41 },
        ],
      },
    ])
  })

  it('breaks a device into two connected clusters around an outage', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 10, humAvg: 0 } }),
      bucket(1 * S, { a: { tempAvg: 11, humAvg: 0 } }), // cluster 1
      bucket(9 * S, { a: { tempAvg: 12, humAvg: 0 } }), // Δ8s > 2s → break before
      bucket(10 * S, { a: { tempAvg: 13, humAvg: 0 } }), // cluster 2
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 10 },
          { t: 1 * S, a: 11 },
          { t: 5 * S, a: null },
          { t: 9 * S, a: 12 },
          { t: 10 * S, a: 13 },
        ],
      },
    ])
  })

  it('scales the break threshold by bucketSec, not the cadence', () => {
    // bucketSec 10 * maxGapBuckets 2 = 20s → a 15s gap connects. If the threshold
    // used cadenceSec (5 * 2 = 10s) instead, 15s would wrongly break.
    const opts = { bucketSec: 10, cadenceSec: 5, maxGapBuckets: 2 }
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 0 } }),
      bucket(15 * S, { a: { tempAvg: 21, humAvg: 0 } }),
    ]
    expect(toDeviceSeries(buckets, 'temp', opts)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 20 },
          { t: 15 * S, a: 21 },
        ],
      },
    ])
  })

  it('returns an empty array for no buckets', () => {
    expect(toDeviceSeries([], 'temp', BREAK)).toEqual([])
  })
})

describe('timeDomain', () => {
  it('spans every device, including hidden ones, so toggling never rescales', () => {
    // The hidden device has the widest span; it must still bound the axis.
    expect(
      timeDomain([
        {
          points: [
            { t: 0, a: 1 },
            { t: 1000, a: 2 },
          ],
        },
        { points: [{ t: 400, b: 3 }] },
      ]),
    ).toEqual([0, 1000])
  })

  it('returns undefined when there are no points', () => {
    expect(timeDomain([{ points: [] }])).toBeUndefined()
  })
})

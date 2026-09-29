import { describe, expect, it } from 'vitest'
import type { SeriesBucket } from '~/lib/services/sensor'
import {
  colorForIndex,
  DEVICE_COLORS,
  nearestReadings,
  niceYScale,
  type SeriesPoint,
  timeDomain,
  toDeviceSeries,
  valueRange,
  type YScale,
} from './chartData'

// A tick step is "nice" when it is 1, 2, or 5 × 10ⁿ — the increments axes read in.
function niceFractionOf(step: number): number {
  return step / 10 ** Math.floor(Math.log10(step))
}

describe('niceYScale', () => {
  it('turns a narrow range into round, evenly-spaced, single-value ticks', () => {
    // The bug: 24.49–24.60 got equal-divided into 24.48/24.51/24.54/… (step
    // 0.03). Nice ticks land on a round 0.02 step instead.
    const { ticks, decimals, domain } = niceYScale(24.49, 24.6)
    expect(decimals).toBe(2)
    expect(ticks).toEqual([24.48, 24.5, 24.52, 24.54, 24.56, 24.58, 24.6])
    expect(domain).toEqual([24.48, 24.6])
  })

  it('never collapses a float-noise spread into repeated ticks', () => {
    // Regression: a spread far below display precision (two bucket averages that
    // differ only in their last bits) used to zoom to a sub-millionth step that
    // the 6-decimal cap then rounded into four identical 24.5 ticks on a
    // zero-width domain. It is now treated as a flat series.
    for (const [lo, hi] of [
      [24.5, 24.5000001],
      [24.533333333333328, 24.533333333333335],
      [-3.1, -3.0999999],
    ]) {
      const { ticks, decimals, domain } = niceYScale(lo, hi)
      expect(domain[1] - domain[0]).toBeGreaterThanOrEqual(1)
      expect(domain[0]).toBeLessThanOrEqual(lo)
      expect(domain[1]).toBeGreaterThanOrEqual(hi)
      const labels = ticks.map((t) => t.toFixed(decimals))
      expect(ticks.length).toBeGreaterThan(1)
      expect(new Set(labels).size).toBe(labels.length)
      expect(decimals).toBeLessThanOrEqual(1)
    }
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

  it('still rounds the domain and gives at least two ticks for a small targetCount', () => {
    for (const targetCount of [0, 1, 2]) {
      const { domain, ticks } = niceYScale(-0.84, 34.32, targetCount)
      expect(domain[0]).toBeLessThanOrEqual(-0.84)
      expect(domain[1]).toBeGreaterThanOrEqual(34.32)
      expect(domain.every(Number.isInteger)).toBe(true)
      expect(ticks.length).toBeGreaterThanOrEqual(2)
    }
  })
})

// The exact axis niceYScale draws (domain, ticks, decimals) across a spread of
// inputs — tiny, sub-zero, zero-crossing, flat, large and humidity ranges — so
// any change to the tick maths shows up here as a deliberate, reviewable diff.
describe('niceYScale outputs', () => {
  it.each<[string, number, number, number | undefined, YScale]>([
    // tiny ranges
    [
      'narrow sub-degree',
      24.49,
      24.6,
      undefined,
      {
        domain: [24.48, 24.6],
        ticks: [24.48, 24.5, 24.52, 24.54, 24.56, 24.58, 24.6],
        decimals: 2,
      },
    ],
    [
      'hundredths',
      24.5,
      24.52,
      undefined,
      { domain: [24.5, 24.52], ticks: [24.5, 24.505, 24.51, 24.515, 24.52], decimals: 3 },
    ],
    [
      'thousandths',
      0.001,
      0.003,
      undefined,
      { domain: [0.001, 0.003], ticks: [0.001, 0.0015, 0.002, 0.0025, 0.003], decimals: 4 },
    ],
    [
      'ten-thousandths',
      0,
      0.00004,
      undefined,
      { domain: [0, 0.00004], ticks: [0, 0.00001, 0.00002, 0.00003, 0.00004], decimals: 5 },
    ],
    // a float-noise spread is treated as flat (padded), never zoomed into
    [
      'float-noise spread',
      24.5,
      24.5000001,
      undefined,
      { domain: [24, 25.2], ticks: [24, 24.2, 24.4, 24.6, 24.8, 25, 25.2], decimals: 1 },
    ],
    // fractional steps
    [
      'fifth-degree step',
      21.3,
      22.1,
      undefined,
      { domain: [21.2, 22.2], ticks: [21.2, 21.4, 21.6, 21.8, 22, 22.2], decimals: 1 },
    ],
    [
      'twentieths step',
      0.1,
      0.35,
      undefined,
      { domain: [0.1, 0.35], ticks: [0.1, 0.15, 0.2, 0.25, 0.3, 0.35], decimals: 2 },
    ],
    [
      'one-unit band',
      42,
      43,
      undefined,
      { domain: [42, 43], ticks: [42, 42.2, 42.4, 42.6, 42.8, 43], decimals: 1 },
    ],
    [
      'fiftieths step',
      1,
      1.1,
      undefined,
      { domain: [1, 1.12], ticks: [1, 1.02, 1.04, 1.06, 1.08, 1.1, 1.12], decimals: 2 },
    ],
    // negative ranges (sub-zero temperatures)
    [
      'all negative',
      -12.3,
      -4.1,
      undefined,
      { domain: [-14, -4], ticks: [-14, -12, -10, -8, -6, -4], decimals: 0 },
    ],
    [
      'deep negative',
      -25,
      -18.5,
      undefined,
      { domain: [-26, -18], ticks: [-26, -24, -22, -20, -18], decimals: 0 },
    ],
    // ranges crossing 0
    [
      'crossing 0',
      -3.2,
      4.8,
      undefined,
      { domain: [-4, 6], ticks: [-4, -2, 0, 2, 4, 6], decimals: 0 },
    ],
    [
      'crossing 0, fractional',
      -0.4,
      0.3,
      undefined,
      { domain: [-0.4, 0.4], ticks: [-0.4, -0.2, 0, 0.2, 0.4], decimals: 1 },
    ],
    [
      'wide crossing 0',
      -10,
      30,
      undefined,
      { domain: [-10, 30], ticks: [-10, 0, 10, 20, 30], decimals: 0 },
    ],
    [
      'sensor full scale',
      -40,
      85,
      undefined,
      { domain: [-50, 100], ticks: [-50, 0, 50, 100], decimals: 0 },
    ],
    // a single value (flat series → padded 1-unit band)
    [
      'flat positive',
      24.5,
      24.5,
      undefined,
      { domain: [24, 25], ticks: [24, 24.2, 24.4, 24.6, 24.8, 25], decimals: 1 },
    ],
    [
      'flat zero',
      0,
      0,
      undefined,
      { domain: [-0.6, 0.6], ticks: [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6], decimals: 1 },
    ],
    [
      'flat negative',
      -5,
      -5,
      undefined,
      { domain: [-5.6, -4.4], ticks: [-5.6, -5.4, -5.2, -5, -4.8, -4.6, -4.4], decimals: 1 },
    ],
    // large values
    [
      'hundreds',
      980,
      1030,
      undefined,
      { domain: [980, 1030], ticks: [980, 990, 1000, 1010, 1020, 1030], decimals: 0 },
    ],
    [
      'tens of thousands',
      12000,
      56000,
      undefined,
      { domain: [10000, 60000], ticks: [10000, 20000, 30000, 40000, 50000, 60000], decimals: 0 },
    ],
    // humidity
    [
      'humidity 0–100',
      0,
      100,
      undefined,
      { domain: [0, 100], ticks: [0, 20, 40, 60, 80, 100], decimals: 0 },
    ],
    [
      'humidity indoor',
      35.2,
      68.9,
      undefined,
      { domain: [30, 70], ticks: [30, 40, 50, 60, 70], decimals: 0 },
    ],
    [
      'indoor temperature',
      18.7,
      26.4,
      undefined,
      { domain: [18, 28], ticks: [18, 20, 22, 24, 26, 28], decimals: 0 },
    ],
    // explicit target counts
    ['targetCount 3', 3, 5, 3, { domain: [3, 5], ticks: [3, 4, 5], decimals: 0 }],
    [
      'targetCount 11',
      0,
      100,
      11,
      { domain: [0, 100], ticks: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], decimals: 0 },
    ],
  ])('%s: [%d, %d]', (_label, min, max, targetCount, expected) => {
    expect(niceYScale(min, max, targetCount)).toEqual(expected)
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

  it('ignores non-finite values', () => {
    expect(
      valueRange([
        {
          id: 'a',
          points: [
            { t: 1, a: 20 },
            { t: 2, a: Number.POSITIVE_INFINITY },
            { t: 3, a: Number.NaN },
          ],
        },
      ]),
    ).toEqual([20, 20])
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

describe('nearestReadings', () => {
  const dev = (id: string, points: SeriesPoint[], extra?: { hidden?: boolean }) => ({
    id,
    displayName: id.toUpperCase(),
    color: `var(--${id})`,
    hidden: extra?.hidden,
    points,
  })

  it('snaps each visible line to its own reading nearest the hovered time', () => {
    // The 24h bug: a hover lands on ONE line's timestamp; the other line has no
    // point at that exact t, so Recharts drops it. Nearest-neighbour resolves
    // BOTH lines to their closest reading so the tooltip shows every sensor.
    const rows = nearestReadings(
      [
        dev('a', [
          { t: 0, a: 20 },
          { t: 100, a: 21 },
          { t: 200, a: 22 },
        ]),
        dev('b', [
          { t: 40, b: 5 },
          { t: 150, b: 6 },
        ]),
      ],
      110, // hovered near a@100 — b has no point there
      1000,
    )
    expect(rows).toEqual([
      { id: 'a', displayName: 'A', color: 'var(--a)', value: 21, t: 100 },
      { id: 'b', displayName: 'B', color: 'var(--b)', value: 6, t: 150 },
    ])
  })

  it('omits a line whose nearest reading is outside the window (not "10h away")', () => {
    const rows = nearestReadings(
      [dev('a', [{ t: 100, a: 21 }]), dev('b', [{ t: 5000, b: 6 }])],
      100,
      1000,
    )
    expect(rows).toEqual([{ id: 'a', displayName: 'A', color: 'var(--a)', value: 21, t: 100 }])
  })

  it('includes a reading exactly at the window edge', () => {
    // dist 1000 == window → shown (inclusive bound).
    expect(nearestReadings([dev('a', [{ t: 1100, a: 9 }])], 100, 1000).map((r) => r.id)).toEqual([
      'a',
    ])
  })

  it('skips hidden devices', () => {
    const rows = nearestReadings(
      [dev('a', [{ t: 100, a: 21 }]), dev('b', [{ t: 100, b: 6 }], { hidden: true })],
      100,
      1000,
    )
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })

  it('ignores outage break markers, snapping to the nearest real reading', () => {
    // The null at t=100 is a break marker (closest to the hover) — it must be
    // skipped in favour of the nearest numeric reading, a@0.
    const rows = nearestReadings(
      [
        dev('a', [
          { t: 0, a: 20 },
          { t: 100, a: null },
          { t: 400, a: 24 },
        ]),
      ],
      120,
      1000,
    )
    expect(rows).toEqual([{ id: 'a', displayName: 'A', color: 'var(--a)', value: 20, t: 0 }])
  })

  it('preserves roster order regardless of which line owns the hovered point', () => {
    const rows = nearestReadings(
      [dev('a', [{ t: 200, a: 1 }]), dev('b', [{ t: 0, b: 2 }])],
      0,
      1000,
    )
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('returns an empty list when nothing is in range', () => {
    expect(nearestReadings([dev('a', [{ t: 9999, a: 1 }])], 0, 100)).toEqual([])
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

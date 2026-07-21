import { describe, expect, it } from 'vitest'
import type { SeriesBucket } from '~/lib/services/sensor'
import { colorForIndex, DEVICE_COLORS, toDeviceSeries } from './chartData'

describe('colorForIndex', () => {
  it('wraps around the palette', () => {
    expect(colorForIndex(0)).toBe(DEVICE_COLORS[0])
    expect(colorForIndex(DEVICE_COLORS.length)).toBe(DEVICE_COLORS[0])
    expect(colorForIndex(DEVICE_COLORS.length + 1)).toBe(DEVICE_COLORS[1])
  })
})

// opts that put us in "break" mode: bucketSec >= cadenceSec → maxGapSec = 2.
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
  it('connects readings within the gap threshold', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(2, { a: { tempAvg: 21, humAvg: 41 } }), // Δ2, not > 2 → connected
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 20 },
          { t: 2, a: 21 },
        ],
      },
    ])
  })

  it('inserts a break marker when silence exceeds the threshold', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(5, { a: { tempAvg: 25, humAvg: 45 } }), // Δ5 > 2 → break
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 20, isolated: true },
          { t: 2.5, a: null },
          { t: 5, a: 25, isolated: true },
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
      bucket(1, { a: { tempAvg: 11, humAvg: 0 } }), // cluster 1
      bucket(9, { a: { tempAvg: 12, humAvg: 0 } }), // Δ8 > 2 → break before
      bucket(10, { a: { tempAvg: 13, humAvg: 0 } }), // cluster 2
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 10 },
          { t: 1, a: 11 },
          { t: 5, a: null },
          { t: 9, a: 12 },
          { t: 10, a: 13 },
        ],
      },
    ])
  })

  it('returns an empty array for no buckets', () => {
    expect(toDeviceSeries([], 'temp', BREAK)).toEqual([])
  })
})

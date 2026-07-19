import { describe, expect, it } from 'vitest'
import type { SeriesBucket } from '~/lib/services/sensor'
import { colorForIndex, DEVICE_COLORS, toChartRows } from './chartData'

const buckets: SeriesBucket[] = [
  { t: 1000, perDevice: { a: { tempAvg: 20, humAvg: 40 }, b: { tempAvg: 25, humAvg: 45 } } },
  { t: 2000, perDevice: { a: { tempAvg: 21, humAvg: 41 } } }, // b missing → gap
]

describe('toChartRows', () => {
  it('pivots temperature buckets to one row per bucket keyed by device id', () => {
    expect(toChartRows(buckets, 'temp')).toEqual([
      { t: 1000, a: 20, b: 25 },
      { t: 2000, a: 21, b: null },
    ])
  })

  it('pivots humidity and renders a missing device as null (a line gap)', () => {
    expect(toChartRows(buckets, 'hum')).toEqual([
      { t: 1000, a: 40, b: 45 },
      { t: 2000, a: 41, b: null },
    ])
  })

  it('carries a null metric through as null, not 0', () => {
    const withNull: SeriesBucket[] = [{ t: 1000, perDevice: { a: { tempAvg: null, humAvg: 40 } } }]
    expect(toChartRows(withNull, 'temp')).toEqual([{ t: 1000, a: null }])
  })

  it('assigns a stable null key to a device before its first appearance', () => {
    // Device b appears only in the LATER bucket — it must still get a column
    // (with null) in the earlier one, so its line is a gap, not a missing key.
    const late: SeriesBucket[] = [
      { t: 1000, perDevice: { a: { tempAvg: 20, humAvg: 40 } } },
      { t: 2000, perDevice: { a: { tempAvg: 21, humAvg: 41 }, b: { tempAvg: 25, humAvg: 45 } } },
    ]
    expect(toChartRows(late, 'temp')).toEqual([
      { t: 1000, a: 20, b: null },
      { t: 2000, a: 21, b: 25 },
    ])
  })

  it('fills every known device key with null for an empty bucket', () => {
    // The "sensor offline for one bucket" case — the row is still emitted.
    const gap: SeriesBucket[] = [
      { t: 1000, perDevice: { a: { tempAvg: 20, humAvg: 40 } } },
      { t: 2000, perDevice: {} },
      { t: 3000, perDevice: { a: { tempAvg: 22, humAvg: 42 } } },
    ]
    expect(toChartRows(gap, 'temp')).toEqual([
      { t: 1000, a: 20 },
      { t: 2000, a: null },
      { t: 3000, a: 22 },
    ])
  })

  it('pivots 3 interleaved devices into stable columns', () => {
    const interleaved: SeriesBucket[] = [
      { t: 1, perDevice: { a: { tempAvg: 1, humAvg: 0 }, b: { tempAvg: 2, humAvg: 0 } } },
      { t: 2, perDevice: { a: { tempAvg: 3, humAvg: 0 } } },
      { t: 3, perDevice: { a: { tempAvg: 4, humAvg: 0 }, c: { tempAvg: 5, humAvg: 0 } } },
    ]
    expect(toChartRows(interleaved, 'temp')).toEqual([
      { t: 1, a: 1, b: 2, c: null },
      { t: 2, a: 3, b: null, c: null },
      { t: 3, a: 4, b: null, c: 5 },
    ])
  })

  it('pivots humidity through the same null-carry logic', () => {
    const late: SeriesBucket[] = [
      { t: 1000, perDevice: { a: { tempAvg: 20, humAvg: 40 } } },
      { t: 2000, perDevice: { a: { tempAvg: 21, humAvg: 41 }, b: { tempAvg: 25, humAvg: 45 } } },
    ]
    expect(toChartRows(late, 'hum')).toEqual([
      { t: 1000, a: 40, b: null },
      { t: 2000, a: 41, b: 45 },
    ])
  })

  it('returns an empty array for no buckets', () => {
    expect(toChartRows([], 'temp')).toEqual([])
  })
})

describe('colorForIndex', () => {
  it('wraps around the palette', () => {
    expect(colorForIndex(0)).toBe(DEVICE_COLORS[0])
    expect(colorForIndex(DEVICE_COLORS.length)).toBe(DEVICE_COLORS[0])
    expect(colorForIndex(DEVICE_COLORS.length + 1)).toBe(DEVICE_COLORS[1])
  })
})

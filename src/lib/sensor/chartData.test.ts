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

import { describe, expect, test } from 'vitest'
import { alertSpanMinutes, mergeReadings, typicalGapMinutes } from './alertGroups'

const T0 = new Date('2026-10-19T10:00:00Z').getTime()
const at = (min: number) => ({ recordedAt: new Date(T0 + min * 60_000) })
const mins = (groups: { recordedAt: Date }[][]) =>
  groups.map((g) => g.map((r) => (r.recordedAt.getTime() - T0) / 60_000))

describe('mergeReadings', () => {
  test('readings within the window are one group', () => {
    expect(mins(mergeReadings([0, 1, 9].map(at)))).toEqual([[0, 1, 9]])
  })

  test('a reading past the window starts a new group', () => {
    expect(mins(mergeReadings([0, 9, 11].map(at)))).toEqual([[0, 9], [11]])
  })

  test('exactly the window length is outside', () => {
    expect(mins(mergeReadings([0, 5, 10].map(at)))).toEqual([[0, 5], [10]])
  })

  test('windows are fixed from the first reading, never chained', () => {
    const readings = Array.from({ length: 11 }, (_, i) => at(i * 4))
    expect(mergeReadings(readings).map((g) => (g[0].recordedAt.getTime() - T0) / 60_000)).toEqual([
      0, 12, 24, 36,
    ])
  })

  test('no readings, no groups', () => {
    expect(mergeReadings([])).toEqual([])
  })
})

describe('typicalGapMinutes', () => {
  test('evenly spaced readings give their spacing', () => {
    expect(typicalGapMinutes([0, 120, 240, 360].map(at))).toBe(120)
  })

  test('bursts count as one reading, the median is rounded', () => {
    expect(typicalGapMinutes([0, 1, 120, 121, 122, 241].map(at))).toBe(121)
  })

  test('one reading has no gap', () => {
    expect(typicalGapMinutes([at(0)])).toBeNull()
  })

  test('one burst has no gap', () => {
    expect(typicalGapMinutes([0, 1, 2].map(at))).toBeNull()
  })
})

describe('alertSpanMinutes', () => {
  test('is (count-1) to count gaps', () => {
    expect(alertSpanMinutes(2, 120)).toEqual({ lowMin: 120, highMin: 240 })
    expect(alertSpanMinutes(3, 60)).toEqual({ lowMin: 120, highMin: 180 })
  })
})

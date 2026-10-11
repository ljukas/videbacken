import { expect, test } from 'vitest'
import { isUtcDay, isUtcMonth, utcDayBounds, utcDayOf } from './utc'

test('isUtcDay accepts real YYYY-MM-DD days in 1970–2999 only', () => {
  expect(isUtcDay('2026-10-08')).toBe(true)
  expect(isUtcDay('2028-02-29')).toBe(true)
  for (const bad of [
    '2026-02-29',
    '2026-13-01',
    '2026-1-01',
    '20261008',
    '1969-12-31',
    '3000-01-01',
    '',
  ])
    expect(isUtcDay(bad), bad).toBe(false)
})

test('isUtcMonth accepts real YYYY-MM months only', () => {
  expect(isUtcMonth('2026-10')).toBe(true)
  for (const bad of ['2026-13', '2026-00', '2026-1', '202610', '2026-10-01'])
    expect(isUtcMonth(bad), bad).toBe(false)
})

test('a UTC day is always 24 h, DST days included', () => {
  expect(utcDayBounds('2026-03-29')).toEqual({
    startMs: Date.UTC(2026, 2, 29),
    endMs: Date.UTC(2026, 2, 30),
  })
  expect(utcDayBounds('2025-10-26').endMs - utcDayBounds('2025-10-26').startMs).toBe(86_400_000)
  expect(() => utcDayBounds('2026-02-30')).toThrow(RangeError)
})

test('utcDayOf is the UTC calendar day of an instant', () => {
  expect(utcDayOf(Date.UTC(2026, 9, 8, 23, 59, 59, 999))).toBe('2026-10-08')
  expect(utcDayOf(Date.UTC(2026, 9, 9))).toBe('2026-10-09')
})

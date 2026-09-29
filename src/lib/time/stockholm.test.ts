import { describe, expect, test } from 'vitest'
import { addDays, stockholmDayBounds, stockholmDayOf, stockholmYearMonth } from './stockholm'

const HOUR = 60 * 60 * 1000
const utc = (iso: string) => new Date(iso).getTime()

describe('stockholmDayOf', () => {
  test('switches day at local midnight, not UTC midnight', () => {
    // CEST (UTC+2)
    expect(stockholmDayOf(utc('2026-09-27T21:59:59.999Z'))).toBe('2026-09-27')
    expect(stockholmDayOf(utc('2026-09-27T22:00:00Z'))).toBe('2026-09-28')
    // CET (UTC+1), across New Year
    expect(stockholmDayOf(utc('2025-12-31T22:59:59.999Z'))).toBe('2025-12-31')
    expect(stockholmDayOf(utc('2025-12-31T23:00:00Z'))).toBe('2026-01-01')
  })
})

describe('stockholmYearMonth', () => {
  test('uses the local calendar month', () => {
    expect(stockholmYearMonth(utc('2026-08-31T22:30:00Z'))).toEqual({ year: 2026, month: 9 })
    expect(stockholmYearMonth(utc('2025-12-31T23:30:00Z'))).toEqual({ year: 2026, month: 1 })
  })
})

describe('addDays', () => {
  test('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  test('rejects a malformed or impossible day', () => {
    expect(() => addDays('2026-9-1', 1)).toThrow(RangeError)
    expect(() => addDays('2025-02-30', 0)).toThrow(RangeError)
  })
})

describe('stockholmDayBounds', () => {
  test('a normal day is 24 h from local midnight', () => {
    const { startMs, endMs } = stockholmDayBounds('2026-09-28')
    expect(new Date(startMs).toISOString()).toBe('2026-09-27T22:00:00.000Z')
    expect(endMs - startMs).toBe(24 * HOUR)
  })

  test('spring-forward day is 23 h, fall-back day is 25 h', () => {
    const spring = stockholmDayBounds('2025-03-30')
    expect(new Date(spring.startMs).toISOString()).toBe('2025-03-29T23:00:00.000Z')
    expect(spring.endMs - spring.startMs).toBe(23 * HOUR)

    const fall = stockholmDayBounds('2025-10-26')
    expect(new Date(fall.startMs).toISOString()).toBe('2025-10-25T22:00:00.000Z')
    expect(fall.endMs - fall.startMs).toBe(25 * HOUR)
  })

  test('consecutive days tile without gaps', () => {
    let day = '2025-03-28'
    for (let i = 0; i < 10; i++) {
      const next = addDays(day, 1)
      expect(stockholmDayBounds(day).endMs).toBe(stockholmDayBounds(next).startMs)
      day = next
    }
  })
})

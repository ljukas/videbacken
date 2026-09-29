import { describe, expect, test } from 'vitest'
import {
  addDays,
  stockholmDayBounds,
  stockholmDayOf,
  stockholmYearBounds,
  stockholmYearMonth,
} from './stockholm'

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

  test('tracks the offset change on DST switch days', () => {
    // Spring forward 2025-03-30 02:00 CET → 03:00 CEST (01:00Z).
    expect(stockholmDayOf(utc('2025-03-29T22:59:59.999Z'))).toBe('2025-03-29')
    expect(stockholmDayOf(utc('2025-03-29T23:00:00Z'))).toBe('2025-03-30')
    expect(stockholmDayOf(utc('2025-03-30T21:59:59.999Z'))).toBe('2025-03-30')
    expect(stockholmDayOf(utc('2025-03-30T22:00:00Z'))).toBe('2025-03-31')
    // Fall back 2025-10-26 03:00 CEST → 02:00 CET (01:00Z).
    expect(stockholmDayOf(utc('2025-10-25T21:59:59.999Z'))).toBe('2025-10-25')
    expect(stockholmDayOf(utc('2025-10-25T22:00:00Z'))).toBe('2025-10-26')
    expect(stockholmDayOf(utc('2025-10-26T22:59:59.999Z'))).toBe('2025-10-26')
    expect(stockholmDayOf(utc('2025-10-26T23:00:00Z'))).toBe('2025-10-27')
  })
})

describe('stockholmYearMonth', () => {
  test('uses the local calendar month', () => {
    expect(stockholmYearMonth(utc('2026-08-31T22:30:00Z'))).toEqual({ year: 2026, month: 9 })
    expect(stockholmYearMonth(utc('2025-12-31T23:30:00Z'))).toEqual({ year: 2026, month: 1 })
    // CET again after the October switch.
    expect(stockholmYearMonth(utc('2025-10-31T22:59:59.999Z'))).toEqual({ year: 2025, month: 10 })
    expect(stockholmYearMonth(utc('2025-10-31T23:00:00Z'))).toEqual({ year: 2025, month: 11 })
  })
})

describe('addDays', () => {
  test('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-01-01', 365)).toBe('2027-01-01')
    expect(addDays('2026-09-28', 0)).toBe('2026-09-28')
  })

  test('is pure calendar arithmetic across DST switch days', () => {
    expect(addDays('2025-03-29', 1)).toBe('2025-03-30')
    expect(addDays('2025-03-30', 1)).toBe('2025-03-31')
    expect(addDays('2025-10-26', 1)).toBe('2025-10-27')
    expect(addDays('2025-10-27', -1)).toBe('2025-10-26')
  })

  test('accepts years 1970–2999 and does not validate the shifted result', () => {
    expect(addDays('1970-01-01', 0)).toBe('1970-01-01')
    expect(addDays('2999-12-31', 0)).toBe('2999-12-31')
    expect(addDays('2999-12-31', 1)).toBe('3000-01-01')
    expect(addDays('1970-01-01', -1)).toBe('1969-12-31')
    expect(() => addDays('1969-12-31', 0)).toThrow(RangeError)
    expect(() => addDays('3000-01-01', 0)).toThrow(RangeError)
  })

  test('rejects a malformed or impossible day', () => {
    expect(() => addDays('2026-9-1', 1)).toThrow(RangeError)
    expect(() => addDays('2025-02-30', 0)).toThrow(RangeError)
    expect(() => addDays('0050-01-01', 0)).toThrow(RangeError)
    expect(() => addDays('0000-01-01', 0)).toThrow(RangeError)
    expect(() => addDays('2026-02-29', 0)).toThrow(RangeError)
    expect(addDays('2028-02-29', 0)).toBe('2028-02-29')
    for (const bad of [
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '2026-04-31',
      ' 2026-01-01',
      '2026-01-01T00:00',
      '20260101',
      '',
    ]) {
      expect(() => addDays(bad, 0), bad).toThrow(RangeError)
    }
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

  test('rejects a malformed or out-of-range day', () => {
    expect(() => stockholmDayBounds('2025-02-30')).toThrow(RangeError)
    expect(() => stockholmDayBounds('2026-9-1')).toThrow(RangeError)
    expect(() => stockholmDayBounds('1969-12-31')).toThrow(RangeError)
    // Its end is the next day's midnight, which is itself out of range.
    expect(() => stockholmDayBounds('2999-12-31')).toThrow(RangeError)
  })

  test('the first supported day is a plain CET day', () => {
    const { startMs, endMs } = stockholmDayBounds('1970-01-01')
    expect(new Date(startMs).toISOString()).toBe('1969-12-31T23:00:00.000Z')
    expect(endMs - startMs).toBe(24 * HOUR)
  })

  test('the 2026 switch days (last Sunday of March / October)', () => {
    const spring = stockholmDayBounds('2026-03-29')
    expect(new Date(spring.startMs).toISOString()).toBe('2026-03-28T23:00:00.000Z')
    expect(new Date(spring.endMs).toISOString()).toBe('2026-03-29T22:00:00.000Z')
    const fall = stockholmDayBounds('2026-10-25')
    expect(new Date(fall.startMs).toISOString()).toBe('2026-10-24T22:00:00.000Z')
    expect(new Date(fall.endMs).toISOString()).toBe('2026-10-25T23:00:00.000Z')
  })

  test('consecutive days tile without gaps', () => {
    let day = '2025-03-28'
    for (let i = 0; i < 220; i++) {
      const next = addDays(day, 1)
      expect(stockholmDayBounds(day).endMs).toBe(stockholmDayBounds(next).startMs)
      day = next
    }
  })
})

describe('stockholmYearBounds', () => {
  test('runs from local 1 January midnight (always CET, UTC+1) to the next', () => {
    const { startMs, endMs } = stockholmYearBounds(2026)
    expect(new Date(startMs).toISOString()).toBe('2025-12-31T23:00:00.000Z')
    expect(new Date(endMs).toISOString()).toBe('2026-12-31T23:00:00.000Z')
    for (let year = 1970; year <= 2100; year++) {
      expect(stockholmYearBounds(year).startMs).toBe(Date.UTC(year - 1, 11, 31, 23))
      expect(stockholmYearBounds(year).endMs).toBe(stockholmYearBounds(year + 1).startMs)
    }
  })
})

import { describe, expect, test } from 'vitest'
import {
  defaultPeriod,
  formatPeriod,
  monthKey,
  parsePeriod,
  periodFromSearch,
  periodQueryYear,
  resolvePeriod,
  stepPeriod,
} from './period'

const MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-04', '2026-10']
const NOW = { year: 2026, month: 10 }

describe('parsePeriod / formatPeriod', () => {
  test.each([
    ['2026-08', { kind: 'month', year: 2026, month: 8 }],
    ['2026-1', null],
    ['2026-13', null],
    ['2026-00', null],
    ['2026', { kind: 'year', year: 2026 }],
    ['all', { kind: 'all' }],
    ['abc', null],
    ['', null],
    [undefined, null],
    ['1999', null],
    ['2101-01', null],
    ['2020', { kind: 'year', year: 2020 }],
    ['2100', { kind: 'year', year: 2100 }],
    ['2020-01', { kind: 'month', year: 2020, month: 1 }],
    ['2100-12', { kind: 'month', year: 2100, month: 12 }],
    ['2019', null],
    ['2101', null],
    ['1999-05', null],
    ['2026-01', { kind: 'month', year: 2026, month: 1 }],
    ['2026-12', { kind: 'month', year: 2026, month: 12 }],
    ['ALL', null],
    ['2026-08-01', null],
    ['20260', null],
    [' 2026', null],
    ['2026-0a', null],
  ] as const)('%s', (value, expected) => {
    expect(parsePeriod(value)).toEqual(expected)
  })

  test('round trip', () => {
    for (const v of ['2026-08', '2025', 'all']) {
      const p = parsePeriod(v)
      expect(p).not.toBeNull()
      if (p) expect(formatPeriod(p)).toBe(v)
    }
  })

  test('monthKey pads the month', () => {
    expect(monthKey(2026, 3)).toBe('2026-03')
  })
})

describe('periodFromSearch', () => {
  test('period wins over the legacy year', () => {
    expect(periodFromSearch({ period: '2026-08', year: 2025 })).toEqual({
      kind: 'month',
      year: 2026,
      month: 8,
    })
  })
  test('the legacy ?year= reads as a year period', () => {
    expect(periodFromSearch({ year: 2025 })).toEqual({ kind: 'year', year: 2025 })
  })
  test('an invalid period counts as missing: the legacy year applies', () => {
    expect(periodFromSearch({ period: 'garbage', year: 2025 })).toEqual({
      kind: 'year',
      year: 2025,
    })
  })
  test('an out-of-range legacy year → null', () => {
    expect(periodFromSearch({ year: 1999 })).toBeNull()
  })
  test('period=all wins over the legacy year', () => {
    expect(periodFromSearch({ period: 'all', year: 2025 })).toEqual({ kind: 'all' })
  })
  test('nothing → null', () => {
    expect(periodFromSearch({})).toBeNull()
  })
})

describe('periodQueryYear', () => {
  test.each([
    [{ kind: 'month', year: 2025, month: 12 }, 2025],
    [{ kind: 'year', year: 2025 }, 2025],
    [{ kind: 'all' }, undefined],
    [null, undefined],
  ] as const)('%j → %s', (p, year) => {
    expect(periodQueryYear(p)).toBe(year)
  })
})

describe('defaultPeriod', () => {
  test('the current month when it has readings', () => {
    expect(defaultPeriod(MONTHS, NOW)).toEqual({ kind: 'month', year: 2026, month: 10 })
  })
  test("a new month's first hour: the newest month with readings this year", () => {
    expect(defaultPeriod(MONTHS, { year: 2026, month: 11 })).toEqual({
      kind: 'month',
      year: 2026,
      month: 10,
    })
  })
  test("a new year's first hour: Totalt (no month this year yet)", () => {
    expect(defaultPeriod(MONTHS, { year: 2027, month: 1 })).toEqual({ kind: 'all' })
  })
  test('order-independent and ignores later years', () => {
    const shuffled = ['2026-10', '2025-11', '2026-02', '2026-04']
    expect(defaultPeriod(shuffled, { year: 2026, month: 11 })).toEqual({
      kind: 'month',
      year: 2026,
      month: 10,
    })
    expect(defaultPeriod([...MONTHS, '2027-01'], NOW)).toEqual({
      kind: 'month',
      year: 2026,
      month: 10,
    })
    expect(defaultPeriod([...MONTHS, '2027-01'], { year: 2026, month: 11 })).toEqual({
      kind: 'month',
      year: 2026,
      month: 10,
    })
  })
  test('no readings at all: Totalt (the page shows the empty state anyway)', () => {
    expect(defaultPeriod([], NOW)).toEqual({ kind: 'all' })
  })
})

describe('resolvePeriod', () => {
  test('a month with readings stays', () => {
    expect(resolvePeriod({ kind: 'month', year: 2026, month: 2 }, MONTHS, NOW)).toEqual({
      kind: 'month',
      year: 2026,
      month: 2,
    })
  })
  test('a month without readings → the default', () => {
    expect(resolvePeriod({ kind: 'month', year: 2026, month: 3 }, MONTHS, NOW)).toEqual({
      kind: 'month',
      year: 2026,
      month: 10,
    })
  })
  test('a year with readings stays; a year without → the default', () => {
    expect(resolvePeriod({ kind: 'year', year: 2025 }, MONTHS, NOW)).toEqual({
      kind: 'year',
      year: 2025,
    })
    expect(resolvePeriod({ kind: 'year', year: 2021 }, MONTHS, NOW)).toEqual({
      kind: 'month',
      year: 2026,
      month: 10,
    })
  })
  test('all stays; null → the default', () => {
    expect(resolvePeriod({ kind: 'all' }, MONTHS, NOW)).toEqual({ kind: 'all' })
    expect(resolvePeriod(null, MONTHS, NOW)).toEqual({ kind: 'month', year: 2026, month: 10 })
  })
})

describe('stepPeriod', () => {
  test('month steps skip months without readings', () => {
    expect(stepPeriod({ kind: 'month', year: 2026, month: 2 }, 1, MONTHS)).toEqual({
      kind: 'month',
      year: 2026,
      month: 4,
    })
    expect(stepPeriod({ kind: 'month', year: 2026, month: 4 }, -1, MONTHS)).toEqual({
      kind: 'month',
      year: 2026,
      month: 2,
    })
  })
  test('month steps cross a year boundary', () => {
    expect(stepPeriod({ kind: 'month', year: 2025, month: 12 }, 1, MONTHS)).toEqual({
      kind: 'month',
      year: 2026,
      month: 1,
    })
  })
  test('the ends return null', () => {
    expect(stepPeriod({ kind: 'month', year: 2025, month: 11 }, -1, MONTHS)).toBeNull()
    expect(stepPeriod({ kind: 'month', year: 2026, month: 10 }, 1, MONTHS)).toBeNull()
  })
  test('year steps go through the years with readings', () => {
    expect(stepPeriod({ kind: 'year', year: 2025 }, 1, MONTHS)).toEqual({
      kind: 'year',
      year: 2026,
    })
    expect(stepPeriod({ kind: 'year', year: 2026 }, 1, MONTHS)).toBeNull()
    expect(stepPeriod({ kind: 'year', year: 2025 }, -1, MONTHS)).toBeNull()
  })
  test('shuffled input steps the same', () => {
    const shuffled = ['2026-10', '2025-12', '2026-02', '2025-11', '2026-04', '2026-01']
    expect(stepPeriod({ kind: 'month', year: 2026, month: 2 }, 1, shuffled)).toEqual({
      kind: 'month',
      year: 2026,
      month: 4,
    })
    expect(stepPeriod({ kind: 'year', year: 2025 }, 1, shuffled)).toEqual({
      kind: 'year',
      year: 2026,
    })
  })
  test('a year or month not in the list → null', () => {
    for (const d of [1, -1] as const) {
      expect(stepPeriod({ kind: 'year', year: 2023 }, d, MONTHS)).toBeNull()
      expect(stepPeriod({ kind: 'month', year: 2026, month: 3 }, d, MONTHS)).toBeNull()
    }
  })
  test('a backward step crosses a year boundary', () => {
    expect(stepPeriod({ kind: 'month', year: 2026, month: 1 }, -1, MONTHS)).toEqual({
      kind: 'month',
      year: 2025,
      month: 12,
    })
  })
  test('sparse years: 2024 → 2026', () => {
    expect(stepPeriod({ kind: 'year', year: 2024 }, 1, ['2024-05', '2026-01'])).toEqual({
      kind: 'year',
      year: 2026,
    })
  })
  test('empty list → null', () => {
    expect(stepPeriod({ kind: 'month', year: 2026, month: 2 }, 1, [])).toBeNull()
    expect(stepPeriod({ kind: 'year', year: 2026 }, -1, [])).toBeNull()
  })
  test('Totalt has no steps', () => {
    expect(stepPeriod({ kind: 'all' }, 1, MONTHS)).toBeNull()
    expect(stepPeriod({ kind: 'all' }, -1, MONTHS)).toBeNull()
  })
})

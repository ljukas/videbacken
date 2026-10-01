import { afterEach, describe, expect, test } from 'vitest'
import { baseLocale, getLocale, type Locale, overwriteGetLocale } from '~/paraglide/runtime'
import {
  formatDay,
  formatDuration,
  formatScore,
  formatSignedSek,
  formatWeekdayDay,
  hourRangeLabel,
  monthLabel,
  monthName,
  weekdayLabel,
} from './format'

const original = getLocale
function inLocale(locale: Locale) {
  overwriteGetLocale(() => locale)
}
afterEach(() => overwriteGetLocale(original))

const at = (iso: string) => new Date(iso)

describe('formatDay', () => {
  test('renders the calendar day itself, never shifted by a time zone', () => {
    inLocale('sv')
    expect(formatDay('2026-09-27')).toBe('27 sep. 2026')
    expect(formatDay('2026-01-01')).toBe('1 jan. 2026')
    expect(formatDay('2025-12-31')).toBe('31 dec. 2025')
    expect(formatDay('2025-03-30')).toBe('30 mars 2025')
    inLocale('en')
    expect(formatDay('2026-09-27')).toBe('27 Sept 2026')
    expect(formatDay('2026-01-01')).toBe('1 Jan 2026')
  })
})

describe('monthLabel', () => {
  test('short month names for 1-based months', () => {
    inLocale(baseLocale)
    expect(Array.from({ length: 12 }, (_, i) => monthLabel(i + 1))).toEqual([
      'jan.',
      'feb.',
      'mars',
      'apr.',
      'maj',
      'juni',
      'juli',
      'aug.',
      'sep.',
      'okt.',
      'nov.',
      'dec.',
    ])
    inLocale('en')
    expect(monthLabel(1)).toBe('Jan')
    expect(monthLabel(9)).toBe('Sep')
  })
})

describe('monthName', () => {
  test('full month names for 1-based months', () => {
    inLocale('sv')
    expect(monthName(1)).toBe('januari')
    expect(monthName(3)).toBe('mars')
    expect(monthName(12)).toBe('december')
    inLocale('en')
    expect(monthName(1)).toBe('January')
    expect(monthName(9)).toBe('September')
  })
})

describe('weekdayLabel', () => {
  test('0 is Monday and 6 is Sunday (Monday-first, unlike date-fns)', () => {
    inLocale('sv')
    expect(Array.from({ length: 7 }, (_, i) => weekdayLabel(i))).toEqual([
      'mån',
      'tis',
      'ons',
      'tors',
      'fre',
      'lör',
      'sön',
    ])
    inLocale('en')
    expect(weekdayLabel(0)).toBe('Mon')
    expect(weekdayLabel(6)).toBe('Sun')
  })

  test("'long' gives the full name", () => {
    inLocale('sv')
    expect(weekdayLabel(0, 'long')).toBe('måndag')
    expect(weekdayLabel(6, 'long')).toBe('söndag')
    inLocale('en')
    expect(weekdayLabel(2, 'long')).toBe('Wednesday')
  })
})

describe('hourRangeLabel', () => {
  test('two-digit hours, and 23 wraps to 00', () => {
    expect(hourRangeLabel(0)).toBe('00–01')
    expect(hourRangeLabel(9)).toBe('09–10')
    expect(hourRangeLabel(21)).toBe('21–22')
    expect(hourRangeLabel(23)).toBe('23–00')
  })
})

describe('formatWeekdayDay', () => {
  test('weekday, day and short month in the active locale', () => {
    inLocale('sv')
    expect(formatWeekdayDay(at('2026-09-14T07:39:00Z'))).toBe('mån 14 sep.')
    inLocale('en')
    expect(formatWeekdayDay(at('2026-09-14T07:39:00Z'))).toBe('Mon 14 Sep')
  })

  test('uses the Stockholm day, not the UTC one, near midnight', () => {
    inLocale('sv')
    // Sat 5 Sep 22:30 UTC is already Sun 6 Sep 00:30 CEST.
    expect(formatWeekdayDay(at('2026-09-05T22:30:00Z'))).toBe('sön 6 sep.')
    // Thu 1 Jan 23:30 UTC is Fri 2 Jan 00:30 CET; an epoch-ms instant works too.
    expect(formatWeekdayDay(Date.parse('2026-01-01T23:30:00Z'))).toBe('fre 2 jan.')
  })
})

describe('formatDuration', () => {
  test('whole minutes, with hours from 60 min', () => {
    inLocale('sv')
    const start = at('2026-09-27T20:00:00Z')
    expect(formatDuration(start, at('2026-09-27T20:00:00Z'))).toBe('0 min')
    expect(formatDuration(start, at('2026-09-27T20:00:29.999Z'))).toBe('0 min')
    expect(formatDuration(start, at('2026-09-27T20:00:30Z'))).toBe('1 min')
    expect(formatDuration(start, at('2026-09-27T20:59:29Z'))).toBe('59 min')
    expect(formatDuration(start, at('2026-09-27T20:59:30Z'))).toBe('1 h 0 min')
    expect(formatDuration(start, at('2026-09-28T01:07:00Z'))).toBe('5 h 7 min')
    expect(formatDuration(start, at('2026-09-28T21:00:00Z'))).toBe('25 h 0 min')
  })

  test('a negative span (end before start) reads as zero', () => {
    inLocale('sv')
    expect(formatDuration(at('2026-09-27T20:00:00Z'), at('2026-09-27T19:00:00Z'))).toBe('0 min')
  })
})

describe('formatSignedSek', () => {
  test('prefixes a real minus and never shows −0', () => {
    inLocale('sv')
    expect(formatSignedSek(-12.4)).toBe('−12\u00a0kr')
    expect(formatSignedSek(12.4)).toBe('12\u00a0kr')
    expect(formatSignedSek(-12.5)).toBe('−13\u00a0kr')
    expect(formatSignedSek(12.5)).toBe('13\u00a0kr')
    expect(formatSignedSek(-0.2)).toBe('0\u00a0kr')
  })
})

describe('formatScore', () => {
  test('is a whole percent, "—" when null', () => {
    inLocale('sv')
    expect(formatScore(0.724)).toMatch(/^72\s?%$/)
    expect(formatScore(null)).toBe('—')
  })
})

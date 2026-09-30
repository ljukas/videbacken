import { afterEach, describe, expect, test } from 'vitest'
import { baseLocale, getLocale, type Locale, overwriteGetLocale } from '~/paraglide/runtime'
import { formatDay, formatDuration, monthLabel } from './format'

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

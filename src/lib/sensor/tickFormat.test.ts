import { expect, test } from 'vitest'
import { makeTickFormatter } from './tickFormat'

// Assertions compare labels to each OTHER rather than to literal strings: the
// exact glyphs are ICU's business (and vary by Node build), while what the chart
// actually needs is that two ticks the range must tell apart get different
// labels, and two ticks it deliberately collapses get the same one.
const t = (iso: string) => new Date(iso).getTime()

test('the 24h range labels by time of day, collapsing the calendar day', () => {
  const fmt = makeTickFormatter('24h', 'sv-SE')
  // A 24h window never shows the same hour twice, so dropping the date is safe.
  expect(fmt(t('2026-08-02T10:00:00Z'))).toBe(fmt(t('2026-08-03T10:00:00Z')))
  expect(fmt(t('2026-08-02T10:00:00Z'))).not.toBe(fmt(t('2026-08-02T14:00:00Z')))
})

test('the 1w range distinguishes ticks within one day', () => {
  // ~12 points per day at 2h buckets: a date-only label would read identically
  // for all of them, on the axis and in the tooltip header.
  const fmt = makeTickFormatter('1w', 'sv-SE')
  expect(fmt(t('2026-08-02T10:00:00Z'))).not.toBe(fmt(t('2026-08-02T14:00:00Z')))
})

test('the 1w range distinguishes the same clock time on different days', () => {
  const fmt = makeTickFormatter('1w', 'sv-SE')
  expect(fmt(t('2026-08-02T14:00:00Z'))).not.toBe(fmt(t('2026-08-03T14:00:00Z')))
})

test('coarse ranges label by date, collapsing the time of day', () => {
  const fmt = makeTickFormatter('1m', 'sv-SE')
  expect(fmt(t('2026-08-02T10:00:00Z'))).toBe(fmt(t('2026-08-02T14:00:00Z')))
  expect(fmt(t('2026-08-02T10:00:00Z'))).not.toBe(fmt(t('2026-08-03T10:00:00Z')))
})

test('labels render in the given locale', () => {
  const sv = makeTickFormatter('1m', 'sv-SE')(t('2026-08-02T10:00:00Z'))
  const en = makeTickFormatter('1m', 'en-GB')(t('2026-08-02T10:00:00Z'))
  expect(sv).not.toBe(en) // "2 aug." vs "2 Aug"
})

import { expect, test } from 'vitest'
import { SERIES_RANGES } from './range'
import { makeTickFormatter, makeTimeAxis } from './tickFormat'

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

// The axis' round ticks (step 5c). Hours and dates are read in the runner's
// local zone, the zone d3-time and Intl both use, so this holds in any TZ.
const span = (from: string, days: number) => {
  const start = new Date(from)
  return [start, new Date(start.getTime() + days * 86_400_000)] as const
}

test('the 24h axis ticks fall on whole hours, every 3 h at the finest', () => {
  const [a, b] = span('2026-08-02T10:20:00', 1)
  const ticks = makeTimeAxis('24h', 'sv-SE').intervals[0].range(a, b)
  expect(ticks.length).toBe(8)
  for (const t of ticks) {
    expect(t.getMinutes()).toBe(0)
    expect(t.getHours() % 3).toBe(0)
  }
})

test('the 1w axis ticks fall on midnights and label the weekday alone', () => {
  const [a, b] = span('2026-08-02T10:20:00', 7)
  const axis = makeTimeAxis('1w', 'sv-SE')
  const ticks = axis.intervals[0].range(a, b)
  expect(ticks.length).toBe(7)
  for (const t of ticks) expect([t.getHours(), t.getMinutes()]).toEqual([0, 0])
  // Two days apart: different labels; the same weekday a week apart: the same label.
  expect(axis.format(ticks[0].getTime())).not.toBe(axis.format(ticks[1].getTime()))
  const weekLater = new Date(ticks[0].getTime() + 7 * 86_400_000).getTime()
  expect(axis.format(weekLater)).toBe(axis.format(ticks[0].getTime()))
})

test('the 1m axis ticks fall on Mondays', () => {
  const [a, b] = span('2026-08-02T10:20:00', 30)
  for (const t of makeTimeAxis('1m', 'sv-SE').intervals[0].range(a, b)) {
    expect([t.getDay(), t.getHours()]).toEqual([1, 0])
  }
})

test('the longer axes fall on the 1st and 16th or on month starts', () => {
  const [a, b] = span('2026-01-10T10:20:00', 180)
  const half = makeTimeAxis('3m', 'sv-SE').intervals[0].range(a, b)
  expect(half.length).toBeGreaterThan(8)
  for (const t of half) expect([1, 16]).toContain(t.getDate())
  for (const range of ['6m', '1y', 'all'] as const) {
    const intervals = makeTimeAxis(range, 'sv-SE').intervals
    for (const t of intervals[intervals.length - 1].range(a, b)) {
      expect([t.getDate(), t.getHours()]).toEqual([1, 0])
    }
  }
})

test('every range lists its intervals finest first', () => {
  for (const range of SERIES_RANGES) {
    const [a, b] = span('2026-01-10T10:20:00', 400)
    const counts = makeTimeAxis(range, 'sv-SE').intervals.map((i) => i.range(a, b).length)
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThan(counts[i - 1])
  }
})

test('the 24h axis labels by time of day, the longer ones by date', () => {
  const day = makeTimeAxis('24h', 'sv-SE').format
  expect(day(new Date('2026-08-02T15:00:00').getTime())).toMatch(/^15[:.]00$/)
  const month = makeTimeAxis('1y', 'sv-SE').format
  expect(month(new Date('2026-08-01T00:00:00').getTime())).toBe(
    makeTickFormatter('1m', 'sv-SE')(new Date('2026-08-01T12:00:00').getTime()),
  )
})

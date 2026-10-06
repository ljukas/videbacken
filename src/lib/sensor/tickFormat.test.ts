import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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
  // One day apart: different labels; the same weekday a week apart: the same label.
  expect(axis.format(ticks[0].getTime())).not.toBe(axis.format(ticks[1].getTime()))
  const weekLater = new Date(ticks[0].getTime() + 7 * 86_400_000).getTime()
  expect(axis.format(weekLater)).toBe(axis.format(ticks[0].getTime()))
  // The weekday alone: the time of day doesn't change the label.
  const noon = new Date(ticks[0])
  noon.setHours(13)
  expect(axis.format(noon.getTime())).toBe(axis.format(ticks[0].getTime()))
})

test('the 1m axis ticks fall on Mondays', () => {
  const [a, b] = span('2026-08-02T10:20:00', 30)
  const ticks = makeTimeAxis('1m', 'sv-SE').intervals[0].range(a, b)
  expect(ticks.length).toBeGreaterThanOrEqual(4)
  for (const t of ticks) expect([t.getDay(), t.getHours()]).toEqual([1, 0])
})

test('every interval of the longer axes falls on its own round dates', () => {
  const [a, b] = span('2026-01-10T10:20:00', 800)
  const check = (
    range: Parameters<typeof makeTimeAxis>[0],
    i: number,
    ok: (t: Date) => boolean,
  ) => {
    const ticks = makeTimeAxis(range, 'sv-SE').intervals[i].range(a, b)
    expect(ticks.length).toBeGreaterThan(0)
    for (const t of ticks) expect([range, i, ok(t)]).toEqual([range, i, true])
  }
  const half = (t: Date) => [1, 16].includes(t.getDate()) && t.getHours() === 0
  const month = (t: Date) => t.getDate() === 1 && t.getHours() === 0
  const every = (n: number) => (t: Date) => month(t) && t.getMonth() % n === 0
  check('3m', 0, half)
  check('3m', 1, month)
  check('6m', 0, half)
  check('6m', 1, month)
  check('6m', 2, every(2))
  check('1y', 0, month)
  check('1y', 1, every(2))
  check('1y', 2, every(3))
  check('all', 0, month)
  check('all', 1, every(2))
  check('all', 2, every(3))
  check('all', 3, every(6))
  check('all', 4, every(12))
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

// DST and month ends, in a zone that has both (Node applies a runtime TZ change).
describe('in Europe/Stockholm', () => {
  const before = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Europe/Stockholm'
  })
  afterAll(() => {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  })

  test('the runner applied the zone', () => {
    expect(new Date('2026-07-01T12:00:00Z').getTimezoneOffset()).toBe(-120)
    expect(new Date('2026-01-01T12:00:00Z').getTimezoneOffset()).toBe(-60)
  })

  test('the 25 h fall-back day still ticks on 3 h marks', () => {
    const ticks = makeTimeAxis('24h', 'sv-SE').intervals[0].range(
      new Date('2026-10-25T00:00:00'),
      new Date('2026-10-26T00:00:00'),
    )
    expect(ticks.length).toBeLessThanOrEqual(9)
    expect(ticks.length).toBeGreaterThanOrEqual(8)
    for (const t of ticks) expect(t.getHours() % 3).toBe(0)
  })

  test('the 23 h spring-forward day has no tick in the skipped hour', () => {
    const ticks = makeTimeAxis('24h', 'sv-SE').intervals[0].range(
      new Date('2026-03-29T00:00:00'),
      new Date('2026-03-30T00:00:00'),
    )
    for (const t of ticks) expect(t.getHours() % 3).toBe(0)
    expect(ticks.map((t) => t.getHours())).not.toContain(2)
  })

  test('every(timeDay, 2) at a month end ticks the 31st and the 1st both', () => {
    const ticks = makeTimeAxis('1w', 'sv-SE').intervals[1].range(
      new Date('2026-07-30T10:20:00'),
      new Date('2026-08-03T10:20:00'),
    )
    expect(ticks.map((t) => t.getDate())).toEqual([31, 1, 3])
  })
})

import { expect, test } from 'vitest'
import { HOUR_MS, splitByStockholmHour } from './pieces'

const t = (iso: string) => Date.parse(iso)

test('an hour-aligned span yields one piece per Stockholm hour with local labels', () => {
  // 2026-09-27 is a Sunday; 19:30Z = 21:30 CEST.
  const pieces = splitByStockholmHour(t('2026-09-27T19:30:00Z'), t('2026-09-27T22:00:00Z'))
  expect(pieces.map((p) => [p.hour, p.weekday, p.day, (p.endMs - p.startMs) / HOUR_MS])).toEqual([
    [21, 6, '2026-09-27', 0.5],
    [22, 6, '2026-09-27', 1],
    [23, 6, '2026-09-27', 1],
  ])
})

test('a span crossing Stockholm midnight changes day and weekday', () => {
  const pieces = splitByStockholmHour(t('2026-09-27T21:00:00Z'), t('2026-09-27T23:00:00Z'))
  expect(pieces.map((p) => [p.day, p.weekday, p.hour])).toEqual([
    ['2026-09-27', 6, 23],
    ['2026-09-28', 0, 0],
  ])
})

test('fall-back night: two pieces are labelled hour 2, none is lost', () => {
  // 2026-10-25: 03:00 CEST → 02:00 CET. 00:00Z = 02:00 CEST, 01:00Z = 02:00 CET.
  const pieces = splitByStockholmHour(t('2026-10-24T23:00:00Z'), t('2026-10-25T02:00:00Z'))
  expect(pieces.map((p) => p.hour)).toEqual([1, 2, 2])
  expect(pieces.map((p) => p.startMs)).toEqual([
    t('2026-10-24T23:00:00Z'),
    t('2026-10-25T00:00:00Z'),
    t('2026-10-25T01:00:00Z'),
  ])
  expect(pieces.map((p) => [p.day, p.weekday])).toEqual([
    ['2026-10-25', 6],
    ['2026-10-25', 6],
    ['2026-10-25', 6],
  ])
  expect(pieces.reduce((ms, p) => ms + p.endMs - p.startMs, 0)).toBe(3 * HOUR_MS)
})

test('spring-forward night: there is no hour 2', () => {
  // 2026-03-29: 02:00 CET → 03:00 CEST. 00:00Z = 01:00 CET, 01:00Z = 03:00 CEST.
  const pieces = splitByStockholmHour(t('2026-03-29T00:00:00Z'), t('2026-03-29T02:00:00Z'))
  expect(pieces.map((p) => p.hour)).toEqual([1, 3])
  expect(pieces.reduce((ms, p) => ms + p.endMs - p.startMs, 0)).toBe(2 * HOUR_MS)
  expect(pieces.map((p) => [p.day, p.weekday])).toEqual([
    ['2026-03-29', 6],
    ['2026-03-29', 6],
  ])
})

test('an empty or inverted span yields no pieces', () => {
  expect(splitByStockholmHour(1000, 1000)).toEqual([])
  expect(splitByStockholmHour(2000, 1000)).toEqual([])
})

test('a span starting exactly on an hour yields no zero-length piece', () => {
  expect(splitByStockholmHour(t('2026-09-27T10:00:00Z'), t('2026-09-27T11:00:00Z'))).toEqual([
    {
      startMs: t('2026-09-27T10:00:00Z'),
      endMs: t('2026-09-27T11:00:00Z'),
      weekday: 6,
      hour: 12,
      day: '2026-09-27',
    },
  ])
})

test('a sub-hour span inside one hour is a single piece equal to the span', () => {
  const pieces = splitByStockholmHour(t('2026-09-27T10:10:00Z'), t('2026-09-27T10:20:00Z'))
  expect(pieces).toHaveLength(1)
  expect(pieces[0]).toMatchObject({
    startMs: t('2026-09-27T10:10:00Z'),
    endMs: t('2026-09-27T10:20:00Z'),
    hour: 12,
  })
})

test.each([
  ['2026-09-27T19:12:34Z', '2026-09-28T05:47:00Z'],
  ['2026-10-24T18:00:00Z', '2026-10-25T10:00:00Z'],
])('pieces are contiguous and cover %s → %s exactly', (a, b) => {
  const start = t(a)
  const end = t(b)
  const pieces = splitByStockholmHour(start, end)
  expect(pieces[0].startMs).toBe(start)
  expect(pieces.at(-1)?.endMs).toBe(end)
  for (let i = 1; i < pieces.length; i++) expect(pieces[i].startMs).toBe(pieces[i - 1].endMs)
  expect(pieces.reduce((ms, p) => ms + p.endMs - p.startMs, 0)).toBe(end - start)
})

test('the fall-back window 18:00Z → 10:00Z totals 16 hours', () => {
  const pieces = splitByStockholmHour(t('2026-10-24T18:00:00Z'), t('2026-10-25T10:00:00Z'))
  expect(pieces.reduce((ms, p) => ms + p.endMs - p.startMs, 0)).toBe(16 * HOUR_MS)
})

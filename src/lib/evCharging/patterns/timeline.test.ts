import { expect, test } from 'vitest'
import { sessionPeakKw, toTimelineSession } from './timeline'
import type { PatternSession } from './types'

const d = (iso: string) => new Date(iso)
const iv = (a: string, b: string, k: number) => ({ startAt: d(a), endAt: d(b), energyKwh: k })
const kinds = (s: ReturnType<typeof toTimelineSession>) =>
  s.segments.map((g) => [
    g.kind,
    g.startAt.toISOString().slice(11, 16),
    g.endAt.toISOString().slice(11, 16),
  ])

function base(
  intervals: PatternSession['intervals'],
  start = '2026-09-27T19:30:00Z',
  end = '2026-09-28T05:00:00Z',
): PatternSession {
  return {
    id: 's1',
    startAt: d(start),
    endAt: d(end),
    energyKwh: intervals.reduce((s, i) => s + i.energyKwh, 0),
    intervals,
  }
}

test('peak ignores sub-10-minute intervals and falls back to all intervals when none is long enough', () => {
  expect(
    sessionPeakKw([
      iv('2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', 11),
      iv('2026-09-27T21:00:00Z', '2026-09-27T21:05:00Z', 2),
    ]),
  ).toBeCloseTo(11)
  expect(sessionPeakKw([iv('2026-09-27T21:00:00Z', '2026-09-27T21:05:00Z', 0.5)])).toBeCloseTo(6)
  expect(sessionPeakKw([iv('2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 0)])).toBeNull()
  expect(sessionPeakKw([])).toBeNull()
})

test('charge at plug-in, taper inside the last hour, then idle until plug-out', () => {
  const s = toTimelineSession(
    base([
      iv('2026-09-27T19:30:00Z', '2026-09-27T20:00:00Z', 5.5),
      iv('2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', 11),
      iv('2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 5.5), // half an hour at 11 kW
      iv('2026-09-27T22:00:00Z', '2026-09-28T05:00:00Z', 0),
    ]),
  )
  expect(kinds(s)).toEqual([
    ['charging', '19:30', '21:30'],
    ['idle', '21:30', '05:00'],
  ])
  expect(s.chargingHours).toBeCloseTo(2)
  expect(s.hourly).toBe(true)
})

test('scheduled charging: idle first, then charging on the hour', () => {
  const s = toTimelineSession(
    base([
      iv('2026-09-27T19:30:00Z', '2026-09-27T23:00:00Z', 0),
      iv('2026-09-27T23:00:00Z', '2026-09-28T00:00:00Z', 11),
      iv('2026-09-28T00:00:00Z', '2026-09-28T01:00:00Z', 11),
      iv('2026-09-28T01:00:00Z', '2026-09-28T05:00:00Z', 0),
    ]),
  )
  expect(kinds(s)).toEqual([
    ['idle', '19:30', '23:00'],
    ['charging', '23:00', '01:00'],
    ['idle', '01:00', '05:00'],
  ])
})

test('gaps and intervals outside the window are idle and clipped; segments cover the window exactly', () => {
  const s = toTimelineSession(
    base(
      [
        iv('2026-09-27T19:00:00Z', '2026-09-27T20:00:00Z', 11), // starts before plug-in (clock quirk)
        iv('2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 11), // gap 20–21 before it
      ],
      '2026-09-27T19:30:00Z',
      '2026-09-27T23:00:00Z',
    ),
  )
  expect(s.segments[0].startAt).toEqual(d('2026-09-27T19:30:00Z'))
  expect(s.segments.at(-1)?.endAt).toEqual(d('2026-09-27T23:00:00Z'))
  for (let i = 1; i < s.segments.length; i++)
    expect(s.segments[i].startAt).toEqual(s.segments[i - 1].endAt)
  expect(kinds(s)).toEqual([
    ['charging', '19:30', '20:00'],
    ['idle', '20:00', '21:00'],
    ['charging', '21:00', '22:00'],
    ['idle', '22:00', '23:00'],
  ])
})

test('all-zero intervals on a counted session are idle throughout, never NaN', () => {
  const s = toTimelineSession(base([iv('2026-09-27T19:30:00Z', '2026-09-28T05:00:00Z', 0)]))
  expect(kinds(s)).toEqual([['idle', '19:30', '05:00']])
  expect(s.chargingHours).toBe(0)
})

test('an interval-less session is one idle bar with hourly = false', () => {
  const s = toTimelineSession({ ...base([]), energyKwh: 12 })
  expect(s.hourly).toBe(false)
  expect(kinds(s)).toEqual([['idle', '19:30', '05:00']])
  expect(s.energyKwh).toBe(12)
})

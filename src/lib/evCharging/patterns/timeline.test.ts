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

const Z = '2026-09-27T'
const at = (hm: string) => d(`${Z}${hm}:00Z`)
const span = (a: string, b: string, k: number) => iv(`${Z}${a}:00Z`, `${Z}${b}:00Z`, k)
const win = (intervals: PatternSession['intervals'], a: string, b: string) =>
  base(intervals, `${Z}${a}:00Z`, `${Z}${b}:00Z`)

test('idle boundary: exactly 0.05 kWh is charging, just below is idle', () => {
  const on = toTimelineSession(win([span('20:00', '21:00', 0.05)], '20:00', '21:00'))
  expect(kinds(on)).toEqual([['charging', '20:00', '21:00']])
  expect(on.chargingHours).toBe(1)
  const off = toTimelineSession(win([span('20:00', '21:00', 0.049)], '20:00', '21:00'))
  expect(kinds(off)).toEqual([['idle', '20:00', '21:00']])
  expect(off.chargingHours).toBe(0)

  const nextTo = toTimelineSession(
    win([span('20:00', '21:00', 11), span('21:00', '22:00', 0.05)], '20:00', '22:00'),
  )
  expect(nextTo.chargingHours).toBeCloseTo(1 + 0.05 / 11, 6)
  const nextToLow = toTimelineSession(
    win([span('20:00', '21:00', 11), span('21:00', '22:00', 0.049)], '20:00', '22:00'),
  )
  expect(nextToLow.chargingHours).toBe(1)
})

test('0.95 threshold: a near-full hour is all charging, below it tapers', () => {
  for (const k of [10.45, 10.46]) {
    const s = toTimelineSession(
      win([span('20:00', '21:00', 11), span('21:00', '22:00', k)], '20:00', '22:00'),
    )
    expect(kinds(s)).toEqual([['charging', '20:00', '22:00']])
    expect(s.chargingHours).toBe(2)
  }
  const s = toTimelineSession(
    win([span('20:00', '21:00', 11), span('21:00', '22:00', 10.44)], '20:00', '22:00'),
  )
  expect(s.segments.map((g) => g.kind)).toEqual(['charging', 'idle'])
  expect(s.segments[0].endAt.getTime()).toBe(Date.parse(`${Z}21:00:00Z`) + 3416727)
  expect(s.chargingHours).toBeCloseTo(1 + 10.44 / 11, 6)
})

test('a sub-10-minute-only session still shows its charging', () => {
  const s = toTimelineSession(win([span('21:00', '21:05', 0.5)], '21:00', '21:05'))
  expect(kinds(s)).toEqual([['charging', '21:00', '21:05']])
  expect(s.chargingHours).toBeCloseTo(5 / 60, 6)
})

test('sessionPeakKw guards degenerate intervals', () => {
  expect(sessionPeakKw([span('21:00', '21:00', 3)])).toBeNull()
  expect(sessionPeakKw([span('21:00', '21:00', 3), span('20:00', '21:00', 11)])).toBeCloseTo(11)
  expect(sessionPeakKw([span('21:00', '20:00', 3)])).toBeNull()
  expect(sessionPeakKw([span('20:00', '21:00', -2)])).toBeNull()
})

test('a zero-length interval does not change the scheduled-charging segments', () => {
  const s = toTimelineSession(
    base([
      iv('2026-09-27T19:30:00Z', '2026-09-27T23:00:00Z', 0),
      iv('2026-09-27T21:00:00Z', '2026-09-27T21:00:00Z', 3),
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

test('unsorted intervals give the same segments as sorted ones', () => {
  const s = toTimelineSession(
    base([
      iv('2026-09-28T01:00:00Z', '2026-09-28T05:00:00Z', 0),
      iv('2026-09-28T00:00:00Z', '2026-09-28T01:00:00Z', 11),
      iv('2026-09-27T23:00:00Z', '2026-09-28T00:00:00Z', 11),
      iv('2026-09-27T19:30:00Z', '2026-09-27T23:00:00Z', 0),
    ]),
  )
  expect(kinds(s)).toEqual([
    ['idle', '19:30', '23:00'],
    ['charging', '23:00', '01:00'],
    ['idle', '01:00', '05:00'],
  ])
})

test('overlapping intervals stay contiguous and keep recorded charging visible', () => {
  const full = toTimelineSession(
    win([span('20:00', '21:00', 11), span('20:30', '21:30', 11)], '20:00', '22:00'),
  )
  expect(kinds(full)).toEqual([
    ['charging', '20:00', '21:30'],
    ['idle', '21:30', '22:00'],
  ])
  expect(full.chargingHours).toBe(1.5)
  const taper = toTimelineSession(
    win([span('20:00', '21:00', 11), span('20:30', '21:30', 5.5)], '20:00', '22:00'),
  )
  expect(kinds(taper)).toEqual([
    ['charging', '20:00', '21:30'],
    ['idle', '21:30', '22:00'],
  ])
  expect(taper.chargingHours).toBe(1.5)
  for (const s of [full, taper])
    for (let i = 1; i < s.segments.length; i++)
      expect(s.segments[i].startAt).toEqual(s.segments[i - 1].endAt)
})

test('a tapered interval starting before plug-in charges from plug-in', () => {
  const s = toTimelineSession(
    win([span('19:00', '20:00', 5.5), span('20:00', '21:00', 11)], '19:30', '20:00'),
  )
  expect(kinds(s)).toEqual([['charging', '19:30', '20:00']])
})

test('leading gap, end clip and fully-outside intervals', () => {
  const lead = toTimelineSession(win([span('20:00', '21:00', 11)], '19:30', '22:00'))
  expect(kinds(lead)).toEqual([
    ['idle', '19:30', '20:00'],
    ['charging', '20:00', '21:00'],
    ['idle', '21:00', '22:00'],
  ])
  const clip = toTimelineSession(
    win([span('20:00', '21:00', 11), span('21:00', '22:00', 11)], '20:00', '21:30'),
  )
  expect(kinds(clip)).toEqual([['charging', '20:00', '21:30']])
  expect(clip.chargingHours).toBe(1.5)
  expect(clip.segments.at(-1)?.endAt).toEqual(at('21:30'))

  const outside = toTimelineSession(
    base(
      [
        span('17:00', '18:00', 11),
        iv('2026-09-28T06:00:00Z', '2026-09-28T07:00:00Z', 11),
        span('20:00', '21:00', 0),
      ],
      '2026-09-27T19:30:00Z',
      '2026-09-28T05:00:00Z',
    ),
  )
  expect(kinds(outside)).toEqual([['idle', '19:30', '05:00']])
  expect(outside.chargingHours).toBe(0)
})

test('zero-length and reversed windows give no segments and do not throw', () => {
  const zero = toTimelineSession(win([span('20:00', '22:00', 11)], '21:00', '21:00'))
  expect(zero.segments).toEqual([])
  expect(zero.chargingHours).toBe(0)
  const reversed = toTimelineSession(win([span('20:00', '22:00', 11)], '21:00', '20:00'))
  expect(reversed.segments).toEqual([])
  const bare = toTimelineSession(win([], '21:00', '21:00'))
  expect(bare.segments).toEqual([])
  expect(bare.hourly).toBe(false)
})

test('a long zero interval does not hide a short energetic one', () => {
  const ivs = [span('20:00', '21:00', 0), span('21:00', '21:05', 0.5)]
  const s = toTimelineSession(win(ivs, '20:00', '21:05'))
  expect(kinds(s)).toEqual([
    ['idle', '20:00', '21:00'],
    ['charging', '21:00', '21:05'],
  ])
  expect(s.chargingHours).toBeCloseTo(5 / 60, 6)
  expect(sessionPeakKw(ivs)).toBeCloseTo(6)
})

test('the peak duration boundary is inclusive at exactly 10 minutes', () => {
  const t0 = at('20:00').getTime()
  const at599 = { startAt: d(`${Z}20:00:00Z`), endAt: new Date(t0 + 599_999), energyKwh: 5 }
  const at600 = { startAt: d(`${Z}20:00:00Z`), endAt: new Date(t0 + 600_000), energyKwh: 5 }
  expect(sessionPeakKw([at599, span('21:00', '22:00', 11)])).toBeCloseTo(11)
  expect(sessionPeakKw([at600, span('21:00', '22:00', 11)])).toBeCloseTo(30)
})

import { expect, test } from 'vitest'
import { buildPatterns } from './patterns'
import type { PatternSession } from './types'

const d = (iso: string) => new Date(iso)
let n = 0
function session(
  startIso: string,
  endIso: string,
  intervals: [string, string, number][],
  energyKwh = intervals.reduce((s, [, , k]) => s + k, 0),
): PatternSession {
  n += 1
  return {
    id: `s${n}`,
    startAt: d(startIso),
    endAt: d(endIso),
    energyKwh,
    intervals: intervals.map(([a, b, k]) => ({ startAt: d(a), endAt: d(b), energyKwh: k })),
  }
}

test('returns full zero grids for no sessions', () => {
  const p = buildPatterns([], 2026)
  expect(p.weekdayHour).toHaveLength(7)
  expect(p.weekdayHour.every((row) => row.length === 24)).toBe(true)
  expect(p.hourOfDay).toHaveLength(24)
  expect(p.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  expect(p.daily).toEqual([])
  expect(p.unhourlySessions).toBe(0)
})

test('kWh lands in the Stockholm weekday × hour of each interval; idle hours count as plugged', () => {
  // Sun 2026-09-27 21:30–00:00 CEST plugged; charges 21:30–23:00, idle 23:00–00:00.
  const s = session('2026-09-27T19:30:00Z', '2026-09-27T22:00:00Z', [
    ['2026-09-27T19:30:00Z', '2026-09-27T20:00:00Z', 5.5],
    ['2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', 11],
    ['2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 0],
  ])
  const p = buildPatterns([s], 2026)
  const sun = p.weekdayHour[6]
  expect(sun[21]).toEqual({ kwh: 5.5, pluggedHours: 0.5 })
  expect(sun[22]).toEqual({ kwh: 11, pluggedHours: 1 })
  expect(sun[23]).toEqual({ kwh: 0, pluggedHours: 1 })
  expect(p.hourOfDay[22]).toEqual({ kwh: 11, pluggedHours: 1 })
})

test('an interval that is not hour-aligned is split pro rata across the hours it spans', () => {
  // Offline-session quirk: one 2 h interval 21:30–23:30 CEST with 10 kWh.
  const s = session('2026-09-27T19:30:00Z', '2026-09-27T21:30:00Z', [
    ['2026-09-27T19:30:00Z', '2026-09-27T21:30:00Z', 10],
  ])
  const sun = buildPatterns([s], 2026).weekdayHour[6]
  expect(sun[21].kwh).toBeCloseTo(2.5)
  expect(sun[22].kwh).toBeCloseTo(5)
  expect(sun[23].kwh).toBeCloseTo(2.5)
})

test('an overnight session splits daily kWh by interval start day and counts once, on its start day', () => {
  const s = session('2026-09-27T20:00:00Z', '2026-09-28T00:00:00Z', [
    ['2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', 11], // 22–23 on the 27th
    ['2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 11], // 23–00 on the 27th
    ['2026-09-27T22:00:00Z', '2026-09-27T23:00:00Z', 7], // 00–01 on the 28th
    ['2026-09-27T23:00:00Z', '2026-09-28T00:00:00Z', 0],
  ])
  const p = buildPatterns([s], 2026)
  expect(p.daily).toEqual([
    { day: '2026-09-27', kwh: 22, sessions: 1 },
    { day: '2026-09-28', kwh: 7, sessions: 0 },
  ])
  expect(p.months[8]).toEqual({ month: 9, kwh: 29, sessions: 1 })
})

test('fall-back night: plugged hours are neither lost nor doubled', () => {
  // Plugged 2026-10-24T22:00Z–2026-10-25T03:00Z = 5 real hours (00–04 local with 02 twice).
  const s = session('2026-10-24T22:00:00Z', '2026-10-25T03:00:00Z', [
    ['2026-10-24T22:00:00Z', '2026-10-25T03:00:00Z', 20],
  ])
  const p = buildPatterns([s], 2026)
  const total = p.hourOfDay.reduce((h, slot) => h + slot.pluggedHours, 0)
  expect(total).toBeCloseTo(5)
  expect(p.hourOfDay[2].pluggedHours).toBeCloseTo(2) // both 02 hours
  expect(p.hourOfDay.reduce((k, slot) => k + slot.kwh, 0)).toBeCloseTo(20)
  expect(p.hourOfDay[2].kwh).toBeCloseTo(8)
  expect(p.weekdayHour[6][2].kwh).toBeCloseTo(8)
  expect(p.weekdayHour[6][2].pluggedHours).toBeCloseTo(2)
  expect(p.weekdayHour[6][0].kwh).toBeCloseTo(4)
})

test('an interval-less session counts plugged hours and daily kWh but no hourly kWh', () => {
  const s = session('2026-09-27T19:00:00Z', '2026-09-27T21:00:00Z', [], 12)
  const p = buildPatterns([s], 2026)
  expect(p.unhourlySessions).toBe(1)
  expect(p.hourOfDay.reduce((k, slot) => k + slot.kwh, 0)).toBe(0)
  expect(p.hourOfDay[21].pluggedHours).toBe(1)
  expect(p.hourOfDay[22].pluggedHours).toBe(1)
  expect(p.daily).toEqual([{ day: '2026-09-27', kwh: 12, sessions: 1 }])
})

test('New Year: January hours of a 31 Dec session belong to the new year, its count to the old', () => {
  // Plugged 31 Dec 22:00 CET → 1 Jan 02:00 CET.
  const s = session('2025-12-31T21:00:00Z', '2026-01-01T01:00:00Z', [
    ['2025-12-31T21:00:00Z', '2025-12-31T22:00:00Z', 11],
    ['2025-12-31T22:00:00Z', '2025-12-31T23:00:00Z', 11],
    ['2025-12-31T23:00:00Z', '2026-01-01T00:00:00Z', 11],
    ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 0],
  ])
  const old = buildPatterns([s], 2025)
  const next = buildPatterns([s], 2026)
  expect(old.months[11]).toEqual({ month: 12, kwh: 22, sessions: 1 })
  expect(next.months[0]).toEqual({ month: 1, kwh: 11, sessions: 0 })
  expect(next.hourOfDay[1].pluggedHours).toBe(1)
  expect(next.hourOfDay[0].kwh).toBe(11)
  expect(old.hourOfDay[0].kwh).toBe(0)
  expect(next.daily).toEqual([{ day: '2026-01-01', kwh: 11, sessions: 0 }])
  expect(old.daily).toEqual([{ day: '2025-12-31', kwh: 22, sessions: 1 }])
  expect(old.hourOfDay[0].pluggedHours).toBe(0)
  expect(old.hourOfDay[23].pluggedHours).toBe(1)
  expect(next.months[11].sessions).toBe(0)
})

const hourTotals = (p: ReturnType<typeof buildPatterns>) => p.hourOfDay.map((s) => s.kwh)

test('an interval-less session outside the year counts nowhere', () => {
  const p = buildPatterns([session('2025-06-10T10:00:00Z', '2025-06-10T12:00:00Z', [], 9)], 2026)
  expect(p.unhourlySessions).toBe(0)
  expect(p.daily).toEqual([])
  expect(p.months.every((m) => m.kwh === 0 && m.sessions === 0)).toBe(true)
  expect(p.hourOfDay.every((s) => s.kwh === 0 && s.pluggedHours === 0)).toBe(true)
})

test('an interval-less session straddling New Year: hours follow the year, count and kWh the start', () => {
  const s = session('2025-12-31T22:00:00Z', '2026-01-01T01:00:00Z', [], 6)
  const next = buildPatterns([s], 2026)
  expect(next.unhourlySessions).toBe(0)
  expect(next.daily).toEqual([])
  expect(next.hourOfDay[0].pluggedHours).toBe(1)
  expect(next.hourOfDay[1].pluggedHours).toBe(1)
  expect(next.hourOfDay[23].pluggedHours).toBe(0)
  const old = buildPatterns([s], 2025)
  expect(old.unhourlySessions).toBe(1)
  expect(old.daily).toEqual([{ day: '2025-12-31', kwh: 6, sessions: 1 }])
  expect(old.hourOfDay[23].pluggedHours).toBe(1)
  expect(old.hourOfDay[0].pluggedHours).toBe(0)
})

test('a day with a session start but 0 kWh stays in daily; a 0 kWh interval on the next day does not', () => {
  const a = buildPatterns(
    [
      session('2026-09-27T10:00:00Z', '2026-09-27T12:00:00Z', [
        ['2026-09-27T10:00:00Z', '2026-09-27T11:00:00Z', 0],
        ['2026-09-27T11:00:00Z', '2026-09-27T12:00:00Z', 0],
      ]),
    ],
    2026,
  )
  expect(a.daily).toEqual([{ day: '2026-09-27', kwh: 0, sessions: 1 }])
  const b = buildPatterns(
    [
      session('2026-09-27T21:00:00Z', '2026-09-27T23:00:00Z', [
        ['2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 0],
        ['2026-09-27T22:00:00Z', '2026-09-27T23:00:00Z', 0],
      ]),
    ],
    2026,
  )
  expect(b.daily).toEqual([{ day: '2026-09-27', kwh: 0, sessions: 1 }])
})

test('spring-forward night: the missing 02 hour stays empty, five real hours are plugged', () => {
  const s = session('2026-03-28T22:00:00Z', '2026-03-29T03:00:00Z', [
    ['2026-03-28T22:00:00Z', '2026-03-29T03:00:00Z', 10],
  ])
  const p = buildPatterns([s], 2026)
  expect(p.hourOfDay[2]).toEqual({ kwh: 0, pluggedHours: 0 })
  for (const [w, h] of [
    [5, 23],
    [6, 0],
    [6, 1],
    [6, 3],
    [6, 4],
  ]) {
    expect(p.weekdayHour[w][h].kwh).toBeCloseTo(2)
    expect(p.weekdayHour[w][h].pluggedHours).toBeCloseTo(1)
  }
  expect(p.hourOfDay.reduce((h, slot) => h + slot.pluggedHours, 0)).toBeCloseTo(5)
})

test('pins current behaviour: zero-length/inverted intervals add no hourly kWh and no NaN (daily keeps kWh; DB CHECK end_at > start_at rules them out)', () => {
  const s = session('2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', [
    ['2026-09-27T20:00:00Z', '2026-09-27T20:00:00Z', 3],
    ['2026-09-27T20:30:00Z', '2026-09-27T20:10:00Z', 2],
  ])
  const p = buildPatterns([s], 2026)
  expect(hourTotals(p).every((k) => Number.isFinite(k) && k === 0)).toBe(true)
  expect(p.hourOfDay[22].pluggedHours).toBe(1)
  expect(p.daily).toEqual([{ day: '2026-09-27', kwh: 5, sessions: 1 }])
})

test('a non-aligned interval across Stockholm midnight: daily by start day, hours pro rata', () => {
  const s = session('2026-09-27T21:30:00Z', '2026-09-27T22:30:00Z', [
    ['2026-09-27T21:30:00Z', '2026-09-27T22:30:00Z', 10],
  ])
  const p = buildPatterns([s], 2026)
  expect(p.daily).toEqual([{ day: '2026-09-27', kwh: 10, sessions: 1 }])
  expect(p.weekdayHour[6][23].kwh).toBeCloseTo(5)
  expect(p.weekdayHour[6][23].pluggedHours).toBeCloseTo(0.5)
  expect(p.weekdayHour[0][0].kwh).toBeCloseTo(5)
  expect(p.weekdayHour[0][0].pluggedHours).toBeCloseTo(0.5)
})

test('contributions accumulate across sessions; daily is sorted; hourOfDay equals weekdayHour column sums', () => {
  const a = session('2026-09-28T18:00:00Z', '2026-09-28T19:00:00Z', [
    ['2026-09-28T18:00:00Z', '2026-09-28T19:00:00Z', 4],
  ])
  const b = session('2026-09-21T18:00:00Z', '2026-09-21T19:00:00Z', [
    ['2026-09-21T18:00:00Z', '2026-09-21T19:00:00Z', 6],
  ])
  const c = session('2026-09-28T19:00:00Z', '2026-09-28T20:00:00Z', [
    ['2026-09-28T19:00:00Z', '2026-09-28T20:00:00Z', 1],
  ])
  const p = buildPatterns([a, b, c], 2026)
  expect(p.weekdayHour[0][20]).toEqual({ kwh: 10, pluggedHours: 2 })
  expect(p.daily).toEqual([
    { day: '2026-09-21', kwh: 6, sessions: 1 },
    { day: '2026-09-28', kwh: 5, sessions: 2 },
  ])
  expect(p.months[8]).toEqual({ month: 9, kwh: 11, sessions: 3 })
  for (let h = 0; h < 24; h++) {
    expect(p.hourOfDay[h].kwh).toBeCloseTo(p.weekdayHour.reduce((k, row) => k + row[h].kwh, 0))
    expect(p.hourOfDay[h].pluggedHours).toBeCloseTo(
      p.weekdayHour.reduce((k, row) => k + row[h].pluggedHours, 0),
    )
  }
})

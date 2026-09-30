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
})

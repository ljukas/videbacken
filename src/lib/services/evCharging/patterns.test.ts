import { expect, test } from 'vitest'
import { insertInterval, insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { getOverview } from './overview'
import { getChargingPatterns, getChargingTimeline } from './patterns'

setupDatabase()

const H = 3_600_000
async function overnight(startIso: string, kwhPerHour: number[], idleHoursAfter = 0) {
  const start = new Date(startIso)
  const end = new Date(start.getTime() + (kwhPerHour.length + idleHoursAfter) * H)
  const id = await insertSession({
    startAt: start,
    endAt: end,
    energyKwh: kwhPerHour.reduce((a, b) => a + b, 0),
  })
  for (const [i, kwh] of kwhPerHour.entries()) {
    await insertInterval(
      id,
      new Date(start.getTime() + i * H),
      new Date(start.getTime() + (i + 1) * H),
      kwh,
    )
  }
  if (idleHoursAfter > 0) {
    const a = start.getTime() + kwhPerHour.length * H
    await insertInterval(id, new Date(a), new Date(a + idleHoursAfter * H), 0)
  }
  return id
}

test('an empty database gives zero grids, 12 zero months and the current year', async () => {
  const p = await getChargingPatterns({ now: new Date('2026-06-15T12:00:00Z') })
  expect(p.year).toBe(2026)
  expect(p.years).toEqual([2026])
  expect(p.hourOfDay.every((s) => s.kwh === 0 && s.pluggedHours === 0)).toBe(true)
  expect(p.months.every((m) => m.kwh === 0 && m.sessions === 0)).toBe(true)
})

test('noise, voided and replaced sessions are excluded', async () => {
  await insertSession({ energyKwh: 0.49 })
  await insertSession({ energyKwh: 5, voided: true })
  await insertSession({ energyKwh: 5, replacedByZaptecSessionId: 'zap-x' })
  const p = await getChargingPatterns({ year: 2026 })
  expect(p.months[0].sessions).toBe(0)
  expect(p.unhourlySessions).toBe(0)
})

test('calendar months equal the overview months for the same data (the two pages never disagree)', async () => {
  await overnight('2026-01-31T20:00:00Z', [11, 11, 6], 3) // spans Jan → Feb in Stockholm
  await overnight('2026-03-28T22:00:00Z', [11, 4], 5) // spans the spring-forward night
  await insertSession({
    startAt: new Date('2026-05-02T10:00:00Z'),
    endAt: new Date('2026-05-02T12:00:00Z'),
    energyKwh: 7,
  }) // no intervals
  const [p, o] = await Promise.all([
    getChargingPatterns({ year: 2026 }),
    getOverview({ year: 2026 }),
  ])
  for (const [i, m] of p.months.entries()) {
    expect(m.kwh).toBeCloseTo(o.months[i].kwh, 9)
    expect(m.sessions).toBe(o.months[i].sessions)
  }
  expect(p.unhourlySessions).toBe(1)
})

test('a session plugged in on 31 Dec shows its January hours in the new year and adds it to years', async () => {
  await overnight('2026-12-31T21:00:00Z', [11, 11, 11], 1) // 22:00 CET → 02:00 CET
  const next = await getChargingPatterns({ year: 2027, now: new Date('2027-01-02T12:00:00Z') })
  expect(next.years).toEqual([2027, 2026])
  expect(next.months[0]).toEqual({ month: 1, kwh: 11, sessions: 0 })
  expect(next.hourOfDay[1].pluggedHours).toBe(1)
})

test('timeline: rows are the month’s sessions by plug-in, oldest first, with months to step through', async () => {
  await overnight('2026-08-31T19:00:00Z', [11], 2) // 31 Aug 21:00 CEST: an August plug-in, not in September's rows
  await overnight('2026-09-05T18:00:00Z', [11, 5.5], 8)
  await overnight('2026-09-01T17:00:00Z', [11], 10)
  const t = await getChargingTimeline({ year: 2026, month: 9 })
  expect(t.months).toEqual([8, 9])
  expect(t.sessions.map((s) => s.startAt.toISOString())).toEqual([
    '2026-09-01T17:00:00.000Z',
    '2026-09-05T18:00:00.000Z',
  ])
  expect(t.sessions[1].segments.map((g) => g.kind)).toEqual(['charging', 'idle'])
})

test('timeline defaults to the latest month with sessions, else the current month', async () => {
  await overnight('2026-07-10T18:00:00Z', [11], 1)
  expect(
    (await getChargingTimeline({ year: 2026, now: new Date('2026-09-30T12:00:00Z') })).month,
  ).toBe(7)
  expect(
    (await getChargingTimeline({ year: 2025, now: new Date('2026-09-30T12:00:00Z') })).month,
  ).toBe(9)
})

test('timeline for a month without sessions is empty, not an error', async () => {
  await overnight('2026-07-10T18:00:00Z', [11], 1)
  const t = await getChargingTimeline({ year: 2026, month: 12 })
  expect(t.sessions).toEqual([])
  expect(t.months).toEqual([7])
})

test('timings are recorded', async () => {
  const timings = {}
  await getChargingPatterns({ year: 2026, timings })
  expect(timings).toEqual({ fetchMs: expect.any(Number), aggregateMs: expect.any(Number) })
})

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

test('noise, voided and replaced sessions are excluded; a counted session is the positive control', async () => {
  await overnight('2026-05-05T18:00:00Z', [11])
  for (const extra of [{ voided: true }, { replacedByZaptecSessionId: 'zap-x' }]) {
    const id = await insertSession({
      startAt: new Date('2026-05-06T18:00:00Z'),
      endAt: new Date('2026-05-06T19:00:00Z'),
      energyKwh: 9,
      ...extra,
    })
    await insertInterval(id, new Date('2026-05-06T18:00:00Z'), new Date('2026-05-06T19:00:00Z'), 9)
  }
  const noise = await insertSession({
    startAt: new Date('2026-05-07T18:00:00Z'),
    endAt: new Date('2026-05-07T19:00:00Z'),
    energyKwh: 0.49,
  })
  await insertInterval(
    noise,
    new Date('2026-05-07T18:00:00Z'),
    new Date('2026-05-07T19:00:00Z'),
    0.49,
  )
  const p = await getChargingPatterns({ year: 2026 })
  expect(p.months[4]).toEqual({ month: 5, kwh: 11, sessions: 1 })
  expect(p.hourOfDay[20]).toEqual({ kwh: 11, pluggedHours: 1 })
  expect(p.daily).toEqual([{ day: '2026-05-05', kwh: 11, sessions: 1 }])
  expect(p.unhourlySessions).toBe(0)
})

test('calendar months equal the overview months for the same data (the two pages never disagree)', async () => {
  await overnight('2026-01-31T22:00:00Z', [11, 11, 6], 3) // Jan 11 kWh / 1 session; Feb 17 kWh / 0
  await overnight('2026-03-28T22:00:00Z', [11, 4], 5) // spans the spring-forward night
  await insertSession({
    startAt: new Date('2026-05-02T10:00:00Z'),
    endAt: new Date('2026-05-02T12:00:00Z'),
    energyKwh: 7,
  }) // no intervals
  const voided = await insertSession({
    startAt: new Date('2026-04-02T10:00:00Z'),
    endAt: new Date('2026-04-02T12:00:00Z'),
    energyKwh: 9,
    voided: true,
  })
  await insertInterval(
    voided,
    new Date('2026-04-02T10:00:00Z'),
    new Date('2026-04-02T11:00:00Z'),
    9,
  )
  const [p, o] = await Promise.all([
    getChargingPatterns({ year: 2026 }),
    getOverview({ year: 2026 }),
  ])
  for (const [i, m] of p.months.entries()) {
    expect(m.kwh).toBeCloseTo(o.months[i].kwh, 9)
    expect(m.sessions).toBe(o.months[i].sessions)
  }
  expect(p.months[0]).toEqual({ month: 1, kwh: 11, sessions: 1 })
  expect(p.months[1]).toEqual({ month: 2, kwh: 17, sessions: 0 })
  expect(p.unhourlySessions).toBe(1)
})

test('a 31 Dec plug-in: years come from the data, hours split across the year boundary', async () => {
  await overnight('2026-12-31T21:00:00Z', [11, 11, 11], 1) // 22:00 CET → 02:00 CET
  const now = new Date('2026-06-15T12:00:00Z')
  const old = await getChargingPatterns({ year: 2026, now })
  expect(old.years).toEqual([2027, 2026])
  expect(old.months[11]).toEqual({ month: 12, kwh: 22, sessions: 1 })
  expect(old.hourOfDay[22]).toEqual({ kwh: 11, pluggedHours: 1 })
  expect(old.hourOfDay[23]).toEqual({ kwh: 11, pluggedHours: 1 })
  expect(old.hourOfDay[0].pluggedHours).toBe(0)
  expect(old.hourOfDay[1].pluggedHours).toBe(0)

  const next = await getChargingPatterns({ year: 2027, now })
  expect(next.hourOfDay[0]).toEqual({ kwh: 11, pluggedHours: 1 })
  expect(next.hourOfDay[1]).toEqual({ kwh: 0, pluggedHours: 1 })
  expect(next.hourOfDay[22].pluggedHours).toBe(0)
  expect(next.months[0]).toEqual({ month: 1, kwh: 11, sessions: 0 })
  expect(next.daily).toEqual([{ day: '2027-01-01', kwh: 11, sessions: 0 }])

  expect((await getChargingTimeline({ year: 2026, month: 12, now })).sessions).toHaveLength(1)
  const jan = await getChargingTimeline({
    year: 2027,
    month: 1,
    now: new Date('2027-01-02T12:00:00Z'),
  })
  expect(jan.sessions).toEqual([])
  expect(jan.months).toEqual([])
})

test('a session plugged in up to 7 days before the year still contributes its hours', async () => {
  const a = await insertSession({
    startAt: new Date('2026-12-27T12:00:00Z'),
    endAt: new Date('2027-01-01T00:00:00Z'),
    energyKwh: 2,
  })
  await insertInterval(a, new Date('2026-12-31T23:00:00Z'), new Date('2027-01-01T00:00:00Z'), 2)
  const p = await getChargingPatterns({ year: 2027, now: new Date('2027-01-02T12:00:00Z') })
  expect(p.hourOfDay[0]).toEqual({ kwh: 2, pluggedHours: 1 })
  expect(p.months[0]).toEqual({ month: 1, kwh: 2, sessions: 0 })
})

test('a session plugged in more than 7 days before the year is dropped (accepted gap)', async () => {
  const a = await insertSession({
    startAt: new Date('2026-12-27T12:00:00Z'),
    endAt: new Date('2027-01-01T00:00:00Z'),
    energyKwh: 2,
  })
  await insertInterval(a, new Date('2026-12-31T23:00:00Z'), new Date('2027-01-01T00:00:00Z'), 2)
  const b = await insertSession({
    startAt: new Date('2026-12-19T12:00:00Z'),
    endAt: new Date('2027-01-01T02:00:00Z'),
    energyKwh: 4,
  })
  await insertInterval(b, new Date('2027-01-01T00:00:00Z'), new Date('2027-01-01T01:00:00Z'), 4)
  const p = await getChargingPatterns({ year: 2027, now: new Date('2027-01-02T12:00:00Z') })
  expect(p.months[0].kwh).toBe(2)
  expect(p.hourOfDay[1].pluggedHours).toBe(0)
})

test('a session ending exactly at the year start contributes nothing to the new year', async () => {
  await overnight('2026-12-31T21:00:00Z', [11, 11]) // ends 2026-12-31T23:00Z = 00:00 CET
  const p = await getChargingPatterns({ year: 2027, now: new Date('2027-01-02T12:00:00Z') })
  expect(p.months[0]).toEqual({ month: 1, kwh: 0, sessions: 0 })
  expect(p.hourOfDay.every((s) => s.pluggedHours === 0)).toBe(true)
})

test('years are newest first and include every year with data plus the current one', async () => {
  await overnight('2024-03-10T10:00:00Z', [5])
  await overnight('2025-03-10T10:00:00Z', [5])
  const p = await getChargingPatterns({ now: new Date('2026-06-15T12:00:00Z') })
  expect(p.years).toEqual([2026, 2025, 2024])
})

test('timeline: rows are the month’s sessions by plug-in, oldest first, with months to step through', async () => {
  await overnight('2026-08-31T20:00:00Z', [11], 4) // 22:00 CEST 31 Aug: overlaps September, but an August plug-in
  await overnight('2026-08-31T22:00:00Z', [11], 1) // exactly 00:00 CEST 1 Sep: a September row
  await overnight('2026-09-05T18:00:00Z', [11, 5.5], 8)
  await overnight('2026-09-01T17:00:00Z', [11], 10)
  const t = await getChargingTimeline({ year: 2026, month: 9 })
  expect(t.months).toEqual([8, 9])
  expect(t.sessions.map((s) => s.startAt.toISOString())).toEqual([
    '2026-08-31T22:00:00.000Z',
    '2026-09-01T17:00:00.000Z',
    '2026-09-05T18:00:00.000Z',
  ])
  expect(t.sessions[2].segments.map((g) => g.kind)).toEqual(['charging', 'idle'])
})

test('timeline excludes voided, noise and replaced sessions from rows and months', async () => {
  await overnight('2026-09-05T18:00:00Z', [11])
  await insertSession({
    startAt: new Date('2026-09-06T18:00:00Z'),
    endAt: new Date('2026-09-06T20:00:00Z'),
    energyKwh: 5,
    voided: true,
  })
  await insertSession({
    startAt: new Date('2026-10-06T18:00:00Z'),
    endAt: new Date('2026-10-06T20:00:00Z'),
    energyKwh: 0.49,
  })
  await insertSession({
    startAt: new Date('2026-11-06T18:00:00Z'),
    endAt: new Date('2026-11-06T20:00:00Z'),
    energyKwh: 5,
    replacedByZaptecSessionId: 'zap-x',
  })
  const t = await getChargingTimeline({ year: 2026, month: 9 })
  expect(t.months).toEqual([9])
  expect(t.sessions.map((s) => s.startAt.toISOString())).toEqual(['2026-09-05T18:00:00.000Z'])
  expect((await getChargingTimeline({ year: 2026 })).month).toBe(9)
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

test('timeline for a year with no data at all is empty', async () => {
  const t = await getChargingTimeline({ year: 2019, month: 3 })
  expect(t.sessions).toEqual([])
  expect(t.months).toEqual([])
})

test('timings are recorded', async () => {
  const timings = {}
  await getChargingPatterns({ year: 2026, timings })
  expect(timings).toEqual({ fetchMs: expect.any(Number), aggregateMs: expect.any(Number) })
})

test('timeline timings are recorded', async () => {
  await overnight('2026-09-05T18:00:00Z', [11])
  const timings = {}
  await getChargingTimeline({ year: 2026, month: 9, timings })
  expect(timings).toEqual({ fetchMs: expect.any(Number), aggregateMs: expect.any(Number) })
})

test('patterns and timeline follow the vehicle scope', async () => {
  await overnight('2026-03-10T20:00:00Z', [2, 2])
  const guest = await insertSession({
    startAt: new Date('2026-04-10T20:00:00Z'),
    endAt: new Date('2026-04-10T22:00:00Z'),
    energyKwh: 3,
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const now = new Date('2026-06-15T12:00:00Z')
  const sumKwh = (p: Awaited<ReturnType<typeof getChargingPatterns>>) =>
    p.months.reduce((a, m) => a + m.kwh, 0)
  expect(sumKwh(await getChargingPatterns({ year: 2026, now, vehicle: 'ours' }))).toBeCloseTo(4)
  expect(sumKwh(await getChargingPatterns({ year: 2026, now, vehicle: 'other' }))).toBeCloseTo(3)
  expect(sumKwh(await getChargingPatterns({ year: 2026, now }))).toBeCloseTo(7)

  const theirs = await getChargingTimeline({ year: 2026, now, vehicle: 'other' })
  expect(theirs.months).toEqual([4])
  expect(theirs.sessions.map((s) => s.id)).toEqual([guest])
  const mine = await getChargingTimeline({ year: 2026, now, vehicle: 'ours' })
  expect(mine.months).toEqual([3])
  expect(mine.sessions).toHaveLength(1)
  expect((await getChargingTimeline({ year: 2026, now })).months).toEqual([3, 4])
})

test('patterns years stay unscoped', async () => {
  await insertSession({
    startAt: new Date('2025-05-01T10:00:00Z'),
    endAt: new Date('2025-05-01T11:00:00Z'),
  })
  const now = new Date('2026-06-15T12:00:00Z')
  expect((await getChargingPatterns({ year: 2026, now, vehicle: 'other' })).years).toEqual([
    2026, 2025,
  ])
})

import { expect, test } from 'vitest'
import { insertCharger, insertInterval, insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { getOverview, listSessions } from './overview'

setupDatabase()

test('getOverview on an empty database returns 12 zero months, the current year only, and zero tiles', async () => {
  const now = new Date('2026-06-15T12:00:00Z')
  const overview = await getOverview({ now })
  expect(overview.year).toBe(2026)
  expect(overview.years).toEqual([2026])
  expect(overview.months).toHaveLength(12)
  expect(overview.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  expect(overview.months.every((m) => m.kwh === 0 && m.sessions === 0)).toBe(true)
  expect(overview.tiles).toEqual({
    thisMonth: { kwh: 0, sessions: 0 },
    thisYear: { kwh: 0, sessions: 0 },
    allTime: { kwh: 0, sessions: 0 },
  })
})

test('a session just under the noise threshold is excluded, exactly at threshold is counted', async () => {
  const now = new Date('2026-01-15T12:00:00Z')
  await insertSession({ energyKwh: 0.49 })
  await insertSession({ energyKwh: 0.5 })
  const overview = await getOverview({ year: 2026, now })
  expect(overview.tiles.allTime).toEqual({ kwh: 0.5, sessions: 1 })
})

test('voided and replaced sessions are excluded from totals', async () => {
  const now = new Date('2026-01-15T12:00:00Z')
  await insertSession({ energyKwh: 5, voided: true })
  await insertSession({ energyKwh: 5, replacedByZaptecSessionId: 'zap-replacement' })
  await insertSession({ energyKwh: 5 })
  const overview = await getOverview({ year: 2026, now })
  expect(overview.tiles.allTime).toEqual({ kwh: 5, sessions: 1 })
})

test('an overnight session splits kWh across Jan/Feb by interval, but counts once in Jan', async () => {
  const now = new Date('2026-01-15T12:00:00Z')
  const chargerId = await insertCharger()
  const sessionId = await insertSession({
    chargerId,
    startAt: new Date('2026-01-31T21:00:00Z'), // 22:00 Stockholm (CET, winter)
    endAt: new Date('2026-02-01T01:00:00Z'), // 02:00 Stockholm
    energyKwh: 5,
  })
  await insertInterval(
    sessionId,
    new Date('2026-01-31T21:00:00Z'),
    new Date('2026-01-31T23:00:00Z'),
    2,
  )
  await insertInterval(
    sessionId,
    new Date('2026-01-31T23:00:00Z'),
    new Date('2026-02-01T01:00:00Z'),
    3,
  )

  const overview = await getOverview({ year: 2026, now })
  const jan = overview.months.find((m) => m.month === 1)
  const feb = overview.months.find((m) => m.month === 2)
  expect(jan).toEqual({ month: 1, kwh: 2, sessions: 1 })
  expect(feb).toEqual({ month: 2, kwh: 3, sessions: 0 })
})

test('DST: an interval starting 2026-03-31T22:30Z buckets into April (Stockholm, CEST)', async () => {
  const now = new Date('2026-01-01T12:00:00Z')
  const chargerId = await insertCharger()
  const startAt = new Date('2026-03-31T22:30:00Z')
  const endAt = new Date('2026-03-31T23:30:00Z')
  const sessionId = await insertSession({ chargerId, startAt, endAt, energyKwh: 1 })
  await insertInterval(sessionId, startAt, endAt, 1)

  const overview = await getOverview({ year: 2026, now })
  expect(overview.months.find((m) => m.month === 4)?.kwh).toBe(1)
  expect(overview.months.find((m) => m.month === 3)?.kwh).toBe(0)
})

test('DST: an interval starting 2026-10-31T23:30Z buckets into November (Stockholm, back to CET)', async () => {
  const now = new Date('2026-01-01T12:00:00Z')
  const chargerId = await insertCharger()
  const startAt = new Date('2026-10-31T23:30:00Z')
  const endAt = new Date('2026-11-01T00:30:00Z')
  const sessionId = await insertSession({ chargerId, startAt, endAt, energyKwh: 1 })
  await insertInterval(sessionId, startAt, endAt, 1)

  const overview = await getOverview({ year: 2026, now })
  expect(overview.months.find((m) => m.month === 11)?.kwh).toBe(1)
  expect(overview.months.find((m) => m.month === 10)?.kwh).toBe(0)
})

test('year edge: an interval starting 2026-12-31T23:30Z buckets into January 2027, and 2027 appears in years', async () => {
  const now = new Date('2026-01-01T12:00:00Z')
  const chargerId = await insertCharger()
  const startAt = new Date('2026-12-31T23:30:00Z')
  const endAt = new Date('2027-01-01T00:30:00Z')
  const sessionId = await insertSession({ chargerId, startAt, endAt, energyKwh: 1 })
  await insertInterval(sessionId, startAt, endAt, 1)

  const overview2027 = await getOverview({ year: 2027, now })
  expect(overview2027.years).toContain(2027)
  expect(overview2027.months.find((m) => m.month === 1)?.kwh).toBe(1)
})

test('thisMonth reflects the Stockholm month of `now`, independent of the selected year', async () => {
  const now = new Date('2026-09-30T22:30:00Z') // 00:30 CEST Oct 1 in Stockholm
  const chargerId = await insertCharger()
  const startAt = new Date('2026-10-01T08:00:00Z')
  const endAt = new Date('2026-10-01T09:00:00Z')
  const sessionId = await insertSession({ chargerId, startAt, endAt, energyKwh: 4 })
  await insertInterval(sessionId, startAt, endAt, 4)

  // Deliberately select an unrelated, empty year — thisMonth must still reflect `now`.
  const overview = await getOverview({ year: 2020, now })
  expect(overview.tiles.thisMonth).toEqual({ kwh: 4, sessions: 1 })
})

test('a session with no intervals falls back to its own start month for kWh', async () => {
  const now = new Date('2026-05-01T12:00:00Z')
  const chargerId = await insertCharger()
  await insertSession({
    chargerId,
    startAt: new Date('2026-05-10T10:00:00Z'),
    endAt: new Date('2026-05-10T11:00:00Z'),
    energyKwh: 7,
  })
  const overview = await getOverview({ year: 2026, now })
  expect(overview.months.find((m) => m.month === 5)).toEqual({ month: 5, kwh: 7, sessions: 1 })
})

test('a selected year with no data returns all-zero months', async () => {
  const now = new Date('2026-05-01T12:00:00Z')
  const chargerId = await insertCharger()
  await insertSession({
    chargerId,
    startAt: new Date('2026-05-10T10:00:00Z'),
    endAt: new Date('2026-05-10T11:00:00Z'),
    energyKwh: 7,
  })
  const overview = await getOverview({ year: 2019, now })
  expect(overview.months.every((m) => m.kwh === 0 && m.sessions === 0)).toBe(true)
})

test('invariant: months sum equals thisYear for the current year, and allTime is at least thisYear', async () => {
  const now = new Date('2026-06-15T12:00:00Z')
  const chargerId = await insertCharger()
  await insertSession({
    chargerId,
    startAt: new Date('2026-02-01T10:00:00Z'),
    endAt: new Date('2026-02-01T11:00:00Z'),
    energyKwh: 3,
  })
  await insertSession({
    chargerId,
    startAt: new Date('2025-02-01T10:00:00Z'),
    endAt: new Date('2025-02-01T11:00:00Z'),
    energyKwh: 9,
  })

  const overview = await getOverview({ year: 2026, now })
  const monthsSum = overview.months.reduce(
    (acc, m) => ({ kwh: acc.kwh + m.kwh, sessions: acc.sessions + m.sessions }),
    { kwh: 0, sessions: 0 },
  )
  expect(monthsSum).toEqual(overview.tiles.thisYear)
  expect(overview.tiles.allTime.kwh).toBeGreaterThanOrEqual(overview.tiles.thisYear.kwh)
  expect(overview.tiles.allTime.sessions).toBeGreaterThanOrEqual(overview.tiles.thisYear.sessions)
})

test('years outside what the overview procedure accepts are left out of years, not of all-time', async () => {
  const now = new Date('2026-06-15T12:00:00Z')
  // A charger with a broken clock, and a session that starts in Stockholm's 2019.
  await insertSession({
    startAt: new Date('1970-01-01T00:10:00Z'),
    endAt: new Date('1970-01-01T01:00:00Z'),
    reliableClock: false,
  })
  await insertSession({
    startAt: new Date('2019-12-31T22:30:00Z'),
    endAt: new Date('2020-01-01T01:00:00Z'),
  })

  const overview = await getOverview({ now })

  expect(overview.years).toEqual([2026])
  expect(overview.tiles.allTime).toEqual({ kwh: 10, sessions: 2 })
})

test('years is sorted descending and always includes the current Stockholm year', async () => {
  const now = new Date('2026-06-15T12:00:00Z')
  const chargerId = await insertCharger()
  await insertSession({
    chargerId,
    startAt: new Date('2023-02-01T10:00:00Z'),
    endAt: new Date('2023-02-01T11:00:00Z'),
    energyKwh: 3,
  })
  const overview = await getOverview({ now })
  expect(overview.years).toEqual([2026, 2023])
})

test('listSessions orders newest first, reports hasMore via limit+1, and computes peakKw', async () => {
  const chargerId = await insertCharger()

  // Oldest, no intervals → peakKw null.
  const s1 = await insertSession({
    chargerId,
    startAt: new Date('2026-01-01T08:00:00Z'),
    endAt: new Date('2026-01-01T08:05:00Z'),
    energyKwh: 0.6,
  })

  // Middle: a single 15-min interval, 0.5 kWh → 2 kW peak.
  const s2 = await insertSession({
    chargerId,
    startAt: new Date('2026-01-02T08:00:00Z'),
    endAt: new Date('2026-01-02T08:15:00Z'),
    energyKwh: 0.5,
  })
  await insertInterval(s2, new Date('2026-01-02T08:00:00Z'), new Date('2026-01-02T08:15:00Z'), 0.5)

  // Newest: two 1h intervals, 1 kWh then 3 kWh → 3 kW peak (the max, not the sum).
  const s3 = await insertSession({
    chargerId,
    startAt: new Date('2026-01-03T08:00:00Z'),
    endAt: new Date('2026-01-03T10:00:00Z'),
    energyKwh: 4,
  })
  await insertInterval(s3, new Date('2026-01-03T08:00:00Z'), new Date('2026-01-03T09:00:00Z'), 1)
  await insertInterval(s3, new Date('2026-01-03T09:00:00Z'), new Date('2026-01-03T10:00:00Z'), 3)

  const page = await listSessions({ limit: 2 })
  expect(page.hasMore).toBe(true)
  expect(page.sessions.map((s) => s.id)).toEqual([s3, s2])

  const all = await listSessions({ limit: 10 })
  expect(all.hasMore).toBe(false)
  expect(all.sessions).toHaveLength(3)
  const byId = new Map(all.sessions.map((s) => [s.id, s]))
  expect(byId.get(s3)?.peakKw).toBe(3)
  expect(byId.get(s2)?.peakKw).toBe(2)
  expect(byId.get(s1)?.peakKw).toBeNull()
})

test('listSessions excludes intervals shorter than 10 minutes from the peakKw calculation', async () => {
  const chargerId = await insertCharger()
  const sessionId = await insertSession({ chargerId, energyKwh: 2 })
  // 5-minute interval with a huge instantaneous rate — must not affect the peak.
  await insertInterval(
    sessionId,
    new Date('2026-01-01T10:00:00Z'),
    new Date('2026-01-01T10:05:00Z'),
    1,
  )
  // 30-minute interval, 0.5 kWh → 1 kW — the only interval long enough to count.
  await insertInterval(
    sessionId,
    new Date('2026-01-01T10:05:00Z'),
    new Date('2026-01-01T10:35:00Z'),
    0.5,
  )

  const { sessions } = await listSessions({ limit: 10 })
  expect(sessions).toHaveLength(1)
  expect(sessions[0].peakKw).toBe(1)
})

test('listSessions excludes voided, replaced, and noise sessions', async () => {
  const chargerId = await insertCharger()
  await insertSession({ chargerId, voided: true, energyKwh: 5 })
  await insertSession({ chargerId, replacedByZaptecSessionId: 'zap-x', energyKwh: 5 })
  await insertSession({ chargerId, energyKwh: 0.1 })
  const counted = await insertSession({ chargerId, energyKwh: 5 })

  const { sessions } = await listSessions({ limit: 10 })
  expect(sessions.map((s) => s.id)).toEqual([counted])
})

test('getOverview and listSessions follow the vehicle scope', async () => {
  const ours = await insertSession({
    startAt: new Date('2026-03-01T10:00:00Z'),
    endAt: new Date('2026-03-01T11:00:00Z'),
    energyKwh: 10,
  })
  const guest = await insertSession({
    startAt: new Date('2026-03-02T10:00:00Z'),
    endAt: new Date('2026-03-02T11:00:00Z'),
    energyKwh: 4,
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const now = new Date('2026-03-15T12:00:00Z')
  const mine = await getOverview({ year: 2026, now, vehicle: 'ours' })
  expect(mine.tiles.allTime).toEqual({ kwh: 10, sessions: 1 })
  expect(mine.tiles.thisYear).toEqual({ kwh: 10, sessions: 1 })
  expect(mine.months[2]).toEqual({ month: 3, kwh: 10, sessions: 1 })
  const theirs = await getOverview({ year: 2026, now, vehicle: 'other' })
  expect(theirs.tiles.allTime).toEqual({ kwh: 4, sessions: 1 })
  expect(theirs.months[2]).toEqual({ month: 3, kwh: 4, sessions: 1 })
  expect((await getOverview({ year: 2026, now })).tiles.allTime).toEqual({ kwh: 14, sessions: 2 })
  expect((await getOverview({ year: 2026, now, vehicle: 'all' })).tiles.allTime).toEqual({
    kwh: 14,
    sessions: 2,
  })

  const list = await listSessions({ limit: 10, vehicle: 'other' })
  expect(list.sessions.map((s) => [s.id, s.vehicle])).toEqual([[guest, 'other']])
  expect((await listSessions({ limit: 10, vehicle: 'ours' })).sessions.map((s) => s.id)).toEqual([
    ours,
  ])
  expect((await listSessions({ limit: 10 })).sessions.map((s) => s.id)).toEqual([guest, ours])
})

test('years stay unscoped: a guest-only year is listed under every scope', async () => {
  await insertSession({
    startAt: new Date('2025-05-01T10:00:00Z'),
    endAt: new Date('2025-05-01T11:00:00Z'),
  })
  await insertSession({
    startAt: new Date('2024-05-01T10:00:00Z'),
    endAt: new Date('2024-05-01T11:00:00Z'),
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const now = new Date('2026-03-15T12:00:00Z')
  for (const vehicle of ['ours', 'other', 'all'] as const)
    expect((await getOverview({ year: 2026, now, vehicle })).years).toEqual([2026, 2025, 2024])
})

test('the interval-sum queries follow the vehicle scope (intervals differ from session energy)', async () => {
  const H = 3_600_000
  const ours = await insertSession({
    startAt: new Date('2026-03-01T10:00:00Z'),
    endAt: new Date('2026-03-01T12:00:00Z'),
    energyKwh: 10,
  })
  await insertInterval(
    ours,
    new Date('2026-03-01T10:00:00Z'),
    new Date(Date.parse('2026-03-01T10:00:00Z') + H),
    3,
  )
  await insertInterval(
    ours,
    new Date('2026-03-01T11:00:00Z'),
    new Date(Date.parse('2026-03-01T11:00:00Z') + H),
    4,
  )
  const guest = await insertSession({
    startAt: new Date('2026-03-02T10:00:00Z'),
    endAt: new Date('2026-03-02T12:00:00Z'),
    energyKwh: 9,
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  await insertInterval(
    guest,
    new Date('2026-03-02T10:00:00Z'),
    new Date(Date.parse('2026-03-02T10:00:00Z') + H),
    2,
  )
  await insertInterval(
    guest,
    new Date('2026-03-02T11:00:00Z'),
    new Date(Date.parse('2026-03-02T11:00:00Z') + H),
    0.5,
  )
  // Interval-less sessions keep the fallback path covered.
  await insertSession({
    startAt: new Date('2026-03-03T10:00:00Z'),
    endAt: new Date('2026-03-03T11:00:00Z'),
    energyKwh: 1,
  })
  await insertSession({
    startAt: new Date('2026-03-04T10:00:00Z'),
    endAt: new Date('2026-03-04T11:00:00Z'),
    energyKwh: 0.8,
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const now = new Date('2026-03-15T12:00:00Z')
  const mine = await getOverview({ year: 2026, now, vehicle: 'ours' })
  expect(mine.tiles.allTime).toEqual({ kwh: 8, sessions: 2 })
  expect(mine.months[2]).toEqual({ month: 3, kwh: 8, sessions: 2 })
  const theirs = await getOverview({ year: 2026, now, vehicle: 'other' })
  expect(theirs.tiles.allTime.kwh).toBeCloseTo(3.3)
  expect(theirs.tiles.allTime.sessions).toBe(2)
  expect(theirs.months[2].kwh).toBeCloseTo(3.3)
  const both = await getOverview({ year: 2026, now })
  expect(both.tiles.allTime.kwh).toBeCloseTo(11.3)
})

test('this year / this month follow the scope when the selected year is not the current one', async () => {
  await insertSession({
    startAt: new Date('2026-03-01T10:00:00Z'),
    endAt: new Date('2026-03-01T11:00:00Z'),
    energyKwh: 10,
  })
  await insertSession({
    startAt: new Date('2026-03-02T10:00:00Z'),
    endAt: new Date('2026-03-02T11:00:00Z'),
    energyKwh: 4,
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const now = new Date('2026-03-15T12:00:00Z')
  const ours = await getOverview({ year: 2025, now, vehicle: 'ours' })
  expect(ours.tiles.thisYear).toEqual({ kwh: 10, sessions: 1 })
  expect(ours.tiles.thisMonth).toEqual({ kwh: 10, sessions: 1 })
  const theirs = await getOverview({ year: 2025, now, vehicle: 'other' })
  expect(theirs.tiles.thisYear).toEqual({ kwh: 4, sessions: 1 })
  expect(theirs.tiles.thisMonth).toEqual({ kwh: 4, sessions: 1 })
  expect(theirs.months.every((m) => m.kwh === 0)).toBe(true)
})

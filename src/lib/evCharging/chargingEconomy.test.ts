import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import { EvChargingDomainError } from '~/lib/services/evCharging'
import { replaceDay } from '~/lib/services/spotPrice'
import * as tariffService from '~/lib/services/tariff'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { setupDatabase } from '~test/setup'
import { getEconomyOverview, getSessionEconomy } from './chargingEconomy'
import { getSessionCosts } from './costing'

setupDatabase()

const NOW = new Date('2026-09-30T12:00:00Z')
const TARIFF = {
  validFrom: '2026-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}
const unit = (spot: number) => (spot + 0.76931) * 1.25

let counter = 0
async function session(
  startIso: string,
  endIso: string,
  kwh: number,
  intervals: [string, string, number][] = [],
  overrides: Partial<typeof evChargeSession.$inferInsert> = {},
) {
  counter += 1
  await db
    .insert(evCharger)
    .values({ id: 'charger-1', name: 'Charger', installationId: 'install-1' })
    .onConflictDoNothing()
  const [row] = await db
    .insert(evChargeSession)
    .values({
      zaptecSessionId: `zap-${counter}`,
      chargerId: 'charger-1',
      startAt: new Date(startIso),
      endAt: new Date(endIso),
      energyKwh: kwh,
      ...overrides,
    })
    .returning({ id: evChargeSession.id })
  if (intervals.length > 0) {
    await db.insert(evChargeInterval).values(
      intervals.map(([s, e, k]) => ({
        sessionId: row.id,
        startAt: new Date(s),
        endAt: new Date(e),
        energyKwh: k,
      })),
    )
  }
  return row.id
}

// 2026-09-28: local 10:xx (08:00Z–09:00Z) costs 3 SEK, everything else 1 SEK.
async function seedPrices() {
  await tariffService.create(TARIFF)
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, (i) => (i >= 40 && i < 44 ? 3 : 1)),
  )
}

test('the optimum uses window slots outside the charged hours', async () => {
  await seedPrices()
  // Plugged in 08:00Z–10:00Z, charged only the dear hour: slots of 09:00Z–10:00Z
  // must be loaded even though no stretch covers them.
  await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  const { sessions } = await getEconomyOverview({ year: 2026, now: NOW })
  const cf = sessions[0].counterfactual
  expect(cf?.optimal.totalSek).toBeCloseTo(10 * unit(1))
  expect(cf?.leftOnTableSek).toBeCloseTo(10 * (unit(3) - unit(1)))
})

test('the actual cost equals the session list’s cost (parity with getSessionCosts)', async () => {
  await seedPrices()
  const id = await session('2026-09-28T07:30:00Z', '2026-09-28T09:40:00Z', 12, [
    ['2026-09-28T07:30:00Z', '2026-09-28T08:00:00Z', 2],
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 7],
    ['2026-09-28T09:00:00Z', '2026-09-28T09:40:00Z', 3],
  ])
  const [{ sessions }, [cost]] = await Promise.all([
    getEconomyOverview({ year: 2026, now: NOW }),
    getSessionCosts({ sessionIds: [id] }),
  ])
  expect(sessions[0].actual.totalSek).toBeCloseTo(cost.totalSek, 9)
  expect(sessions[0].actual.fullKwh).toBeCloseTo(cost.fullKwh, 9)
})

test('only counted sessions of the selected year, newest first, bucketed by start month', async () => {
  await seedPrices()
  await replaceDay(
    'SE3',
    '2026-08-31',
    daySlots('2026-08-31', 15, () => 1),
  )
  await replaceDay(
    'SE3',
    '2026-09-01',
    daySlots('2026-09-01', 15, () => 1),
  )
  // Overnight across the month end (local 23:00 Aug 31 → 01:00 Sep 1): August.
  const overnight = await session('2026-08-31T21:00:00Z', '2026-08-31T23:00:00Z', 10, [
    ['2026-08-31T21:00:00Z', '2026-08-31T22:00:00Z', 5],
    ['2026-08-31T22:00:00Z', '2026-08-31T23:00:00Z', 5],
  ])
  const september = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  await session('2026-09-28T11:00:00Z', '2026-09-28T12:00:00Z', 9, [], { voided: true })
  await session('2026-09-28T13:00:00Z', '2026-09-28T14:00:00Z', 0.2) // noise
  await session('2025-09-28T08:00:00Z', '2025-09-28T09:00:00Z', 5) // another year
  await session('2026-09-28T15:00:00Z', '2026-09-28T16:00:00Z', 6, [], {
    replacedByZaptecSessionId: 'zap-other',
  })

  const o = await getEconomyOverview({ year: 2026, now: NOW })
  expect(o.sessions.map((s) => s.sessionId)).toEqual([september, overnight])
  expect(o.months[7]).toMatchObject({ month: 8, sessions: 1, included: 1 })
  expect(o.months[8]).toMatchObject({ month: 9, sessions: 1, included: 1 })
  expect(o.tiles).toMatchObject({ sessions: 2, included: 2, excluded: { noHourly: 0, noPrice: 0 } })
  expect(o.months.reduce((n, m) => n + m.sessions, 0)).toBe(2)
  expect(o.years).toEqual([2026, 2025])
})

test('excluded sessions are counted by reason: no hourly data, or a price day missing mid-window', async () => {
  await seedPrices()
  // No intervals.
  await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10)
  // Overnight into 2026-09-29, which has no prices (its sync failed).
  await session('2026-09-28T20:00:00Z', '2026-09-28T23:00:00Z', 10, [
    ['2026-09-28T20:00:00Z', '2026-09-28T21:00:00Z', 10],
  ])
  const { tiles, sessions } = await getEconomyOverview({ year: 2026, now: NOW })
  expect(tiles.excluded).toEqual({ noHourly: 1, noPrice: 1 })
  expect(tiles.included).toBe(0)
  expect(tiles.score).toBeNull()
  expect(sessions.map((s) => s.excluded).sort()).toEqual(['no_hourly', 'no_price'])
})

test('the month and year average spot cover every priced day, charged or not', async () => {
  await seedPrices()
  const { months, tiles } = await getEconomyOverview({ year: 2026, now: NOW })
  // One day stored: 4 of 96 quarters at 3 SEK, the rest at 1.
  const avg = ((4 * 3 + 92 * 1) / 96) * 1.25 * 100
  expect(months[8].avgSpotOre).toBeCloseTo(avg)
  expect(tiles.avgSpotOre).toBeCloseTo(avg)
  expect(months[0].avgSpotOre).toBeNull()
})

test('the selected year defaults to the current Stockholm year and the list always offers it', async () => {
  const o = await getEconomyOverview({ now: NOW })
  expect(o.year).toBe(2026)
  expect(o.years).toEqual([2026])
  expect(o.months).toHaveLength(12)
})

test('getSessionEconomy returns the chart data: stretches, prices ±1 h, the optimal schedule', async () => {
  await seedPrices()
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  const d = await getSessionEconomy({ sessionId: id })
  expect(d.session).toMatchObject({ id, kwh: 10, estimated: false })
  expect(d.session.peakKw).toBeCloseTo(10)
  expect(d.intervals).toHaveLength(1)
  // 07:00Z–11:00Z of 15-min slots.
  expect(d.prices).toHaveLength(16)
  expect(d.prices[4].spotOre).toBeCloseTo(3 * 1.25 * 100)
  expect(d.optimalSchedule?.[0].startMs).toBe(new Date('2026-09-28T09:00:00Z').getTime())
  expect(d.economy.counterfactual?.score).toBeCloseTo(0)
})

test('getSessionEconomy exposes the rate the counterfactuals charged at', async () => {
  await seedPrices()
  // 6 kWh over 08:00Z–08:30Z: the observed 12 kW, not the window average (6 kWh / 2 h = 3 kW).
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 6, [
    ['2026-09-28T08:00:00Z', '2026-09-28T08:30:00Z', 6],
  ])
  const d = await getSessionEconomy({ sessionId: id })
  expect(d.rateKw).toBeCloseTo(12)
  // It is the rate the schedules were filled at: every optimal piece holds rate × its hours.
  expect(d.optimalSchedule?.length).toBeGreaterThan(0)
  for (const piece of d.optimalSchedule ?? []) {
    expect(piece.kwh).toBeCloseTo((12 * (piece.endMs - piece.startMs)) / 3_600_000)
  }
  // 6 kWh at 12 kW: two cheap quarters of 3 kWh (= 12 kW × 0,25 h).
  expect(d.optimalSchedule?.map((p) => p.kwh)).toEqual([3, 3])
})

test('getSessionEconomy throws EV_SESSION_NOT_FOUND for an unknown id', async () => {
  await expect(
    getSessionEconomy({ sessionId: '00000000-0000-4000-8000-000000000000' }),
  ).rejects.toBeInstanceOf(EvChargingDomainError)
  await expect(
    getSessionEconomy({ sessionId: '00000000-0000-4000-8000-000000000000' }),
  ).rejects.toMatchObject({ code: 'EV_SESSION_NOT_FOUND' })
})

test('both reads fill their timings sink', async () => {
  const timings: Record<string, number> = {}
  await getEconomyOverview({ now: NOW, timings })
  expect(timings).toMatchObject({
    energyMs: expect.any(Number),
    tariffMs: expect.any(Number),
    slotsMs: expect.any(Number),
    dailySpotMs: expect.any(Number),
    yearsMs: expect.any(Number),
    computeMs: expect.any(Number),
  })
})

test('getSessionEconomy fills its timings sink', async () => {
  await seedPrices()
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  const timings: Record<string, number> = {}
  await getSessionEconomy({ sessionId: id, timings })
  expect(timings).toMatchObject({
    energyMs: expect.any(Number),
    tariffMs: expect.any(Number),
    slotsMs: expect.any(Number),
    computeMs: expect.any(Number),
  })
})

test('a session starting at 00:30 local on the 1st belongs to the new month', async () => {
  await seedPrices()
  await replaceDay(
    'SE3',
    '2026-09-01',
    daySlots('2026-09-01', 15, () => 1),
  )
  // 22:30Z Aug 31 = 00:30 Sep 1 in Stockholm (UTC+2).
  await session('2026-08-31T22:30:00Z', '2026-08-31T23:30:00Z', 5, [
    ['2026-08-31T22:30:00Z', '2026-08-31T23:30:00Z', 5],
  ])
  const { months } = await getEconomyOverview({ year: 2026, now: NOW })
  expect(months[8].sessions).toBe(1)
  expect(months[7].sessions).toBe(0)
})

test('a session starting at 00:30 local on 1 January belongs to the new year', async () => {
  await seedPrices()
  // 23:30Z Dec 31 = 00:30 Jan 1 in Stockholm (UTC+1).
  const id = await session('2025-12-31T23:30:00Z', '2026-01-01T00:30:00Z', 5, [
    ['2025-12-31T23:30:00Z', '2026-01-01T00:30:00Z', 5],
  ])
  const y2026 = await getEconomyOverview({ year: 2026, now: NOW })
  expect(y2026.sessions.map((s) => s.sessionId)).toEqual([id])
  expect(y2026.months[0].sessions).toBe(1)
  const y2025 = await getEconomyOverview({ year: 2025, now: NOW })
  expect(y2025.sessions).toEqual([])
})

test('a non-current year selection reads that year’s months and price days', async () => {
  await tariffService.create({ ...TARIFF, validFrom: '2025-01-01' })
  await replaceDay(
    'SE3',
    '2025-06-10',
    daySlots('2025-06-10', 15, () => 2),
  )
  const y2025 = await getEconomyOverview({ year: 2025, now: NOW })
  expect(y2025.year).toBe(2025)
  expect(y2025.months[5].avgSpotOre).toBeCloseTo(2 * 1.25 * 100)
  expect(y2025.tiles.avgSpotOre).toBeCloseTo(2 * 1.25 * 100)
  const y2026 = await getEconomyOverview({ year: 2026, now: NOW })
  expect(y2026.months[5].avgSpotOre).toBeNull()
  expect(y2026.tiles.avgSpotOre).toBeNull()
})

test('years: only counted sessions contribute, the future sorts first, and it ignores the selection', async () => {
  await session('2027-03-01T08:00:00Z', '2027-03-01T09:00:00Z', 5)
  await session('2025-03-01T08:00:00Z', '2025-03-01T09:00:00Z', 5)
  await session('2024-03-01T08:00:00Z', '2024-03-01T09:00:00Z', 5, [], { voided: true })
  await session('2023-03-01T08:00:00Z', '2023-03-01T09:00:00Z', 0.2) // noise
  await session('2022-03-01T08:00:00Z', '2022-03-01T09:00:00Z', 5, [], {
    replacedByZaptecSessionId: 'zap-other',
  })
  const current = await getEconomyOverview({ now: NOW })
  expect(current.years).toEqual([2027, 2026, 2025])
  const picked = await getEconomyOverview({ year: 2025, now: NOW })
  expect(picked.years).toEqual([2027, 2026, 2025])
})

test('getSessionEconomy on a day without a tariff: null prices, excluded no_price', async () => {
  // Prices but no tariff period at all.
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, () => 1),
  )
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  const d = await getSessionEconomy({ sessionId: id })
  expect(d.prices).toHaveLength(16)
  expect(d.prices.every((p) => p.spotOre === null)).toBe(true)
  expect(d.economy.excluded).toBe('no_price')
  expect(d.economy.counterfactual).toBeNull()
  expect(d.optimalSchedule).toBeNull()
  expect(d.rateKw).toBeNull()
})

test('getSessionEconomy on an estimated session (no intervals): no chart data, excluded no_hourly', async () => {
  await seedPrices()
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10)
  const d = await getSessionEconomy({ sessionId: id })
  expect(d.session.estimated).toBe(true)
  expect(d.session.peakKw).toBeNull()
  expect(d.intervals).toEqual([])
  expect(d.economy.excluded).toBe('no_hourly')
  expect(d.optimalSchedule).toBeNull()
  expect(d.rateKw).toBeNull()
})

test('economy overview follows the vehicle scope; the session detail carries the attribution', async () => {
  const ours = await session('2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z', 10)
  const guest = await session('2026-09-11T10:00:00Z', '2026-09-11T11:00:00Z', 4, [], {
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const rows = async (vehicle?: 'ours' | 'other' | 'all') =>
    (await getEconomyOverview({ year: 2026, now: NOW, vehicle })).sessions.map((s) => [
      s.sessionId,
      s.vehicle,
    ])
  expect(await rows('ours')).toEqual([[ours, 'ours']])
  expect(await rows('other')).toEqual([[guest, 'other']])
  expect(await rows('all')).toEqual([
    [guest, 'other'],
    [ours, 'ours'],
  ])
  expect(await rows()).toHaveLength(2)

  const detail = await getSessionEconomy({ sessionId: guest })
  expect(detail.session).toMatchObject({ vehicle: 'other', vehicleSource: 'admin' })
})

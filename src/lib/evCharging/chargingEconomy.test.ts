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

  const o = await getEconomyOverview({ year: 2026, now: NOW })
  expect(o.sessions.map((s) => s.sessionId)).toEqual([september, overnight])
  expect(o.months[7]).toMatchObject({ month: 8, sessions: 1, included: 1 })
  expect(o.months[8]).toMatchObject({ month: 9, sessions: 1, included: 1 })
  expect(o.tiles).toMatchObject({ sessions: 2, included: 2 })
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

test('getSessionEconomy throws EV_SESSION_NOT_FOUND for an unknown id', async () => {
  await expect(
    getSessionEconomy({ sessionId: '00000000-0000-4000-8000-000000000000' }),
  ).rejects.toBeInstanceOf(EvChargingDomainError)
})

test('both reads fill their timings sink', async () => {
  const timings: Record<string, number> = {}
  await getEconomyOverview({ now: NOW, timings })
  expect(timings).toMatchObject({
    energyMs: expect.any(Number),
    tariffMs: expect.any(Number),
    slotsMs: expect.any(Number),
    dailySpotMs: expect.any(Number),
    computeMs: expect.any(Number),
  })
})

import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import { getOverview } from '~/lib/services/evCharging'
import { replaceDay } from '~/lib/services/spotPrice'
import * as tariffService from '~/lib/services/tariff'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { setupDatabase } from '~test/setup'
import { getCostOverview, getSessionCosts } from './costing'

setupDatabase()

const NOW = new Date('2026-09-28T12:00:00Z')
const TARIFF = {
  validFrom: '2026-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}
const FEES_ORE = 5.331 + 35.6 + 36

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

test('cost kWh per month equals the overview’s kWh per month (same bucketing)', async () => {
  // Overnight across a month boundary (local 23:00 Aug 31 → 01:00 Sep 1, CEST).
  await session('2026-08-31T21:00:00Z', '2026-08-31T23:00:00Z', 10, [
    ['2026-08-31T21:00:00Z', '2026-08-31T22:00:00Z', 4],
    ['2026-08-31T22:00:00Z', '2026-08-31T23:00:00Z', 6],
  ])
  // No intervals: falls back to the session's own energy in its start month.
  await session('2026-03-10T18:00:00Z', '2026-03-10T20:00:00Z', 7)
  // Uncounted: noise and voided never appear in either.
  await session('2026-05-01T18:00:00Z', '2026-05-01T19:00:00Z', 0.2)
  await session('2026-05-02T18:00:00Z', '2026-05-02T19:00:00Z', 9, [], { voided: true })

  const [kwh, cost] = await Promise.all([
    getOverview({ year: 2026, now: NOW }),
    getCostOverview({ year: 2026, now: NOW }),
  ])

  for (const month of kwh.months) {
    expect(cost.months[month.month - 1].kwh).toBeCloseTo(month.kwh, 9)
  }
  expect(cost.tiles.allTime.kwh).toBeCloseTo(kwh.tiles.allTime.kwh, 9)
  expect(cost.months[7].kwh).toBeCloseTo(4) // August
  expect(cost.months[8].kwh).toBeCloseTo(6) // September
  expect(cost.months[2].kwh).toBeCloseTo(7) // March
})

test('a fully priced month: spot + fees incl VAT, average öre/kWh, complete', async () => {
  await replaceDay(
    'SE3',
    '2026-09-20',
    daySlots('2026-09-20', 15, () => 0.5),
  )
  await tariffService.create(TARIFF)
  await session('2026-09-20T18:00:00Z', '2026-09-20T20:00:00Z', 10, [
    ['2026-09-20T18:00:00Z', '2026-09-20T19:00:00Z', 4],
    ['2026-09-20T19:00:00Z', '2026-09-20T20:00:00Z', 6],
  ])

  const cost = await getCostOverview({ now: NOW })
  const sep = cost.months[8]

  expect(sep.complete).toBe(true)
  expect(sep.spotSek).toBeCloseTo(10 * 0.5 * 1.25)
  expect(sep.feesSek).toBeCloseTo(((10 * FEES_ORE) / 100) * 1.25)
  expect(sep.totalSek).toBeCloseTo(sep.spotSek + sep.feesSek)
  expect(sep.avgOre).toBeCloseTo((sep.totalSek / 10) * 100)
  expect(cost.tiles.thisMonth).toMatchObject({ kwh: 10, complete: true })
  expect(cost.tiles.thisYear.totalSek).toBeCloseTo(sep.totalSek)
})

test('missing prices or tariff are partial, never 0 kr', async () => {
  await session('2026-09-21T18:00:00Z', '2026-09-21T19:00:00Z', 5, [
    ['2026-09-21T18:00:00Z', '2026-09-21T19:00:00Z', 5],
  ])

  const noPrices = await getCostOverview({ now: NOW })
  expect(noPrices.months[8]).toMatchObject({
    kwh: 5,
    fullKwh: 0,
    noPriceKwh: 5,
    totalSek: 0,
    complete: false,
    avgOre: null,
  })

  await replaceDay('SE3', '2026-09-21', daySlots('2026-09-21', 15))
  const noTariff = await getCostOverview({ now: NOW })
  expect(noTariff.months[8]).toMatchObject({ noPriceKwh: 0, noTariffKwh: 5, complete: false })
})

test('an empty history is 12 zero months and zero tiles', async () => {
  const cost = await getCostOverview({ year: 2025, now: NOW })
  expect(cost.year).toBe(2025)
  expect(cost.months).toHaveLength(12)
  expect(cost.months.every((m) => m.kwh === 0 && m.totalSek === 0 && m.avgOre === null)).toBe(true)
  // Nothing to price counts as complete (no grid kWh is missing a price).
  expect(cost.tiles.allTime).toMatchObject({ kwh: 0, complete: true })
})

test('session costs price each session, flag estimated ones, and skip uncounted ids', async () => {
  await replaceDay(
    'SE3',
    '2026-09-22',
    daySlots('2026-09-22', 15, () => 1),
  )
  await tariffService.create(TARIFF)
  const priced = await session('2026-09-22T08:00:00Z', '2026-09-22T09:00:00Z', 2, [
    ['2026-09-22T08:00:00Z', '2026-09-22T09:00:00Z', 2],
  ])
  const estimated = await session('2026-09-22T10:00:00Z', '2026-09-22T12:00:00Z', 4)
  const unpriced = await session('2026-09-25T08:00:00Z', '2026-09-25T09:00:00Z', 3)
  const voided = await session('2026-09-22T13:00:00Z', '2026-09-22T14:00:00Z', 3, [], {
    voided: true,
  })

  const costs = await getSessionCosts({ sessionIds: [priced, estimated, unpriced, voided] })
  const byId = new Map(costs.map((c) => [c.sessionId, c]))

  expect(byId.has(voided)).toBe(false)
  expect(byId.get(priced)).toMatchObject({ estimated: false, complete: true })
  expect(byId.get(priced)?.spotSek).toBeCloseTo(2 * 1 * 1.25)
  expect(byId.get(estimated)).toMatchObject({ estimated: true, complete: true, kwh: 4 })
  expect(byId.get(unpriced)).toMatchObject({ complete: false, avgOre: null })
  expect(await getSessionCosts({ sessionIds: [] })).toEqual([])
})

test('records sub-timings when asked', async () => {
  await session('2026-09-23T08:00:00Z', '2026-09-23T09:00:00Z', 2)
  const timings = {}
  await getCostOverview({ now: NOW, timings })
  expect(timings).toEqual({
    energyMs: expect.any(Number),
    slotsMs: expect.any(Number),
    tariffMs: expect.any(Number),
    computeMs: expect.any(Number),
  })
})

test('a tariff change mid-month prices each side with its own period', async () => {
  await replaceDay(
    'SE3',
    '2026-09-10',
    daySlots('2026-09-10', 15, () => 0),
  )
  await replaceDay(
    'SE3',
    '2026-09-20',
    daySlots('2026-09-20', 15, () => 0),
  )
  await tariffService.create(TARIFF)
  await tariffService.create({ ...TARIFF, validFrom: '2026-09-15', gridTransferOre: 135.6 })
  await session('2026-09-10T08:00:00Z', '2026-09-10T09:00:00Z', 1, [
    ['2026-09-10T08:00:00Z', '2026-09-10T09:00:00Z', 1],
  ])
  await session('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', 1, [
    ['2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', 1],
  ])

  const sep = (await getCostOverview({ now: NOW })).months[8]
  expect(sep.feesSek).toBeCloseTo(((FEES_ORE + (FEES_ORE + 100)) / 100) * 1.25)
})

test('months follow the selected year; tiles stay on now’s year; all time spans years', async () => {
  await session('2025-06-10T08:00:00Z', '2025-06-10T09:00:00Z', 3)
  await session('2026-09-10T08:00:00Z', '2026-09-10T09:00:00Z', 5)

  const cost = await getCostOverview({ year: 2025, now: NOW })

  expect(cost.year).toBe(2025)
  expect(cost.months[5].kwh).toBe(3) // June 2025
  expect(cost.months[8].kwh).toBe(0) // September 2025
  expect(cost.tiles.thisYear.kwh).toBe(5) // 2026
  expect(cost.tiles.thisMonth.kwh).toBe(5) // September 2026
  expect(cost.tiles.allTime.kwh).toBe(8)
})

test('a single interval across a month boundary is bucketed by its start, like the overview', async () => {
  // Local 23:30 Aug 31 → 00:30 Sep 1 (CEST), one interval.
  await session('2026-08-31T21:30:00Z', '2026-08-31T22:30:00Z', 2, [
    ['2026-08-31T21:30:00Z', '2026-08-31T22:30:00Z', 2],
  ])
  const [kwh, cost] = await Promise.all([
    getOverview({ year: 2026, now: NOW }),
    getCostOverview({ year: 2026, now: NOW }),
  ])
  expect(cost.months[7].kwh).toBe(2)
  expect(cost.months[8].kwh).toBe(0)
  expect(kwh.months[7].kwh).toBe(2)
})

test('an interval-less session is priced over its whole span in the overview', async () => {
  await replaceDay(
    'SE3',
    '2026-09-24',
    daySlots('2026-09-24', 15, () => 2),
  )
  await tariffService.create(TARIFF)
  await session('2026-09-24T08:00:00Z', '2026-09-24T10:00:00Z', 4)

  const sep = (await getCostOverview({ now: NOW })).months[8]
  expect(sep).toMatchObject({ kwh: 4, complete: true })
  expect(sep.spotSek).toBeCloseTo(4 * 2 * 1.25)
})

test('getCostOverview follows the vehicle scope', async () => {
  await session('2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z', 10)
  await session('2026-09-11T10:00:00Z', '2026-09-11T11:00:00Z', 4, [], {
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const allTimeKwh = async (vehicle?: 'ours' | 'other' | 'all') =>
    (await getCostOverview({ now: NOW, vehicle })).tiles.allTime.kwh
  expect(await allTimeKwh('ours')).toBeCloseTo(10)
  expect(await allTimeKwh('other')).toBeCloseTo(4)
  expect(await allTimeKwh('all')).toBeCloseTo(14)
  expect(await allTimeKwh()).toBeCloseTo(14)
})

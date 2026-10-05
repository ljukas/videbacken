import { afterEach, expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import { logger } from '~/lib/logger/server'
import { replaceForSessions } from '~/lib/services/energyMix'
import { getOverview, listSessionEnergy } from '~/lib/services/evCharging'
import { replaceDay as replaceHouseDay } from '~/lib/services/houseEnergy'
import { replaceDay } from '~/lib/services/spotPrice'
import * as tariffService from '~/lib/services/tariff'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { mixSlot } from '~test/fixtures/energyMix'
import { reading } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { loadMix } from './costInputs'
import { getCostOverview, getSessionCosts } from './costing'

setupDatabase()

afterEach(() => {
  vi.restoreAllMocks()
})

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
    mixMs: expect.any(Number),
    houseFromMs: expect.any(Number),
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

test('getSessionCosts prices a guest session (unscoped by id)', async () => {
  const guest = await session('2026-09-11T10:00:00Z', '2026-09-11T11:00:00Z', 4, [], {
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const costs = await getSessionCosts({ sessionIds: [guest] })
  expect(costs.map((c) => [c.sessionId, c.kwh])).toEqual([[guest, 4]])
})

test('loadMix returns the stored mix of the sessions that have one, and times it', async () => {
  const a = await session('2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3, [
    ['2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3],
  ])
  const b = await session('2026-09-21T18:00:00Z', '2026-09-21T18:30:00Z', 2, [
    ['2026-09-21T18:00:00Z', '2026-09-21T18:30:00Z', 2],
  ])
  const slots = [
    mixSlot('2026-09-20T18:00:00Z', { gridKwh: 1, solarKwh: 0.5 }),
    mixSlot('2026-09-20T18:15:00Z', { gridKwh: 1.5 }),
  ]
  await replaceForSessions(
    [a],
    slots.map((s) => ({ ...s, sessionId: a })),
  )
  const sessions = await listSessionEnergy({ sessionIds: [a, b] })
  const timings: { mixMs?: number } = {}
  const mixes = await loadMix(sessions, timings)
  expect([...mixes.keys()]).toEqual([a])
  expect(mixes.get(a)).toEqual(slots)
  expect(timings.mixMs).toEqual(expect.any(Number))

  const none: { mixMs?: number } = {}
  expect(await loadMix([], none)).toEqual(new Map())
  expect(none.mixMs).toEqual(expect.any(Number))
})

const storeMix = (sessionId: string, slots: MixSlot[]) =>
  replaceForSessions(
    [sessionId],
    slots.map((s) => ({ ...s, sessionId })),
  )

test('a session with a stored mix costs its cash: own solar 0 kr, battery at its stored spot', async () => {
  await replaceDay(
    'SE3',
    '2026-09-20',
    daySlots('2026-09-20', 15, () => 0.5),
  )
  await tariffService.create(TARIFF)
  const id = await session('2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3, [
    ['2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3],
  ])
  await storeMix(id, [
    mixSlot('2026-09-20T18:00:00Z', { gridKwh: 1, solarKwh: 0.5 }),
    mixSlot('2026-09-20T18:15:00Z', { gridKwh: 0.5, batteryGridKwh: 1, batteryGridSpotSek: 0.2 }),
  ])

  const sep = (await getCostOverview({ now: NOW })).months[8]
  expect(sep).toMatchObject({
    kwh: 3,
    solarKwh: 0.5,
    batteryKwh: 1,
    noHouseDataKwh: 0,
    complete: true,
  })
  expect(sep.gridKwh).toBeCloseTo(2.5)
  expect(sep.spotSek).toBeCloseTo((1.5 * 0.5 + 1 * 0.2) * 1.25)
  expect(sep.feesSek).toBeCloseTo(((2.5 * FEES_ORE) / 100) * 1.25)
  expect(sep.solarValueSek).toBeCloseTo(0.5 * 0.5)
  expect(sep.avgOre).toBeCloseTo((sep.totalSek / 3) * 100)

  const tiles = (await getCostOverview({ now: NOW })).tiles
  for (const tile of [tiles.thisMonth, tiles.thisYear, tiles.allTime]) {
    expect(tile).toMatchObject({ solarKwh: 0.5, batteryKwh: 1 })
    expect(tile.totalSek).toBeCloseTo(sep.totalSek, 9)
  }

  const timings = {}
  const [cost] = await getSessionCosts({ sessionIds: [id], timings })
  expect(cost.totalSek).toBeCloseTo(sep.totalSek, 9)
  expect(cost.solarKwh).toBeCloseTo(0.5)
  expect(timings).toEqual({
    energyMs: expect.any(Number),
    tariffMs: expect.any(Number),
    slotsMs: expect.any(Number),
    mixMs: expect.any(Number),
    computeMs: expect.any(Number),
  })
})

test('a session without a mix is all grid, labelled as without house data', async () => {
  await replaceDay(
    'SE3',
    '2026-09-20',
    daySlots('2026-09-20', 15, () => 0.5),
  )
  await tariffService.create(TARIFF)
  await session('2026-09-20T18:00:00Z', '2026-09-20T19:00:00Z', 4, [
    ['2026-09-20T18:00:00Z', '2026-09-20T19:00:00Z', 4],
  ])
  const sep = (await getCostOverview({ now: NOW })).months[8]
  expect(sep).toMatchObject({
    kwh: 4,
    noHouseDataKwh: 4,
    solarKwh: 0,
    batteryKwh: 0,
    complete: true,
  })
  expect(sep.spotSek).toBeCloseTo(4 * 0.5 * 1.25)
})

test('a mix that no longer matches the session falls back to all grid', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const id = await session('2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3, [
    ['2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3],
  ])
  await storeMix(id, [mixSlot('2026-09-20T18:00:00Z', { solarKwh: 2 })])
  const [cost] = await getSessionCosts({ sessionIds: [id] })
  expect(cost).toMatchObject({ kwh: 3, solarKwh: 0, noHouseDataKwh: 3 })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(
    'cost: energy mix ignored, kWh differs from the session',
    expect.objectContaining({ sessionId: id }),
  )
  const sep = (await getCostOverview({ now: NOW })).months[8]
  expect(sep).toMatchObject({ kwh: 3, solarKwh: 0, noHouseDataKwh: 3 })
  expect(warn).toHaveBeenCalledTimes(2) // once per pricing call
})

test('mix pieces count in the month of their own interval, like the kWh overview', async () => {
  // Local 23:00 Aug 31 → 01:00 Sep 1 (CEST), hour-aligned intervals.
  const id = await session('2026-08-31T21:00:00Z', '2026-08-31T23:00:00Z', 10, [
    ['2026-08-31T21:00:00Z', '2026-08-31T22:00:00Z', 4],
    ['2026-08-31T22:00:00Z', '2026-08-31T23:00:00Z', 6],
  ])
  await storeMix(id, [
    ...['21:00', '21:15', '21:30', '21:45'].map((hm) =>
      mixSlot(`2026-08-31T${hm}:00Z`, { gridKwh: 1 }),
    ),
    ...['22:00', '22:15', '22:30', '22:45'].map((hm) =>
      mixSlot(`2026-08-31T${hm}:00Z`, { solarKwh: 1.5 }),
    ),
  ])
  const [kwh, cost] = await Promise.all([
    getOverview({ year: 2026, now: NOW }),
    getCostOverview({ year: 2026, now: NOW }),
  ])
  expect(cost.months[7].kwh).toBeCloseTo(kwh.months[7].kwh, 9) // August: 4
  expect(cost.months[8].kwh).toBeCloseTo(kwh.months[8].kwh, 9) // September: 6
  expect(cost.months[8].solarKwh).toBeCloseTo(6)
})

test('an interval-less session with a mix stays whole in its start month', async () => {
  // Local 23:30 Aug 31 → 00:30 Sep 1, no intervals: one estimated stretch.
  const id = await session('2026-08-31T21:30:00Z', '2026-08-31T22:30:00Z', 2)
  await storeMix(
    id,
    ['21:30', '21:45', '22:00', '22:15'].map((hm) =>
      mixSlot(`2026-08-31T${hm}:00Z`, { gridKwh: 0.25, solarKwh: 0.25 }),
    ),
  )
  const cost = await getCostOverview({ year: 2026, now: NOW })
  expect(cost.months[7]).toMatchObject({ kwh: 2, solarKwh: 1 })
  expect(cost.months[8].kwh).toBe(0)
})

test('reports when house data starts: the first reading (null before any)', async () => {
  expect((await getCostOverview({ now: NOW })).houseDataFrom).toBeNull()
  const first = new Date('2026-09-01T05:00:00Z')
  await replaceHouseDay(
    { dayStart: new Date('2026-08-31T22:00:00Z'), dayEnd: new Date('2026-09-01T22:00:00Z') },
    [
      reading(first, { gridImportKwh: 0.1, loadKwh: 0.1 }),
      reading(new Date('2026-09-01T06:00:00Z')),
    ],
  )
  expect((await getCostOverview({ now: NOW })).houseDataFrom).toEqual(first)
})

test('a guest session’s mix stays out of the “ours” scope', async () => {
  const guest = await session(
    '2026-09-11T10:00:00Z',
    '2026-09-11T10:30:00Z',
    2,
    [['2026-09-11T10:00:00Z', '2026-09-11T10:30:00Z', 2]],
    { vehicle: 'other', vehicleSource: 'admin' },
  )
  await storeMix(guest, [
    mixSlot('2026-09-11T10:00:00Z', { solarKwh: 1 }),
    mixSlot('2026-09-11T10:15:00Z', { solarKwh: 1 }),
  ])
  const solar = async (vehicle: 'ours' | 'other' | 'all') =>
    (await getCostOverview({ now: NOW, vehicle })).tiles.allTime.solarKwh
  expect(await solar('ours')).toBe(0)
  expect(await solar('other')).toBeCloseTo(2)
  expect(await solar('all')).toBeCloseTo(2)
})

test('the slot a session starts inside counts in its first interval’s month', async () => {
  // Local 23:50 Aug 31 → 00:20 Sep 1 (CEST); the first slot starts 5 min before the energy.
  await storeMix(
    await session('2026-08-31T21:50:00Z', '2026-08-31T22:20:00Z', 1.5, [
      ['2026-08-31T21:50:00Z', '2026-08-31T22:20:00Z', 1.5],
    ]),
    ['21:45', '22:00', '22:15'].map((hm) => mixSlot(`2026-08-31T${hm}:00Z`, { solarKwh: 0.5 })),
  )
  const [kwh, cost] = await Promise.all([
    getOverview({ year: 2026, now: NOW }),
    getCostOverview({ year: 2026, now: NOW }),
  ])
  expect(cost.months[7]).toMatchObject({ kwh: 1.5, solarKwh: 1.5 })
  expect(cost.months[8].kwh).toBe(0)
  expect(cost.months[7].kwh).toBeCloseTo(kwh.months[7].kwh, 9)
})

test('an interval across local midnight keeps its pieces in its start month; the next interval in its own', async () => {
  // 23:30–00:30 local (2 kWh), then 00:30–01:00 (1 kWh).
  await storeMix(
    await session('2026-08-31T21:30:00Z', '2026-08-31T23:00:00Z', 3, [
      ['2026-08-31T21:30:00Z', '2026-08-31T22:30:00Z', 2],
      ['2026-08-31T22:30:00Z', '2026-08-31T23:00:00Z', 1],
    ]),
    ['21:30', '21:45', '22:00', '22:15', '22:30', '22:45'].map((hm) =>
      mixSlot(`2026-08-31T${hm}:00Z`, { gridKwh: 0.5 }),
    ),
  )
  const [kwh, cost] = await Promise.all([
    getOverview({ year: 2026, now: NOW }),
    getCostOverview({ year: 2026, now: NOW }),
  ])
  expect(cost.months[7].kwh).toBeCloseTo(2)
  expect(cost.months[8].kwh).toBeCloseTo(1)
  expect(cost.months[7].kwh).toBeCloseTo(kwh.months[7].kwh, 9)
  expect(cost.months[8].kwh).toBeCloseTo(kwh.months[8].kwh, 9)
})

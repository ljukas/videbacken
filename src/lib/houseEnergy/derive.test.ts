import { eq, sql } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { energyMixDeriveRequest, evChargeSession } from '~/lib/db/schema'
import { createServerLogger } from '~/lib/logger/server'
import * as energyMixService from '~/lib/services/energyMix'
import * as houseEnergyService from '~/lib/services/houseEnergy'
import * as spotPriceService from '~/lib/services/spotPrice'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { addDays, stockholmDayBounds } from '~/lib/time/stockholm'
import { insertInterval, insertSession } from '~test/fixtures/evCharging'
import { type Flows, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { DERIVE_VERSION, deriveFrom } from './derive'
import { deriveAfterSync } from './deriveAfterSync'
import type { MixSlot } from './mix/carMix'
import { BATTERY_CAPACITY_KWH } from './mix/pool'

setupDatabase()

const log = createServerLogger({ write: () => true })
const derive = (day: string, nowIso = '2026-06-12T12:00:00Z') =>
  deriveFrom(day, { log, now: () => new Date(nowIso) })

const at = (iso: string) => Date.parse(iso)
const inRange = (ms: number, fromIso: string, toIso: string) => ms >= at(fromIso) && ms < at(toIso)
const BASE: Flows = { loadKwh: 0.1, gridImportKwh: 0.1 }
type KwhKey =
  | 'kwh'
  | 'gridKwh'
  | 'solarKwh'
  | 'batteryGridKwh'
  | 'batterySolarKwh'
  | 'batteryUnpricedKwh'
  | 'noHouseDataKwh'
const total = (slots: MixSlot[], key: KwhKey) => slots.reduce((s, x) => s + x[key], 0)

async function storeDay(day: string, flows: (ms: number) => Flows) {
  const { startMs, endMs } = stockholmDayBounds(day)
  await houseEnergyService.replaceDay(
    { dayStart: new Date(startMs), dayEnd: new Date(endMs) },
    syntheticDay(day, flows),
  )
}
async function storePrices(day: string, price: (ms: number) => number = () => 1) {
  await spotPriceService.replaceDay(
    'SE3',
    day,
    daySlots(day, 15).map((s) => ({ ...s, sekPerKwh: price(s.startMs) })),
  )
}
async function mixOf(sessionId: string): Promise<MixSlot[]> {
  return (await energyMixService.listForSessions([sessionId])).get(sessionId) ?? []
}
async function session(
  fromIso: string,
  toIso: string,
  kwh: number,
  opts: { intervals?: boolean } = {},
) {
  const id = await insertSession({
    startAt: new Date(fromIso),
    endAt: new Date(toIso),
    energyKwh: kwh,
  })
  if (opts.intervals !== false) await insertInterval(id, new Date(fromIso), new Date(toIso), kwh)
  return id
}

// 2026-06-10: the car draws 1 kWh per bucket 08:00–10:00Z, half of the house's
// 1.1 kWh load from solar, half from the grid; Zaptec's interval starts at 07:00.
const sunny = (ms: number): Flows =>
  inRange(ms, '2026-06-10T08:00:00Z', '2026-06-10T10:00:00Z')
    ? { loadKwh: 1.1, solarKwh: 0.55, gridImportKwh: 0.55 }
    : BASE

test('with no house readings nothing is derived', async () => {
  const id = await session('2026-06-10T08:00:00Z', '2026-06-10T10:00:00Z', 10)
  const result = await derive('2026-06-10')
  expect(result).toMatchObject({ days: 0, sessions: 0 })
  expect(typeof result.deriveMs).toBe('number')
  expect(await mixOf(id)).toEqual([])
  expect(await houseEnergyService.getPoolDay('2026-06-10')).toBeNull()
})

test.each<[string, boolean]>([
  ['with Zaptec intervals', true],
  ['estimated (no intervals)', false],
])('a sunny midday session (%s) is half solar, shaped to the load jump', async (_, intervals) => {
  await storeDay('2026-06-10', sunny)
  await storePrices('2026-06-10')
  const id = await session('2026-06-10T07:00:00Z', '2026-06-10T10:00:00Z', 24, { intervals })
  const result = await derive('2026-06-10')
  // From the day before the requested one (its last bucket's cap), through today.
  expect(result).toMatchObject({ sessions: 1, days: 4 }) // 06-09 … 06-12
  const slots = await mixOf(id)
  expect(slots).toHaveLength(8)
  expect(slots[0].slotStart).toEqual(new Date('2026-06-10T08:00:00Z'))
  expect(total(slots, 'kwh')).toBeCloseTo(24, 9)
  expect(total(slots, 'gridKwh')).toBeCloseTo(12, 9)
  expect(total(slots, 'solarKwh')).toBeCloseTo(12, 9)
  expect(total(slots, 'noHouseDataKwh')).toBe(0)
})

// 2026-02-15: the battery charges from the grid 00:00–01:00 local at 0.2 SEK,
// then covers half of a 19:00–20:00Z session (the other half from the grid).
const NIGHT_CHARGE_END = stockholmDayBounds('2026-02-15').startMs + 3_600_000
const NIGHT_CHARGE: Flows = { loadKwh: 0.1, gridImportKwh: 0.6, batteryChargeGridKwh: 0.5 }
const BATTERY_HALF: Flows = { loadKwh: 0.6, gridImportKwh: 0.3, batteryDischargeKwh: 0.3 }
const nightThenSession =
  (sessionFrom: string, sessionTo: string) =>
  (ms: number): Flows => {
    if (ms < NIGHT_CHARGE_END) return NIGHT_CHARGE
    return inRange(ms, sessionFrom, sessionTo) ? BATTERY_HALF : BASE
  }

test('battery energy charged from the grid at night carries the night spot', async () => {
  await storeDay('2026-02-15', nightThenSession('2026-02-15T19:00:00Z', '2026-02-15T20:00:00Z'))
  await storePrices('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? 0.2 : 1))
  const id = await session('2026-02-15T19:00:00Z', '2026-02-15T20:00:00Z', 6)
  await derive('2026-02-15', '2026-02-15T22:00:00Z')
  const slots = await mixOf(id)
  expect(total(slots, 'kwh')).toBeCloseTo(6, 9)
  expect(total(slots, 'gridKwh')).toBeCloseTo(3, 9)
  expect(total(slots, 'batteryGridKwh')).toBeCloseTo(3, 9)
  for (const s of slots) expect(s.batteryGridSpotSek).toBeCloseTo(0.2, 9)
  // No SoC in these readings, so no cap: 6 kWh in, 3.6 out.
  const left = 6 - 3.6
  const checkpoint = await houseEnergyService.getPoolDay('2026-02-15')
  expect(checkpoint).toMatchObject({
    capacityKwh: BATTERY_CAPACITY_KWH,
    deriveVersion: DERIVE_VERSION,
  })
  expect(checkpoint?.state.gridKwh).toBeCloseTo(left, 9)
  expect(checkpoint?.state.gridSpotSekSum).toBeCloseTo(left * 0.2, 9)
})

test('battery energy stored without a spot price is battery-unpriced', async () => {
  await storeDay('2026-02-15', nightThenSession('2026-02-15T19:00:00Z', '2026-02-15T20:00:00Z'))
  const id = await session('2026-02-15T19:00:00Z', '2026-02-15T20:00:00Z', 6)
  await derive('2026-02-15', '2026-02-15T22:00:00Z')
  const slots = await mixOf(id)
  expect(total(slots, 'batteryUnpricedKwh')).toBeCloseTo(3, 9)
  expect(total(slots, 'batteryGridKwh')).toBe(0)
  expect(total(slots, 'gridKwh')).toBeCloseTo(3, 9)
})

test('the pool follows the measured SoC: losses leave less energy at a higher cost', async () => {
  // The same night charge (6 kWh at 0.2 SEK), but the battery reports 10 %
  // all day: the pool is capped at 10 % of C and keeps the 1.2 SEK paid.
  await storeDay('2026-02-15', (ms) => ({
    ...(ms < NIGHT_CHARGE_END ? NIGHT_CHARGE : BASE),
    batterySocPct: 10,
  }))
  await storePrices('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? 0.2 : 1))
  await derive('2026-02-15', '2026-02-15T22:00:00Z')
  const checkpoint = await houseEnergyService.getPoolDay('2026-02-15')
  expect(checkpoint?.state.gridKwh).toBeCloseTo(0.1 * BATTERY_CAPACITY_KWH, 9)
  expect(checkpoint?.state.gridSpotSekSum).toBeCloseTo(1.2, 9)
})

test('resuming from a checkpoint gives the same mix as deriving every day', async () => {
  // Charged on the night of 02-15, used by a session on 02-17.
  await storeDay('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? NIGHT_CHARGE : BASE))
  await storeDay('2026-02-16', () => BASE)
  await storeDay('2026-02-17', (ms) =>
    inRange(ms, '2026-02-17T19:00:00Z', '2026-02-17T20:00:00Z') ? BATTERY_HALF : BASE,
  )
  await storePrices('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? 0.2 : 1))
  await storePrices('2026-02-17')
  const id = await session('2026-02-17T19:00:00Z', '2026-02-17T20:00:00Z', 6)
  expect((await derive('2026-02-15', '2026-02-17T22:00:00Z')).days).toBe(4) // 02-14 … 02-17
  const full = await mixOf(id)
  // 02-16 and 02-17: resumed from 02-15's charged checkpoint, not rebuilt (that would be 3).
  expect((await derive('2026-02-17', '2026-02-17T22:00:00Z')).days).toBe(2)
  expect(await mixOf(id)).toEqual(full)
  expect(total(full, 'batteryGridKwh')).toBeCloseTo(3, 9)
  for (const s of full) if (s.batteryGridKwh > 0) expect(s.batteryGridSpotSek).toBeCloseTo(0.2, 9)
})

test('a session spanning midnight widens the derive to its start day', async () => {
  const flows = (ms: number): Flows =>
    inRange(ms, '2026-06-10T21:00:00Z', '2026-06-10T23:00:00Z')
      ? { loadKwh: 0.3, gridImportKwh: 0.3 }
      : BASE
  await storeDay('2026-06-10', flows)
  await storeDay('2026-06-11', flows)
  // 23:00 local on 06-10 → 01:00 local on 06-11.
  const id = await session('2026-06-10T21:00:00Z', '2026-06-10T23:00:00Z', 4)
  const result = await derive('2026-06-11')
  expect(result.days).toBe(3) // 06-10 … 06-12
  const slots = await mixOf(id)
  expect(slots[0].slotStart).toEqual(new Date('2026-06-10T21:00:00Z'))
  expect(total(slots, 'kwh')).toBeCloseTo(4, 9)
  expect(total(slots, 'gridKwh')).toBeCloseTo(4, 9)
  expect(await houseEnergyService.getPoolDay('2026-06-10')).not.toBeNull()
})

test('without a checkpoint for the day before, it rebuilds from the first reading', async () => {
  for (const day of ['2026-06-08', '2026-06-09', '2026-06-10']) await storeDay(day, () => BASE)
  const result = await derive('2026-06-10')
  expect(result.days).toBe(5) // 06-08 … 06-12
  expect(await houseEnergyService.getPoolDay('2026-06-08')).not.toBeNull()
})

test.each([
  ['capacity', { capacityKwh: BATTERY_CAPACITY_KWH / 2, deriveVersion: DERIVE_VERSION }],
  ['derive version', { capacityKwh: BATTERY_CAPACITY_KWH, deriveVersion: DERIVE_VERSION + 1 }],
])('a checkpoint computed with another %s is not resumed from', async (_, params) => {
  await storeDay('2026-06-09', () => BASE)
  await storeDay('2026-06-10', () => BASE)
  await houseEnergyService.replacePoolDaysFrom(
    '2026-06-09',
    [
      {
        day: '2026-06-09',
        state: {
          storedKwh: 5,
          gridKwh: 5,
          gridSpotSekSum: 5,
          solarKwh: 0,
          solarSpotSekSum: 0,
          unpricedKwh: 0,
        },
      },
    ],
    params,
  )
  await derive('2026-06-10')
  const rebuilt = await houseEnergyService.getPoolDay('2026-06-09')
  expect(rebuilt).toMatchObject({
    capacityKwh: BATTERY_CAPACITY_KWH,
    deriveVersion: DERIVE_VERSION,
  })
  expect(rebuilt?.state.storedKwh).toBe(0)
})

test('a session after the last reading is all no-house-data', async () => {
  await storeDay('2026-06-10', () => BASE)
  await storePrices('2026-06-11')
  const id = await session('2026-06-11T10:00:00Z', '2026-06-11T11:00:00Z', 3)
  await derive('2026-06-10')
  const slots = await mixOf(id)
  expect(total(slots, 'noHouseDataKwh')).toBeCloseTo(3, 9)
  expect(total(slots, 'kwh')).toBeCloseTo(3, 9)
})

test('a voided session loses its mix on the next derive', async () => {
  await storeDay('2026-06-10', sunny)
  const id = await session('2026-06-10T07:00:00Z', '2026-06-10T10:00:00Z', 24)
  await derive('2026-06-10')
  expect(await mixOf(id)).not.toEqual([])
  await db.update(evChargeSession).set({ voided: true }).where(eq(evChargeSession.id, id))
  await derive('2026-06-10')
  expect(await mixOf(id)).toEqual([])
})

test('sessions ending before the derive window keep their rows', async () => {
  await storeDay('2026-06-09', () => BASE)
  await storeDay('2026-06-10', () => BASE)
  const early = await session('2026-06-09T10:00:00Z', '2026-06-09T11:00:00Z', 2)
  await derive('2026-06-09')
  const before = await mixOf(early)
  expect(before).not.toEqual([])
  await storeDay('2026-06-10', () => ({ loadKwh: 0.2, gridImportKwh: 0.2 }))
  await derive('2026-06-10')
  expect(await mixOf(early)).toEqual(before)
})

test('deriving twice gives the same rows', async () => {
  await storeDay('2026-06-10', sunny)
  await storePrices('2026-06-10')
  const id = await session('2026-06-10T07:00:00Z', '2026-06-10T10:00:00Z', 24)
  await derive('2026-06-10')
  const first = await mixOf(id)
  await derive('2026-06-10')
  expect(await mixOf(id)).toEqual(first)
})

test('a malformed day is refused', async () => {
  await expect(derive('2026-6-10')).rejects.toThrow(RangeError)
})

test('a request left queued by a failed derive widens the next derive back to its day', async () => {
  for (const day of ['2026-06-08', '2026-06-09', '2026-06-10']) await storeDay(day, () => BASE)
  await derive('2026-06-08')
  // A session stored on 06-08 whose derive then failed: only its request remains.
  const id = await session('2026-06-08T10:00:00Z', '2026-06-08T11:00:00Z', 2)
  await energyMixService.requestDerive('2026-06-08')
  const result = await derive('2026-06-10')
  expect(result.days).toBe(6) // 06-07 … 06-12, not 06-09 … 06-12
  expect(total(await mixOf(id), 'kwh')).toBeCloseTo(2, 9)
  // The queue is empty again: the next derive from 06-10 starts at 06-09.
  expect((await derive('2026-06-10')).days).toBe(4)
})

test('a request queued for hours means derives kept failing: warned, with counts only', async () => {
  await storeDay('2026-06-10', () => BASE)
  await energyMixService.requestDerive('2026-06-10')
  await db.update(energyMixDeriveRequest).set({ requestedAt: new Date(Date.now() - 4 * 3_600_000) })
  const lines: string[] = []
  const capture = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  await deriveFrom('2026-06-10', { log: capture, now: () => new Date('2026-06-12T12:00:00Z') })
  const entries = lines
    .flatMap((l) => l.split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  expect(entries.find((e) => e.msg === 'energy mix derive request was stale')).toMatchObject({
    queuedRequests: 1,
    queuedForMin: expect.any(Number),
  })
  expect(entries.find((e) => e.msg === 'energy mix derived')).toMatchObject({ queuedRequests: 1 })
})

const takeQueue = () =>
  energyMixService.withDeriveLock((tx) => energyMixService.takeDeriveRequests(tx))

test('a derive that fails leaves the queue, the mix and the checkpoints as they were', async () => {
  await storeDay('2026-06-10', sunny)
  const id = await session('2026-06-10T07:00:00Z', '2026-06-10T10:00:00Z', 24)
  await derive('2026-06-10')
  const mix = await mixOf(id)
  const checkpoint = await houseEnergyService.getPoolDay('2026-06-10')
  await energyMixService.requestDerive('2026-06-08')
  // Any mix write now fails (the per-test schema goes, trigger and all).
  await db.execute(sql`
    CREATE FUNCTION refuse_mix() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'mix write refused'; END $$`)
  await db.execute(sql`
    CREATE TRIGGER refuse_mix BEFORE INSERT ON ev_charge_energy_mix
    FOR EACH ROW EXECUTE FUNCTION refuse_mix()`)
  await expect(derive('2026-06-10')).rejects.toThrow()
  await db.execute(sql`DROP TRIGGER refuse_mix ON ev_charge_energy_mix`)
  expect(await mixOf(id)).toEqual(mix)
  expect(await houseEnergyService.getPoolDay('2026-06-10')).toEqual(checkpoint)
  expect(await takeQueue()).toMatchObject({ fromDay: '2026-06-08', count: 1 })
})

test('a matching checkpoint is resumed from: its pool carries into the next days', async () => {
  // The derive from 06-10 starts on 06-09 and resumes from 06-08's checkpoint.
  await storeDay('2026-06-08', () => BASE)
  await storeDay('2026-06-09', () => BASE)
  await storeDay('2026-06-10', (ms) =>
    inRange(ms, '2026-06-10T19:00:00Z', '2026-06-10T20:00:00Z') ? BATTERY_HALF : BASE,
  )
  const id = await session('2026-06-10T19:00:00Z', '2026-06-10T20:00:00Z', 6)
  const pool = {
    storedKwh: 5,
    gridKwh: 5,
    gridSpotSekSum: 1,
    solarKwh: 0,
    solarSpotSekSum: 0,
    unpricedKwh: 0,
  }
  await houseEnergyService.replacePoolDaysFrom('2026-06-08', [{ day: '2026-06-08', state: pool }], {
    capacityKwh: BATTERY_CAPACITY_KWH,
    deriveVersion: DERIVE_VERSION,
  })
  expect((await derive('2026-06-10')).days).toBe(4) // 06-09 … 06-12
  expect((await houseEnergyService.getPoolDay('2026-06-08'))?.state).toEqual(pool)
  const slots = await mixOf(id)
  expect(total(slots, 'batteryGridKwh')).toBeCloseTo(3, 9)
  for (const s of slots) expect(s.batteryGridSpotSek).toBeCloseTo(0.2, 9)
})

test('with no house readings the queue is still taken', async () => {
  await energyMixService.requestDerive('2026-06-08')
  expect(await derive('2026-06-10')).toMatchObject({ days: 0, sessions: 0 })
  expect(await takeQueue()).toBeNull()
})

test('a queued day later than the requested one changes nothing; of several, the earliest wins', async () => {
  for (const day of ['2026-06-08', '2026-06-09', '2026-06-10']) await storeDay(day, () => BASE)
  await derive('2026-06-08')
  await energyMixService.requestDerive('2026-06-11')
  expect((await derive('2026-06-10')).days).toBe(4) // 06-09 … 06-12
  await energyMixService.requestDerive('2026-06-09')
  await energyMixService.requestDerive('2026-06-08')
  expect((await derive('2026-06-10')).days).toBe(6) // 06-07 … 06-12
  expect(await takeQueue()).toBeNull()
})

test('a requested day before the first reading starts the day before that reading', async () => {
  await storeDay('2026-06-08', () => BASE)
  expect((await derive('2026-06-05')).days).toBe(6) // 06-07 … 06-12: nothing earlier has house data
  expect(await houseEnergyService.getPoolDay('2026-06-06')).toBeNull()
  expect((await houseEnergyService.getPoolDay('2026-06-07'))?.state.storedKwh).toBe(0)
})

test('a rebuild runs from the first reading: an early night charge reaches a later session', async () => {
  const nightEnd = stockholmDayBounds('2026-06-08').startMs + 3_600_000
  await storeDay('2026-06-08', (ms) => (ms < nightEnd ? NIGHT_CHARGE : BASE))
  await storeDay('2026-06-09', () => BASE)
  await storeDay('2026-06-10', (ms) =>
    inRange(ms, '2026-06-10T19:00:00Z', '2026-06-10T20:00:00Z') ? BATTERY_HALF : BASE,
  )
  await storePrices('2026-06-08', (ms) => (ms < nightEnd ? 0.2 : 1))
  await storePrices('2026-06-10')
  const early = await session('2026-06-08T10:00:00Z', '2026-06-08T11:00:00Z', 2)
  const late = await session('2026-06-10T19:00:00Z', '2026-06-10T20:00:00Z', 6)
  expect((await derive('2026-06-10')).days).toBe(5) // no checkpoint for 06-09: from 06-08
  expect(total(await mixOf(early), 'kwh')).toBeCloseTo(2, 9)
  const slots = await mixOf(late)
  expect(total(slots, 'batteryGridKwh')).toBeCloseTo(3, 9)
  for (const s of slots) expect(s.batteryGridSpotSek).toBeCloseTo(0.2, 9)
})

test('widening follows a chain of sessions spanning midnight', async () => {
  for (const day of ['2026-06-08', '2026-06-09', '2026-06-10']) await storeDay(day, () => BASE)
  await derive('2026-06-08')
  // 22:00 → 01:00 local twice: 06-08 → 06-09, and 06-09 → 06-10.
  const a = await session('2026-06-08T20:00:00Z', '2026-06-08T23:00:00Z', 3)
  const b = await session('2026-06-09T20:00:00Z', '2026-06-09T23:00:00Z', 3)
  expect((await derive('2026-06-10')).days).toBe(5) // 06-08 … 06-12
  expect(total(await mixOf(a), 'kwh')).toBeCloseTo(3, 9)
  expect(total(await mixOf(b), 'kwh')).toBeCloseTo(3, 9)
})

test('a session running past the last reading is partly no-house-data', async () => {
  await storeDay('2026-06-10', () => BASE)
  // 22:00 → 01:00 local: the hour after midnight has no readings.
  const id = await session('2026-06-10T20:00:00Z', '2026-06-10T23:00:00Z', 3)
  await derive('2026-06-10')
  const slots = await mixOf(id)
  expect(total(slots, 'kwh')).toBeCloseTo(3, 9)
  expect(total(slots, 'noHouseDataKwh')).toBeCloseTo(1, 9)
  expect(total(slots, 'gridKwh')).toBeCloseTo(2, 9)
})

test('deriveAfterSync end to end: queues, derives, empties the queue; a failed derive keeps it', async () => {
  await storeDay('2026-06-10', sunny)
  const id = await session('2026-06-10T07:00:00Z', '2026-06-10T10:00:00Z', 24)
  await deriveAfterSync({ source: 'zaptec', fromDay: '2026-06-10', log })
  expect(total(await mixOf(id), 'kwh')).toBeCloseTo(24, 9)
  expect(await takeQueue()).toBeNull()
  await deriveAfterSync({
    source: 'zaptec',
    fromDay: '2026-06-09',
    log,
    derive: async () => {
      throw new Error('derive failed')
    },
  })
  expect(await takeQueue()).toMatchObject({ fromDay: '2026-06-09' })
})

test("a resume re-derives the previous day, so a checkpoint written before the next day's readings is capped", async () => {
  // 06-10's last bucket charges with SoC 4 %; 06-11's first reading (6 %) arrives later.
  const next = stockholmDayBounds('2026-06-10').endMs
  const lastOf10 = (ms: number): Flows =>
    ms === next - 300_000 ? { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: 4 } : BASE
  await storeDay('2026-06-10', lastOf10)
  await derive('2026-06-10', '2026-06-10T21:00:00Z')
  // Written without a next reading: uncapped.
  expect((await houseEnergyService.getPoolDay('2026-06-10'))?.state.storedKwh).toBeCloseTo(1, 9)
  await storeDay('2026-06-11', (ms) => (ms === next ? { ...BASE, batterySocPct: 6 } : BASE))
  await derive('2026-06-11', '2026-06-11T12:00:00Z')
  // Now capped at the mean SoC, 5 % of C, exactly as a full derive gives.
  const resumed = await houseEnergyService.getPoolDay('2026-06-10')
  expect(resumed?.state.storedKwh).toBeCloseTo(0.05 * BATTERY_CAPACITY_KWH, 9)
  await derive('2026-06-09', '2026-06-11T12:00:00Z')
  expect(await houseEnergyService.getPoolDay('2026-06-10')).toEqual(resumed)
})

/** 22:00 → 01:00 local (CEST) sessions starting on each day in [fromDay, throughDay]. */
async function midnightChain(fromDay: string, throughDay: string) {
  for (let day = fromDay; day <= throughDay; day = addDays(day, 1)) {
    const start = stockholmDayBounds(day).startMs + 22 * 3_600_000
    await session(new Date(start).toISOString(), new Date(start + 3 * 3_600_000).toISOString(), 3)
  }
}
function captureLog() {
  const lines: string[] = []
  const capture = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  const messages = () =>
    lines
      .flatMap((l) => l.split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l).msg as string)
  return { capture, messages }
}
const WINDOW_INSIDE_SESSION = 'energy mix derive window starts inside a session'

test('widening stops after MAX_WIDEN_STEPS and warns that the window starts inside a session', async () => {
  await storeDay('2026-05-20', () => BASE) // the first reading: the window's floor is 05-19
  await derive('2026-05-20') // checkpoints exist: the derive below resumes, no rebuild
  await midnightChain('2026-05-25', '2026-06-11')
  const { capture, messages } = captureLog()
  const result = await deriveFrom('2026-06-12', {
    log: capture,
    now: () => new Date('2026-06-12T12:00:00Z'),
  })
  // From 06-11 (a day early), ten steps back: 06-01, with 05-31's session still spanning in.
  expect(result.fromDay).toBe('2026-06-01')
  expect(messages()).toContain(WINDOW_INSIDE_SESSION)
})

test('a chain exactly MAX_WIDEN_STEPS long widens fully, without a warning', async () => {
  await storeDay('2026-05-20', () => BASE)
  await derive('2026-05-20') // checkpoints exist: the derive below resumes, no rebuild
  await midnightChain('2026-06-01', '2026-06-11')
  const { capture, messages } = captureLog()
  const result = await deriveFrom('2026-06-12', {
    log: capture,
    now: () => new Date('2026-06-12T12:00:00Z'),
  })
  expect(result.fromDay).toBe('2026-06-01')
  expect(messages()).not.toContain(WINDOW_INSIDE_SESSION)
})

test('a requested or queued day after today is clamped to today: a resume, not a rebuild', async () => {
  for (const day of ['2026-06-08', '2026-06-09', '2026-06-10']) await storeDay(day, () => BASE)
  await derive('2026-06-08')
  expect(await derive('2026-06-20')).toMatchObject({ fromDay: '2026-06-11', days: 2 })
  await energyMixService.requestDerive('2026-06-20')
  expect(await derive('2026-06-12')).toMatchObject({ fromDay: '2026-06-11', days: 2 })
})

test('a session with a bogus start (epoch 0) neither throws nor drags the window back', async () => {
  await storeDay('2026-06-10', () => BASE)
  const good = await session('2026-06-10T10:00:00Z', '2026-06-10T11:00:00Z', 2)
  // Zaptec's clock reset: starts at the epoch, ends in the window.
  await session('1970-01-01T00:00:00Z', '2026-06-10T12:00:00Z', 5, { intervals: false })
  await energyMixService.requestDerive('1970-01-01')
  const { capture, messages } = captureLog()
  const result = await deriveFrom('2026-06-10', {
    log: capture,
    now: () => new Date('2026-06-12T12:00:00Z'),
  })
  expect(result.fromDay).toBe('2026-06-09') // the floor: the day before the first reading
  expect(total(await mixOf(good), 'kwh')).toBeCloseTo(2, 9)
  expect(messages()).toContain('energy mix derive skipped glitched sessions')
})

test('a session whose slot would exceed the table bound is skipped, not fatal', async () => {
  await storeDay('2026-06-10', () => BASE)
  const good = await session('2026-06-10T10:00:00Z', '2026-06-10T11:00:00Z', 2)
  // An estimated session with start = end puts everything in one slot.
  const huge = await insertSession({
    startAt: new Date('2026-06-10T12:00:00Z'),
    endAt: new Date('2026-06-10T12:00:00Z'),
    energyKwh: 1500,
  })
  await derive('2026-06-10')
  expect(total(await mixOf(good), 'kwh')).toBeCloseTo(2, 9)
  expect(await mixOf(huge)).toEqual([])
})

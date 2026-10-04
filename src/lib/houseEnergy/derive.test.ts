import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { energyMixDeriveRequest, evChargeSession } from '~/lib/db/schema'
import { createServerLogger } from '~/lib/logger/server'
import * as energyMixService from '~/lib/services/energyMix'
import * as houseEnergyService from '~/lib/services/houseEnergy'
import * as spotPriceService from '~/lib/services/spotPrice'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { insertInterval, insertSession } from '~test/fixtures/evCharging'
import { type Flows, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { DERIVE_VERSION, deriveFrom } from './derive'
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
  expect(result).toMatchObject({ sessions: 1, days: 3 }) // 06-10 … 06-12 (today)
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

test("resuming from the previous day's checkpoint gives the same mix as deriving both days", async () => {
  // Charged on the night of 02-15, used by a session on 02-16.
  await storeDay('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? NIGHT_CHARGE : BASE))
  await storeDay('2026-02-16', (ms) =>
    inRange(ms, '2026-02-16T19:00:00Z', '2026-02-16T20:00:00Z') ? BATTERY_HALF : BASE,
  )
  await storePrices('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? 0.2 : 1))
  await storePrices('2026-02-16')
  const id = await session('2026-02-16T19:00:00Z', '2026-02-16T20:00:00Z', 6)
  await derive('2026-02-15', '2026-02-16T22:00:00Z')
  const full = await mixOf(id)
  await derive('2026-02-16', '2026-02-16T22:00:00Z')
  expect(await mixOf(id)).toEqual(full)
  expect(total(full, 'batteryGridKwh')).toBeCloseTo(3, 9)
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
  expect(result.days).toBe(5) // 06-08 … 06-12, not 06-10 … 06-12
  expect(total(await mixOf(id), 'kwh')).toBeCloseTo(2, 9)
  // The queue is empty again: the next derive from 06-10 stays at 06-10.
  expect((await derive('2026-06-10')).days).toBe(3)
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

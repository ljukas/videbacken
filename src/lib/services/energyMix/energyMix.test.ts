import { eq, inArray } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeEnergyMix, evChargeSession } from '~/lib/db/schema'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import {
  listForSessions,
  MIX_INSERT_BATCH,
  pruneUncounted,
  replaceForSessions,
  withDeriveLock,
} from './energyMix'

setupDatabase()

const QUARTER = 15 * 60_000

function slot(iso: string, over: Partial<MixSlot> = {}): MixSlot {
  return {
    slotStart: new Date(iso),
    kwh: 1,
    gridKwh: 1,
    solarKwh: 0,
    batteryGridKwh: 0,
    batteryGridSpotSek: null,
    batterySolarKwh: 0,
    batterySolarSpotSek: null,
    batteryUnpricedKwh: 0,
    noHouseDataKwh: 0,
    ...over,
  }
}
const rowsOf = (sessionId: string, slots: MixSlot[]) => slots.map((s) => ({ ...s, sessionId }))
const batteryHeavy = {
  kwh: 2,
  gridKwh: 0.5,
  solarKwh: 0.5,
  batteryGridKwh: 1,
  batteryGridSpotSek: 0.3,
}

test('replaceForSessions stores rows that listForSessions returns per session, in slot order', async () => {
  const a = await insertSession()
  const b = await insertSession({
    startAt: new Date('2026-01-02T10:00:00Z'),
    endAt: new Date('2026-01-02T11:00:00Z'),
  })
  await replaceForSessions(
    [a, b],
    [
      ...rowsOf(a, [slot('2026-01-01T10:15:00Z'), slot('2026-01-01T10:00:00Z', batteryHeavy)]),
      ...rowsOf(b, [slot('2026-01-02T10:00:00Z', { kwh: 3, gridKwh: 0, noHouseDataKwh: 3 })]),
    ],
  )
  const mix = await listForSessions([a, b])
  expect(mix.get(a)).toEqual([
    slot('2026-01-01T10:00:00Z', batteryHeavy),
    slot('2026-01-01T10:15:00Z'),
  ])
  expect(mix.get(b)).toEqual([
    slot('2026-01-02T10:00:00Z', { kwh: 3, gridKwh: 0, noHouseDataKwh: 3 }),
  ])
})

test('replacing a session rewrites only its rows and leaves none stale', async () => {
  const a = await insertSession()
  const b = await insertSession()
  await replaceForSessions(
    [a, b],
    [
      ...rowsOf(a, [slot('2026-01-01T10:00:00Z'), slot('2026-01-01T10:15:00Z')]),
      ...rowsOf(b, [slot('2026-01-01T10:00:00Z')]),
    ],
  )
  await replaceForSessions([a], rowsOf(a, [slot('2026-01-01T10:30:00Z')]))
  const mix = await listForSessions([a, b])
  expect(mix.get(a)?.map((s) => s.slotStart.toISOString())).toEqual(['2026-01-01T10:30:00.000Z'])
  expect(mix.get(b)).toHaveLength(1)
})

test('a row for a session not being replaced is refused before anything is written', async () => {
  const a = await insertSession()
  const b = await insertSession()
  await expect(replaceForSessions([a], rowsOf(b, [slot('2026-01-01T10:00:00Z')]))).rejects.toThrow(
    RangeError,
  )
  expect((await listForSessions([a, b])).size).toBe(0)
})

test('more rows than one insert batch are all stored', async () => {
  const a = await insertSession()
  const start = Date.parse('2026-01-01T00:00:00Z')
  const slots = Array.from({ length: MIX_INSERT_BATCH + 1 }, (_, i) =>
    slot(new Date(start + i * QUARTER).toISOString()),
  )
  await replaceForSessions([a], rowsOf(a, slots))
  expect((await listForSessions([a])).get(a)).toHaveLength(MIX_INSERT_BATCH + 1)
})

test('listForSessions: no ids → empty map; sessions without rows are absent', async () => {
  expect(await listForSessions([])).toEqual(new Map())
  const a = await insertSession()
  expect((await listForSessions([a])).has(a)).toBe(false)
})

test('rows go with their session (FK cascade)', async () => {
  const a = await insertSession()
  await replaceForSessions([a], rowsOf(a, [slot('2026-01-01T10:00:00Z')]))
  await db.delete(evChargeSession).where(eq(evChargeSession.id, a))
  expect(await db.select().from(evChargeEnergyMix)).toEqual([])
})

test('the table refuses parts that do not add up, a spot without kWh, an unaligned slot and negative kWh', async () => {
  const a = await insertSession()
  const insert = (over: Partial<MixSlot>) =>
    db.insert(evChargeEnergyMix).values({ ...slot('2026-01-01T10:00:00Z', over), sessionId: a })
  await expectConstraintViolation(insert({ gridKwh: 0.5 }), 'ev_charge_energy_mix_parts_sum_check')
  await expectConstraintViolation(
    insert({ batteryGridSpotSek: 0.3 }),
    'ev_charge_energy_mix_battery_grid_spot_check',
  )
  await expectConstraintViolation(
    insert({ gridKwh: 0, batteryGridKwh: 1 }),
    'ev_charge_energy_mix_battery_grid_spot_check',
  )
  await expectConstraintViolation(
    insert({ gridKwh: 0, batterySolarKwh: 1 }),
    'ev_charge_energy_mix_battery_solar_spot_check',
  )
  await expectConstraintViolation(
    insert({ slotStart: new Date('2026-01-01T10:05:00Z') }),
    'ev_charge_energy_mix_slot_start_check',
  )
  await expectConstraintViolation(
    insert({ kwh: 0, gridKwh: -1, solarKwh: 1 }),
    'ev_charge_energy_mix_kwh_nonneg_check',
  )
  // The derive never writes an empty slot.
  await expectConstraintViolation(
    insert({ kwh: 0, gridKwh: 0 }),
    'ev_charge_energy_mix_kwh_nonneg_check',
  )
})

test('the table refuses NaN and infinite values', async () => {
  const a = await insertSession()
  const insert = (over: Partial<MixSlot>) =>
    db.insert(evChargeEnergyMix).values({ ...slot('2026-01-01T10:00:00Z', over), sessionId: a })
  await expectConstraintViolation(
    insert({ kwh: Number.NaN, gridKwh: Number.NaN }),
    'ev_charge_energy_mix_kwh_nonneg_check',
  )
  await expectConstraintViolation(
    insert({ gridKwh: Number.NaN }),
    'ev_charge_energy_mix_parts_sum_check',
  )
  await expectConstraintViolation(
    insert({ gridKwh: 0, batteryGridKwh: 1, batteryGridSpotSek: Number.POSITIVE_INFINITY }),
    'ev_charge_energy_mix_battery_grid_spot_check',
  )
  await expectConstraintViolation(
    insert({ gridKwh: 0, batterySolarKwh: 1, batterySolarSpotSek: Number.NaN }),
    'ev_charge_energy_mix_battery_solar_spot_check',
  )
  // Battery spots far above any market price are allowed: losses raise them.
  await insert({ gridKwh: 0, batteryGridKwh: 1, batteryGridSpotSek: 4200 })
  expect((await listForSessions([a])).get(a)?.[0].batteryGridSpotSek).toBe(4200)
})

test('pruneUncounted drops the rows of no-longer-counted sessions that end after the instant', async () => {
  const counted = await insertSession({
    startAt: new Date('2026-01-05T10:00:00Z'),
    endAt: new Date('2026-01-05T11:00:00Z'),
  })
  const voided = await insertSession({
    startAt: new Date('2026-01-05T12:00:00Z'),
    endAt: new Date('2026-01-05T13:00:00Z'),
  })
  const earlierVoided = await insertSession({
    startAt: new Date('2026-01-01T10:00:00Z'),
    endAt: new Date('2026-01-01T11:00:00Z'),
  })
  await replaceForSessions(
    [counted, voided, earlierVoided],
    [
      ...rowsOf(counted, [slot('2026-01-05T10:00:00Z')]),
      ...rowsOf(voided, [slot('2026-01-05T12:00:00Z')]),
      ...rowsOf(earlierVoided, [slot('2026-01-01T10:00:00Z')]),
    ],
  )
  await db
    .update(evChargeSession)
    .set({ voided: true })
    .where(inArray(evChargeSession.id, [voided, earlierVoided]))
  expect(await pruneUncounted(new Date('2026-01-05T00:00:00Z'))).toBe(1)
  const left = await listForSessions([counted, voided, earlierVoided])
  expect([...left.keys()].sort()).toEqual([counted, earlierVoided].sort())
})

test('withDeriveLock runs its writes in one transaction that a throw rolls back', async () => {
  const a = await insertSession()
  await expect(
    withDeriveLock(async (tx) => {
      await replaceForSessions([a], rowsOf(a, [slot('2026-01-01T10:00:00Z')]), tx)
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect((await listForSessions([a])).size).toBe(0)
  await withDeriveLock((tx) =>
    replaceForSessions([a], rowsOf(a, [slot('2026-01-01T10:00:00Z')]), tx),
  )
  expect((await listForSessions([a])).get(a)).toHaveLength(1)
})

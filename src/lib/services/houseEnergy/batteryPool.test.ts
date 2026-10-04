import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { batteryPoolDay, houseEnergyReading } from '~/lib/db/schema'
import type { PoolState } from '~/lib/houseEnergy/mix/pool'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { reading, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { getPoolDay, measureBatteryCapacity, replacePoolDaysFrom } from './batteryPool'
import { firstReadingAt, listReadings, replaceDay } from './houseEnergy'

setupDatabase()

const P = { capacityKwh: 7.5, deriveVersion: 1 }
const state = (gridKwh: number, solarKwh = 0): PoolState => ({
  storedKwh: gridKwh + solarKwh,
  gridKwh,
  gridSpotSekSum: gridKwh * 0.5,
  solarKwh,
  solarSpotSekSum: solarKwh * 0.25,
  unpricedKwh: 0,
})
const storedDays = async () =>
  (
    await db.select({ day: batteryPoolDay.day }).from(batteryPoolDay).orderBy(batteryPoolDay.day)
  ).map((r) => r.day)
async function storeDay(day: string, flows: Parameters<typeof syntheticDay>[1]) {
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay(
    { dayStart: new Date(startMs), dayEnd: new Date(endMs) },
    syntheticDay(day, flows),
  )
}

test('getPoolDay is null without a checkpoint and round-trips one with its params', async () => {
  expect(await getPoolDay('2026-06-10')).toBeNull()
  await replacePoolDaysFrom('2026-06-10', [{ day: '2026-06-10', state: state(2, 1) }], P)
  expect(await getPoolDay('2026-06-10')).toEqual({ state: state(2, 1), ...P })
})

test('replacePoolDaysFrom rewrites the days from `day` on and keeps earlier ones', async () => {
  await replacePoolDaysFrom(
    '2026-06-08',
    ['2026-06-08', '2026-06-09', '2026-06-10'].map((day) => ({ day, state: state(1) })),
    P,
  )
  await replacePoolDaysFrom('2026-06-09', [{ day: '2026-06-09', state: state(5) }], P)
  expect(await storedDays()).toEqual(['2026-06-08', '2026-06-09'])
  expect((await getPoolDay('2026-06-09'))?.state).toEqual(state(5))
  expect((await getPoolDay('2026-06-08'))?.state).toEqual(state(1))
})

test('an empty list clears every checkpoint from `day` on', async () => {
  await replacePoolDaysFrom(
    '2026-06-08',
    ['2026-06-08', '2026-06-09'].map((day) => ({ day, state: state(1) })),
    P,
  )
  await replacePoolDaysFrom('2026-06-09', [], P)
  expect(await storedDays()).toEqual(['2026-06-08'])
})

test('a row before `day` or a malformed day is refused before anything changes', async () => {
  await replacePoolDaysFrom('2026-06-08', [{ day: '2026-06-08', state: state(1) }], P)
  await expect(
    replacePoolDaysFrom('2026-06-09', [{ day: '2026-06-08', state: state(2) }], P),
  ).rejects.toThrow(RangeError)
  await expect(replacePoolDaysFrom('2026-6-9', [], P)).rejects.toThrow(RangeError)
  await expect(getPoolDay('yesterday')).rejects.toThrow(RangeError)
  expect(await storedDays()).toEqual(['2026-06-08'])
})

test('the table refuses inconsistent or non-finite checkpoints', async () => {
  const row = (over: Partial<typeof batteryPoolDay.$inferInsert>) =>
    db.insert(batteryPoolDay).values({ day: '2026-06-10', ...state(1), ...P, ...over })
  await expectConstraintViolation(row({ storedKwh: 2 }), 'battery_pool_day_stored_sum_check')
  await expectConstraintViolation(row({ capacityKwh: 0 }), 'battery_pool_day_capacity_kwh_check')
  await expectConstraintViolation(
    row({ deriveVersion: 0 }),
    'battery_pool_day_derive_version_check',
  )
  await expectConstraintViolation(
    row({ storedKwh: Number.NaN, gridKwh: Number.NaN }),
    'battery_pool_day_kwh_nonneg_check',
  )
  await expectConstraintViolation(
    row({ gridSpotSekSum: Number.POSITIVE_INFINITY }),
    'battery_pool_day_spot_sums_finite_check',
  )
  await expectConstraintViolation(
    row({ solarSpotSekSum: Number.NaN }),
    'battery_pool_day_spot_sums_finite_check',
  )
})

test('measureBatteryCapacity: kWh delivered per 100 % SoC over discharge-only pairs', async () => {
  expect(await measureBatteryCapacity()).toBeNull()
  // 2026-06-10: 100 buckets charging (not measured), then 0.04 kWh out per
  // bucket while the SoC falls 0.5 % per bucket → 8 kWh per 100 %. Bucket 150
  // also charges, so the two pairs touching it are left out.
  await storeDay('2026-06-10', (_, i) => {
    if (i < 100) return { batteryChargeSolarKwh: 0.1, solarKwh: 0.1, batterySocPct: i * 0.9 }
    const discharging = {
      batteryDischargeKwh: 0.04,
      loadKwh: 0.04,
      batterySocPct: 100 - (i - 100) * 0.5,
    }
    return i === 150
      ? { ...discharging, batteryChargeGridKwh: 0.5, gridImportKwh: 0.5 }
      : discharging
  })
  const measured = await measureBatteryCapacity()
  expect(measured?.capacityKwh).toBeCloseTo(8, 9)
  // Buckets 100–287: 187 adjacent pairs, minus the two touching bucket 150.
  expect(measured?.pairs).toBe(185)
  const { startMs } = stockholmDayBounds('2026-06-10')
  expect(measured?.from).toEqual(new Date(startMs + 100 * 300_000))
  expect(measured?.to).toEqual(new Date(startMs + 287 * 300_000))
})

test('measureBatteryCapacity ignores pairs across a gap or without a SoC', async () => {
  const discharging = (soc: number | null) => (_: number, i: number) => ({
    batteryDischargeKwh: 0.04,
    loadKwh: 0.04,
    batterySocPct: soc === null ? null : soc - i * 0.25,
  })
  // Every other bucket missing: no two adjacent readings.
  const { startMs, endMs } = stockholmDayBounds('2026-06-10')
  await replaceDay(
    { dayStart: new Date(startMs), dayEnd: new Date(endMs) },
    syntheticDay('2026-06-10', discharging(100)).filter((_, i) => i % 2 === 0),
  )
  await storeDay('2026-06-11', discharging(null))
  expect(await measureBatteryCapacity()).toBeNull()
})

test("listReadings and firstReadingAt read inside a caller's transaction", async () => {
  // The test pool has one connection: using `db` instead of `tx` here would hang.
  await db.transaction(async (tx) => {
    await tx
      .insert(houseEnergyReading)
      .values(reading(Date.parse('2026-06-10T10:00:00Z'), { loadKwh: 0.1, gridImportKwh: 0.1 }))
    expect(await firstReadingAt(tx)).toEqual(new Date('2026-06-10T10:00:00Z'))
    const rows = await listReadings(
      { from: new Date('2026-06-10T00:00:00Z'), to: new Date('2026-06-11T00:00:00Z') },
      tx,
    )
    expect(rows).toHaveLength(1)
  })
})

test('measureBatteryCapacity leaves out pairs touching a bucket without SoC', async () => {
  // As the happy path, with bucket 150's SoC missing instead of a charge.
  await storeDay('2026-06-10', (_, i) => {
    if (i < 100) return { batteryChargeSolarKwh: 0.1, solarKwh: 0.1, batterySocPct: i * 0.9 }
    return {
      batteryDischargeKwh: 0.04,
      loadKwh: 0.04,
      batterySocPct: i === 150 ? null : 100 - (i - 100) * 0.5,
    }
  })
  const measured = await measureBatteryCapacity()
  expect(measured?.pairs).toBe(185)
  expect(measured?.capacityKwh).toBeCloseTo(8, 9)
})

test('measureBatteryCapacity counts the mean of each pair’s two discharges, and skips idle buckets', async () => {
  // Discharge ramps 0.02, 0.04, 0.06, …; the SoC drop between rows spans half
  // of each bucket, so it falls by (d_i + d_{i+1}) / 2 / 8 × 100 % per pair.
  // Bucket 20 is idle (no flow, SoC unchanged): its two pairs are left out.
  const discharge = (i: number) => (i === 20 ? 0 : 0.02 * (1 + (i % 10)))
  let soc = 90
  const socs: number[] = []
  for (let i = 0; i < 40; i++) {
    socs.push(soc)
    soc -= ((discharge(i) + discharge(i + 1)) / 2 / 8) * 100
  }
  const { startMs } = stockholmDayBounds('2026-06-10')
  await replaceDay(
    { dayStart: new Date(startMs), dayEnd: new Date(stockholmDayBounds('2026-06-10').endMs) },
    socs.map((s, i) =>
      reading(startMs + i * 300_000, {
        batteryDischargeKwh: discharge(i),
        loadKwh: discharge(i),
        batterySocPct: s,
      }),
    ),
  )
  const measured = await measureBatteryCapacity()
  expect(measured?.pairs).toBe(39 - 2)
  expect(measured?.capacityKwh).toBeCloseTo(8, 9)
})

test('measureBatteryCapacity is null when the SoC never falls', async () => {
  await storeDay('2026-06-10', () => ({
    batteryDischargeKwh: 0.04,
    loadKwh: 0.04,
    batterySocPct: 50,
  }))
  expect(await measureBatteryCapacity()).toBeNull()
  // A day apart, so no pair spans the two.
  await storeDay('2026-06-12', (_, i) => ({
    batteryDischargeKwh: 0.04,
    loadKwh: 0.04,
    batterySocPct: 10 + i * 0.1,
  }))
  expect(await measureBatteryCapacity()).toBeNull()
})

test('replacePoolDaysFrom rolls back when an insert fails', async () => {
  await replacePoolDaysFrom(
    '2026-06-08',
    ['2026-06-08', '2026-06-09'].map((day) => ({ day, state: state(1) })),
    P,
  )
  await expect(
    replacePoolDaysFrom(
      '2026-06-08',
      [
        { day: '2026-06-08', state: state(2) },
        { day: '2026-06-08', state: state(3) },
      ],
      P,
    ),
  ).rejects.toThrow()
  expect(await storedDays()).toEqual(['2026-06-08', '2026-06-09'])
  expect((await getPoolDay('2026-06-08'))?.state).toEqual(state(1))
})

test('a malformed row day is refused; a row on `day` itself is fine', async () => {
  await expect(
    replacePoolDaysFrom('2026-06-08', [{ day: '2026-6-9', state: state(1) }], P),
  ).rejects.toThrow(RangeError)
  await replacePoolDaysFrom('2026-06-08', [{ day: '2026-06-08', state: state(1) }], P)
  expect(await storedDays()).toEqual(['2026-06-08'])
})

test('checkpoints round-trip distinct params', async () => {
  const other = { capacityKwh: 6.2, deriveVersion: 3 }
  await replacePoolDaysFrom('2026-06-10', [{ day: '2026-06-10', state: state(1) }], other)
  expect(await getPoolDay('2026-06-10')).toEqual({ state: state(1), ...other })
})

test("the pool service reads and writes inside a caller's transaction", async () => {
  // The test pool has one connection: a function using `db` instead of `tx` would hang.
  await expect(
    db.transaction(async (tx) => {
      await replacePoolDaysFrom('2026-06-10', [{ day: '2026-06-10', state: state(1) }], P, tx)
      expect(await getPoolDay('2026-06-10', tx)).toEqual({ state: state(1), ...P })
      expect(await measureBatteryCapacity(tx)).toBeNull()
      throw new Error('roll back')
    }),
  ).rejects.toThrow('roll back')
  expect(await getPoolDay('2026-06-10')).toBeNull()
})

test('the table refuses negative parts, a huge pool, a capacity of 100 and -Infinity spot sums', async () => {
  const row = (over: Partial<typeof batteryPoolDay.$inferInsert>) =>
    db.insert(batteryPoolDay).values({ day: '2026-06-10', ...state(1), ...P, ...over })
  await expectConstraintViolation(
    row({ gridKwh: -1, solarKwh: 2, storedKwh: 1 }),
    'battery_pool_day_kwh_nonneg_check',
  )
  await expectConstraintViolation(
    row({ storedKwh: 1000, gridKwh: 1000 }),
    'battery_pool_day_kwh_nonneg_check',
  )
  await expectConstraintViolation(row({ capacityKwh: 100 }), 'battery_pool_day_capacity_kwh_check')
  await expectConstraintViolation(
    row({ solarSpotSekSum: Number.NEGATIVE_INFINITY }),
    'battery_pool_day_spot_sums_finite_check',
  )
  // Negative spot sums are real (negative prices).
  await row({ gridSpotSekSum: -0.4 })
  expect((await getPoolDay('2026-06-10'))?.state.gridSpotSekSum).toBe(-0.4)
})

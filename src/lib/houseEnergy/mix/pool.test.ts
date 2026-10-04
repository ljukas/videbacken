import { expect, test } from 'vitest'
import { reading } from '~test/fixtures/houseEnergy'
import {
  BATTERY_CAPACITY_KWH,
  type BatteryOut,
  emptyPool,
  endOfBucketSocPct,
  type PoolState,
  stepPool,
} from './pool'

const T = Date.UTC(2026, 1, 15, 1)

/** A pool from its parts (storedKwh is always their sum). */
function pool(parts: Partial<PoolState>): PoolState {
  const s = { ...emptyPool(), ...parts }
  return { ...s, storedKwh: s.gridKwh + s.solarKwh + s.unpricedKwh }
}
function expectOut(actual: BatteryOut, expected: Partial<BatteryOut>) {
  const full: BatteryOut = {
    gridKwh: 0,
    gridSpotSekSum: 0,
    solarKwh: 0,
    solarSpotSekSum: 0,
    unpricedKwh: 0,
    ...expected,
  }
  for (const key of Object.keys(full) as (keyof BatteryOut)[]) {
    expect(actual[key], key).toBeCloseTo(full[key], 12)
  }
}
function expectPool(actual: PoolState, expected: Partial<PoolState>) {
  const full = pool(expected)
  for (const key of Object.keys(full) as (keyof PoolState)[]) {
    expect(actual[key], key).toBeCloseTo(full[key], 12)
  }
}

test('BATTERY_CAPACITY_KWH is a plausible kWh per 100 % SoC', () => {
  expect(BATTERY_CAPACITY_KWH).toBeGreaterThan(5)
  expect(BATTERY_CAPACITY_KWH).toBeLessThan(12)
})

test('grid charging (charge_grid and charge_ac) enters at its full kWh at the slot spot', () => {
  const r = reading(T, { batteryChargeGridKwh: 1, batteryChargeAcKwh: 0.5 })
  const { next, out } = stepPool(emptyPool(), r, 0.2, null)
  expectPool(next, { gridKwh: 1.5, gridSpotSekSum: 0.3 })
  expectOut(out, {})
})

test('solar charging carries its slot spot as value', () => {
  const { next } = stepPool(emptyPool(), reading(T, { batteryChargeSolarKwh: 1 }), 0.6, null)
  expectPool(next, { solarKwh: 1, solarSpotSekSum: 0.6 })
})

test('charging in a slot without a spot price is unpriced', () => {
  const r = reading(T, { batteryChargeGridKwh: 1, batteryChargeSolarKwh: 1 })
  expectPool(stepPool(emptyPool(), r, null, null).next, { unpricedKwh: 2 })
})

test('a discharge takes every part in proportion and keeps each average spot', () => {
  const s = pool({ gridKwh: 2, gridSpotSekSum: 2, solarKwh: 2, solarSpotSekSum: 1 })
  const { next, out } = stepPool(s, reading(T, { batteryDischargeKwh: 1 }), 5, null)
  expectOut(out, { gridKwh: 0.5, gridSpotSekSum: 0.5, solarKwh: 0.5, solarSpotSekSum: 0.25 })
  expectPool(next, { gridKwh: 1.5, gridSpotSekSum: 1.5, solarKwh: 1.5, solarSpotSekSum: 0.75 })
})

test('a discharge beyond the pool empties it; the excess is grid at the current spot (drift)', () => {
  const s = pool({ solarKwh: 1, solarSpotSekSum: 0.4 })
  const { next, out } = stepPool(s, reading(T, { batteryDischargeKwh: 1.5 }), 2, null)
  expectOut(out, { solarKwh: 1, solarSpotSekSum: 0.4, gridKwh: 0.5, gridSpotSekSum: 1 })
  expect(next).toEqual(emptyPool())
})

test("an empty pool's discharge without a spot price is unpriced", () => {
  const { next, out } = stepPool(emptyPool(), reading(T, { batteryDischargeKwh: 0.3 }), null, null)
  expectOut(out, { unpricedKwh: 0.3 })
  expect(next).toEqual(emptyPool())
})

test('charge and discharge in one bucket: the inflow joins before the outflow leaves', () => {
  const r = reading(T, { batteryChargeGridKwh: 1, batteryDischargeKwh: 0.45 })
  const { next, out } = stepPool(emptyPool(), r, 1, null)
  expectOut(out, { gridKwh: 0.45, gridSpotSekSum: 0.45 })
  expectPool(next, { gridKwh: 0.55, gridSpotSekSum: 0.55 })
})

test('float dust left after a discharge resets the pool to empty', () => {
  const s = pool({ gridKwh: 1, gridSpotSekSum: 1 })
  const { next } = stepPool(s, reading(T, { batteryDischargeKwh: 1 - 1e-13 }), 1, null)
  expect(next).toEqual(emptyPool())
})

test('above the cap every part shrinks by one factor and keeps its spot sum (losses raise the cost)', () => {
  const s = pool({
    gridKwh: 3,
    gridSpotSekSum: 1.5,
    solarKwh: 1,
    solarSpotSekSum: 0.8,
    unpricedKwh: 1,
  })
  const { next, out } = stepPool(s, reading(T), 1, 2.5)
  expectOut(out, {})
  expectPool(next, {
    gridKwh: 1.5,
    gridSpotSekSum: 1.5,
    solarKwh: 0.5,
    solarSpotSekSum: 0.8,
    unpricedKwh: 0.5,
  })
})

test("the cap applies after the bucket's inflow and outflow", () => {
  // 2 in, 0.5 out → 1.5 stored, capped at 1.2; the 2 SEK paid stay, less the 0.5 that left.
  const r = reading(T, { batteryChargeGridKwh: 2, batteryDischargeKwh: 0.5 })
  const { next, out } = stepPool(emptyPool(), r, 1, 1.2)
  expectOut(out, { gridKwh: 0.5, gridSpotSekSum: 0.5 })
  expectPool(next, { gridKwh: 1.2, gridSpotSekSum: 1.5 })
})

test('below the cap nothing changes: the pool never invents energy', () => {
  const s = pool({ gridKwh: 1, gridSpotSekSum: 0.5 })
  expect(stepPool(s, reading(T), 1, 5).next).toEqual(s)
})

test('a cap of 0 empties the pool', () => {
  const s = pool({ gridKwh: 1, gridSpotSekSum: 0.5 })
  expect(stepPool(s, reading(T), 1, 0).next).toEqual(emptyPool())
})

test("the end-of-bucket SoC is the mean of this and the next reading's (Emaldo's SoC is mid-bucket)", () => {
  const r = reading(T, { batterySocPct: 40 })
  expect(endOfBucketSocPct(r, reading(T + 300_000, { batterySocPct: 45 }))).toBe(42.5)
})

test('no end-of-bucket SoC without both values or across a gap', () => {
  const r = reading(T, { batterySocPct: 40 })
  expect(endOfBucketSocPct(r, undefined)).toBeNull()
  expect(endOfBucketSocPct(r, reading(T + 300_000))).toBeNull()
  expect(endOfBucketSocPct(reading(T), reading(T + 300_000, { batterySocPct: 45 }))).toBeNull()
  expect(endOfBucketSocPct(r, reading(T + 600_000, { batterySocPct: 45 }))).toBeNull()
})

test('stepPool never mutates its input', () => {
  const s = pool({ gridKwh: 2, gridSpotSekSum: 2 })
  const copy = structuredClone(s)
  stepPool(s, reading(T, { batteryDischargeKwh: 1, batteryChargeSolarKwh: 1 }), 1, 0.5)
  expect(s).toEqual(copy)
})

test('a long random run keeps every part non-negative, stored equal to their sum and under the cap', () => {
  let seed = 11
  const rand = () => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  let s = emptyPool()
  for (let i = 0; i < 10_000; i++) {
    const r = reading(T + i * 300_000, {
      batteryChargeGridKwh: rand() < 0.3 ? rand() * 0.4 : 0,
      batteryChargeSolarKwh: rand() < 0.3 ? rand() * 0.4 : 0,
      batteryDischargeKwh: rand() < 0.4 ? rand() * 0.5 : 0,
    })
    const cap = rand() < 0.2 ? null : rand() * 8
    const { next, out } = stepPool(s, r, rand() < 0.1 ? null : rand() * 3 - 0.5, cap)
    for (const v of [
      next.gridKwh,
      next.solarKwh,
      next.unpricedKwh,
      out.gridKwh,
      out.solarKwh,
      out.unpricedKwh,
    ]) {
      expect(v).toBeGreaterThanOrEqual(0)
    }
    expect(next.storedKwh).toBeCloseTo(next.gridKwh + next.solarKwh + next.unpricedKwh, 9)
    if (cap !== null) expect(next.storedKwh).toBeLessThanOrEqual(cap + 1e-12)
    expect(out.gridKwh + out.solarKwh + out.unpricedKwh).toBeCloseTo(r.batteryDischargeKwh, 9)
    s = next
  }
})

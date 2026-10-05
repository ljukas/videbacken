import { expect, test } from 'vitest'
import { addPeriodSums, energyFigures, gapHours, type PeriodSums } from './figures'
import { BATTERY_CAPACITY_KWH } from './mix/pool'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 0,
  gridExportKwh: 0,
  solarKwh: 0,
  loadKwh: 0,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  carKwh: 0,
  firstSocPct: null,
  lastSocPct: null,
  buckets: 0,
  expectedBuckets: 0,
  ...over,
})

test('splits solar into battery, exported and direct use', () => {
  const f = energyFigures(sums({ solarKwh: 500, batteryChargeSolarKwh: 170, gridExportKwh: 110 }))
  expect(f.solarToBattery).toBe(170)
  expect(f.solarExported).toBe(110)
  expect(f.solarDirect).toBe(220)
})

test('export beyond the solar surplus is not counted as solar', () => {
  // 10 kWh solar, 8 to the battery: at most 2 kWh of the 5 exported was solar.
  const f = energyFigures(sums({ solarKwh: 10, batteryChargeSolarKwh: 8, gridExportKwh: 5 }))
  expect(f.solarExported).toBe(2)
  expect(f.solarDirect).toBe(0)
})

test('battery charging from solar above production never makes direct use negative', () => {
  const f = energyFigures(sums({ solarKwh: 5, batteryChargeSolarKwh: 6 }))
  expect(f.solarExported).toBe(0)
  expect(f.solarDirect).toBe(0)
})

test('splits import into battery charging and direct use', () => {
  const f = energyFigures(sums({ gridImportKwh: 560, batteryChargeGridKwh: 68 }))
  expect(f.importToBattery).toBe(68)
  expect(f.importDirect).toBe(492)
})

test('grid charging above import is capped at import', () => {
  const f = energyFigures(sums({ gridImportKwh: 3, batteryChargeGridKwh: 4 }))
  expect(f.importToBattery).toBe(3)
  expect(f.importDirect).toBe(0)
})

test('self-sufficiency is the share of load not bought', () => {
  expect(energyFigures(sums({ gridImportKwh: 364, loadKwh: 898 })).selfSufficiency).toBeCloseTo(
    1 - 364 / 898,
    12,
  )
})

test('self-sufficiency is 0 when import exceeds load, and null without load', () => {
  expect(energyFigures(sums({ gridImportKwh: 671, loadKwh: 620 })).selfSufficiency).toBe(0)
  expect(energyFigures(sums({ gridImportKwh: 1 })).selfSufficiency).toBeNull()
})

test('car and the rest of the house; car above load leaves 0 for the house', () => {
  const f = energyFigures(sums({ loadKwh: 947, carKwh: 312 }))
  expect(f.car).toBe(312)
  expect(f.restOfHouse).toBe(635)
  expect(energyFigures(sums({ loadKwh: 2, carKwh: 3 })).restOfHouse).toBe(0)
})

test('battery in/out, SoC-corrected loss and efficiency', () => {
  const f = energyFigures(
    sums({
      batteryChargeSolarKwh: 170,
      batteryChargeGridKwh: 70,
      batteryDischargeKwh: 220,
      firstSocPct: 20,
      lastSocPct: 70,
    }),
  )
  const delta = (50 / 100) * BATTERY_CAPACITY_KWH
  expect(f.batteryIn).toBe(240)
  expect(f.batteryOut).toBe(220)
  expect(f.deltaStored).toBeCloseTo(delta, 12)
  expect(f.loss).toBeCloseTo(240 - 220 - delta, 12)
  expect(f.efficiency).toBeCloseTo(220 / (240 - delta), 12)
  expect(f.gridChargedShare).toBeCloseTo(70 / 240, 12)
})

test('a missing SoC at either end means no SoC correction', () => {
  const f = energyFigures(
    sums({ batteryChargeSolarKwh: 10, batteryDischargeKwh: 8, firstSocPct: 40 }),
  )
  expect(f.deltaStored).toBe(0)
  expect(f.loss).toBe(2)
})

test('efficiency is capped at 1 and hidden below 1 kWh in; grid share hidden below 1 kWh in', () => {
  expect(
    energyFigures(sums({ batteryChargeSolarKwh: 10, batteryDischargeKwh: 11 })).efficiency,
  ).toBe(1)
  const small = energyFigures(sums({ batteryChargeGridKwh: 0.9, batteryDischargeKwh: 0.5 }))
  expect(small.efficiency).toBeNull()
  expect(small.gridChargedShare).toBeNull()
})

test('a capacity can be passed (the default is BATTERY_CAPACITY_KWH)', () => {
  const f = energyFigures(sums({ firstSocPct: 0, lastSocPct: 100 }), 10)
  expect(f.deltaStored).toBe(10)
})

test('coverage, missing hours and the gap note', () => {
  const f = energyFigures(sums({ buckets: 288 * 30 - 113, expectedBuckets: 288 * 30 }))
  expect(f.coverage).toBeCloseTo(1 - 113 / (288 * 30), 12)
  expect(f.missingHours).toBeCloseTo((113 * 5) / 60, 12)
  expect(gapHours(f)).toBe(9)
  // 99 % or better: no note.
  expect(gapHours(energyFigures(sums({ buckets: 99, expectedBuckets: 100 })))).toBeNull()
  // Under an hour but below 99 %: at least 1 h.
  expect(gapHours(energyFigures(sums({ buckets: 3, expectedBuckets: 6 })))).toBe(1)
  expect(energyFigures(sums()).coverage).toBeNull()
})

test('addPeriodSums adds flows and buckets and keeps the outer SoCs', () => {
  const jan = sums({
    gridImportKwh: 1,
    buckets: 2,
    expectedBuckets: 3,
    firstSocPct: 10,
    lastSocPct: 20,
    carKwh: 1,
  })
  const feb = sums({
    gridImportKwh: 2,
    buckets: 4,
    expectedBuckets: 4,
    firstSocPct: 30,
    lastSocPct: 40,
    carKwh: 2,
  })
  expect(addPeriodSums(jan, feb)).toEqual(
    sums({
      gridImportKwh: 3,
      buckets: 6,
      expectedBuckets: 7,
      firstSocPct: 10,
      lastSocPct: 40,
      carKwh: 3,
    }),
  )
  // A month without SoC doesn't erase the other's.
  const noSoc = sums({ gridImportKwh: 1 })
  expect(addPeriodSums(jan, noSoc).lastSocPct).toBe(20)
  expect(addPeriodSums(noSoc, feb).firstSocPct).toBe(30)
})

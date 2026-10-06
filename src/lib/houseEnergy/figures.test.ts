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

test('car and the rest of the house; car above load is capped at load, leaving 0 for the house', () => {
  const f = energyFigures(sums({ loadKwh: 947, carKwh: 312 }))
  expect(f.car).toBe(312)
  expect(f.restOfHouse).toBe(635)
  const over = energyFigures(sums({ loadKwh: 2, carKwh: 3 }))
  expect(over.car).toBe(2)
  expect(over.restOfHouse).toBe(0)
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

test('addPeriodSums adds flows and buckets and keeps the outer SoCs (distinct values)', () => {
  // Each numeric field has a distinct nonzero value per operand to catch copy-paste bugs.
  const jan = sums({
    gridImportKwh: 1,
    gridExportKwh: 2,
    solarKwh: 4,
    loadKwh: 8,
    batteryDischargeKwh: 16,
    batteryChargeSolarKwh: 32,
    batteryChargeGridKwh: 64,
    carKwh: 128,
    buckets: 256,
    expectedBuckets: 512,
    firstSocPct: 10,
    lastSocPct: 20,
  })
  const feb = sums({
    gridImportKwh: 3,
    gridExportKwh: 6,
    solarKwh: 12,
    loadKwh: 24,
    batteryDischargeKwh: 48,
    batteryChargeSolarKwh: 96,
    batteryChargeGridKwh: 192,
    carKwh: 384,
    buckets: 768,
    expectedBuckets: 1024,
    firstSocPct: 30,
    lastSocPct: 40,
  })
  expect(addPeriodSums(jan, feb)).toEqual(
    sums({
      gridImportKwh: 4,
      gridExportKwh: 8,
      solarKwh: 16,
      loadKwh: 32,
      batteryDischargeKwh: 64,
      batteryChargeSolarKwh: 128,
      batteryChargeGridKwh: 256,
      carKwh: 512,
      buckets: 1024,
      expectedBuckets: 1536,
      firstSocPct: 10,
      lastSocPct: 40,
    }),
  )
  // A month without SoC doesn't erase the other's.
  const noSoc = sums({ gridImportKwh: 1 })
  expect(addPeriodSums(jan, noSoc).lastSocPct).toBe(20)
  expect(addPeriodSums(noSoc, feb).firstSocPct).toBe(30)
})

test('addPeriodSums keeps earlier.firstSocPct when both are present (guards ?? vs ||)', () => {
  // Ensure `earlier.firstSocPct ?? later.firstSocPct` works correctly when earlier is 0.
  const earlier = sums({ firstSocPct: 0, gridImportKwh: 1 })
  const later = sums({ firstSocPct: 30, gridImportKwh: 2 })
  expect(addPeriodSums(earlier, later).firstSocPct).toBe(0)
})

test('efficiency floor: netIn >= 1 (SoC-corrected charge)', () => {
  // charge 10 kWh, SoC goes 0 → 100: deltaStored = 1.0 × capacity (default ~7.58 kWh)
  // netIn = 10 - 7.58 ≈ 2.42 >= 1, so efficiency is non-null.
  const f = energyFigures(
    sums({
      batteryChargeGridKwh: 10,
      batteryDischargeKwh: 0,
      firstSocPct: 0,
      lastSocPct: 100,
    }),
  )
  expect(f.batteryIn).toBe(10)
  expect(f.deltaStored).toBeCloseTo((100 / 100) * BATTERY_CAPACITY_KWH, 12)
  expect(f.efficiency).not.toBeNull()
})

test('efficiency null when netIn < 1 but batteryIn >= 1 (SoC rise absorbs charge)', () => {
  // charge 5 kWh, SoC goes 10 → 75: deltaStored = (65/100) × capacity ≈ 4.93
  // netIn = 5 - 4.93 ≈ 0.07 < 1, so efficiency is null.
  // gridChargedShare = 5 / 5 = 1, batteryIn >= 1, so it's non-null.
  const f = energyFigures(
    sums({
      batteryChargeGridKwh: 5,
      batteryDischargeKwh: 0,
      firstSocPct: 10,
      lastSocPct: 75,
    }),
  )
  expect(f.batteryIn).toBe(5)
  expect(f.deltaStored).toBeCloseTo((65 / 100) * BATTERY_CAPACITY_KWH, 12)
  expect(f.efficiency).toBeNull()
  expect(f.gridChargedShare).not.toBeNull()
})

test('exactly 1 kWh in: efficiency and grid share non-null', () => {
  const f = energyFigures(
    sums({
      batteryChargeGridKwh: 1,
      batteryDischargeKwh: 0.5,
    }),
  )
  expect(f.batteryIn).toBe(1)
  expect(f.efficiency).not.toBeNull()
  expect(f.gridChargedShare).not.toBeNull()
})

test('0.99 kWh in: efficiency and grid share null', () => {
  const f = energyFigures(
    sums({
      batteryChargeGridKwh: 0.99,
      batteryDischargeKwh: 0.5,
    }),
  )
  expect(f.batteryIn).toBe(0.99)
  expect(f.efficiency).toBeNull()
  expect(f.gridChargedShare).toBeNull()
})

test('a missing firstSocPct with lastSocPct set means no SoC correction', () => {
  const f = energyFigures(
    sums({ batteryChargeSolarKwh: 10, batteryDischargeKwh: 8, lastSocPct: 60 }),
  )
  expect(f.deltaStored).toBe(0)
  expect(f.loss).toBe(2)
})

test('gapHours rounds ≥0.5 hours up', () => {
  // 90 missing buckets × 5 min/bucket × 1 h/60 min = 7.5 h → rounds to 8.
  const f = energyFigures(sums({ buckets: 288 * 30 - 90, expectedBuckets: 288 * 30 }))
  expect(f.missingHours).toBeCloseTo(7.5, 12)
  expect(gapHours(f)).toBe(8)
})

test('buckets more than expected gives 0 missing hours', () => {
  const f = energyFigures(sums({ buckets: 100, expectedBuckets: 50 }))
  expect(f.missingHours).toBe(0)
  expect(gapHours(f)).toBeNull()
})

test('falling SoC: battery emptied, deltaStored negative', () => {
  // Battery goes from 80% to 10%: loses 70% of capacity, so deltaStored is negative.
  // Discharge 15, no charge: batteryIn = 0, out = 15, delta ≈ -5.306.
  // loss = in - out - delta = 0 - 15 - (-5.306) ≈ -9.694.
  const f = energyFigures(
    sums({
      batteryDischargeKwh: 15,
      firstSocPct: 80,
      lastSocPct: 10,
    }),
  )
  const expectedDelta = -((80 - 10) / 100) * BATTERY_CAPACITY_KWH
  expect(f.deltaStored).toBeCloseTo(expectedDelta, 12)
  expect(f.batteryIn).toBe(0)
  expect(f.batteryOut).toBe(15)
  // loss = in - out - delta = 0 - 15 - expectedDelta
  expect(f.loss).toBeCloseTo(0 - 15 - expectedDelta, 12)
})

test('battery to grid is the export the solar surplus cannot explain', () => {
  // 10 kWh solar, 8 into the battery: 2 kWh of solar could be sold; the other 3 kWh came from the battery.
  const f = energyFigures(
    sums({ solarKwh: 10, batteryChargeSolarKwh: 8, gridExportKwh: 5, batteryDischargeKwh: 20 }),
  )
  expect(f.batteryToGrid).toBe(3)
  expect(f.batteryToHouse).toBe(17)
})

test('export within the solar surplus leaves nothing from the battery to the grid', () => {
  const f = energyFigures(
    sums({
      solarKwh: 500,
      batteryChargeSolarKwh: 170,
      gridExportKwh: 110,
      batteryDischargeKwh: 90,
    }),
  )
  expect(f.batteryToGrid).toBe(0)
  expect(f.batteryToHouse).toBe(90)
})

test('battery to house is never negative', () => {
  // More export beyond the surplus than the battery discharged (meter noise): the house gets 0, not −2.
  const f = energyFigures(sums({ gridExportKwh: 5, batteryDischargeKwh: 3 }))
  expect(f.batteryToGrid).toBe(5)
  expect(f.batteryToHouse).toBe(0)
})

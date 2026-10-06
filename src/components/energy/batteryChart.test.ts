import { expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { batteryChartRows } from './batteryChart'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 0,
  gridExportKwh: 0,
  solarKwh: 0,
  loadKwh: 0,
  batteryDischargeKwh: 157,
  batteryChargeSolarKwh: 25.6,
  batteryChargeGridKwh: 248.9,
  carKwh: 0,
  firstSocPct: 34,
  lastSocPct: 23,
  buckets: 1,
  expectedBuckets: 1,
  ...over,
})

test('a month: out, the loss stacked on it, and a label only above the winter share', () => {
  const [feb, jun] = batteryChartRows([
    sums(), // February on prod: loss 118,3 of 275,3 → 43 %
    sums({
      batteryDischargeKwh: 186.8,
      batteryChargeSolarKwh: 187.5,
      batteryChargeGridKwh: 9.8,
      firstSocPct: 80,
      lastSocPct: 90,
    }),
  ])
  expect(feb.out).toBe(157)
  expect(feb.loss).toBeCloseTo(274.5 - 157 + 0.11 * 7.58, 9)
  expect(feb.label).toMatch(/^43\s%$/)
  expect(jun.loss).toBeGreaterThan(0)
  expect(jun.label).toBeNull()
})

test('no readings: no bar; a negative loss draws only out', () => {
  const [none, noisy] = batteryChartRows([
    null,
    sums({
      batteryChargeSolarKwh: 10,
      batteryChargeGridKwh: 0,
      batteryDischargeKwh: 10.2,
      firstSocPct: 50,
      lastSocPct: 50,
    }),
  ])
  expect(none).toMatchObject({ out: null, loss: null, label: null })
  expect(noisy.out).toBeCloseTo(10.2, 9)
  expect(noisy.loss).toBeNull()
  expect(noisy.label).toBeNull()
})

test('a loss share of exactly 25 % is not winter: no label', () => {
  // in 100, out 75 with an unchanged charge level: loss 25, share 0,25.
  const [edge] = batteryChartRows([
    sums({
      batteryChargeSolarKwh: 100,
      batteryChargeGridKwh: 0,
      batteryDischargeKwh: 75,
      firstSocPct: 50,
      lastSocPct: 50,
    }),
  ])
  expect(edge.loss).toBeCloseTo(25, 9)
  expect(edge.label).toBeNull()
})

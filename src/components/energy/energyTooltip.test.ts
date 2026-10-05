import { expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { energyTooltipRows } from './energyTooltip'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 500,
  gridExportKwh: 100,
  solarKwh: 400,
  loadKwh: 800,
  batteryDischargeKwh: 150,
  batteryChargeSolarKwh: 120,
  batteryChargeGridKwh: 40,
  carKwh: 250,
  firstSocPct: 20,
  lastSocPct: 30,
  buckets: 100,
  expectedBuckets: 100,
  ...over,
})

test('solar rows: parts and the produced total', () => {
  expect(energyTooltipRows('solar', sums())).toEqual({
    parts: [
      { key: 'solarDirect', kwh: 180 },
      { key: 'solarBattery', kwh: 120 },
      { key: 'solarExported', kwh: 100 },
    ],
    totalKwh: 400,
  })
})

test('grid rows: export as a positive part; total is what was bought', () => {
  expect(energyTooltipRows('grid', sums())).toEqual({
    parts: [
      { key: 'importDirect', kwh: 460 },
      { key: 'importBattery', kwh: 40 },
      { key: 'exported', kwh: 100 },
    ],
    totalKwh: 500,
  })
})

test('load rows: charging and the rest of the house', () => {
  expect(energyTooltipRows('load', sums())).toEqual({
    parts: [
      { key: 'car', kwh: 250 },
      { key: 'house', kwh: 550 },
    ],
    totalKwh: 800,
  })
})

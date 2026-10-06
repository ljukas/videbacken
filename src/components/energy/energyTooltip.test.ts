import { expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { chartRows, energyTooltipRows } from './energyTooltip'

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
      { key: 'solarDirect', kwh: 180, share: 0.45 },
      { key: 'solarBattery', kwh: 120, share: 0.3 },
      { key: 'solarExported', kwh: 100, share: 0.25 },
    ],
    totalKwh: 400,
  })
})

test('grid rows: export as a positive part; total is what was bought', () => {
  expect(energyTooltipRows('grid', sums())).toEqual({
    parts: [
      { key: 'importDirect', kwh: 460, share: 0.92 },
      { key: 'importBattery', kwh: 40, share: 0.08 },
      { key: 'exported', kwh: 100, share: null },
    ],
    totalKwh: 500,
  })
})

test('load rows: charging and the rest of the house', () => {
  expect(energyTooltipRows('load', sums())).toEqual({
    parts: [
      { key: 'car', kwh: 250, share: 0.3125 },
      { key: 'house', kwh: 550, share: 0.6875 },
    ],
    totalKwh: 800,
  })
})

test('solar overshoot: battery-from-solar above solar is capped so the parts sum to the total', () => {
  const { parts, totalKwh } = energyTooltipRows(
    'solar',
    sums({ solarKwh: 100, batteryChargeSolarKwh: 130, gridExportKwh: 0 }),
  )
  expect(parts.reduce((a, p) => a + p.kwh, 0)).toBe(totalKwh)
  expect(parts.find((p) => p.key === 'solarBattery')?.kwh).toBe(100)
})

test('solar: export larger than the surplus never exceeds the produced total', () => {
  const { parts, totalKwh } = energyTooltipRows(
    'solar',
    sums({ solarKwh: 100, batteryChargeSolarKwh: 40, gridExportKwh: 500 }),
  )
  expect(parts.reduce((a, p) => a + p.kwh, 0)).toBeCloseTo(totalKwh)
})

test('load: car above load is capped so car + house = load', () => {
  const { parts, totalKwh } = energyTooltipRows('load', sums({ loadKwh: 200, carKwh: 250 }))
  expect(parts).toEqual([
    { key: 'car', kwh: 200, share: 1 },
    { key: 'house', kwh: 0, share: 0 },
  ])
  expect(totalKwh).toBe(200)
})

test('chartRows: Nät export is negative, Solel export positive', () => {
  expect(chartRows('grid', [sums()])[0].exported).toBe(-100)
  expect(chartRows('grid', [sums()])[0].importDirect).toBe(460)
  expect(chartRows('solar', [sums()])[0].solarExported).toBe(100)
})

test('chartRows: months without data are null, never 0, for every series', () => {
  for (const metric of ['solar', 'grid', 'load'] as const) {
    const [row] = chartRows(metric, [null])
    const { month: _m, sums: _s, ...values } = row
    expect(Object.keys(values).length).toBeGreaterThan(0)
    for (const v of Object.values(values)) expect(v).toBeNull()
  }
})

test('stacked parts carry their share of the total; Nät export has none', () => {
  const p = sums({
    solarKwh: 100,
    batteryChargeSolarKwh: 20,
    gridExportKwh: 30,
    gridImportKwh: 50,
    batteryChargeGridKwh: 10,
  })
  const solar = energyTooltipRows('solar', p).parts
  expect(solar.map((r) => r.share)).toEqual([0.5, 0.2, 0.3])
  const grid = energyTooltipRows('grid', p).parts
  expect(grid.find((r) => r.key === 'importBattery')?.share).toBeCloseTo(0.2, 9)
  expect(grid.find((r) => r.key === 'exported')?.share).toBeNull()
})

test('a zero total gives no shares', () => {
  expect(
    energyTooltipRows(
      'solar',
      sums({ solarKwh: 0, batteryChargeSolarKwh: 0, gridExportKwh: 0 }),
    ).parts.every((r) => r.share === null),
  ).toBe(true)
})

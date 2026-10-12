import { expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import {
  chartRows,
  chartUnits,
  energyTooltipRows,
  METRIC_SERIES,
  metricSeries,
} from './energyTooltip'

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
  heatPumps: [],
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

const hp = (id: string, name: string, kwh: number) => ({
  id,
  name,
  kwh,
  hours: 720,
  expectedHours: 720,
})

test('load rows with heat pumps: laddning, each unit by name, övrigt hus; the parts add up to the load', () => {
  const p = sums({
    loadKwh: 800,
    carKwh: 250,
    heatPumps: [hp('hp-a', 'Matsal', 150), hp('hp-b', 'Övervåning', 60)],
  })
  const { parts, totalKwh } = energyTooltipRows('load', p)
  expect(parts).toEqual([
    { key: 'car', kwh: 250, share: 0.3125 },
    { key: 'heatPump:hp-a', kwh: 150, share: 0.1875 },
    { key: 'heatPump:hp-b', kwh: 60, share: 0.075 },
    { key: 'house', kwh: 340, share: 0.425 },
  ])
  expect(parts.reduce((a, r) => a + r.kwh, 0)).toBeCloseTo(totalKwh, 9)
})

test('load rows when the heat pumps exceed load − laddning: scaled, övrigt hus 0, still adding up to the load', () => {
  const p = sums({
    loadKwh: 400,
    carKwh: 300,
    heatPumps: [hp('hp-a', 'Matsal', 150), hp('hp-b', 'Övervåning', 50)],
  })
  const { parts, totalKwh } = energyTooltipRows('load', p)
  expect(parts.map((r) => r.kwh)).toEqual([300, 75, 25, 0])
  expect(parts.reduce((a, r) => a + r.kwh, 0)).toBeCloseTo(totalKwh, 9)
  expect(parts.every((r) => (r.share ?? 0) <= 1)).toBe(true)
})

test('metricSeries: Förbrukning puts the units between laddning and övrigt hus; Solel and Nät unchanged', () => {
  expect(metricSeries('load', [{ id: 'hp-a' }, { id: 'hp-b' }])).toEqual([
    'car',
    'heatPump:hp-a',
    'heatPump:hp-b',
    'house',
  ])
  expect(metricSeries('load', [])).toEqual(['car', 'house'])
  expect(metricSeries('solar', [{ id: 'hp-a' }])).toEqual(METRIC_SERIES.solar)
  expect(metricSeries('grid', [{ id: 'hp-a' }])).toEqual(METRIC_SERIES.grid)
})

test('chartUnits: every unit with a figure in any month, once, in name order', () => {
  const months = [
    null,
    sums({ heatPumps: [hp('hp-b', 'Övervåning', 1)] }),
    sums({ heatPumps: [hp('hp-a', 'Matsal', 1), hp('hp-b', 'Övervåning', 1)] }),
  ]
  expect(chartUnits(months)).toEqual([
    { id: 'hp-a', name: 'Matsal' },
    { id: 'hp-b', name: 'Övervåning' },
  ])
  expect(chartUnits([null])).toEqual([])
})

test('chartRows: a unit absent in a month is null there, never 0', () => {
  const rows = chartRows('load', [
    sums({ heatPumps: [hp('hp-a', 'Matsal', 10)] }),
    sums({ heatPumps: [hp('hp-a', 'Matsal', 10), hp('hp-b', 'Övervåning', 5)] }),
  ])
  expect(rows[0]['heatPump:hp-b']).toBeNull()
  expect(rows[1]['heatPump:hp-b']).toBe(5)
  expect(rows[0]['heatPump:hp-a']).toBe(10)
})

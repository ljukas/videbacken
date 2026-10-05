import { expect, test, vi } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type EnergyMetric, EnergyMonthlyChart } from './EnergyMonthlyChart'

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

// Jan–Mar empty (before the first reading), Apr–Dec with data.
const months = Array.from({ length: 12 }, (_, i) => (i < 3 ? null : sums()))

const render = (metric: EnergyMetric, data: (PeriodSums | null)[] = months) =>
  renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <EnergyMonthlyChart year={2026} months={data} metric={metric} currentMonth={null} />
    </div>,
  )

test('solar: three stacked series, one bar per month with data', async () => {
  const { screen } = await render('solar')
  await vi.waitFor(() => {
    // 9 months × 3 series.
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(27)
  })
  await expect.element(screen.getByText(m.energy_series_solar_direct())).toBeVisible()
  await expect.element(screen.getByText(m.energy_series_solar_battery())).toBeVisible()
  await expect.element(screen.getByText(m.energy_series_solar_exported())).toBeVisible()
})

test('grid metric names its series in the legend', async () => {
  const { screen } = await render('grid')
  await expect.element(screen.getByText(m.energy_series_import_direct())).toBeVisible()
  await expect.element(screen.getByText(m.energy_series_import_battery())).toBeVisible()
  await expect.element(screen.getByText(m.energy_series_export())).toBeVisible()
})

test('load metric names its series in the legend', async () => {
  const { screen } = await render('load')
  await expect.element(screen.getByText(m.energy_series_car())).toBeVisible()
  await expect.element(screen.getByText(m.energy_series_house())).toBeVisible()
})

test('a year without any data shows the no-data state, not an empty chart', async () => {
  const { screen } = await render('solar', Array(12).fill(null))
  await expect.element(screen.getByText(m.energy_chart_no_data({ year: '2026' }))).toBeVisible()
  expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(0)
})

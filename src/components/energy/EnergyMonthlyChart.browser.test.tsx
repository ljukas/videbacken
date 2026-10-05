import { expect, test, vi } from 'vitest'
import { monthName } from '~/components/evCharging/format'
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

const legendText = (container: Element) =>
  container.querySelector('.recharts-legend-wrapper')?.textContent ?? ''
const inOrder = (text: string, labels: string[]) => {
  const at = labels.map((l) => text.indexOf(l))
  expect(at.every((i) => i >= 0)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
}

test('the legend follows the stack order on Solel', async () => {
  const { screen } = await render('solar')
  await vi.waitFor(() =>
    inOrder(legendText(screen.container), [
      m.energy_series_solar_direct(),
      m.energy_series_solar_battery(),
      m.energy_series_solar_exported(),
    ]),
  )
})

test('the legend follows the stack order on Nät', async () => {
  const { screen } = await render('grid')
  await vi.waitFor(() =>
    inOrder(legendText(screen.container), [
      m.energy_series_import_direct(),
      m.energy_series_import_battery(),
      m.energy_series_export(),
    ]),
  )
})

test('a year without any data shows the no-data state, not an empty chart', async () => {
  const { screen } = await render('solar', Array(12).fill(null))
  await expect.element(screen.getByText(m.energy_chart_no_data({ year: '2026' }))).toBeVisible()
  expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(0)
})

test('a Nät tooltip on a partial current month: parts, totals, self-sufficiency and the gap', async () => {
  const partial = months.map((p, i) => (i === 3 && p ? { ...p, buckets: 50 } : p))
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <EnergyMonthlyChart year={2026} months={partial} metric="grid" currentMonth={4} />
    </div>,
  )
  const rects = () => [...screen.container.querySelectorAll('.recharts-bar-rectangle')]
  await vi.waitFor(() => expect(rects().length).toBeGreaterThan(0))
  // Rectangles in DOM order: import direct (Apr is the first month with data).
  const box = rects()[0].getBoundingClientRect()
  rects()[0].dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    }),
  )
  await vi.waitFor(() => expect(document.body.textContent).toContain(m.energy_chart_so_far()))
  const text = document.body.textContent ?? ''
  const heading = `${monthName(4)} (${m.energy_chart_so_far()})`
  expect(text).toContain(heading)
  const tip = text.slice(text.indexOf(heading))
  const order = [
    m.energy_series_import_direct(),
    m.energy_series_import_battery(),
    m.energy_chart_total_grid(),
    m.energy_series_export(),
    m.energy_tile_self_sufficiency(),
    m.energy_missing_hours({ hours: '4' }),
  ]
  const at = order.map((l) => tip.indexOf(l))
  expect(at.every((i) => i >= 0)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
})

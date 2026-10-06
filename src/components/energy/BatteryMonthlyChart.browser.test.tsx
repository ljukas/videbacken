import { expect, test, vi } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { bars, clickOn, legendLabels } from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { BatteryMonthlyChart } from './BatteryMonthlyChart'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 500,
  gridExportKwh: 100,
  solarKwh: 400,
  loadKwh: 800,
  batteryDischargeKwh: 186.8,
  batteryChargeSolarKwh: 187.5,
  batteryChargeGridKwh: 9.8,
  carKwh: 0,
  firstSocPct: 80,
  lastSocPct: 90,
  buckets: 100,
  expectedBuckets: 100,
  ...over,
})
const feb = sums({
  batteryDischargeKwh: 157,
  batteryChargeSolarKwh: 25.6,
  batteryChargeGridKwh: 248.9,
  firstSocPct: 34,
  lastSocPct: 23,
})
// Jan none; Feb winter; Mar–Sep summer-like; Oct–Dec none.
const months = Array.from({ length: 12 }, (_, i) =>
  i === 0 || i > 8 ? null : i === 1 ? feb : sums(),
)
const render = (data: (PeriodSums | null)[] = months, onSelectMonth = vi.fn()) =>
  renderWithProviders(
    <div style={{ width: 720, height: 360 }}>
      <BatteryMonthlyChart
        year={2026}
        months={data}
        currentMonth={null}
        selectedMonth={null}
        onSelectMonth={onSelectMonth}
      />
    </div>,
  )

test('out and loss per month with readings; the loss is hatched; one winter label', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(16)) // 8 months × (out + loss)
  expect(
    screen.container.querySelector('[data-series="loss"] [data-bar]')?.getAttribute('fill'),
  ).toMatch(/^url\(#/)
  const labels = [...screen.container.querySelectorAll('[data-bar-label]')].map(
    (l) => l.textContent,
  )
  expect(labels).toHaveLength(1)
  expect(labels[0]).toMatch(/^43\s%$/)
  expect(legendLabels(screen.container)).toEqual([
    m.energy_battery_series_out(),
    m.energy_battery_series_loss(),
  ])
})

test('clicking a month with readings selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await render(months, onSelectMonth)
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  const bar = bars(screen.container).find((b) => b.getAttribute('data-index') === '1')
  if (!bar) throw new Error('no February bar')
  await clickOn(screen.container, bar)
  expect(onSelectMonth).toHaveBeenCalledWith(2)
})

test('no data in the year: the no-data state', async () => {
  const { screen } = await render(Array(12).fill(null))
  await expect.element(screen.getByText(m.energy_chart_no_data({ year: '2026' }))).toBeVisible()
})

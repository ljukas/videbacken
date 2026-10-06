import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import {
  bars,
  clickOn,
  focusChart,
  hoverBar,
  legendLabels,
  selectedTint,
  tooltipText,
  xTickLabels,
} from '~test/browser/chartDom'
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
const render = (
  data: (PeriodSums | null)[] = months,
  onSelectMonth = vi.fn(),
  o: { width?: number; currentMonth?: number | null; selectedMonth?: number | null } = {},
) =>
  renderWithProviders(
    <div style={{ width: o.width ?? 720, height: 360 }}>
      <BatteryMonthlyChart
        year={2026}
        months={data}
        currentMonth={o.currentMonth ?? null}
        selectedMonth={o.selectedMonth ?? null}
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

test("a month's tooltip: in by origin, stored, out, the loss with its share, the efficiency", async () => {
  const { screen } = await render()
  await hoverBar(screen.container, 0) // February
  await vi.waitFor(() => expect(tooltipText()).toContain(m.energy_battery_tooltip_in()))
  const t = tooltipText()
  for (const label of [
    m.energy_battery_tooltip_from_solar(),
    m.energy_battery_tooltip_from_grid(),
    m.energy_flow_row_stored(),
    m.energy_battery_series_out(),
    m.energy_battery_series_loss(),
    m.energy_battery_efficiency(),
  ])
    expect(t).toContain(label)
  expect(t).toMatch(/43\s%/)
  expect(t).toMatch(/157,0\skWh/)
  expect(t).toMatch(/118,3\skWh/)
  expect(t).toMatch(/57\s%/)
  expect(t).not.toContain('—')
})

test('an unknown charge level reads "—" for Ändrat lager, not +0,0', async () => {
  const unknown = months.map((x, i) =>
    i === 1 && x ? { ...x, firstSocPct: null, lastSocPct: null } : x,
  )
  const { screen } = await render(unknown)
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.energy_flow_row_stored()))
  expect(tooltipText()).toMatch(new RegExp(`${m.energy_flow_row_stored()}\\s*—`))
  expect(tooltipText()).not.toContain('+0,0')
})

test('the current month says "hittills"', async () => {
  const { screen } = await render(months, vi.fn(), { currentMonth: 2 })
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).toContain(`(${m.energy_chart_so_far()})`))
})

test('the selected month is tinted', async () => {
  const { screen } = await render(months, vi.fn(), { selectedMonth: 2 })
  await vi.waitFor(() => expect(selectedTint(screen.container)).not.toBeNull())
})

test('a month with a slightly negative loss draws only its Ut bar', async () => {
  const noisy = sums({
    batteryChargeSolarKwh: 10,
    batteryChargeGridKwh: 0,
    batteryDischargeKwh: 10.2,
    firstSocPct: 50,
    lastSocPct: 50,
  })
  const { screen } = await render([noisy, ...Array(11).fill(null)])
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(1))
  expect(bars(screen.container)[0].closest('[data-series]')?.getAttribute('data-series')).toBe(
    'out',
  )
})

test('Enter on the keyboard-focused month selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await render(months, onSelectMonth)
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(16))
  await userEvent.hover(screen.getByText(m.energy_battery_chart_hint()))
  focusChart(screen.container)
  // The first → lands on January (no readings); one step right is February.
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{Enter}')
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(2))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

test('month initials at 360 px', async () => {
  const { screen } = await render(months, vi.fn(), { width: 360 })
  await vi.waitFor(() => expect(xTickLabels(screen.container)).toHaveLength(12))
  expect(xTickLabels(screen.container).every((l) => l.length === 1)).toBe(true)
})

test('the no-data state keeps the hint line, invisible and aria-hidden', async () => {
  const { screen } = await render(Array(12).fill(null))
  await expect.element(screen.getByText(m.energy_chart_no_data({ year: '2026' }))).toBeVisible()
  const hint = [...screen.container.querySelectorAll('p')].find(
    (p) => p.textContent === m.energy_battery_chart_hint(),
  )
  expect(hint?.getAttribute('aria-hidden')).toBe('true')
  expect(hint?.className).toContain('invisible')
})

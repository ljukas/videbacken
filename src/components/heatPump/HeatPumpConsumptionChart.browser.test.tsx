import { beforeEach, expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { clickOn, legendLabels, lineDots, parkPointer, seriesBars } from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { allPayload, daysPayload, monthsPayload } from '~test/fixtures/heatPumpView'
import { HeatPumpConsumptionChart } from './HeatPumpConsumptionChart'
import { type HeatPumpView, heatPumpView } from './heatPumpView'

beforeEach(parkPointer)

const NOW = { year: 2026, month: 9 }
const viewOf = (
  input: Partial<Parameters<typeof heatPumpView>[0]> &
    Pick<Parameters<typeof heatPumpView>[0], 'period'>,
) => {
  const v = heatPumpView({
    months: monthsPayload(),
    days: null,
    now: NOW,
    today: '2026-09-15',
    ...input,
  })
  if (!v) throw new Error('no view')
  return v
}
const render = (view: HeatPumpView, onSelectMonth = vi.fn()) =>
  renderWithProviders(
    <div style={{ width: 720 }}>
      <HeatPumpConsumptionChart view={view} onSelectMonth={onSelectMonth} />
    </div>,
  )
const rightTicks = (root: ParentNode) =>
  root.querySelectorAll('[data-axis="y-right"] .visx-axis-tick')

test('year: units stacked per month, last year as an outline beside them, outdoor °C on a right axis', async () => {
  const { screen } = await render(viewOf({ period: { kind: 'year', year: 2026 } }))
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(9)) // Matsal, Jan–Sep
  expect(seriesBars(screen.container, 1)).toHaveLength(9) // Övervåning
  expect(seriesBars(screen.container, 2)).toHaveLength(12) // 2025, every month
  expect(seriesBars(screen.container, 2)[0].getAttribute('fill')).toBe('none')
  expect(legendLabels(screen.container)).toEqual([
    'Matsal',
    'Övervåning',
    m.heat_pump_series_last_year({ year: '2025' }),
    m.heat_pump_series_outdoor(),
  ])
  expect(lineDots(screen.container)).toHaveLength(9)
  expect(rightTicks(screen.container).length).toBeGreaterThan(1)
  expect(screen.container.textContent).toContain(m.heat_pump_chart_hint())
})

test('year: clicking a month with readings selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await render(viewOf({ period: { kind: 'year', year: 2026 } }), onSelectMonth)
  await vi.waitFor(() => expect(seriesBars(screen.container, 0).length).toBeGreaterThan(2))
  await clickOn(screen.container, seriesBars(screen.container, 0)[2])
  expect(onSelectMonth).toHaveBeenCalledWith({ year: 2026, month: 3 })
})

test('month: a bar per day with data, no outline, not selectable; the hint line is reserved but hidden', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await render(
    viewOf({ days: daysPayload(2026, 9, 15), period: { kind: 'month', year: 2026, month: 9 } }),
    onSelectMonth,
  )
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(15))
  expect(screen.container.querySelector('[data-series="lastYear"]')).toBeNull()
  await clickOn(screen.container, seriesBars(screen.container, 0)[0])
  expect(onSelectMonth).not.toHaveBeenCalled()
  expect(screen.container.querySelector('[data-slot="heat-pump-chart-hint"]')?.className).toContain(
    'invisible',
  )
})

test('Totalt: one bar group per month of the history', async () => {
  const { screen } = await render(viewOf({ months: allPayload(), period: { kind: 'all' } }))
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(21))
  expect(screen.container.querySelector('[data-series="lastYear"]')).toBeNull()
})

test("a period without data: the no-data line at the chart's height", async () => {
  const empty = monthsPayload({ months: [], lastYear: [], lastYearSoFar: null })
  const { screen } = await render(viewOf({ months: empty, period: { kind: 'year', year: 2026 } }))
  await expect
    .element(screen.getByText(m.heat_pump_chart_no_data({ period: '2026' })))
    .toBeVisible()
})

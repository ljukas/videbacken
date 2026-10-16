import { beforeEach, expect, test, vi } from 'vitest'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { m } from '~/paraglide/messages'
import {
  centre,
  clickOn,
  hoverBar,
  legendLabels,
  lineDots,
  moveAt,
  parkPointer,
  seriesBars,
  tooltipText,
} from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import {
  allPayload,
  daysPayload,
  MATSAL,
  monthsPayload,
  OVERVANING,
} from '~test/fixtures/heatPumpView'
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
const render = (
  view: HeatPumpView,
  onSelectMonth = vi.fn(),
  events?: readonly HeatPumpEventDto[],
) =>
  renderWithProviders(
    <div style={{ width: 720 }}>
      <HeatPumpConsumptionChart view={view} onSelectMonth={onSelectMonth} events={events} />
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

test('no outdoor temperature in any row: no line, no right axis, no legend entry (never a 0°–1° axis)', async () => {
  const p = monthsPayload()
  p.months = p.months.map((c) => ({ ...c, outsideC: null }))
  const { screen } = await render(viewOf({ months: p, period: { kind: 'year', year: 2026 } }))
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(9))
  expect(rightTicks(screen.container)).toHaveLength(0)
  expect(lineDots(screen.container)).toHaveLength(0)
  expect(legendLabels(screen.container)).not.toContain(m.heat_pump_series_outdoor())
})

test("the tooltip's kWh never break from their number", async () => {
  const { screen } = await render(viewOf({ period: { kind: 'year', year: 2026 } }))
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).toMatch(/kWh/))
  expect(tooltipText()).toMatch(/\d\u00a0kWh/)
  expect(tooltipText()).not.toMatch(/ kWh/)
})

// Step 4a: events on the day chart. September 2026, readings on days 1–15.
const september = () =>
  viewOf({ days: daysPayload(2026, 9, 15), period: { kind: 'month', year: 2026, month: 9 } })
const markerNodes = (root: ParentNode) => [...root.querySelectorAll<SVGGElement>('[data-marker]')]
const event = (over: Partial<HeatPumpEventDto>): HeatPumpEventDto => ({
  id: crypto.randomUUID(),
  occurredOn: '2026-09-10',
  heatPumpId: null,
  kind: 'service',
  note: null,
  ...over,
})

test('events mark their days: a unit event in its colour, a both-units event across', async () => {
  const view = september()
  const { screen } = await render(view, vi.fn(), [
    event({ occurredOn: '2026-09-10' }),
    event({ occurredOn: '2026-09-03', heatPumpId: OVERVANING.id, kind: 'filter' }),
  ])
  await vi.waitFor(() => expect(markerNodes(screen.container)).toHaveLength(2))
  const across = markerNodes(screen.container).find((n) => n.dataset.across)
  expect(across?.dataset.marker).toBe('all')
  expect(across?.dataset.index).toBe('9') // the 10th
  const unit = markerNodes(screen.container).find((n) => !n.dataset.across)
  expect(unit?.dataset.index).toBe('2') // the 3rd
  expect(unit?.querySelector('path')?.getAttribute('fill')).toBe(
    heatPumpColor(view.units, OVERVANING.id),
  )
})

test("a marked day's tooltip names the event; a day without readings still explains its event", async () => {
  const { screen } = await render(september(), vi.fn(), [
    event({ occurredOn: '2026-09-10' }),
    event({ occurredOn: '2026-09-20', heatPumpId: MATSAL.id, kind: 'setting' }),
  ])
  await hoverBar(screen.container, 9) // Matsal's bar on the 10th
  await vi.waitFor(() =>
    expect(tooltipText()).toContain(m.heat_pump_event_tooltip({ kinds: 'Service', unit: 'Båda' })),
  )
  // The 20th draws no bar: hover its column's centre, five day steps right of the 15th.
  const bars = seriesBars(screen.container, 0)
  const p = centre(bars[13])
  const q = centre(bars[14])
  moveAt(screen.container, q.x + 5 * (q.x - p.x), q.y)
  await vi.waitFor(() =>
    expect(tooltipText()).toContain(
      m.heat_pump_event_tooltip({ kinds: 'Inställning', unit: 'Matsal' }),
    ),
  )
})

test("an event-only day's tooltip has the day's title; a note shows under its event", async () => {
  const view = september()
  const { screen } = await render(view, vi.fn(), [
    event({ occurredOn: '2026-09-10', note: 'Årlig service hos installatören' }),
    event({ occurredOn: '2026-09-20', heatPumpId: MATSAL.id, kind: 'setting' }),
  ])
  await hoverBar(screen.container, 9)
  await vi.waitFor(() => expect(tooltipText()).toContain('Årlig service hos installatören'))
  const bars = seriesBars(screen.container, 0)
  const p = centre(bars[13])
  const q = centre(bars[14])
  moveAt(screen.container, q.x + 5 * (q.x - p.x), q.y)
  await vi.waitFor(() =>
    expect(tooltipText()).toContain(
      m.heat_pump_event_tooltip({ kinds: 'Inställning', unit: 'Matsal' }),
    ),
  )
  expect(tooltipText()).toContain(view.rows[19].title)
  // The tooltip's ▼ is the chart's mark: in the unit's colour.
  const mark = document.querySelector<HTMLElement>('[data-event-mark]')
  expect(mark?.style.color).toBe(heatPumpColor(view.units, MATSAL.id))
})

test('the year view draws no markers', async () => {
  const { screen } = await render(viewOf({ period: { kind: 'year', year: 2026 } }), vi.fn(), [
    event({ occurredOn: '2026-09-10' }),
  ])
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(9))
  expect(markerNodes(screen.container)).toHaveLength(0)
})

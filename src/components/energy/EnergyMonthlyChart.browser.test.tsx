import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import {
  formatOneDecimal,
  formatShare,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
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

const renderChart = ({
  metric = 'solar',
  data = months,
  currentMonth = null,
  selectedMonth = null,
  onSelectMonth = vi.fn(),
  width = 720,
}: {
  metric?: EnergyMetric
  data?: (PeriodSums | null)[]
  currentMonth?: number | null
  selectedMonth?: number | null
  onSelectMonth?: (month: number) => void
  width?: number
} = {}) =>
  renderWithProviders(
    <div style={{ width, height: 340 }}>
      <EnergyMonthlyChart
        year={2026}
        months={data}
        metric={metric}
        currentMonth={currentMonth}
        selectedMonth={selectedMonth}
        onSelectMonth={onSelectMonth}
      />
    </div>,
  )

const render = (metric: EnergyMetric, data: (PeriodSums | null)[] = months) =>
  renderChart({ metric, data })

const barRects = (container: Element) => [...container.querySelectorAll('.recharts-bar-rectangle')]

const legendText = (container: Element) =>
  container.querySelector('.recharts-legend-wrapper')?.textContent ?? ''
const inOrder = (text: string, labels: string[]) => {
  const at = labels.map((l) => text.indexOf(l))
  expect(at.every((i) => i >= 0)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
}

// Series names are read from the legend only: a tooltip (opened by a pointer
// left over the chart's spot) repeats them, so a page-wide getByText can match twice.
const expectLegend = (container: Element, labels: string[]) =>
  vi.waitFor(() => {
    for (const label of labels) expect(legendText(container)).toContain(label)
  })

test('solar: three stacked series, one bar per month with data', async () => {
  const { screen } = await render('solar')
  await vi.waitFor(() => {
    // 9 months × 3 series.
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(27)
  })
  await expectLegend(screen.container, [
    m.energy_series_solar_direct(),
    m.energy_series_solar_battery(),
    m.energy_series_solar_exported(),
  ])
})

test('grid metric names its series in the legend', async () => {
  const { screen } = await render('grid')
  await expectLegend(screen.container, [
    m.energy_series_import_direct(),
    m.energy_series_import_battery(),
    m.energy_series_export(),
  ])
})

test('load metric names its series in the legend', async () => {
  const { screen } = await render('load')
  await expectLegend(screen.container, [m.energy_series_car(), m.energy_series_house()])
})

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

test('a Nät tooltip on a partial current month: parts, totals and the gap', async () => {
  const partial = months.map((p, i) => (i === 3 && p ? { ...p, buckets: 50 } : p))
  const { screen } = await renderChart({ metric: 'grid', data: partial, currentMonth: 4 })
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
    m.energy_missing_hours({ hours: '4' }),
  ]
  const at = order.map((l) => tip.indexOf(l))
  expect(at.every((i) => i >= 0)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
  // The self-sufficiency row is gone (the spec's tooltip: parts, total, Såld, gap).
  expect(tip).not.toContain(m.energy_tile_self_sufficiency())
})

test('clicking a month selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  // Rectangles in DOM order: series by series, months in order; [0] is April's solar-direct.
  await userEvent.click(barRects(screen.container)[0])
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

const tickText = (container: Element, month: number) =>
  [...container.querySelectorAll('.recharts-xAxis-tick-labels text')].find(
    (t) => t.textContent === monthLabel(month),
  ) as SVGTextElement

test("clicking a month's label selects it; a month without readings doesn't", async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  await userEvent.click(tickText(screen.container, 2)) // February: no readings
  await userEvent.click(tickText(screen.container, 5))
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(5))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

test('clicking the legend selects nothing', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  const legend = screen.container.querySelector('.recharts-legend-wrapper') as HTMLElement
  await userEvent.click(legend, { position: { x: legend.offsetWidth - 2, y: 4 } })
  await new Promise((r) => setTimeout(r, 50))
  expect(onSelectMonth).not.toHaveBeenCalled()
})

test('the selected month is marked: a tinted area and a bold tick', async () => {
  const { screen } = await renderChart({ selectedMonth: 2 })
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-slot="selected-month"]')).not.toBeNull(),
  )
  const bold = screen.container.querySelectorAll(
    '.recharts-xAxis-tick-labels text[font-weight="600"]',
  )
  expect(bold).toHaveLength(1)
  expect(bold[0].textContent).toBe(monthLabel(2))
  // The tint spans exactly one month's band (the distance between two month labels).
  const tint = screen.container.querySelector('[data-slot="selected-month"]') as SVGGraphicsElement
  const band =
    Number(tickText(screen.container, 3).getAttribute('x')) -
    Number(tickText(screen.container, 2).getAttribute('x'))
  expect(tint.getBBox().width).toBeCloseTo(band, 1)
})

test('no month selected: no tint, no bold tick', async () => {
  const { screen } = await renderChart({ selectedMonth: null })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  expect(screen.container.querySelector('[data-slot="selected-month"]')).toBeNull()
  expect(
    screen.container.querySelector('.recharts-xAxis-tick-labels text[font-weight="600"]'),
  ).toBeNull()
})

test('a tooltip row shows the share of the total', async () => {
  const { screen } = await renderChart({ metric: 'solar' })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  await userEvent.hover(barRects(screen.container)[0])
  // April's solar: 180 of 400 kWh used directly.
  const row = await vi.waitFor(() => {
    const label = [...document.querySelectorAll('.recharts-tooltip-wrapper span')].find(
      (el) => el.textContent === m.energy_series_solar_direct(),
    )
    expect(label).toBeDefined()
    return label?.parentElement as HTMLElement
  })
  expect(row.textContent).toContain(`${formatOneDecimal(180)} kWh`)
  expect(row.lastElementChild?.textContent).toBe(formatShare(0.45))
})

test('hovering a month outlines its column, label included', async () => {
  const { screen } = await renderChart()
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  await userEvent.hover(barRects(screen.container)[0])
  const outline = await vi.waitFor(() => {
    const el = screen.container.querySelector('[data-slot="hover-month"]')
    expect(el).not.toBeNull()
    return el as SVGRectElement
  })
  const tick = tickText(screen.container, 4)
  const o = outline.getBoundingClientRect()
  const t = tick.getBoundingClientRect()
  expect(o.left).toBeLessThanOrEqual(t.left)
  expect(o.right).toBeGreaterThanOrEqual(t.right)
  expect(o.bottom).toBeGreaterThanOrEqual(t.bottom)
  // Painted above the bars (SVG paints in document order).
  for (const bar of barRects(screen.container))
    expect(bar.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(outline.getAttribute('stroke-dasharray')).toBeNull()
})

const allMonths = Array.from({ length: 12 }, () => sums())
const tooltipText = () =>
  [...document.querySelectorAll('.recharts-tooltip-wrapper')].map((w) => w.textContent).join('')

test('after a click, moving the pointer off the chart leaves no outline or tooltip', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ data: allMonths, onSelectMonth })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(36))
  await userEvent.click(barRects(screen.container)[3]) // April's solar-direct
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  await new Promise((r) => setTimeout(r, 100))
  expect(document.activeElement?.classList.contains('recharts-surface')).toBe(false)
  expect(screen.container.querySelector('[data-slot="hover-month"]')).toBeNull()
  expect(tooltipText()).not.toContain(monthName(1))
  expect(tooltipText()).not.toContain(monthName(4))
})

test('a touch tap selects the month without a tooltip or an outline', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ data: allMonths, onSelectMonth })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(36))
  // Re-query each time: a re-render may replace the rectangles.
  const bar = () => barRects(screen.container)[3]
  const box = bar().getBoundingClientRect()
  const at = { bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  // A tap's sequence: the pointer events say "touch"; the browser then emulates the mouse.
  bar().dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'touch' }))
  bar().dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'touch' }))
  bar().dispatchEvent(new MouseEvent('mousemove', at))
  bar().dispatchEvent(new MouseEvent('mousedown', at))
  bar().dispatchEvent(new MouseEvent('mouseup', at))
  bar().dispatchEvent(new MouseEvent('click', at))
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  await new Promise((r) => setTimeout(r, 100))
  expect(screen.container.querySelector('[data-slot="hover-month"]')).toBeNull()
  expect(tooltipText()).not.toContain(monthName(4))
  // The same spot under a mouse does show them (the check above is not vacuous).
  bar().dispatchEvent(new PointerEvent('pointermove', { ...at, pointerType: 'mouse' }))
  bar().dispatchEvent(new MouseEvent('mousemove', { ...at, clientX: at.clientX + 1 }))
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[data-slot="hover-month"]')).not.toBeNull()
    expect(tooltipText()).toContain(monthName(4))
  })
})

test('keyboard focus on a month without readings shows a dashed outline, no tooltip', async () => {
  const { screen } = await renderChart()
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  const surface = screen.container.querySelector('.recharts-surface') as HTMLElement
  surface.focus() // January: no readings
  const outline = await vi.waitFor(() => {
    const el = screen.container.querySelector('[data-slot="hover-month"]')
    expect(el).not.toBeNull()
    return el as SVGRectElement
  })
  expect(outline.getAttribute('stroke-dasharray')).not.toBeNull()
  expect(tooltipText()).not.toContain(monthName(1))
  // Three steps right is April, with readings: a solid outline.
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector('[data-slot="hover-month"]')?.getAttribute('stroke-dasharray'),
    ).toBeNull(),
  )
})

test('Space on the keyboard-focused month selects it too', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  const surface = screen.container.querySelector('.recharts-surface') as HTMLElement
  surface.focus()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight} ')
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

test('Enter on the keyboard-focused month selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  // Park the pointer off the chart: a hovered month wins over the keyboard's.
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  const surface = screen.container.querySelector('.recharts-surface') as HTMLElement
  surface.focus()
  // Focus lands on January (no readings); three steps right is April.
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{Enter}')
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

test('a month without readings is not selectable', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  // Park the pointer off the chart: a hovered month wins over the keyboard's.
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  const surface = screen.container.querySelector('.recharts-surface') as HTMLElement
  surface.focus() // January: no readings
  await userEvent.keyboard('{Enter}')
  await new Promise((r) => setTimeout(r, 50))
  expect(onSelectMonth).not.toHaveBeenCalled()
})

test('on a narrow chart the month labels shorten to initials', async () => {
  const { screen } = await renderChart({ width: 360 })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  const ticks = [...screen.container.querySelectorAll('.recharts-xAxis-tick-labels text')]
  expect(ticks).toHaveLength(12)
  expect(ticks.map((t) => t.textContent)).toEqual(
    Array.from({ length: 12 }, (_, i) =>
      monthLabel(i + 1)
        .charAt(0)
        .toUpperCase(),
    ),
  )
})

test('on a wide chart every month label is shown in full', async () => {
  const { screen } = await renderChart({ width: 720 })
  await vi.waitFor(() => expect(barRects(screen.container).length).toBe(27))
  const ticks = [...screen.container.querySelectorAll('.recharts-xAxis-tick-labels text')]
  expect(ticks.map((t) => t.textContent)).toEqual(
    Array.from({ length: 12 }, (_, i) => monthLabel(i + 1)),
  )
})

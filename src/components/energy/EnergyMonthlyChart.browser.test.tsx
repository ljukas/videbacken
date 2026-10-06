import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import {
  formatOneDecimal,
  formatShare,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import {
  bars,
  boldTickLabels,
  centre,
  clickOn,
  focusChart,
  hoverBar,
  legend,
  legendText,
  moveAt,
  outline,
  parkPointer,
  selectedTint,
  seriesBars,
  tapOn,
  tooltipNodes,
  tooltipText,
  xTick,
  xTickLabels,
} from '~test/browser/chartDom'
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

beforeEach(parkPointer)

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
    expect(bars(screen.container)).toHaveLength(27)
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
  expect(bars(screen.container)).toHaveLength(0)
})

test('the no-data state reserves the hint line, so the card keeps its height', async () => {
  const { screen } = await render('solar', Array(12).fill(null))
  await expect.element(screen.getByText(m.energy_chart_no_data({ year: '2026' }))).toBeVisible()
  // No app.css in browser tests: pin the reserved line, not its geometry.
  const reserved = screen.container.querySelector('p[aria-hidden="true"].invisible')
  expect(reserved?.textContent).toBe(m.energy_chart_select_hint())
  expect(reserved?.className).toContain('mt-2')
  expect(reserved?.className).toContain('text-sm')
})

test('a Nät tooltip on a partial current month: parts, totals and the gap', async () => {
  const partial = months.map((p, i) => (i === 3 && p ? { ...p, buckets: 50 } : p))
  const { screen } = await renderChart({ metric: 'grid', data: partial, currentMonth: 4 })
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  // Bars in DOM order: import direct (Apr is the first month with data).
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.energy_chart_so_far()))
  const text = tooltipText()
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
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  // Bars in DOM order: series by series, months in order; [0] is April's solar-direct.
  await clickOn(screen.container, bars(screen.container)[0])
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

test("clicking a month's label selects it; a month without readings doesn't", async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  await clickOn(screen.container, xTick(screen.container, monthLabel(2))) // February: no readings
  await clickOn(screen.container, xTick(screen.container, monthLabel(5)))
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(5))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

test('clicking the legend selects nothing', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  const box = legend(screen.container) as HTMLElement
  await userEvent.click(box, { position: { x: box.offsetWidth - 2, y: 4 } })
  await new Promise((r) => setTimeout(r, 50))
  expect(onSelectMonth).not.toHaveBeenCalled()
})

test('the selected month is marked: a tinted area and a bold tick', async () => {
  const { screen } = await renderChart({ selectedMonth: 2 })
  const c = screen.container
  await vi.waitFor(() => expect(selectedTint(c)).not.toBeNull())
  expect(boldTickLabels(c)).toEqual([monthLabel(2)])
  // The tint spans exactly one month's band (the distance between two month labels).
  const band = centre(xTick(c, monthLabel(3))).x - centre(xTick(c, monthLabel(2))).x
  expect((selectedTint(c) as SVGGraphicsElement).getBoundingClientRect().width).toBeCloseTo(band, 1)
})

test('no month selected: no tint, no bold tick', async () => {
  const { screen } = await renderChart({ selectedMonth: null })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  expect(selectedTint(screen.container)).toBeNull()
  expect(xTickLabels(screen.container)).toHaveLength(12)
  expect(boldTickLabels(screen.container)).toEqual([])
})

test('a tooltip row shows the share of the total', async () => {
  const { screen } = await renderChart({ metric: 'solar' })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  await hoverBar(screen.container, 0)
  // April's solar: 180 of 400 kWh used directly.
  const row = await vi.waitFor(() => {
    const label = tooltipNodes()
      .flatMap((t) => [...t.querySelectorAll('span')])
      .find((el) => el.textContent === m.energy_series_solar_direct())
    expect(label).toBeDefined()
    return label?.parentElement as HTMLElement
  })
  expect(row.textContent).toContain(`${formatOneDecimal(180)} kWh`)
  expect(row.lastElementChild?.textContent).toBe(formatShare(0.45))
})

test('hovering a month outlines its column, label included', async () => {
  const { screen } = await renderChart()
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  await hoverBar(screen.container, 0)
  const ring = await vi.waitFor(() => {
    const el = outline(screen.container)
    expect(el).not.toBeNull()
    return el as SVGGraphicsElement
  })
  const tick = xTick(screen.container, monthLabel(4))
  const o = ring.getBoundingClientRect()
  const t = tick.getBoundingClientRect()
  expect(o.left).toBeLessThanOrEqual(t.left)
  expect(o.right).toBeGreaterThanOrEqual(t.right)
  expect(o.bottom).toBeGreaterThanOrEqual(t.bottom)
  // Painted above the bars (SVG paints in document order).
  for (const bar of bars(screen.container))
    expect(bar.compareDocumentPosition(ring) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(ring.getAttribute('stroke-dasharray')).toBeNull()
})

const allMonths = Array.from({ length: 12 }, () => sums())

test('after a click, moving the pointer off the chart leaves no outline or tooltip', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ data: allMonths, onSelectMonth })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(36))
  await clickOn(screen.container, bars(screen.container)[3]) // April's solar-direct
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  // The click was dispatched on the overlay, so the real pointer never entered
  // it: send the exit (React derives onPointerLeave from pointerout).
  const hint = screen.getByText(m.energy_chart_select_hint()).element()
  screen.container.querySelector('[data-hover-overlay]')?.dispatchEvent(
    new PointerEvent('pointerout', {
      bubbles: true,
      pointerType: 'mouse',
      relatedTarget: hint,
    }),
  )
  await userEvent.hover(hint)
  await new Promise((r) => setTimeout(r, 100))
  expect(outline(screen.container)).toBeNull()
  expect(tooltipText()).not.toContain(monthName(1))
  expect(tooltipText()).not.toContain(monthName(4))
})

test('a touch tap selects the month without a tooltip or an outline', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ data: allMonths, onSelectMonth })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(36))
  // tapOn re-resolves the bar for each event: a re-render may replace it.
  tapOn(screen.container, () => bars(screen.container)[3])
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  await new Promise((r) => setTimeout(r, 100))
  expect(outline(screen.container)).toBeNull()
  expect(tooltipText()).not.toContain(monthName(4))
  // The same spot under a mouse does show them (the check above is not vacuous).
  // Scroll first: on recharts the move is hit-tested, so the bar must be in view.
  bars(screen.container)[3].scrollIntoView({ block: 'center', inline: 'center' })
  const c = centre(bars(screen.container)[3])
  moveAt(screen.container, c.x + 1, c.y)
  await vi.waitFor(() => {
    expect(outline(screen.container)).not.toBeNull()
    expect(tooltipText()).toContain(monthName(4))
  })
})

test('the keyboard on a month without readings shows a dashed outline, no tooltip', async () => {
  const { screen } = await renderChart()
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  focusChart(screen.container)
  await userEvent.keyboard('{ArrowRight}') // January: no readings
  const ring = await vi.waitFor(() => {
    const el = outline(screen.container)
    expect(el).not.toBeNull()
    return el as SVGGraphicsElement
  })
  expect(ring.getAttribute('stroke-dasharray')).not.toBeNull()
  expect(tooltipText()).not.toContain(monthName(1))
  // Three more steps right is April, with readings: a solid outline.
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
  await vi.waitFor(() =>
    expect(outline(screen.container)?.getAttribute('stroke-dasharray')).toBeNull(),
  )
})

test('Space on the keyboard-focused month selects it too', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  focusChart(screen.container)
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight} ')
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

test('Enter on the keyboard-focused month selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  // Park the pointer off the chart: a hovered month wins over the keyboard's.
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  focusChart(screen.container)
  // The first → lands on January (no readings); four steps right is April.
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Enter}')
  await vi.waitFor(() => expect(onSelectMonth).toHaveBeenCalledWith(4))
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})

test('a month without readings is not selectable', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  // Park the pointer off the chart: a hovered month wins over the keyboard's.
  await userEvent.hover(screen.getByText(m.energy_chart_select_hint()))
  focusChart(screen.container)
  await userEvent.keyboard('{ArrowRight}{Enter}') // January: no readings
  await new Promise((r) => setTimeout(r, 50))
  expect(onSelectMonth).not.toHaveBeenCalled()
})

test('on a narrow chart the month labels shorten to initials', async () => {
  const { screen } = await renderChart({ width: 360 })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  const ticks = xTickLabels(screen.container)
  expect(ticks).toHaveLength(12)
  expect(ticks).toEqual(
    Array.from({ length: 12 }, (_, i) =>
      monthLabel(i + 1)
        .charAt(0)
        .toUpperCase(),
    ),
  )
})

test('on a wide chart every month label is shown in full', async () => {
  const { screen } = await renderChart({ width: 720 })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  const ticks = xTickLabels(screen.container)
  expect(ticks).toEqual(Array.from({ length: 12 }, (_, i) => monthLabel(i + 1)))
})

test('the chart is one Tab stop named by its title, with the month hint', async () => {
  const { screen } = await renderChart()
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  const group = screen.getByRole('group', { name: m.energy_chart_title({ year: '2026' }) })
  await expect.element(group).toBeInTheDocument()
  await expect.element(screen.getByText(m.energy_chart_keyboard_hint())).toBeInTheDocument()
})

test('Nät: export hangs below the zero line, the purchase stands on it', async () => {
  const { screen } = await render('grid')
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  const zero = (
    screen.container.querySelector('[data-zero-line]') as SVGLineElement
  ).getBoundingClientRect().y
  // Series order: import direct, import battery, export.
  for (const bar of seriesBars(screen.container, 2))
    expect(bar.getBoundingClientRect().top).toBeCloseTo(zero, 0)
  for (const bar of seriesBars(screen.container, 0))
    expect(bar.getBoundingClientRect().bottom).toBeCloseTo(zero, 0)
})

test('switching the metric with a card open shows the new metric', async () => {
  const props = {
    year: 2026,
    months,
    currentMonth: null,
    selectedMonth: null,
    onSelectMonth: vi.fn(),
  }
  const ui = (metric: EnergyMetric) => (
    <div style={{ width: 720, height: 340 }}>
      <EnergyMonthlyChart {...props} metric={metric} />
    </div>
  )
  const { screen, queryClient } = await renderWithProviders(ui('solar'))
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  await hoverBar(screen.container, 0) // April
  await vi.waitFor(() => expect(tooltipText()).toContain(m.energy_chart_total_solar()))
  // Same provider tree, so the chart updates instead of remounting.
  screen.rerender(<QueryClientProvider client={queryClient}>{ui('grid')}</QueryClientProvider>)
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(m.energy_chart_total_grid())
    expect(tooltipText()).not.toContain(m.energy_chart_total_solar())
  })
})

test('a 320 px phone: initials, and the outline stays inside the chart at both ends', async () => {
  const { screen } = await renderChart({ data: allMonths, width: 320 })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(36))
  expect(xTickLabels(screen.container).every((l) => l.length === 1)).toBe(true)
  const svg = (
    screen.container.querySelector('svg[data-chart-svg]') as SVGSVGElement
  ).getBoundingClientRect()
  for (const i of [0, 11]) {
    // Series 0's bars, month by month: [0] January, [11] December.
    await hoverBar(screen.container, i)
    const o = await vi.waitFor(() => {
      const el = outline(screen.container)
      expect(el).not.toBeNull()
      return (el as SVGGraphicsElement).getBoundingClientRect()
    })
    expect(o.left).toBeGreaterThanOrEqual(svg.left)
    expect(o.right).toBeLessThanOrEqual(svg.right)
  }
  // The widest y label is inside the chart.
  const yLabels = [...screen.container.querySelectorAll('[data-axis="y"] text')]
  for (const t of yLabels) expect(t.getBoundingClientRect().left).toBeGreaterThanOrEqual(svg.left)
})

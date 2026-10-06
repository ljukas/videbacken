import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { m } from '~/paraglide/messages'
import {
  barHeight,
  bars,
  boldTickLabels,
  centre,
  focusChart,
  focusTarget,
  gridLines,
  hoverBar,
  hoverBetween,
  legend,
  legendLabels,
  moveAt,
  outline,
  parkPointer,
  selectedTint,
  seriesBars,
  settle,
  tapOn,
  tooltipText,
  xTick,
  xTickLabels,
  xTickTexts,
} from '~test/browser/chartDom'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { BarChart, type BarChartProps } from './BarChart'

// Keep the real pointer off the charts (see parkPointer).
beforeEach(parkPointer)

type Row = { label: string; a: number | null; b: number | null }
const rows: Row[] = [
  { label: 'jan', a: 10, b: 5 },
  { label: 'feb', a: null, b: null },
  { label: 'mar', a: 0, b: 0 },
  { label: 'apr', a: 30, b: 10 },
]
const base: BarChartProps<Row> = {
  rows,
  category: (r) => r.label,
  series: [
    { key: 'a', label: 'Serie A', color: 'red' },
    { key: 'b', label: 'Serie B', color: 'blue' },
  ],
  value: (r, k) => r[k as 'a' | 'b'],
  yTickFormat: String,
  tooltip: (r) =>
    r.a === null ? null : (
      <span>
        A {r.a} B {r.b}
      </span>
    ),
  legend: true,
  label: 'Testdiagram',
}
const render = (over: Partial<BarChartProps<Row>> = {}, width = 480) =>
  renderWithProviders(
    <div style={{ width }}>
      <button type="button">before</button>
      <BarChart {...base} {...over} />
    </div>,
  )

test('draws one bar per drawn value, series by series, with data hooks', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(4)) // jan, apr × 2; feb null, mar 0
  expect(seriesBars(screen.container, 0).map((b) => b.getAttribute('data-index'))).toEqual([
    '0',
    '3',
  ])
  expect(screen.container.querySelector('[data-series="a"][data-kind="bar"]')).not.toBeNull()
})

test('the legend lists the series in order', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(legendLabels(screen.container)).toEqual(['Serie A', 'Serie B']))
})

test('hovering anywhere in a month opens its card with the month label on top', async () => {
  const { screen } = await render()
  await hoverBar(screen.container, 1) // apr's a
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  const card = document.querySelector('[data-slot="chart-tooltip"]')
  expect(card?.className).toContain('bg-background')
})

// The centre of the `i`th of the 4 bands, in client coordinates.
const bandCentre = (container: Element, i: number) => {
  const o = (
    container.querySelector('[data-hover-overlay]') as SVGRectElement
  ).getBoundingClientRect()
  return { x: o.x + (o.width * (i + 0.5)) / 4, y: o.y + o.height / 2 }
}

test('a month whose bars draw nothing still answers a hover; a null tooltip opens nothing', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  const mar = bandCentre(screen.container, 2) // 0 and 0: no rect, but a tooltip
  moveAt(screen.container, mar.x, mar.y)
  await vi.waitFor(() => expect(tooltipText()).toBe('marA 0 B 0'))
  const feb = bandCentre(screen.container, 1) // its tooltip render is null: no card at all
  moveAt(screen.container, feb.x, feb.y)
  await vi.waitFor(() => expect(document.querySelector('[data-slot="chart-tooltip"]')).toBeNull())
})

test('the band halfway between two bars answers too (hoverBetween)', async () => {
  const { screen } = await render({ rows: [rows[0], rows[2], rows[3]] }) // jan, mar, apr
  await hoverBetween(screen.container, 0, 1) // jan's a and apr's a: mar's band
  await vi.waitFor(() => expect(tooltipText()).toBe('marA 0 B 0'))
})

test('leaving the chart with a mouse closes the card', async () => {
  const { screen } = await render()
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  // React's onPointerLeave listens to pointerout with a relatedTarget outside.
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  overlay.dispatchEvent(
    new PointerEvent('pointerout', {
      bubbles: true,
      pointerType: 'mouse',
      relatedTarget: document.body,
    }),
  )
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

test('a labelled chart is one named Tab stop; arrows, Home and End walk the months', async () => {
  const { screen } = await render()
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  const group = screen.getByRole('group', { name: 'Testdiagram' })
  await expect.element(group).toHaveFocus()
  expect(group.element().getAttribute('aria-describedby')).toBeTruthy()
  await expect.element(screen.getByText(m.chart_keyboard_hint())).toBeInTheDocument()
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(tooltipText()).toBe('janA 10 B 5'))
  await userEvent.keyboard('{End}')
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  // A keyboard step is announced once, politely, with its month.
  const live = screen.container.querySelector('[data-chart-announce]')
  expect(live?.getAttribute('aria-live')).toBe('polite')
  expect(live?.textContent).toBe('aprA 30 B 10')
  await userEvent.keyboard('{Home}')
  await vi.waitFor(() => expect(tooltipText()).toBe('janA 10 B 5'))
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
  expect(live?.textContent).toBe('')
})

test('the keyboard walk steps over a month without a tooltip instead of restarting', async () => {
  const { screen } = await render()
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}') // jan
  await vi.waitFor(() => expect(tooltipText()).toBe('janA 10 B 5'))
  await userEvent.keyboard('{ArrowRight}') // feb: null tooltip, nothing shown
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
  await userEvent.keyboard('{ArrowRight}') // mar, not jan again
  await vi.waitFor(() => expect(tooltipText()).toBe('marA 0 B 0'))
})

test('a pointer move after a keyboard step clears the announcement', async () => {
  const { screen } = await render()
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  await hoverBar(screen.container, 1)
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  expect(screen.container.querySelector('[data-chart-announce]')?.textContent).toBe('')
})

test('an unlabelled chart is hidden from assistive tech and not a Tab stop', async () => {
  const { screen } = await render({ label: undefined })
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  expect(focusTarget(screen.container)).toBeNull()
  expect(screen.container.querySelector('[data-chart="bar"]')?.getAttribute('aria-hidden')).toBe(
    'true',
  )
})

test('xTickEvery labels every nth category', async () => {
  const { screen } = await render({ xTickEvery: 2 })
  await vi.waitFor(() => expect(xTickLabels(screen.container)).toEqual(['jan', 'mar']))
})

test('a line series draws a dashed path through its non-null points, with solid dots', async () => {
  const { screen } = await render({
    series: [{ key: 'a', label: 'Serie A', color: 'red' }],
    line: { key: 'b', label: 'Serie B', color: 'blue', dash: '5 4' },
  })
  await vi.waitFor(
    () => expect(screen.container.querySelectorAll('[data-line-dot]')).toHaveLength(3), // jan, mar, apr
  )
  const curve = screen.container.querySelector('[data-line-curve]')
  expect(curve?.getAttribute('stroke-dasharray')).toBe('5 4')
  expect(curve?.getAttribute('d')?.match(/M/g)).toHaveLength(2) // broken at feb (null)
  for (const dot of screen.container.querySelectorAll('[data-line-dot]')) {
    expect(dot.getAttribute('stroke-dasharray')).toBeNull()
    expect(dot.getAttribute('fill')).toBe('#fff')
  }
  expect(legendLabels(screen.container)).toEqual(['Serie A', 'Serie B'])
})

test('hideYAxis drops the y axis and the grid', async () => {
  const { screen } = await render({ hideYAxis: true })
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  expect(screen.container.querySelector('[data-axis="y"]')).toBeNull()
  expect(screen.container.querySelector('[data-grid]')).toBeNull()
})

test('the card stays inside the window at the edges', async () => {
  const { screen } = await render({}, 320)
  await hoverBar(screen.container, 0) // the first month, at the left edge
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const card = document.querySelector('[data-slot="chart-tooltip"]') as HTMLElement
  await vi.waitFor(() => {
    const r = card.getBoundingClientRect()
    expect(r.left).toBeGreaterThanOrEqual(8)
    expect(r.right).toBeLessThanOrEqual(window.innerWidth - 8)
  })
})

test('Tab out of the chart closes the card and the announcement', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 480 }}>
      <button type="button">before</button>
      <BarChart {...base} />
      <button type="button">after</button>
    </div>,
  )
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(tooltipText()).toBe('janA 10 B 5'))
  await userEvent.tab()
  await expect.element(screen.getByRole('button', { name: 'after' })).toHaveFocus()
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
  expect(screen.container.querySelector('[data-chart-announce]')?.textContent).toBe('')
})

test('a tap opens the month under the finger, survives the lift, and a tap outside closes it', async () => {
  const { screen } = await render({}, 360)
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  const overlay = screen.container.querySelector('[data-hover-overlay]') as Element
  const p = bandCentre(screen.container, 3)
  const touch = { bubbles: true, clientX: p.x, clientY: p.y, pointerType: 'touch' }
  overlay.dispatchEvent(new PointerEvent('pointerdown', touch))
  overlay.dispatchEvent(new PointerEvent('pointerup', touch))
  overlay.dispatchEvent(new PointerEvent('pointerout', { ...touch, relatedTarget: document.body }))
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  document.body.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
  )
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

test('the card stays inside the window at the right edge too', async () => {
  const { screen } = await render({}, 400)
  await hoverBar(screen.container, 1) // apr, the last month
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  const card = document.querySelector('[data-slot="chart-tooltip"]') as HTMLElement
  await vi.waitFor(() => {
    const r = card.getBoundingClientRect()
    expect(r.right).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(r.left).toBeGreaterThanOrEqual(8)
  })
})

test('the card keeps its width at the right edge instead of wrapping into the space left', async () => {
  const wide = (r: Row) => <span>{`Ett långt värde för ${r.label} som inte ska radbrytas`}</span>
  // The chart's right edge on the window's right edge, so April's anchor is
  // a few dozen px from it.
  const { screen } = await renderWithProviders(
    <div style={{ width: 400, marginLeft: Math.max(0, window.innerWidth - 410) }}>
      <BarChart {...base} tooltip={wide} />
    </div>,
  )
  const width = async (index: number, month: string) => {
    await hoverBar(screen.container, index)
    await vi.waitFor(() => expect(tooltipText()).toContain(month))
    const card = document.querySelector('[data-slot="chart-tooltip"]') as HTMLElement
    return card.getBoundingClientRect().width
  }
  const first = await width(0, 'jan') // mid-window
  const last = await width(1, 'apr') // at the window's right edge
  expect(Math.abs(last - first)).toBeLessThan(4)
})

test('moving from the plot onto the axis or the legend closes the card', async () => {
  const { screen } = await render()
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  overlay.dispatchEvent(
    new PointerEvent('pointerout', {
      bubbles: true,
      pointerType: 'mouse',
      relatedTarget: screen.container.querySelector('[data-slot="chart-legend"]'),
    }),
  )
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

test('the keyboard announcement names the category even without a visible title', async () => {
  const { screen } = await render({ tooltipTitle: false })
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(tooltipText()).toBe('A 10 B 5'))
  expect(screen.container.querySelector('[data-chart-announce]')?.textContent).toBe('janA 10 B 5')
})

test('the card sits above the line dot when the line is higher than the bars', async () => {
  const { screen } = await render({
    series: [{ key: 'a', label: 'Serie A', color: 'red' }],
    line: { key: 'b', label: 'Serie B', color: 'blue' },
    value: (r, k) => (k === 'b' ? (r.b === null ? null : r.b * 10) : r[k as 'a']),
  })
  await hoverBar(screen.container, 0) // jan: bar 10, dot 50
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const dot = screen.container.querySelector('[data-line-dot]') as SVGCircleElement
  const card = document.querySelector('[data-slot="chart-tooltip"]') as HTMLElement
  await vi.waitFor(() =>
    expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      dot.getBoundingClientRect().top,
    ),
  )
})

test('the announcement is read whole, not just the text that changed', async () => {
  const { screen } = await render()
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-chart-announce]')).not.toBeNull(),
  )
  expect(screen.container.querySelector('[data-chart-announce]')?.getAttribute('aria-atomic')).toBe(
    'true',
  )
})

test('fewer rows after a refetch never leave the keyboard on a missing category', async () => {
  const queryClient = makeTestQueryClient()
  const ui = (shown: Row[]) => (
    <div style={{ width: 480 }}>
      <button type="button">before</button>
      <BarChart {...base} rows={shown} />
    </div>
  )
  const { screen } = await renderWithProviders(ui(rows), { queryClient })
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{End}')
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  // Same tree (provider included), so the chart keeps focus as the rows shrink.
  await screen.rerender(
    <QueryClientProvider client={queryClient}>{ui(rows.slice(0, 2))}</QueryClientProvider>,
  )
  await userEvent.keyboard('{ArrowLeft}')
  await vi.waitFor(() => expect(tooltipText()).toBe('janA 10 B 5'))
})

test('browser shortcuts with a modifier pass through', async () => {
  const { screen } = await render()
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}')
  await settle()
  expect(tooltipText()).toBe('')
})

const cardBox = () =>
  (document.querySelector('[data-slot="chart-tooltip"]') as HTMLElement).getBoundingClientRect()

test('an open card follows its bar when a refetch changes the bar', async () => {
  const queryClient = makeTestQueryClient()
  const ui = (shown: Row[]) => (
    <div style={{ width: 480 }}>
      <BarChart {...base} rows={shown} />
    </div>
  )
  const { screen } = await renderWithProviders(ui(rows), { queryClient })
  await hoverBar(screen.container, 1) // apr: a 30 + b 10
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  await settle()
  const before = cardBox().bottom
  // April halves: its stack's top drops, so the card must drop with it.
  const lower = rows.map((r) => (r.label === 'apr' ? { ...r, a: 15, b: 5 } : r))
  await screen.rerender(<QueryClientProvider client={queryClient}>{ui(lower)}</QueryClientProvider>)
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 15 B 5'))
  await vi.waitFor(() => expect(cardBox().bottom).toBeGreaterThan(before + 10))
})

test('an open card follows its bar when its scroll container scrolls', async () => {
  const { screen } = await renderWithProviders(
    // Room above the chart, so the card stays above its bar (no flip) after the scroll.
    <div data-testid="scroller" style={{ height: 700, overflowY: 'auto' }}>
      <div style={{ width: 480, paddingTop: 400, paddingBottom: 900 }}>
        <BarChart {...base} />
      </div>
    </div>,
  )
  const scroller = screen.getByTestId('scroller').element() as HTMLElement
  await hoverBar(screen.container, 1)
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  await settle()
  const bar = () => bars(screen.container)[1].getBoundingClientRect().top
  const gap = bar() - cardBox().bottom
  scroller.scrollTop += 60
  await vi.waitFor(() => expect(Math.abs(bar() - cardBox().bottom - gap)).toBeLessThan(2))
})

test('a finger can drag across the bars: the plot only lets the page pan vertically', async () => {
  const { screen } = await render()
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-hover-overlay]')).not.toBeNull(),
  )
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  expect(overlay.style.touchAction).toBe('pan-y')
})

test('a long tooltip wraps inside a readable width', async () => {
  const long = () => <span>{'Ett mycket långt förklarande stycke text '.repeat(6)}</span>
  const { screen } = await render({ tooltip: long }, 480)
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  expect(cardBox().width).toBeLessThanOrEqual(22 * 16 + 1)
})

test('the y labels stay inside the chart', async () => {
  const { screen } = await render({ yTickFormat: (v) => `${v} 000 kr` })
  await vi.waitFor(() =>
    expect(
      screen.container.querySelectorAll('[data-axis="y"] .visx-axis-tick').length,
    ).toBeGreaterThan(1),
  )
  const svg = (
    screen.container.querySelector('svg[data-chart-svg]') as SVGSVGElement
  ).getBoundingClientRect()
  for (const t of screen.container.querySelectorAll('[data-axis="y"] .visx-axis-tick text')) {
    expect(t.getBoundingClientRect().left).toBeGreaterThanOrEqual(svg.left - 0.5)
  }
})

test('with the y axis shown, grid lines and the axis line are drawn; yAxisLine={false} drops only the line', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(gridLines(screen.container).length).toBeGreaterThan(1))
  expect(screen.container.querySelector('[data-axis="y"] .visx-axis-line')).not.toBeNull()
  const hidden = await render({ yAxisLine: false })
  await vi.waitFor(() => expect(gridLines(hidden.screen.container).length).toBeGreaterThan(1))
  expect(hidden.screen.container.querySelector('[data-axis="y"] .visx-axis-line')).toBeNull()
})

test('stackOffset="diverging" hangs a negative series from the zero line', async () => {
  const signed = [
    { label: 'jan', a: 10, b: -6 },
    { label: 'feb', a: 4, b: -12 },
  ]
  const { screen } = await render({
    rows: signed,
    series: [
      { key: 'a', label: 'A', color: 'red', stack: 's' },
      { key: 'b', label: 'B', color: 'blue', stack: 's' },
    ],
    stackOffset: 'diverging',
    zeroLine: true,
  })
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(4))
  const zero = screen.container.querySelector('[data-zero-line]') as SVGLineElement
  expect(zero).not.toBeNull()
  const zeroY = zero.getBoundingClientRect().y
  for (const bar of seriesBars(screen.container, 1)) {
    expect(bar.getBoundingClientRect().top).toBeCloseTo(zeroY, 0)
  }
  for (const bar of seriesBars(screen.container, 0)) {
    expect(bar.getBoundingClientRect().bottom).toBeCloseTo(zeroY, 0)
  }
})

test('no zero line unless asked for', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  expect(screen.container.querySelector('[data-zero-line]')).toBeNull()
})

const twelve = Array.from({ length: 12 }, (_, i) => ({ label: `Långmånad${i}`, a: 5, b: 1 }))

const shortProps = { rows: twelve, shortCategory: (r: Row) => r.label.slice(-1) }

test('shortCategory: every label short when the full ones do not fit', async () => {
  const { screen } = await render(shortProps, 240)
  await vi.waitFor(() =>
    expect(xTickLabels(screen.container)).toEqual(twelve.map((r) => r.label.slice(-1))),
  )
})

test('shortCategory: every label in full when they fit', async () => {
  const { screen } = await render(shortProps, 1400)
  await vi.waitFor(() => expect(xTickLabels(screen.container)).toEqual(twelve.map((r) => r.label)))
})

test('tickPx sets the axis label size', async () => {
  const { screen } = await render({ tickPx: 13 })
  await vi.waitFor(() => expect(xTickTexts(screen.container).length).toBeGreaterThan(0))
  for (const t of xTickTexts(screen.container)) expect(t.getAttribute('font-size')).toBe('13')
})

const tiny = [
  { label: 'jan', a: 0.1, b: null },
  { label: 'feb', a: 100, b: null },
]

test('a tiny value is floored to MIN_BAR_PX by default', async () => {
  const { screen } = await render({ rows: tiny })
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(2))
  expect(barHeight(bars(screen.container)[0])).toBeCloseTo(4, 0)
})

test('minBarPx 0 draws a tiny value at its true height', async () => {
  const { screen } = await render({ rows: tiny, minBarPx: 0 })
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(2))
  expect(barHeight(bars(screen.container)[0])).toBeLessThan(1)
})

test('tooltipClassName and legendClassName merge over the defaults', async () => {
  const { screen } = await render({
    tooltipClassName: 'min-w-56 text-sm',
    legendClassName: 'text-sm',
  })
  expect(legend(screen.container)?.className).toContain('text-sm')
  await hoverBar(screen.container, 0)
  const card = await vi.waitFor(() => {
    const el = document.querySelector('[data-slot="chart-tooltip"]')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  expect(card.className).toContain('text-sm')
  expect(card.className).not.toContain('text-xs')
  expect(card.className).toContain('min-w-56')
  expect(card.className).not.toContain('min-w-32')
})

test('keyboardHint replaces the default hint', async () => {
  const { screen } = await render({ keyboardHint: 'Pila och välj' })
  await expect.element(screen.getByText('Pila och välj')).toBeInTheDocument()
  expect(screen.container.textContent).not.toContain(m.chart_keyboard_hint())
})

// jan, mar and apr can be selected; feb (null) can't.
const selectable = (r: Row) => r.a !== null
const withSelection = (selected: number | null, onSelect = vi.fn()) => ({
  selection: { selected, onSelect, canSelect: selectable },
})
const overlayBox = (c: Element) =>
  (c.querySelector('[data-hover-overlay]') as SVGRectElement).getBoundingClientRect()
const clickBand = (c: Element, i: number, y?: number) => {
  const o = overlayBox(c)
  const at = { bubbles: true, clientX: o.x + (o.width * (i + 0.5)) / 4, clientY: y ?? o.y + 10 }
  const overlay = c.querySelector('[data-hover-overlay]') as SVGRectElement
  overlay.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse' }))
  overlay.dispatchEvent(new MouseEvent('click', at))
}

test('a click selects the category under it; one that cannot be selected does nothing', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  clickBand(screen.container, 1) // feb
  clickBand(screen.container, 3) // apr
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(3))
  expect(onSelect).toHaveBeenCalledTimes(1)
})

test('the label band under the plot is clickable too', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  const tick = xTick(screen.container, 'jan').getBoundingClientRect()
  expect(overlayBox(screen.container).bottom).toBeGreaterThanOrEqual(tick.bottom)
  clickBand(screen.container, 0, tick.y + tick.height / 2)
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(0))
})

test('without selection the overlay stops at the plot and draws no outline', async () => {
  const { screen } = await render()
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const tick = xTick(screen.container, 'jan').getBoundingClientRect()
  expect(overlayBox(screen.container).bottom).toBeLessThanOrEqual(tick.top)
  expect(outline(screen.container)).toBeNull()
})

test('Enter and Space select the keyboard category; not one that cannot be selected', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{Enter}') // feb: nothing
  await userEvent.keyboard('{ArrowRight}{ArrowRight} ') // apr
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(3))
  expect(onSelect).toHaveBeenCalledTimes(1)
  await userEvent.keyboard('{Home}{Enter}')
  await vi.waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(0))
})

test('the selected category is tinted over its band and its label is bold', async () => {
  const { screen } = await render(withSelection(2))
  const tint = await vi.waitFor(() => {
    const el = selectedTint(screen.container)
    expect(el).not.toBeNull()
    return el as SVGGraphicsElement
  })
  const band = centre(xTick(screen.container, 'apr')).x - centre(xTick(screen.container, 'mar')).x
  expect(tint.getBoundingClientRect().width).toBeCloseTo(band, 0)
  expect(centre(tint).x).toBeCloseTo(centre(xTick(screen.container, 'mar')).x, 0)
  expect(boldTickLabels(screen.container)).toEqual(['mar'])
  // Painted under the bars.
  for (const bar of bars(screen.container))
    expect(tint.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

// One chart per test: a second chart rendered after an unmount in the same
// test stays empty in this setup.
const expectNoSelectionDrawn = async (selected: number | null) => {
  const { screen } = await render(withSelection(selected))
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  // All four labels drawn, so no bold label can't pass on an empty axis.
  await vi.waitFor(() => expect(xTickTexts(screen.container)).toHaveLength(4))
  expect(selectedTint(screen.container)).toBeNull()
  expect(boldTickLabels(screen.container)).toEqual([])
}

test('no selection draws no tint and no bold label', () => expectNoSelectionDrawn(null))

test('a selection past the last row draws no tint and no bold label', () =>
  expectNoSelectionDrawn(4))

test('a negative selection draws no tint and no bold label', () => expectNoSelectionDrawn(-1))

test('a new selection moves the tint; the hover outline stays on the pointer', async () => {
  const { screen, queryClient } = await render(withSelection(0))
  await hoverBar(screen.container, 1) // apr's a
  await vi.waitFor(() => expect(outline(screen.container)).not.toBeNull())
  const outlineX = centre(outline(screen.container) as Element).x
  // Same tree (provider included), so the chart keeps its state.
  await screen.rerender(
    <QueryClientProvider client={queryClient}>
      <div style={{ width: 480 }}>
        <button type="button">before</button>
        <BarChart {...base} {...withSelection(2)} />
      </div>
    </QueryClientProvider>,
  )
  await vi.waitFor(() => expect(boldTickLabels(screen.container)).toEqual(['mar']))
  expect(centre(outline(screen.container) as Element).x).toBeCloseTo(outlineX, 0)
})

test('hovering a selectable category outlines its column, label included, over the bars', async () => {
  const { screen } = await render(withSelection(null))
  await hoverBar(screen.container, 1) // apr's a
  const o = await vi.waitFor(() => {
    const el = outline(screen.container)
    expect(el).not.toBeNull()
    return el as SVGGraphicsElement
  })
  const box = o.getBoundingClientRect()
  const tick = xTick(screen.container, 'apr').getBoundingClientRect()
  expect(box.left).toBeLessThanOrEqual(tick.left)
  expect(box.right).toBeGreaterThanOrEqual(tick.right)
  expect(box.bottom).toBeGreaterThanOrEqual(tick.bottom)
  expect(o.getAttribute('stroke-dasharray')).toBeNull()
  for (const bar of bars(screen.container))
    expect(bar.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  expect(overlay.style.cursor).toBe('pointer')
})

test('hovering a category that cannot be selected draws no outline and no pointer cursor', async () => {
  const { screen } = await render(withSelection(null))
  const overlay = () => screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  // First an outlined one, so the checks below can't pass on a chart that never outlines.
  await hoverBar(screen.container, 1) // apr's a
  await vi.waitFor(() => {
    expect(outline(screen.container)).not.toBeNull()
    expect(overlay().style.cursor).toBe('pointer')
  })
  const o = overlayBox(screen.container)
  moveAt(screen.container, o.x + (o.width * 1.5) / 4, o.y + 10) // feb
  await vi.waitFor(() => {
    expect(outline(screen.container)).toBeNull()
    expect(overlay().style.cursor).toBe('')
  })
})

test('from the keyboard a category that cannot be selected gets a dashed outline', async () => {
  const { screen } = await render(withSelection(null))
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}') // feb
  await vi.waitFor(() =>
    expect(outline(screen.container)?.getAttribute('stroke-dasharray')).not.toBeNull(),
  )
  await userEvent.keyboard('{ArrowRight}') // mar
  await vi.waitFor(() =>
    expect(outline(screen.container)?.getAttribute('stroke-dasharray')).toBeNull(),
  )
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(outline(screen.container)).toBeNull())
})

test('a tap selects without a card or an outline; a mouse afterwards shows both', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  tapOn(screen.container, () => bars(screen.container)[1]) // apr
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(3))
  await settle()
  expect(tooltipText()).toBe('')
  expect(outline(screen.container)).toBeNull()
  const c = centre(bars(screen.container)[1])
  moveAt(screen.container, c.x + 1, c.y)
  await vi.waitFor(() => {
    expect(tooltipText()).toBe('aprA 30 B 10')
    expect(outline(screen.container)).not.toBeNull()
  })
})

test('leaving the chart with a mouse clears the outline', async () => {
  const { screen } = await render(withSelection(null))
  await hoverBar(screen.container, 1)
  await vi.waitFor(() => expect(outline(screen.container)).not.toBeNull())
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  overlay.dispatchEvent(
    new PointerEvent('pointerout', {
      bubbles: true,
      pointerType: 'mouse',
      relatedTarget: document.body,
    }),
  )
  await vi.waitFor(() => expect(outline(screen.container)).toBeNull())
})

test('a non-integer selection draws no tint and no bold label', () => expectNoSelectionDrawn(1.5))

// Records whether each key press's default was prevented (after React's handler).
const recordKeys = () => {
  const seen: { key: string; prevented: boolean }[] = []
  const listener = (e: KeyboardEvent) => seen.push({ key: e.key, prevented: e.defaultPrevented })
  document.addEventListener('keydown', listener)
  return { seen, stop: () => document.removeEventListener('keydown', listener) }
}

test('after the mouse leaves, Enter and Space select nothing and Space keeps its default', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await hoverBar(screen.container, 1) // apr's a
  await vi.waitFor(() => expect(outline(screen.container)).not.toBeNull())
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  overlay.dispatchEvent(
    new PointerEvent('pointerout', {
      bubbles: true,
      pointerType: 'mouse',
      relatedTarget: document.body,
    }),
  )
  await vi.waitFor(() => expect(outline(screen.container)).toBeNull())
  focusChart(screen.container)
  const keys = recordKeys()
  try {
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{Enter}')
    await settle()
  } finally {
    keys.stop()
  }
  expect(onSelect).not.toHaveBeenCalled()
  expect(keys.seen.find((k) => k.key === ' ')?.prevented).toBe(false)
})

test('Space on a keyboard category selects it and keeps the page from scrolling', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{End}') // apr
  await vi.waitFor(() => expect(outline(screen.container)).not.toBeNull())
  const keys = recordKeys()
  try {
    await userEvent.keyboard(' ')
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(3))
  } finally {
    keys.stop()
  }
  expect(keys.seen.find((k) => k.key === ' ')?.prevented).toBe(true)
})

test('fewer rows after a refetch never let Enter select a missing category', async () => {
  const onSelect = vi.fn()
  const queryClient = makeTestQueryClient()
  const ui = (shown: Row[]) => (
    <div style={{ width: 480 }}>
      <button type="button">before</button>
      <BarChart {...base} {...withSelection(null, onSelect)} rows={shown} />
    </div>
  )
  const { screen } = await renderWithProviders(ui(rows), { queryClient })
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{End}')
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  // Same tree (provider included), so the chart keeps focus as the rows shrink.
  await screen.rerender(
    <QueryClientProvider client={queryClient}>{ui(rows.slice(0, 2))}</QueryClientProvider>,
  )
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(2)) // jan's a and b
  await userEvent.keyboard('{Enter}')
  await settle()
  expect(onSelect).not.toHaveBeenCalled()
})

test('a hatched series fills its bars with a pattern in the chart and hatches its legend swatch', async () => {
  const { screen } = await render({
    series: [
      { key: 'a', label: 'Serie A', color: 'var(--energy-battery)', stack: 's' },
      { key: 'b', label: 'Serie B', color: 'var(--energy-loss)', stack: 's', pattern: 'hatch' },
    ],
  })
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-series="b"] [data-bar]')).not.toBeNull(),
  )
  const fill =
    screen.container.querySelector('[data-series="b"] [data-bar]')?.getAttribute('fill') ?? ''
  const id = /^url\(#(.+)\)$/.exec(fill)?.[1]
  expect(id).toBeTruthy()
  expect(screen.container.querySelector(`pattern[id="${id}"]`)).not.toBeNull()
  expect(screen.container.querySelector('[data-series="a"] [data-bar]')?.getAttribute('fill')).toBe(
    'var(--energy-battery)',
  )
  const swatch = screen.container.querySelector<HTMLElement>('[data-legend-item="b"] > div')
  expect(swatch?.style.backgroundImage).toContain('repeating-linear-gradient')
})

test('barLabel draws above its stack, and nothing where it returns null', async () => {
  // Index 3 is apr (the tallest stack); feb (1) has no bars at all.
  const { screen } = await render({ barLabel: (_r, i) => (i === 3 ? '43 %' : null) })
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('[data-bar-label]')).toHaveLength(1),
  )
  const label = screen.container.querySelector<SVGTextElement>('[data-bar-label]')
  expect(label?.textContent).toBe('43 %')
  const top = Math.min(
    ...[...screen.container.querySelectorAll('[data-bar][data-index="3"]')].map(
      (b) => b.getBoundingClientRect().top,
    ),
  )
  expect(label?.getBoundingClientRect().bottom).toBeLessThanOrEqual(top)
})

test('without pattern or barLabel nothing new is drawn', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  expect(screen.container.querySelectorAll('pattern, [data-bar-label]')).toHaveLength(0)
})

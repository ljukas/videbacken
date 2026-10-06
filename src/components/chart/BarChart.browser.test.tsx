import { QueryClientProvider } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { m } from '~/paraglide/messages'
import {
  bars,
  focusTarget,
  hoverBar,
  hoverBetween,
  legendLabels,
  pointAt,
  seriesBars,
  settle,
  tooltipText,
  xTickLabels,
} from '~test/browser/chartDom'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { BarChart, type BarChartProps } from './BarChart'

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
  pointAt(mar.x, mar.y)
  await vi.waitFor(() => expect(tooltipText()).toBe('marA 0 B 0'))
  const feb = bandCentre(screen.container, 1) // its tooltip render is null: no card at all
  pointAt(feb.x, feb.y)
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

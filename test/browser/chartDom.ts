import { expect, vi } from 'vitest'

// Library-neutral queries for the chart tests. Each selector matches recharts'
// DOM and the visx bar module's own data-* hooks, so a test keeps its
// assertions while a chart moves from one to the other (client-perf step 5).
// Once no chart in a test file renders recharts, its recharts half is dead
// weight; step 5c deletes those halves with recharts itself.
const SEL = {
  bar: '.recharts-bar-rectangle, [data-bar]',
  barSeries: '.recharts-bar, [data-kind="bar"]',
  lineSeries: '.recharts-line, [data-kind="line"]',
  lineCurve: '.recharts-line-curve, [data-line-curve]',
  lineDot: '.recharts-line-dot, [data-line-dot]',
  legend: '.recharts-legend-wrapper, [data-slot="chart-legend"]',
  tooltip: '.recharts-tooltip-wrapper, [data-slot="chart-tooltip"]',
  // recharts 3 draws tick labels in their own layer (the tick groups hold only tick lines).
  xTick: '.recharts-xAxis-tick-labels text, [data-axis="x"] .visx-axis-tick',
  yTick: '.recharts-yAxis-tick-labels text, [data-axis="y"] .visx-axis-tick',
  gridLine: '.recharts-cartesian-grid-horizontal line, [data-grid] line, line[data-grid]',
  svg: 'svg.recharts-surface, svg[data-chart-svg]',
  focus: 'svg.recharts-surface[tabindex], [data-chart-focus]',
} as const

const all = <E extends Element = Element>(root: ParentNode, sel: string) => [
  ...root.querySelectorAll<E>(sel),
]

/** Every bar rectangle, in DOM order: series by series, then month by month. */
export const bars = (root: ParentNode) => all<SVGElement>(root, SEL.bar)
/** The bar series groups, in series order. */
export const barSeries = (root: ParentNode) => all(root, SEL.barSeries)
/** The bars of the `i`th bar series. Throws when there is no such series, so a check over its bars can't pass empty. */
export const seriesBars = (root: ParentNode, i: number) => {
  const series = barSeries(root)[i]
  if (!series) throw new Error(`no bar series ${i} (found ${barSeries(root).length})`)
  return all<SVGElement>(series, SEL.bar)
}
/**
 * A bar's drawn height in px. recharts wraps the shape in a group; the visx
 * module's `[data-bar]` must be the visible shape itself, never a group with
 * a hit area in it.
 */
export const barHeight = (bar: Element) =>
  (bar.matches('path, rect')
    ? bar
    : (bar.querySelector('path, rect') ?? bar)
  ).getBoundingClientRect().height
export const lineSeries = (root: ParentNode) => all(root, SEL.lineSeries)
export const lineCurve = (root: ParentNode) => root.querySelector<SVGPathElement>(SEL.lineCurve)
export const lineDots = (root: ParentNode) => all<SVGElement>(root, SEL.lineDot)
export const gridLines = (root: ParentNode) => all(root, SEL.gridLine)
export const chartSvg = (root: ParentNode) => root.querySelector<SVGSVGElement>(SEL.svg)
/** The chart's keyboard stop (recharts' focusable svg, or the visx module's group). */
export const focusTarget = (root: ParentNode) => root.querySelector<HTMLElement>(SEL.focus)

export const legend = (root: ParentNode) => root.querySelector<HTMLElement>(SEL.legend)
export const legendText = (root: ParentNode) => legend(root)?.textContent ?? ''
/** Legend entries' labels in order. */
export const legendLabels = (root: ParentNode) => {
  const box = legend(root)
  if (!box) return []
  const items = all(box, '[data-legend-item]')
  // recharts: wrapper > ChartLegendContent's div > one div per entry.
  const entries = items.length > 0 ? items : [...(box.firstElementChild?.children ?? [])]
  return entries.map((e) => e.textContent ?? '')
}

/** The open tooltip's text ('' when none). Tooltips may be portalled, so this searches the document. */
export const tooltipText = () =>
  all(document, SEL.tooltip)
    .map((t) => t.textContent ?? '')
    .join('\n')

export const xTickLabels = (root: ParentNode) =>
  all(root, SEL.xTick).map((t) => t.textContent ?? '')
export const yTickLabels = (root: ParentNode) =>
  all(root, SEL.yTick).map((t) => t.textContent ?? '')

/** Moves the pointer to (x, y): both recharts (mousemove) and the visx module (pointermove) listen. */
export function pointAt(x: number, y: number) {
  const target = document.elementFromPoint(x, y)
  if (!target) throw new Error(`nothing at (${x}, ${y}): off the viewport?`)
  const init = { bubbles: true, clientX: x, clientY: y }
  target.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerType: 'mouse' }))
  target.dispatchEvent(new MouseEvent('mousemove', init))
}

const centre = (el: Element) => {
  const b = el.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

// elementFromPoint only sees the viewport (414 px wide by default), and tests
// often render a wider chart: scroll the bar into view before pointing at it.
const reveal = (el: Element) => el.scrollIntoView({ block: 'center', inline: 'center' })

/** Hovers the centre of the `index`th bar (DOM order, see `bars`). */
export async function hoverBar(root: ParentNode, index: number) {
  await vi.waitFor(() => expect(bars(root).length).toBeGreaterThan(index))
  reveal(bars(root)[index])
  const { x, y } = centre(bars(root)[index])
  pointAt(x, y)
}

/** Hovers halfway between two bars' centres (a month that draws no rect of its own). */
export async function hoverBetween(root: ParentNode, a: number, b: number) {
  await vi.waitFor(() => expect(bars(root).length).toBeGreaterThan(Math.max(a, b)))
  reveal(bars(root)[a])
  const p = centre(bars(root)[a])
  const q = centre(bars(root)[b])
  pointAt((p.x + q.x) / 2, p.y)
}

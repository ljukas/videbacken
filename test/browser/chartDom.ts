import { expect, vi } from 'vitest'
import { userEvent } from 'vitest/browser'

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
/** Every line path (a library may draw one path per segment, or one path of several). */
export const lineCurves = (root: ParentNode) => all<SVGPathElement>(root, SEL.lineCurve)
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
  all<HTMLElement>(document, SEL.tooltip)
    // recharts hides a dismissed tooltip (an inline visibility: hidden)
    // instead of removing it, so a hidden one doesn't count.
    .filter((t) => t.style.visibility !== 'hidden')
    .map((t) => t.textContent ?? '')
    .join('\n')

export const xTickNodes = (root: ParentNode) => all(root, SEL.xTick)
export const xTickLabels = (root: ParentNode) => xTickNodes(root).map((t) => t.textContent ?? '')
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

/**
 * Moves the pointer to (x, y) over a chart. The visx module answers on its
 * hover overlay, so the move is sent there directly: no scrolling and no
 * hit-testing, which depend on the viewport, the fonts and wherever the real
 * pointer rests (they made CI differ from local runs). recharts (still used by
 * the Energi and climate charts) needs a hit-tested target in view.
 */
/** A mouse move at (x, y) on the visx module's hover overlay; false when there is none (recharts). */
export function moveOverPlot(root: ParentNode, x: number, y: number) {
  const overlay = root.querySelector('[data-hover-overlay]')
  if (!overlay) return false
  overlay.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerType: 'mouse',
    }),
  )
  return true
}

/** Hovers the centre of the `index`th bar (DOM order, see `bars`). */
export async function hoverBar(root: ParentNode, index: number) {
  await vi.waitFor(() => expect(bars(root).length).toBeGreaterThan(index))
  const bar = bars(root)[index]
  const { x, y } = centre(bar)
  if (moveOverPlot(root, x, y)) return
  bar.scrollIntoView({ block: 'center', inline: 'center' })
  const c = centre(bar)
  pointAt(c.x, c.y)
}

/** Hovers halfway between two bars' centres (a month that draws no rect of its own). */
export async function hoverBetween(root: ParentNode, a: number, b: number) {
  await vi.waitFor(() => expect(bars(root).length).toBeGreaterThan(Math.max(a, b)))
  const mid = () => {
    const p = centre(bars(root)[a])
    const q = centre(bars(root)[b])
    return { x: (p.x + q.x) / 2, y: p.y }
  }
  const m = mid()
  if (moveOverPlot(root, m.x, m.y)) return
  bars(root)[a].scrollIntoView({ block: 'center', inline: 'center' })
  const r = mid()
  pointAt(r.x, r.y)
}

/**
 * Parks the real pointer in the window's bottom-right corner, away from the
 * charts, so a pointer an earlier test left over a plot can't fire real moves
 * when the next chart renders under it (a CI-only failure). Call in beforeEach.
 */
export async function parkPointer() {
  let spot = document.getElementById('chart-pointer-park')
  if (!spot) {
    spot = document.createElement('div')
    spot.id = 'chart-pointer-park'
    Object.assign(spot.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: '4px',
      height: '4px',
    })
    document.body.appendChild(spot)
  }
  await userEvent.hover(spot)
}

/** Lets a key press or pointer move render before the next read. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

/**
 * Presses `key` until `done()` holds, one press per render, at most `max`
 * times. Unlike pressing inside `vi.waitFor`, a slow render can't make it
 * press twice and overshoot.
 */
export async function pressUntil(key: string, done: () => boolean, max = 12) {
  for (let i = 0; i < max && !done(); i++) {
    await userEvent.keyboard(key)
    await settle()
  }
  expect(done()).toBe(true)
}

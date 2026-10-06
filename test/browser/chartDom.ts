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
  // The Energi chart's recharts hooks, and the bar module's selection hooks.
  outline: '[data-slot="hover-month"], [data-slot="category-outline"]',
  selectedTint: '[data-slot="selected-month"], [data-slot="category-selected"]',
  // The Klimat chart: an isolated reading's dot, the hovered readings' dots, the hover line.
  readingDot: '.recharts-line-dots .recharts-dot, [data-reading-dot]',
  activeDot: '.recharts-active-dot .recharts-dot, [data-active-dot]',
  hoverCursor: '.recharts-tooltip-cursor, [data-hover-cursor]',
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
/** The dots for isolated readings (a reading with no connected neighbour). */
export const readingDots = (root: ParentNode) => all<SVGElement>(root, SEL.readingDot)
/** The dots on the hovered readings. */
export const activeDots = (root: ParentNode) => all<SVGElement>(root, SEL.activeDot)
/** The vertical hover line (null: none). */
export const hoverCursor = (root: ParentNode) => root.querySelector<SVGElement>(SEL.hoverCursor)
export const gridLines = (root: ParentNode) => all(root, SEL.gridLine)
export const chartSvg = (root: ParentNode) => root.querySelector<SVGSVGElement>(SEL.svg)
/** The chart's keyboard stop (recharts' focusable svg, or the visx module's group). */
export const focusTarget = (root: ParentNode) => root.querySelector<HTMLElement>(SEL.focus)
/** Focuses the chart's keyboard stop; throws when there is none or the focus didn't land. */
export function focusChart(root: ParentNode) {
  const target = focusTarget(root)
  if (!target) throw new Error('no chart keyboard stop to focus')
  target.focus()
  expect(document.activeElement).toBe(target)
  return target
}

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
/** The outline round the hovered or keyboard category (null: none). */
export const outline = (root: ParentNode) => root.querySelector<SVGGraphicsElement>(SEL.outline)
/** The selected category's tint (null: none). */
export const selectedTint = (root: ParentNode) =>
  root.querySelector<SVGGraphicsElement>(SEL.selectedTint)
/** The x tick label `<text>` elements (recharts' are the nodes; visx wraps each in a tick group). */
export const xTickTexts = (root: ParentNode) =>
  xTickNodes(root)
    .map((n) => (n.matches('text') ? n : n.querySelector('text')))
    .filter((t): t is SVGTextElement => t !== null)
/** The x tick node showing `label` (throws when none does). */
export const xTick = (root: ParentNode, label: string) => {
  const tick = xTickNodes(root).find((t) => t.textContent === label)
  if (!tick) throw new Error(`no x tick "${label}" (have ${xTickLabels(root).join(', ')})`)
  return tick
}
/** The labels drawn bold (the selected category's). */
export const boldTickLabels = (root: ParentNode) =>
  xTickTexts(root)
    .filter((t) => t.getAttribute('font-weight') === '600')
    .map((t) => t.textContent ?? '')
/** The open tooltips' elements (portalled, so searched in the document; recharts' hidden ones skipped). */
export const tooltipNodes = () =>
  all<HTMLElement>(document, SEL.tooltip).filter((t) => t.style.visibility !== 'hidden')

/** Moves the pointer to (x, y): both recharts (mousemove) and the visx module (pointermove) listen. */
export function pointAt(x: number, y: number) {
  const target = document.elementFromPoint(x, y)
  if (!target) throw new Error(`nothing at (${x}, ${y}): off the viewport?`)
  const init = { bubbles: true, clientX: x, clientY: y }
  target.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerType: 'mouse' }))
  target.dispatchEvent(new MouseEvent('mousemove', init))
}

export const centre = (el: Element) => {
  const b = el.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/**
 * A mouse move at (x, y) on the visx module's hover overlay; false when there
 * is none (recharts). Sent to the overlay directly: no scrolling and no
 * hit-testing, which depend on the viewport, the fonts and wherever the real
 * pointer rests (they made CI differ from local runs). recharts needs a
 * hit-tested target in view.
 */
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

/** A mouse move at (x, y): on the visx overlay when there is one, else on the element there (recharts). */
export function moveAt(root: ParentNode, x: number, y: number) {
  if (!moveOverPlot(root, x, y)) pointAt(x, y)
}

/**
 * A mouse click at the centre of `el` (a bar or a tick label). The visx
 * overlay covers both, so the click is dispatched on it at that point;
 * recharts gets a real click on the element.
 */
export async function clickOn(root: ParentNode, el: Element) {
  const overlay = root.querySelector('[data-hover-overlay]')
  const { x, y } = centre(el)
  if (!overlay) return userEvent.click(el)
  const init = { bubbles: true, clientX: x, clientY: y }
  overlay.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }))
  overlay.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse' }))
  overlay.dispatchEvent(new MouseEvent('click', init))
}

/**
 * A finger tap at the centre of `el`: the pointer events say "touch", then
 * the browser emulates the mouse (move, down, up, click). Dispatched on the
 * visx overlay when there is one; on recharts each event goes to `el()`
 * resolved afresh, since a re-render may replace the element mid-tap.
 */
export function tapOn(root: ParentNode, el: () => Element) {
  const overlay = root.querySelector('[data-hover-overlay]')
  const { x, y } = centre(el())
  const at = { bubbles: true, clientX: x, clientY: y }
  const target = () => overlay ?? el()
  target().dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'touch' }))
  target().dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'touch' }))
  target().dispatchEvent(new MouseEvent('mousemove', at))
  target().dispatchEvent(new MouseEvent('mousedown', at))
  target().dispatchEvent(new MouseEvent('mouseup', at))
  target().dispatchEvent(new MouseEvent('click', at))
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

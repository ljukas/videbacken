import { expect, vi } from 'vitest'
import { userEvent } from 'vitest/browser'

// Queries for the chart tests: the visx charts' own data-* hooks and visx
// axis classes, so a test pins structure and not implementation details.
const SEL = {
  bar: '[data-bar]',
  barSeries: '[data-kind="bar"]',
  lineSeries: '[data-kind="line"]',
  lineCurve: '[data-line-curve]',
  lineDot: '[data-line-dot]',
  legend: '[data-slot="chart-legend"]',
  tooltip: '[data-slot="chart-tooltip"]',
  xTick: '[data-axis="x"] .visx-axis-tick',
  yTick: '[data-axis="y"] .visx-axis-tick',
  gridLine: '[data-grid] line',
  svg: 'svg[data-chart-svg]',
  focus: '[data-chart-focus]',
  // The bar module's selection hooks.
  outline: '[data-slot="category-outline"]',
  selectedTint: '[data-slot="category-selected"]',
  // The Klimat chart: an isolated reading's dot, the hovered readings' dots, the hover line.
  readingDot: '[data-reading-dot]',
  activeDot: '[data-active-dot]',
  hoverCursor: '[data-hover-cursor]',
} as const

// Tailwind's sr-only as the build emits it; the browser project has no app.css.
export const SR_ONLY_CSS =
  '.sr-only{clip-path:inset(50%);white-space:nowrap;border-width:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}'

// How far `box`'s content reaches past its right edge. A table can't shrink to
// sr-only's 1px, so an sr-only <table> sticks out and widens a phone's page.
export const overflowX = (box: Element) => box.scrollWidth - box.clientWidth

// Every <table> under `root` sits in a box that clips it to sr-only's 1px —
// wherever the layout puts it (with SR_ONLY_CSS loaded).
export function tablesClipped(root: ParentNode) {
  const tables = all<HTMLTableElement>(root, 'table')
  expect(tables.length).toBeGreaterThan(0)
  for (const table of tables) {
    const box = table.parentElement as HTMLElement
    expect(getComputedStyle(box).overflow).toBe('hidden')
    expect(box.getBoundingClientRect().width).toBeLessThanOrEqual(1)
  }
}

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
 * A bar's drawn height in px. `[data-bar]` must be the visible shape itself,
 * never a group with a hit area in it.
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
/** The chart's keyboard stop (the visx chart's group). */
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
  return all(box, '[data-legend-item]').map((e) => e.textContent ?? '')
}

/** The open tooltip's text ('' when none). Tooltips may be portalled, so this searches the document. */
export const tooltipText = () =>
  all<HTMLElement>(document, SEL.tooltip)
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
/** The x tick label `<text>` elements (visx wraps each in a tick group). */
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
/** The open tooltips' elements (portalled, so searched in the document). */
export const tooltipNodes = () => all<HTMLElement>(document, SEL.tooltip)

export const centre = (el: Element) => {
  const b = el.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/**
 * A mouse move at (x, y) on the chart's hover overlay; throws when there is
 * none. Sent to the overlay directly: no scrolling and no hit-testing, which
 * depend on the viewport, the fonts and wherever the real pointer rests (they
 * made CI differ from local runs).
 */
export function moveAt(root: ParentNode, x: number, y: number) {
  const overlay = root.querySelector('[data-hover-overlay]')
  if (!overlay) throw new Error('no chart hover overlay')
  overlay.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerType: 'mouse',
    }),
  )
}

/** Hovers the centre of the `index`th bar (DOM order, see `bars`). */
export async function hoverBar(root: ParentNode, index: number) {
  await vi.waitFor(() => expect(bars(root).length).toBeGreaterThan(index))
  const bar = bars(root)[index]
  const { x, y } = centre(bar)
  moveAt(root, x, y)
}

/** Hovers halfway between two bars' centres (a month that draws no rect of its own). */
export async function hoverBetween(root: ParentNode, a: number, b: number) {
  await vi.waitFor(() => expect(bars(root).length).toBeGreaterThan(Math.max(a, b)))
  const p = centre(bars(root)[a])
  const q = centre(bars(root)[b])
  moveAt(root, (p.x + q.x) / 2, p.y)
}

/**
 * A mouse click at the centre of `el` (a bar or a tick label). The
 * overlay covers both, so the click is dispatched on it at that point.
 */
export async function clickOn(root: ParentNode, el: Element) {
  const overlay = root.querySelector('[data-hover-overlay]')
  const { x, y } = centre(el)
  if (!overlay) throw new Error('no chart hover overlay')
  const init = { bubbles: true, clientX: x, clientY: y }
  overlay.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }))
  overlay.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse' }))
  overlay.dispatchEvent(new MouseEvent('click', init))
}

/**
 * A finger tap at the centre of `el`: the pointer events say "touch", then
 * the browser emulates the mouse (move, down, up, click). Dispatched on the
 * hover overlay; `el` is read once, for the tap point.
 */
export function tapOn(root: ParentNode, el: () => Element) {
  const overlay = root.querySelector('[data-hover-overlay]')
  if (!overlay) throw new Error('no chart hover overlay')
  const { x, y } = centre(el())
  const at = { bubbles: true, clientX: x, clientY: y }
  overlay.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'touch' }))
  overlay.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'touch' }))
  overlay.dispatchEvent(new MouseEvent('mousemove', at))
  overlay.dispatchEvent(new MouseEvent('mousedown', at))
  overlay.dispatchEvent(new MouseEvent('mouseup', at))
  overlay.dispatchEvent(new MouseEvent('click', at))
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

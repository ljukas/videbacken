import { StrictMode } from 'react'
import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { overflowX, SR_ONLY_CSS, tablesClipped } from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { SessionPriceChart } from './SessionPriceChart'

type Detail = RouterOutputs['evCharging']['session']
type Slot = Detail['prices'][number]

// 15 Sep 2026 (a Tuesday) is CEST (UTC+2): 08:00Z reads "10:00" in Stockholm.
const at = (hhmm: string, day = '2026-09-15') => Date.parse(`${day}T${hhmm}:00Z`)
const QUARTER = 15 * 60_000

const quarters = (fromMs: number, n: number, ore: (startMs: number) => number | null): Slot[] =>
  Array.from({ length: n }, (_, i) => {
    const startMs = fromMs + i * QUARTER
    return { startMs, endMs: startMs + QUARTER, spotOre: ore(startMs) }
  })

// 16 quarter-hour slots 07:00Z–11:00Z: 375 öre for 08:00–09:00, else 125,
// and no price (no tariff) for 10:30–10:45.
const prices = quarters(at('07:00'), 16, (startMs) =>
  startMs === at('10:30') ? null : startMs >= at('08:00') && startMs < at('09:00') ? 375 : 125,
)

const detail = {
  session: {
    id: '00000000-0000-4000-8000-000000000001',
    startAt: new Date(at('08:00')),
    endAt: new Date(at('10:00')),
    kwh: 10,
    peakKw: 10,
    estimated: false,
  },
  window: { startMs: at('08:00'), endMs: at('10:00') },
  intervals: [
    { startMs: at('08:00'), endMs: at('09:00'), kwh: 10 },
    { startMs: at('09:00'), endMs: at('10:00'), kwh: 0 },
  ],
  prices,
  optimalSchedule: [0, 1, 2, 3].map((i) => ({
    startMs: at('09:00') + i * QUARTER,
    endMs: at('09:00') + (i + 1) * QUARTER,
    kwh: 2.5,
  })),
  // The chart doesn't read the economy figures.
  economy: null,
} as unknown as Detail

// `strict` renders under StrictMode, as the app's dev entry does.
async function renderChart(d: Detail = detail, width = 900, { strict = false } = {}) {
  const chart = (
    <div style={{ width }}>
      <SessionPriceChart detail={d} />
    </div>
  )
  const result = await renderWithProviders(strict ? <StrictMode>{chart}</StrictMode> : chart)
  // The SVG draws once the container has been measured.
  await expect.poll(() => document.querySelector('[data-hover-overlay]')).not.toBeNull()
  return result
}

const series = (name: string) => document.querySelectorAll(`[data-series="${name}"]`)
const texts = (selector: string) =>
  [...document.querySelectorAll(`${selector} text`)].map((t) => t.textContent ?? '')
const chartTable = (screen: Awaited<ReturnType<typeof renderChart>>['screen']) =>
  screen.getByRole('table', { name: m.charging_session_chart_table_caption() })

function overlay() {
  const el = document.querySelector('[data-hover-overlay]')
  if (!el) throw new Error('hover overlay missing')
  return el
}

// A pointer event at `ms` on the overlay's time axis (07:00Z–11:00Z in the fixture).
function pointAt(type: string, ms: number, pointerType: 'mouse' | 'touch' = 'mouse') {
  const box = overlay().getBoundingClientRect()
  const clientX = box.left + ((ms - at('07:00')) / (at('11:00') - at('07:00'))) * box.width
  overlay().dispatchEvent(
    new PointerEvent(type, { clientX, clientY: box.top + 10, pointerType, bubbles: true }),
  )
}

test('draws a bar per charged interval, ghost bars for the optimal schedule and a stepped price line', async () => {
  const { screen } = await renderChart()
  await expect
    .element(screen.getByRole('heading', { level: 2, name: m.charging_session_chart_title() }))
    .toBeVisible()
  expect(series('actual')).toHaveLength(1) // the 0-kWh hour draws nothing
  expect(series('optimal')).toHaveLength(1) // four consecutive quarters: one run, one outline
  expect(series('spot')).toHaveLength(1)
})

// An overnight session at phone width: plugged in 22:00–06:00 Stockholm, hourly
// bars at 11 kW, and a cheapest schedule at the same rate in two runs, one of
// them right over charged hours. Quarters are ~5 px wide here.
const HOUR = 4 * QUARTER
const night = at('20:00')
const overnight = {
  ...detail,
  window: { startMs: night, endMs: night + 8 * HOUR },
  intervals: [0, 1, 2, 3].map((h) => ({
    startMs: night + h * HOUR,
    endMs: night + (h + 1) * HOUR,
    kwh: 11,
  })),
  prices: quarters(night - HOUR, 40, () => 100),
  optimalSchedule: [
    ...quarters(night + HOUR, 2, () => 0),
    ...quarters(night + 3 * HOUR, 16, () => 0),
  ].map((q) => ({ startMs: q.startMs, endMs: q.endMs, kwh: 2.75 })),
} as Detail

test('at phone width the cheapest schedule never covers the actual bars', async () => {
  await renderChart(overnight, 360)
  expect(series('actual')).toHaveLength(4)
  expect(series('optimal')).toHaveLength(2) // one outline per run
  const firstBar = series('actual')[0]
  if (!firstBar) throw new Error('no actual bar')
  const drawnAfterBars = (el: Element) =>
    (firstBar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  const ghosts = [...document.querySelectorAll<SVGElement>('[data-ghost]')]
  expect(ghosts.length).toBeGreaterThan(0)
  for (const el of ghosts) {
    // Anything painted in over the bars is a stroke, never a fill…
    if (drawnAfterBars(el)) expect(el.style.fill).toBe('none')
    else expect(el.dataset.ghost).toBe('fill')
    expect(el.style.fill).not.toBe('var(--card)')
    // …and a card-coloured stroke runs only along the runs' top edges (no
    // vertical cuts through bars), masked off inside every run.
    if (el.style.stroke === 'var(--card)') {
      const segments = [
        ...(el.getAttribute('d') ?? '').matchAll(/M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)/g),
      ]
      expect(segments.length).toBe(18) // one per scheduled quarter
      for (const [, , y1, , y2] of segments) expect(y1).toBe(y2)
      expect((el.getAttribute('d') ?? '').replace(/M[\d.]+,[\d.]+L[\d.]+,[\d.]+/g, '')).toBe('')
      const id = el.getAttribute('mask')?.match(/url\(#(.+)\)/)?.[1]
      const mask = id ? document.getElementById(id) : null
      expect(mask?.querySelectorAll('path[fill="black"]')).toHaveLength(2)
    }
  }
})

test('a bar too short to round is a plain rect, not rounded below the baseline', async () => {
  await renderChart({
    ...detail,
    intervals: [
      { startMs: at('08:00'), endMs: at('09:00'), kwh: 10 },
      // 0.2 kW on the 10 kW / 144 px panel: ≈ 2.9 px, under 2 × the 2 px radius.
      { startMs: at('09:00'), endMs: at('10:00'), kwh: 0.2 },
    ],
  })
  const [tall, short] = [...series('actual')]
  expect(tall?.tagName).toBe('path') // rounded top
  expect(short?.tagName).toBe('rect')
})

test("tick labels carry their size as an attribute, so tests measure the app's text", async () => {
  await renderChart()
  for (const text of document.querySelectorAll('svg[data-chart="session-price"] text')) {
    expect(text.getAttribute('font-size')).toBe('10')
  }
})

test('the chart card is a region named by its heading; the svg is left to the table', async () => {
  const { screen } = await renderChart()
  await expect
    .element(screen.getByRole('region', { name: m.charging_session_chart_title() }))
    .toBeInTheDocument()
  expect(
    document.querySelector('svg[data-chart="session-price"][aria-hidden="true"]'),
  ).not.toBeNull()
})

test('dashed rules mark the plug-in window, with a legend entry', async () => {
  const { screen } = await renderChart()
  expect(document.querySelectorAll('[data-window]')).toHaveLength(2)
  await expect.element(screen.getByText(m.charging_session_chart_window())).toBeVisible()
})

test('the optimal schedule and its legend entry can be hidden', async () => {
  const { screen } = await renderChart()
  await expect
    .element(screen.getByText(m.charging_session_chart_optimal(), { exact: true }))
    .toBeVisible()
  const toggle = screen.getByRole('checkbox', { name: m.charging_session_chart_show_optimal() })
  // ui/checkbox styles its checked state on aria-checked (Radix sets no data-checked).
  await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => series('optimal').length).toBe(0)
  expect(series('actual')).toHaveLength(1)
  expect(document.querySelector('[data-legend="optimal"]')).toBeNull()
})

test('exposes the same data as a screen-reader table', async () => {
  const { screen } = await renderChart()
  const table = chartTable(screen)
  await expect.element(table).toBeInTheDocument()
  expect(table.getByRole('row').elements().length).toBe(1 + 16)
  await expect
    .element(table.getByRole('columnheader', { name: m.charging_session_chart_col_optimal() }))
    .toBeInTheDocument()
  // 10:00–10:15 Stockholm: a quarter of the 10 kWh hour, at 375 öre, nothing scheduled.
  await expect
    .element(table.getByRole('row', { name: /^10:00–10:15/ }))
    .toMatchTextContent(/10:00–10:15\s*2,5\s*375\s*—/)
  // The 0-kWh hour is 0 kWh; the cheapest schedule puts 2,5 kWh in each of its quarters.
  await expect
    .element(table.getByRole('row', { name: /^11:00–11:15/ }))
    .toMatchTextContent(/11:00–11:15\s*0,0\s*125\s*2,5/)
  // Outside every interval there's no energy figure.
  await expect.element(table.getByRole('row', { name: /^09:00–09:15/ })).toMatchTextContent(/—/)
  // A slot without a price reads "—", never 0 öre.
  await expect
    .element(table.getByRole('row', { name: /^12:30–12:45/ }))
    .toMatchTextContent(/12:30–12:45\s*—\s*—/)
})

test('a partial-hour interval spreads its energy over the slots it covers', async () => {
  const { screen } = await renderChart({
    ...detail,
    intervals: [{ startMs: at('08:10'), endMs: at('09:00'), kwh: 5 }],
  })
  const table = chartTable(screen)
  // 5 of its 50 minutes in 08:00–08:15Z, then 15 of 50.
  await expect.element(table.getByRole('row', { name: /^10:00–10:15/ })).toMatchTextContent(/0,5/)
  await expect.element(table.getByRole('row', { name: /^10:15–10:30/ })).toMatchTextContent(/1,5/)
})

test('hovering shows the nearest slot with the same kWh share as the table', async () => {
  const { screen } = await renderChart()
  pointAt('pointermove', at('08:07'))
  await expect.element(screen.getByText('10:00–10:15 · 2,5 kWh · 375 öre')).toBeInTheDocument()
  pointAt('pointermove', at('08:20'))
  await expect.element(screen.getByText('10:15–10:30 · 2,5 kWh · 375 öre')).toBeInTheDocument()
})

// The crosshair's hairline, in client px: its x and vertical extent.
function crosshair() {
  const lines = document.querySelectorAll('[data-crosshair] line')
  const hair = lines[lines.length - 1]
  if (!hair) return null
  const box = hair.getBoundingClientRect()
  return { x: (box.left + box.right) / 2, top: box.top, bottom: box.bottom }
}
// The client x of a time on the overlay's axis (07:00Z–11:00Z in the fixture).
const clientXAt = (ms: number) => {
  const box = overlay().getBoundingClientRect()
  return box.left + ((ms - at('07:00')) / (at('11:00') - at('07:00'))) * box.width
}

test('hovering draws one crosshair through both panels at the slot, gone on leaving', async () => {
  await renderChart()
  expect(crosshair()).toBeNull()
  pointAt('pointermove', at('08:07'))
  await expect.poll(crosshair).not.toBeNull()
  const hair = crosshair()
  // Snapped to the middle of 08:00–08:15Z, not to the pointer at 08:07.
  const mid = (clientXAt(at('08:00')) + clientXAt(at('08:15'))) / 2
  expect(Math.abs((hair?.x ?? 0) - mid)).toBeLessThan(0.5)
  expect(hair?.top ?? 0).toBeLessThanOrEqual(axisBox('ore').top + 0.5)
  expect(hair?.bottom ?? 0).toBeGreaterThanOrEqual(axisBox('kw').bottom - 0.5)
  // Only one, and it never takes the pointer from the overlay.
  expect(document.querySelectorAll('[data-crosshair]')).toHaveLength(1)
  expect(
    (document.querySelector('[data-crosshair]') as SVGElement | null)?.style.pointerEvents,
  ).toBe('none')
  // React derives onPointerLeave from pointerout towards an element outside.
  overlay().dispatchEvent(
    new PointerEvent('pointerout', {
      pointerType: 'mouse',
      bubbles: true,
      relatedTarget: document.body,
    }),
  )
  await expect.poll(crosshair).toBeNull()
})

const popoverBox = () => document.querySelector('.visx-tooltip')?.getBoundingClientRect() ?? null

// The app's dev entry renders under StrictMode, whose simulated unmount /
// remount detached visx's Portal node: the popover was "open" (the crosshair
// drew) yet never on screen. Assert it is on the page, inside the window.
test('under StrictMode a hover opens the popover on screen, not just in state', async () => {
  const { screen } = await renderChart(detail, 900, { strict: true })
  pointAt('pointermove', at('08:07'))
  await expect.poll(crosshair).not.toBeNull()
  await expect.element(screen.getByText('10:00–10:15 · 2,5 kWh · 375 öre')).toBeVisible()
  const tip = document.querySelector('.visx-tooltip')
  expect(tip?.isConnected).toBe(true)
  const box = popoverBox()
  if (!box) throw new Error('no popover')
  expect(box.width).toBeGreaterThan(0)
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(window.innerWidth)
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
  // At its slot (left edge on the anchor, unless nudged in from the window's
  // edge), not somewhere else on the page: it spans the crosshair.
  const x = crosshair()?.x ?? Number.NaN
  expect(box.left).toBeLessThanOrEqual(x + 0.5)
  expect(box.right).toBeGreaterThanOrEqual(x)
  // Moving on keeps it on screen (each slot re-mounts it).
  pointAt('pointermove', at('09:20'))
  await expect.element(screen.getByText('11:15–11:30 · 0,0 kWh · 125 öre')).toBeVisible()
  expect(document.querySelector('.visx-tooltip')?.isConnected).toBe(true)
})

test('the crosshair marks the active slot on the price line with a dot', async () => {
  await renderChart()
  pointAt('pointermove', at('08:07'))
  await expect.poll(() => document.querySelector('[data-crosshair-dot]')).not.toBeNull()
  const dot = document.querySelector('[data-crosshair-dot]')?.getBoundingClientRect()
  // The 375 öre stretch is the line's highest step: its smallest y.
  const ys = [...(series('spot')[0]?.getAttribute('d') ?? '').matchAll(/,([\d.]+)/g)].map(([, y]) =>
    Number(y),
  )
  const top = overlay().getBoundingClientRect().top + Math.min(...ys)
  expect(Math.abs(((dot?.top ?? 0) + (dot?.bottom ?? 0)) / 2 - top)).toBeLessThan(0.5)
  expect(Math.abs(((dot?.left ?? 0) + (dot?.right ?? 0)) / 2 - (crosshair()?.x ?? 0))).toBeLessThan(
    0.5,
  )
  // At least 8 px across (the dataviz marker floor).
  expect(dot?.width ?? 0).toBeGreaterThanOrEqual(8)
})

test("a priced slot's popover points into the price panel, an unpriced one into the energy", async () => {
  const { screen } = await renderChart()
  const plot = screen.getByRole('group', { name: m.charging_session_chart_title() }).element()
  ;(plot as HTMLElement).focus()
  await userEvent.keyboard('{ArrowRight}')
  await expect.poll(popoverText).toBe('09:00–09:15 · — kWh · 125 öre')
  expect(popoverBox()?.top ?? Number.POSITIVE_INFINITY).toBeLessThan(axisBox('ore').bottom)
  await userEvent.keyboard('{End}{ArrowLeft}')
  await expect.poll(popoverText).toBe('12:30–12:45 · — kWh · — öre')
  // No price there and no dot; the popover sits over the energy panel.
  expect(document.querySelector('[data-crosshair-dot]')).toBeNull()
  expect(popoverBox()?.top ?? 0).toBeGreaterThan(axisBox('ore').bottom)
})

test('a tap on a phone-width chart opens the slot under the finger', async () => {
  const { screen } = await renderChart(detail, 360)
  pointAt('pointerdown', at('09:05'), 'touch')
  await expect.element(screen.getByText('11:00–11:15 · 0,0 kWh · 125 öre')).toBeInTheDocument()
})

test('a slot without a price breaks the step line instead of bridging it', async () => {
  await renderChart()
  const d = series('spot')[0]?.getAttribute('d') ?? ''
  expect(d.match(/M/g)).toHaveLength(2)
})

test('an hour missing from the prices breaks the line but keeps its energy in the table', async () => {
  // The 08:00–09:00Z hour's slots never synced; the rest are all priced.
  const synced = quarters(at('07:00'), 16, () => 125).filter(
    (p) => p.startMs < at('08:00') || p.startMs >= at('09:00'),
  )
  const { screen } = await renderChart({ ...detail, prices: synced })
  const d = series('spot')[0]?.getAttribute('d') ?? ''
  expect(d.match(/M/g)).toHaveLength(2)
  const table = chartTable(screen)
  expect(table.getByRole('row').elements().length).toBe(1 + 12 + 1)
  await expect
    .element(table.getByRole('row', { name: /^10:00–11:00/ }))
    .toMatchTextContent(/10:00–11:00\s*10,0\s*—/)
})

test('without any price there is no line and no price axis, and nothing breaks', async () => {
  const { screen } = await renderChart({
    ...detail,
    prices: prices.map((p) => ({ ...p, spotOre: null })),
  })
  // No price panel at all: no zero-height group, no empty line, no axis or unit.
  expect(document.querySelector('[data-panel="price"]')).toBeNull()
  expect(series('spot')).toHaveLength(0)
  expect(document.querySelector('[data-axis="ore"]')).toBeNull()
  expect(document.querySelector('[data-unit="ore"]')).toBeNull()
  expect(document.querySelector('[data-legend="spot"]')).toBeNull()
  // No empty price panel: the energy panel takes the whole plot.
  const plot = overlay().getBoundingClientRect()
  expect(Math.abs(axisBox('kw').top - plot.top)).toBeLessThanOrEqual(0.5)
  await expect
    .element(chartTable(screen).getByRole('row', { name: /^10:00–10:15/ }))
    .toMatchTextContent(/10:00–10:15\s*2,5\s*—/)
})

test('only a day with negative prices gets a zero line', async () => {
  await renderChart()
  expect(document.querySelector('[data-ref="zero-ore"]')).toBeNull()
})

test('negative spot prices stay on the price axis, with a zero line', async () => {
  await renderChart({
    ...detail,
    prices: prices.map((p, i) => (i === 0 ? { ...p, spotOre: -60 } : p)),
  })
  expect(texts('[data-axis="ore"]').some((t) => /^[−-]\d/.test(t))).toBe(true)
  expect(document.querySelector('[data-ref="zero-ore"]')).not.toBeNull()
})

test('a four-digit negative tick fits inside the left margin', async () => {
  await renderChart({
    ...detail,
    prices: prices.map((p, i) => ({ ...p, spotOre: i === 0 ? -1250 : 1250 })),
  })
  const svgLeft = document
    .querySelector('svg[data-chart="session-price"]')
    ?.getBoundingClientRect().left
  const labels = [...document.querySelectorAll('[data-axis="ore"] .visx-axis-tick text')]
  expect(labels.some((t) => /^[−-]1\s?000$/.test(t.textContent ?? ''))).toBe(true)
  const plot = overlay().getBoundingClientRect()
  for (const label of labels) {
    const box = label.getBoundingClientRect()
    expect(box.left).toBeGreaterThanOrEqual(svgLeft ?? 0)
    // Left of the plot, not drawn into it.
    expect(box.right).toBeLessThanOrEqual(plot.left + 1)
  }
})

// The two panels, by their y-axes' tick lines (the domain line spans the panel).
const axisBox = (name: string) => {
  const el = document.querySelector(`[data-axis="${name}"] .visx-axis-line`)
  if (!el) throw new Error(`${name} axis missing`)
  return el.getBoundingClientRect()
}

test('price on top and energy below, each on its own left axis, with no right axis', async () => {
  await renderChart()
  const price = axisBox('ore')
  const energy = axisBox('kw')
  const time = axisBox('time')
  // Stacked with a small gap, the price panel ≈ 40 % of the two.
  const gap = energy.top - price.bottom
  expect(gap).toBeGreaterThanOrEqual(8)
  expect(gap).toBeLessThanOrEqual(12)
  expect(price.height / (price.height + energy.height)).toBeCloseTo(0.4, 1)
  // Both axes on the same left edge; the one time axis under the energy panel.
  expect(Math.abs(price.left - energy.left)).toBeLessThan(0.5)
  expect(Math.abs(time.top - energy.bottom)).toBeLessThan(1)
  expect(document.querySelectorAll('[data-axis="time"]')).toHaveLength(1)
  // Each panel's ticks stay in its own panel; nothing is labelled right of the plot.
  const plot = overlay().getBoundingClientRect()
  for (const [name, box] of [
    ['ore', price],
    ['kw', energy],
  ] as const) {
    const ticks = [...document.querySelectorAll(`[data-axis="${name}"] .visx-axis-tick line`)]
    expect(ticks.length).toBeGreaterThan(1)
    for (const tick of ticks) {
      const y = tick.getBoundingClientRect().top
      expect(y).toBeGreaterThanOrEqual(box.top - 0.5)
      expect(y).toBeLessThanOrEqual(box.bottom + 0.5)
    }
  }
  const svgRight =
    document.querySelector('svg[data-chart="session-price"]')?.getBoundingClientRect().right ?? 0
  for (const text of document.querySelectorAll('svg[data-chart="session-price"] text')) {
    const box = text.getBoundingClientRect()
    expect(box.left).toBeLessThan(plot.right)
    expect(box.right).toBeLessThanOrEqual(svgRight)
  }
  expect(texts('[data-unit="ore"]')).toEqual(['öre/kWh'])
  expect(texts('[data-unit="kw"]')).toEqual(['kW'])
})

// A unit label's text box and its backing, in client px.
const unitBoxes = (name: string) => {
  const g = document.querySelector(`[data-unit="${name}"]`)
  const text = g?.querySelector('text')?.getBoundingClientRect()
  const backing = g?.querySelector('[data-unit-backing]')
  if (!g || !text || !backing) throw new Error(`${name} unit missing`)
  return { g, text, backing }
}
const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

test('both units sit the same way over their panel, each on a card backing', async () => {
  await renderChart()
  const plot = overlay().getBoundingClientRect()
  for (const [name, panelTop] of [
    ['ore', axisBox('ore').top],
    ['kw', axisBox('kw').top],
  ] as const) {
    const { text, backing } = unitBoxes(name)
    const back = backing.getBoundingClientRect()
    // Just over its panel's top-left corner, at the plot's left edge.
    expect(Math.abs(text.left - plot.left)).toBeLessThan(1)
    expect(text.bottom).toBeLessThanOrEqual(panelTop + 0.5)
    expect(panelTop - text.bottom).toBeLessThan(4)
    // The backing covers the text and is card-coloured.
    expect(back.left).toBeLessThanOrEqual(text.left)
    expect(back.right).toBeGreaterThanOrEqual(text.right)
    expect((backing as SVGElement).style.fill).toBe('var(--card)')
  }
  // The kW unit stays inside the gap, clear of the price panel above it.
  expect(unitBoxes('kw').backing.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    axisBox('ore').bottom,
  )
})

// An overnight plug-in at phone width: the window-start rule lands near the
// plot's left edge, where the kW unit sits in the gap.
const longWindow = (hours: number) =>
  ({
    ...detail,
    window: { startMs: night, endMs: night + hours * HOUR },
    intervals: [{ startMs: night, endMs: night + HOUR, kwh: 11 }],
    prices: quarters(night - HOUR, (hours + 2) * 4, () => 100),
    optimalSchedule: null,
  }) as Detail

test('at 360 px a 15 h plug-in window keeps its start rule clear of the kW unit', async () => {
  await renderChart(longWindow(15), 360)
  const rule = document.querySelector('[data-window="start"]')?.getBoundingClientRect()
  if (!rule) throw new Error('no start rule')
  expect(overlaps(rule, unitBoxes('kw').text)).toBe(false)
})

test('when a rule does cross a unit, the unit is painted over it on its backing', async () => {
  // 30 h at 360 px: an hour is ~10 px, so the start rule runs through "kW".
  await renderChart(longWindow(30), 360)
  const ruleEl = document.querySelector('[data-window="start"]')
  const rule = ruleEl?.getBoundingClientRect()
  if (!ruleEl || !rule) throw new Error('no start rule')
  for (const name of ['ore', 'kw']) {
    const { g, backing } = unitBoxes(name)
    const back = backing.getBoundingClientRect()
    // Painted after the rule (and the crosshair layer), over it.
    expect(ruleEl.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    if (name === 'kw') expect(rule.left).toBeGreaterThan(back.left)
    if (name === 'kw') expect(rule.right).toBeLessThan(back.right)
  }
})

test('the plug-in window rules and the hover overlay span both panels', async () => {
  await renderChart()
  const top = axisBox('ore').top
  const bottom = axisBox('kw').bottom
  const plot = overlay().getBoundingClientRect()
  expect(plot.top).toBeLessThanOrEqual(top + 0.5)
  expect(plot.bottom).toBeGreaterThanOrEqual(bottom - 0.5)
  for (const rule of document.querySelectorAll('[data-window]')) {
    const box = rule.getBoundingClientRect()
    expect(box.top).toBeLessThanOrEqual(top + 0.5)
    expect(box.bottom).toBeGreaterThanOrEqual(bottom - 0.5)
  }
})

// The x of the price step at 08:00Z (125 → 375 öre), in client px: the line's
// first vertical segment.
function priceStepX() {
  const d = series('spot')[0]?.getAttribute('d') ?? ''
  const points = [...d.matchAll(/([\d.]+),([\d.]+)/g)].map(([, px, py]) => [Number(px), Number(py)])
  const i = points.findIndex(([px, py], k) => {
    const [nx, ny] = points[k + 1] ?? []
    return nx !== undefined && Math.abs(nx - (px ?? 0)) < 0.01 && ny !== py
  })
  const xStep = points[i]?.[0]
  if (xStep === undefined) throw new Error('no step in the price line')
  return overlay().getBoundingClientRect().left + xStep
}

test.each([
  900, 360,
])('the panels share one x at %i px: a bar starts where the price steps at the same time', async (width) => {
  await renderChart(detail, width)
  const barLeft = series('actual')[0]?.getBoundingClientRect().left ?? Number.NaN
  expect(Math.abs(barLeft - priceStepX())).toBeLessThanOrEqual(0.5)
})

test("the price panel shades the cheapest schedule's runs behind the line", async () => {
  await renderChart(overnight, 900)
  const bands = [...document.querySelectorAll('[data-band="optimal"]')]
  const outlines = [...series('optimal')]
  expect(bands).toHaveLength(2)
  bands.forEach((band, i) => {
    // The run's outline goes baseline → steps → baseline: its first and last x.
    const xs = [...(outlines[i]?.getAttribute('d') ?? '').matchAll(/[ML]([\d.]+),/g)].map(([, v]) =>
      Number(v),
    )
    const x = Number(band.getAttribute('x'))
    expect(x).toBeCloseTo(xs[0] ?? Number.NaN, 1)
    expect(x + Number(band.getAttribute('width'))).toBeCloseTo(xs.at(-1) ?? Number.NaN, 1)
    // Over the price panel's full height, and drawn before (behind) the line.
    const box = band.getBoundingClientRect()
    const price = axisBox('ore')
    // (within visx's half-pixel axis alignment)
    expect(Math.abs(box.top - price.top)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(box.bottom - price.bottom)).toBeLessThanOrEqual(0.5)
    const line = series('spot')[0]
    if (!line) throw new Error('no line')
    expect(band.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })
  // Each run's start and end get a dashed --chart-2 edge over the panel's
  // height (the fill alone can't clear 3:1 against the card).
  const edge = document.querySelector<SVGElement>('[data-band-edge]')
  expect(edge?.style.stroke).toBe('var(--chart-2)')
  expect(edge?.style.strokeDasharray).not.toBe('')
  const segments = [...(edge?.getAttribute('d') ?? '').matchAll(/M([\d.]+),0V([\d.]+)/g)]
  expect(segments).toHaveLength(4)
  const bandXs = bands.flatMap((b) => {
    const x = Number(b.getAttribute('x'))
    return [x, x + Number(b.getAttribute('width'))]
  })
  expect(segments.map(([, x]) => Number(Number(x).toFixed(1)))).toEqual(
    bandXs.map((x) => Number(x.toFixed(1))),
  )
  // Drawn before the line, so the price stays on top.
  const line = series('spot')[0]
  if (!edge || !line) throw new Error('no edge or line')
  expect(edge.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
})

test("the legend's cheapest-schedule entry shows both its marks: the band and the ghost bar", async () => {
  await renderChart()
  const entry = document.querySelector('[data-legend="optimal"]')
  expect(entry?.querySelector('[data-swatch="band"]')).not.toBeNull()
  expect(entry?.querySelector('[data-swatch="ghost"]')).not.toBeNull()
})

test('hiding the cheapest schedule hides its price band too', async () => {
  const { screen } = await renderChart()
  expect(document.querySelectorAll('[data-band="optimal"]')).toHaveLength(1)
  await screen.getByRole('checkbox', { name: m.charging_session_chart_show_optimal() }).click()
  await expect.poll(() => document.querySelectorAll('[data-band="optimal"]').length).toBe(0)
})

test('an idle hour of a few Wh draws no bar, not a hairline on the baseline', async () => {
  const { screen } = await renderChart({
    ...detail,
    intervals: [
      { startMs: at('08:00'), endMs: at('09:00'), kwh: 10 },
      { startMs: at('09:00'), endMs: at('10:00'), kwh: 0.002 },
      { startMs: at('10:00'), endMs: at('10:30'), kwh: 0 },
    ],
  })
  expect(series('actual')).toHaveLength(1)
  // The table still has the idle hour's energy, rounded.
  await expect
    .element(chartTable(screen).getByRole('row', { name: /^11:00–11:15/ }))
    .toMatchTextContent(/11:00–11:15\s*0,0\s*125/)
})

test('an idle night logged as one long interval draws no hairline under the night', async () => {
  // As Zaptec logged the owner's Sun–Mon session: one interval over the idle
  // hours with a little standby energy (0.1 kW: ≈ 1.4 px on 10 kW / 144 px).
  await renderChart({
    ...detail,
    intervals: [
      { startMs: at('08:00'), endMs: at('09:00'), kwh: 10 },
      { startMs: at('09:00'), endMs: at('11:00'), kwh: 0.2 },
    ],
  })
  expect(series('actual')).toHaveLength(1)
})

test('a small but real hour still draws: just over 2 px is a bar', async () => {
  await renderChart({
    ...detail,
    intervals: [
      { startMs: at('08:00'), endMs: at('09:00'), kwh: 10 },
      // 0.15 kW on 10 kW / 144 px: ≈ 2.2 px.
      { startMs: at('09:00'), endMs: at('10:00'), kwh: 0.15 },
    ],
  })
  const bars = [...series('actual')]
  expect(bars).toHaveLength(2)
  const height = bars[1]?.getBoundingClientRect().height ?? 0
  expect(height).toBeGreaterThanOrEqual(2)
  expect(height).toBeLessThan(2.5)
})

test('the kW labels sit inside the left margin, beside their ticks', async () => {
  await renderChart()
  const svgLeft = document
    .querySelector('svg[data-chart="session-price"]')
    ?.getBoundingClientRect().left
  const plot = overlay().getBoundingClientRect()
  const ticks = [...document.querySelectorAll('[data-axis="kw"] .visx-axis-tick')]
  expect(ticks.length).toBeGreaterThan(1)
  for (const tick of ticks) {
    const label = tick.querySelector('text')?.getBoundingClientRect()
    const line = tick.querySelector('line')?.getBoundingClientRect()
    if (!label || !line) throw new Error('tick without label or line')
    expect(label.right).toBeLessThanOrEqual(plot.left + 1)
    expect(label.left).toBeGreaterThanOrEqual(svgLeft ?? 0)
    // Vertically centred on its tick, not above it.
    expect(Math.abs((label.top + label.bottom) / 2 - line.top)).toBeLessThan(3)
  }
})

test('time labels are centred under their ticks', async () => {
  await renderChart()
  const ticks = [...document.querySelectorAll('[data-axis="time"] .visx-axis-tick')]
  expect(ticks.length).toBeGreaterThan(1)
  for (const tick of ticks) {
    const text = tick.querySelector('text')
    const label = text?.getBoundingClientRect()
    const line = tick.querySelector('line')?.getBoundingClientRect()
    if (!text || !label || !line) throw new Error('tick without label or line')
    expect(text.getAttribute('text-anchor')).toBe('middle')
    expect(Math.abs((label.left + label.right) / 2 - line.left)).toBeLessThan(1.5)
    expect(label.top).toBeGreaterThanOrEqual(line.bottom - 1)
  }
})

test('the fall-back night labels its repeated 02:00 once', async () => {
  // 25 Oct 2026: 00:00Z is 02:00 CEST, 01:00Z is 02:00 CET.
  const day = '2026-10-25'
  await renderChart({
    ...detail,
    window: { startMs: at('00:00', day), endMs: at('02:00', day) },
    intervals: [],
    prices: quarters(at('23:00', '2026-10-24'), 16, () => 100),
    optimalSchedule: null,
  })
  const ticks = texts('[data-axis="time"]')
  expect(ticks.filter((t) => t === '02:00')).toHaveLength(1)
  expect(new Set(ticks).size).toBe(ticks.length)
})

test('a window over 24 h keeps every tick, including a time of day repeated on the next day', async () => {
  // Fri 18 Sep 18:00Z – Sat 19 Sep 20:00Z is Fri 20:00 – Sat 22:00 Stockholm;
  // the axis spans Fri 19:00 – Sat 23:00 (28 h), so ticks fall every 4 h.
  const fri = '2026-09-18'
  await renderChart({
    ...detail,
    window: { startMs: at('18:00', fri), endMs: at('20:00', '2026-09-19') },
    intervals: [],
    prices: quarters(at('17:00', fri), 28 * 4, () => 100),
    optimalSchedule: null,
  })
  expect(texts('[data-axis="time"]')).toEqual([
    '20:00',
    'lör 00:00',
    '04:00',
    '08:00',
    '12:00',
    '16:00',
    '20:00',
  ])
})

test('a window over midnight names the weekday on the midnight tick and in the table', async () => {
  // 21:00Z–23:00Z is 23:00–01:00 Stockholm, into Wednesday.
  const { screen } = await renderChart({
    ...detail,
    window: { startMs: at('21:00'), endMs: at('23:00') },
    intervals: [],
    prices: quarters(at('20:00'), 16, () => 100),
    optimalSchedule: null,
  })
  expect(texts('[data-axis="time"]')).toContain('ons 00:00')
  await expect
    .element(chartTable(screen).getByRole('row', { name: /^tis 22:00–22:15/ }))
    .toBeInTheDocument()
})

test('an estimated session draws no bars but still the price line', async () => {
  const { screen } = await renderChart({ ...detail, intervals: [] })
  expect(series('actual')).toHaveLength(0)
  expect(series('spot')[0]?.getAttribute('d')).toMatch(/M/)
  await expect
    .element(chartTable(screen).getByRole('row', { name: /^10:00–10:15/ }))
    .toMatchTextContent(/—/)
  // No "Laddat" legend entry for bars that aren't there; a note says why.
  expect(document.querySelector('[data-legend="actual"]')).toBeNull()
  await expect.element(screen.getByText(m.charging_session_chart_no_hourly())).toBeVisible()
})

test('a session with hourly data has the "Laddat" legend entry and no note', async () => {
  const { screen } = await renderChart()
  await expect
    .element(screen.getByText(m.charging_session_chart_actual(), { exact: true }))
    .toBeVisible()
  expect(screen.getByText(m.charging_session_chart_no_hourly()).elements()).toHaveLength(0)
})

// The keyboard path: the plot is one tab stop outside the aria-hidden svg, and
// the arrows step the popover through the same rows the pointer picks from.
const popoverText = () => document.querySelector('.visx-tooltip')?.textContent ?? null
const announced = () => document.querySelector('[data-chart-announce]')?.textContent ?? ''

test('the plot takes focus, named and described, outside the hidden svg', async () => {
  const { screen } = await renderChart()
  const plot = screen.getByRole('group', { name: m.charging_session_chart_title() })
  await expect.element(plot).toHaveAttribute('tabindex', '0')
  await expect.element(plot).toHaveAccessibleDescription(m.charging_session_chart_keyboard_hint())
  expect(plot.element().closest('[aria-hidden="true"]')).toBeNull()
})

test('arrow keys step the popover through the rows; Escape closes it', async () => {
  const { screen } = await renderChart()
  const plot = screen.getByRole('group', { name: m.charging_session_chart_title() }).element()
  ;(plot as HTMLElement).focus()
  expect(popoverText()).toBeNull()

  await userEvent.keyboard('{ArrowRight}')
  await expect.poll(popoverText).toBe('09:00–09:15 · — kWh · 125 öre')
  expect(announced()).toBe('09:00–09:15 · — kWh · 125 öre')
  // The crosshair follows the keyboard: the first row's middle, then one quarter on.
  const first = crosshair()?.x ?? Number.NaN
  expect(Math.abs(first - (clientXAt(at('07:00')) + clientXAt(at('07:15'))) / 2)).toBeLessThan(0.5)
  await userEvent.keyboard('{ArrowRight}')
  await expect.poll(popoverText).toBe('09:15–09:30 · — kWh · 125 öre')
  const quarterPx = clientXAt(at('07:15')) - clientXAt(at('07:00'))
  expect(Math.abs((crosshair()?.x ?? Number.NaN) - first - quarterPx)).toBeLessThan(0.5)
  await userEvent.keyboard('{End}')
  await expect.poll(popoverText).toBe('12:45–13:00 · — kWh · 125 öre')
  await userEvent.keyboard('{ArrowLeft}')
  await expect.poll(popoverText).toBe('12:30–12:45 · — kWh · — öre')
  await userEvent.keyboard('{Home}')
  await expect.poll(popoverText).toBe('09:00–09:15 · — kWh · 125 öre')
  await userEvent.keyboard('{ArrowLeft}') // stays on the first row
  await expect.poll(popoverText).toBe('09:00–09:15 · — kWh · 125 öre')

  await userEvent.keyboard('{Escape}')
  await expect.poll(popoverText).toBeNull()
  expect(announced()).toBe('')
  expect(crosshair()).toBeNull()
})

test('leaving the plot with the keyboard closes its popover', async () => {
  const { screen } = await renderChart()
  const plot = screen.getByRole('group', { name: m.charging_session_chart_title() }).element()
  ;(plot as HTMLElement).focus()
  await userEvent.keyboard('{ArrowRight}')
  await expect.poll(popoverText).not.toBeNull()
  ;(plot as HTMLElement).blur()
  await expect.poll(popoverText).toBeNull()
})

test('an excluded session without an optimal schedule shows no toggle', async () => {
  const { screen } = await renderChart({ ...detail, optimalSchedule: null })
  expect(screen.getByRole('checkbox').elements()).toHaveLength(0)
  expect(series('optimal')).toHaveLength(0)
  expect(document.querySelector('[data-legend="optimal"]')).toBeNull()
})

test("its sr-only table doesn't widen a 320 px page", async () => {
  const { screen } = await renderWithProviders(
    <div data-testid="page" style={{ width: 320, overflow: 'auto', position: 'relative' }}>
      <style>{SR_ONLY_CSS}</style>
      <SessionPriceChart detail={detail} />
    </div>,
  )
  await expect.poll(() => document.querySelector('[data-hover-overlay]')).not.toBeNull()
  expect(overflowX(screen.getByTestId('page').element())).toBe(0)
  tablesClipped(screen.container)
})

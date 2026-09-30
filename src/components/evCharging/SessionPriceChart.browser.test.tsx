import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
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

async function renderChart(d: Detail = detail, width = 900) {
  const result = await renderWithProviders(
    <div style={{ width }}>
      <SessionPriceChart detail={d} />
    </div>,
  )
  // The SVG draws once the container has been measured.
  await expect.poll(() => document.querySelector('[data-series="spot"]')).not.toBeNull()
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
    // …and a card-coloured stroke is masked off inside every run.
    if (el.style.stroke === 'var(--card)') {
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
      { startMs: at('09:00'), endMs: at('10:00'), kwh: 0.05 },
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
    .toHaveTextContent(/10:00–10:15\s*2,5\s*375\s*—/)
  // The 0-kWh hour is 0 kWh; the cheapest schedule puts 2,5 kWh in each of its quarters.
  await expect
    .element(table.getByRole('row', { name: /^11:00–11:15/ }))
    .toHaveTextContent(/11:00–11:15\s*0,0\s*125\s*2,5/)
  // Outside every interval there's no energy figure.
  await expect.element(table.getByRole('row', { name: /^09:00–09:15/ })).toHaveTextContent(/—/)
  // A slot without a price reads "—", never 0 öre.
  await expect
    .element(table.getByRole('row', { name: /^12:30–12:45/ }))
    .toHaveTextContent(/12:30–12:45\s*—\s*—/)
})

test('a partial-hour interval spreads its energy over the slots it covers', async () => {
  const { screen } = await renderChart({
    ...detail,
    intervals: [{ startMs: at('08:10'), endMs: at('09:00'), kwh: 5 }],
  })
  const table = chartTable(screen)
  // 5 of its 50 minutes in 08:00–08:15Z, then 15 of 50.
  await expect.element(table.getByRole('row', { name: /^10:00–10:15/ })).toHaveTextContent(/0,5/)
  await expect.element(table.getByRole('row', { name: /^10:15–10:30/ })).toHaveTextContent(/1,5/)
})

test('hovering shows the nearest slot with the same kWh share as the table', async () => {
  const { screen } = await renderChart()
  pointAt('pointermove', at('08:07'))
  await expect.element(screen.getByText('10:00–10:15 · 2,5 kWh · 375 öre')).toBeInTheDocument()
  pointAt('pointermove', at('08:20'))
  await expect.element(screen.getByText('10:15–10:30 · 2,5 kWh · 375 öre')).toBeInTheDocument()
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
    .toHaveTextContent(/10:00–11:00\s*10,0\s*—/)
})

test('without any price there is no line and no price axis, and nothing breaks', async () => {
  const { screen } = await renderChart({
    ...detail,
    prices: prices.map((p) => ({ ...p, spotOre: null })),
  })
  expect(series('spot')[0]?.getAttribute('d') ?? '').not.toMatch(/M/)
  expect(document.querySelector('[data-axis="ore"]')).toBeNull()
  await expect
    .element(chartTable(screen).getByRole('row', { name: /^10:00–10:15/ }))
    .toHaveTextContent(/10:00–10:15\s*2,5\s*—/)
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

test('a four-digit negative tick fits inside the chart', async () => {
  await renderChart({
    ...detail,
    prices: prices.map((p, i) => ({ ...p, spotOre: i === 0 ? -1250 : 1250 })),
  })
  const svgRight = document
    .querySelector('svg[data-chart="session-price"]')
    ?.getBoundingClientRect().right
  const labels = [...document.querySelectorAll('[data-axis="ore"] text')]
  expect(labels.some((t) => /^[−-]1\s?000$/.test(t.textContent ?? ''))).toBe(true)
  for (const label of labels) {
    expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(svgRight ?? 0)
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
    .toHaveTextContent(/—/)
})

test('an excluded session without an optimal schedule shows no toggle', async () => {
  const { screen } = await renderChart({ ...detail, optimalSchedule: null })
  expect(screen.getByRole('checkbox').elements()).toHaveLength(0)
  expect(series('optimal')).toHaveLength(0)
  expect(document.querySelector('[data-legend="optimal"]')).toBeNull()
})

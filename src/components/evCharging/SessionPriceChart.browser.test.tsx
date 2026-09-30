import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SessionPriceChart } from './SessionPriceChart'

type Detail = RouterOutputs['evCharging']['session']

// 15 Sep 2026 is CEST (UTC+2): 08:00Z reads "10:00" in Stockholm.
const at = (hhmm: string) => Date.parse(`2026-09-15T${hhmm}:00Z`)
const QUARTER = 15 * 60_000

// 16 quarter-hour slots 07:00Z–11:00Z: 375 öre for 08:00–09:00, else 125,
// and no price (no tariff) for 10:30–10:45.
const prices = Array.from({ length: 16 }, (_, i) => {
  const startMs = at('07:00') + i * QUARTER
  const expensive = startMs >= at('08:00') && startMs < at('09:00')
  return {
    startMs,
    endMs: startMs + QUARTER,
    spotOre: startMs === at('10:30') ? null : expensive ? 375 : 125,
  }
})

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

async function renderChart(d: Detail = detail) {
  const result = await renderWithProviders(
    <div style={{ width: 900 }}>
      <SessionPriceChart detail={d} />
    </div>,
  )
  // The SVG draws once the container has been measured.
  await expect.poll(() => document.querySelector('[data-series="spot"]')).not.toBeNull()
  return result
}

const series = (name: string) => document.querySelectorAll(`[data-series="${name}"]`)

test('draws a bar per charged interval, ghost bars for the optimal schedule and a stepped price line', async () => {
  const { screen } = await renderChart()
  await expect
    .element(screen.getByRole('heading', { level: 2, name: m.charging_session_chart_title() }))
    .toBeVisible()
  expect(series('actual')).toHaveLength(1) // the 0-kWh hour draws nothing
  expect(series('optimal')).toHaveLength(4)
  expect(series('spot')).toHaveLength(1)
})

test('the chart card is a region named by its heading', async () => {
  const { screen } = await renderChart()
  await expect
    .element(screen.getByRole('region', { name: m.charging_session_chart_title() }))
    .toBeInTheDocument()
})

test('the optimal schedule can be hidden', async () => {
  const { screen } = await renderChart()
  await screen.getByRole('checkbox', { name: m.charging_session_chart_show_optimal() }).click()
  await expect.poll(() => series('optimal').length).toBe(0)
  expect(series('actual')).toHaveLength(1)
})

test('exposes the same data as a screen-reader table', async () => {
  const { screen } = await renderChart()
  const table = screen.getByRole('table', { name: m.charging_session_chart_table_caption() })
  await expect.element(table).toBeInTheDocument()
  expect(table.getByRole('row').elements().length).toBe(1 + 16)
  // 10:00–10:15 Stockholm: a quarter of the 10 kWh hour, at 375 öre.
  const row = table.getByRole('row', { name: /^10:00–10:15/ })
  await expect.element(row).toHaveTextContent(/10:00–10:15\s*2,5\s*375/)
  // The 0-kWh hour is 0 kWh; outside every interval there's no energy figure.
  await expect.element(table.getByRole('row', { name: /^11:00–11:15/ })).toHaveTextContent(/0,0/)
  await expect.element(table.getByRole('row', { name: /^09:00–09:15/ })).toHaveTextContent(/—/)
  // A slot without a price reads "—", never 0 öre.
  await expect
    .element(table.getByRole('row', { name: /^12:30–12:45/ }))
    .toHaveTextContent(/12:30–12:45\s*—\s*—/)
})

test('the tooltip shows the hovered slot with the same kWh share as the table', async () => {
  const { screen } = await renderChart()
  const target = document.querySelector(`[data-hover-slot="${at('08:00')}"]`)
  if (!target) throw new Error('hover target missing')
  await userEvent.hover(target)
  await expect.element(screen.getByText('10:00–10:15 · 2,5 kWh · 375 öre')).toBeInTheDocument()
})

test('a slot without a price breaks the step line instead of bridging it', async () => {
  await renderChart()
  const d = series('spot')[0]?.getAttribute('d') ?? ''
  expect(d.match(/M/g)).toHaveLength(2)
})

test('negative spot prices stay on the price axis', async () => {
  const negative = {
    ...detail,
    prices: prices.map((p, i) => (i === 0 ? { ...p, spotOre: -60 } : p)),
  }
  await renderChart(negative)
  const ticks = [...document.querySelectorAll('[data-axis="ore"] text')].map((t) => t.textContent)
  expect(ticks.some((t) => /^[−-]\d/.test(t ?? ''))).toBe(true)
})

test('an estimated session draws no bars but still the price line', async () => {
  const { screen } = await renderChart({ ...detail, intervals: [] })
  expect(series('actual')).toHaveLength(0)
  expect(series('spot')).toHaveLength(1)
  const table = screen.getByRole('table', { name: m.charging_session_chart_table_caption() })
  await expect.element(table.getByRole('row', { name: /^10:00–10:15/ })).toHaveTextContent(/—/)
})

test('an excluded session without an optimal schedule shows no toggle', async () => {
  const { screen } = await renderChart({ ...detail, optimalSchedule: null })
  expect(screen.getByRole('checkbox').elements()).toHaveLength(0)
  expect(series('optimal')).toHaveLength(0)
})

import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { MetricToggle } from './MetricToggle'
import { chartMetricOptions, MonthlyChart } from './MonthlyChart'

const months = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  kwh: 10 + i * 5,
  sessions: i + 1,
}))

test('renders one bar per month (12)', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(12)
  })
})

test('labels the x-axis with localized short month names', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} />
    </div>,
  )
  // sv-SE short months ("jan.", "maj", "dec.").
  const jan = new Intl.DateTimeFormat('sv-SE', { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, 0, 15, 12)),
  )
  // Scoped to the SVG axis ticks: a hover tooltip (the pointer can rest over the chart
  // between tests) also renders the month label.
  await vi.waitFor(() => {
    const ticks = [...screen.container.querySelectorAll('svg tspan')]
    expect(ticks.map((t) => t.textContent)).toContain(jan)
  })
})

const costMonths = months.map((mo) => ({
  month: mo.month,
  kwh: mo.kwh,
  gridKwh: mo.kwh,
  fullKwh: mo.kwh,
  noPriceKwh: 0,
  noTariffKwh: 0,
  solarKwh: 0,
  batteryKwh: 0,
  noHouseDataKwh: 0,
  solarValueSek: 0,
  solarPricedKwh: 0,
  solarUnpricedKwh: 0,
  spotSek: mo.kwh * 0.6,
  feesSek: mo.kwh * 0.95,
  totalSek: mo.kwh * 1.55,
  avgOre: 155,
  complete: true,
}))

test('the kr view stacks spot and fees: two bar series of 12', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(24),
  )
})

test('without cost data the kr metric falls back to kWh', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} metric="sek" />
    </div>,
  )
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(12),
  )
})

test('the metric toggle reports the chosen metric', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(
    <MetricToggle
      value="kwh"
      options={chartMetricOptions()}
      onChange={onChange}
      aria-label={m.charging_chart_metric_label()}
    />,
  )
  await screen.getByRole('radio', { name: 'kr' }).click()
  expect(onChange).toHaveBeenCalledWith('sek')
})

test('the kr view has a legend naming spot and fees', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  // Scoped to the legend: a hover tooltip may also be open (see above).
  await vi.waitFor(() => {
    const legend = screen.container.querySelector('.recharts-legend-wrapper')?.textContent
    expect(legend).toContain(m.charging_chart_series_spot())
    expect(legend).toContain(m.charging_chart_series_fees())
    expect(legend).not.toContain(m.charging_chart_no_price())
  })
})

test('a month with energy but no price gets a stub and a "Pris saknas" legend, not an empty 0 kr bar', async () => {
  const unpriced = costMonths.map((c) =>
    c.month <= 5
      ? {
          ...c,
          fullKwh: 0,
          noPriceKwh: c.kwh,
          spotSek: 0,
          feesSek: 0,
          totalSek: 0,
          avgOre: null,
          complete: false,
        }
      : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: unpriced }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() =>
    expect(screen.container.querySelector('.recharts-legend-wrapper')?.textContent).toContain(
      m.charging_chart_no_price(),
    ),
  )
  // 7 priced months × (spot + fees) + 5 stubs.
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(19),
  )
})

test('the kr view draws from the cost data alone, whatever kWh months it is given', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={[]} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(24),
  )
})

test('a year with nothing priced says so in the kr view instead of drawing 0 kr', async () => {
  const none = costMonths.map((c) => ({
    ...c,
    fullKwh: 0,
    noPriceKwh: c.kwh,
    spotSek: 0,
    feesSek: 0,
    totalSek: 0,
    avgOre: null,
    complete: false,
  }))
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2023, months: none }} metric="sek" />
    </div>,
  )
  await expect.element(screen.getByText(m.charging_chart_cost_empty({ year: 2023 }))).toBeVisible()
  expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(0)
})

const barHeights = (container: Element, bar = 0) =>
  [
    ...container
      .querySelectorAll('.recharts-bar')
      [bar].querySelectorAll('.recharts-bar-rectangle path'),
  ].map((p) => p.getBoundingClientRect().height)

test('a tiny real kWh month keeps a visible bar; a genuine 0 month stays empty', async () => {
  const sparse = months.map((mo) => ({
    ...mo,
    kwh: mo.month === 1 ? 1000 : mo.month === 2 ? 0.01 : 0,
  }))
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={sparse} />
    </div>,
  )
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(2),
  )
  const heights = barHeights(screen.container)
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(2)
})

test('the kr view keeps a tiny real month visible, and invents no stub for a real 0 component', async () => {
  const sparse = costMonths.map((c) => {
    const base = { ...c, kwh: 0, gridKwh: 0, fullKwh: 0, spotSek: 0, feesSek: 0, totalSek: 0 }
    if (c.month === 1) return { ...c, spotSek: 400, feesSek: 100, totalSek: 500 }
    // A real tiny spot cost with genuinely 0 fees.
    if (c.month === 2) return { ...c, spotSek: 0.01, feesSek: 0, totalSek: 0.01 }
    return base
  })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: sparse }} metric="sek" />
    </div>,
  )
  // spot: months 1 + 2; fees: month 1 only (month 2's 0 fees means nothing).
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(3),
  )
  expect(Math.min(...barHeights(screen.container, 0))).toBeGreaterThanOrEqual(2)
  expect(barHeights(screen.container, 1)).toHaveLength(1)
})

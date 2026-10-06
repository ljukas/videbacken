import { beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { m } from '~/paraglide/messages'
import {
  barHeight,
  bars,
  focusTarget,
  hoverBar,
  hoverBetween,
  legend,
  legendLabels,
  legendText,
  parkPointer,
  pressUntil,
  seriesBars,
  settle,
  tooltipText,
  xTickLabels,
  xTickNodes,
  yTickLabels,
} from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { formatOneDecimal, formatSek, formatShare, monthLabel } from './format'
import { MetricToggle } from './MetricToggle'
import { chartMetricOptions, MonthlyChart } from './MonthlyChart'

// Keep the real pointer off the charts (see parkPointer).
beforeEach(parkPointer)

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
    expect(bars(screen.container)).toHaveLength(12)
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
  // Scoped to the x-axis ticks: a hover tooltip (the pointer can rest over the chart
  // between tests) also renders the month label.
  await vi.waitFor(() => {
    expect(xTickLabels(screen.container)).toContain(jan)
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
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(24))
})

test('without cost data the kr metric falls back to kWh', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} metric="sek" />
    </div>,
  )
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(12))
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
    const legend = legendText(screen.container)
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
    expect(legendText(screen.container)).toContain(m.charging_chart_no_price()),
  )
  // 7 priced months × (spot + fees) + 5 stubs.
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(19))
})

test('the kr view draws from the cost data alone, whatever kWh months it is given', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={[]} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(24))
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
  expect(bars(screen.container)).toHaveLength(0)
})

test('a year charged only from own solar draws its 0 kr, never "nothing priced"', async () => {
  const solar = costMonths.map((c) => ({
    ...c,
    gridKwh: 0,
    fullKwh: 0,
    solarKwh: c.kwh,
    spotSek: 0,
    feesSek: 0,
    totalSek: 0,
    avgOre: null,
  }))
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2023, months: solar }} metric="sek" />
    </div>,
  )
  await expect.element(screen.getByText(m.charging_chart_series_spot()).first()).toBeVisible()
  expect(screen.getByText(m.charging_chart_cost_empty({ year: 2023 })).elements()).toHaveLength(0)
})

const barHeights = (container: Element, bar = 0) => seriesBars(container, bar).map(barHeight)

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
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(2))
  const heights = barHeights(screen.container)
  expect(heights).toHaveLength(2)
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
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(3))
  const spot = barHeights(screen.container, 0)
  expect(spot).toHaveLength(2)
  expect(Math.min(...spot)).toBeGreaterThanOrEqual(2)
  expect(barHeights(screen.container, 1)).toHaveLength(1)
})

test('a month charged only from own solar is 0 kr, not "Pris saknas"', async () => {
  const solarJune = costMonths.map((c) =>
    c.month === 6
      ? {
          ...c,
          gridKwh: 0,
          fullKwh: 0,
          solarKwh: c.kwh,
          spotSek: 0,
          feesSek: 0,
          totalSek: 0,
          avgOre: null,
        }
      : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: solarJune }} metric="sek" />
    </div>,
  )
  await expect.element(screen.getByText(m.charging_chart_series_spot()).first()).toBeVisible()
  expect(screen.getByText(m.charging_chart_no_price()).elements()).toHaveLength(0)
})

// hoverBar(container, i) moves the pointer onto the i-th bar (DOM order: all spot bars, then all fees bars).
const withSolar = (
  solar: { solarPricedKwh: number; solarUnpricedKwh: number; solarValueSek: number },
  base = costMonths,
) => base.map((c) => (c.month === 6 ? { ...c, ...solar } : c))

test('a month with solar shows its value in the tooltip, under the total', async () => {
  const sunny = withSolar({ solarPricedKwh: 300, solarUnpricedKwh: 0, solarValueSek: 212 })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: sunny }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 5) // June's spot bar
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(m.charging_solar_value_label())
    expect(tooltipText()).toContain(formatSek(212))
    expect(tooltipText()).toContain(m.charging_solar_value_hint())
  })
  // The total comes first, then the solar value.
  const text = tooltipText()
  expect(text.indexOf(m.charging_chart_total())).toBeLessThan(
    text.indexOf(m.charging_solar_value_label()),
  )
})

test('a month without solar has no solar row', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 5)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.charging_chart_total()))
  expect(tooltipText()).not.toContain(m.charging_solar_value_label())
})

test('partly unpriced solar reads "minst" in the tooltip', async () => {
  const partly = withSolar({ solarPricedKwh: 250, solarUnpricedKwh: 50, solarValueSek: 212 })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: partly }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 5)
  await vi.waitFor(() =>
    expect(tooltipText()).toContain(m.charging_cost_min({ total: formatSek(212) })),
  )
})

test('wholly unpriced solar is a dash with its reason, never 0 kr', async () => {
  const none = withSolar({ solarPricedKwh: 0, solarUnpricedKwh: 300, solarValueSek: 0 })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: none }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 5)
  // The reason is visible text: the tooltip ignores the pointer, so a title never shows.
  await vi.waitFor(() => expect(tooltipText()).toContain(m.charging_solar_value_unknown_hint()))
  expect(tooltipText()).toContain(m.charging_solar_value_label())
  expect(tooltipText()).not.toContain(m.charging_solar_value_hint())
})

test('an unpriced stub month still shows its solar value', async () => {
  // No tariff in force: the cash cost is a "Pris saknas" stub, but spot prices exist, so solar is valued.
  const stubbed = costMonths.map((c) =>
    c.month === 6
      ? {
          ...c,
          fullKwh: 0,
          noTariffKwh: c.kwh,
          spotSek: 0,
          feesSek: 0,
          totalSek: 0,
          avgOre: null,
          complete: false,
          solarPricedKwh: 300,
          solarUnpricedKwh: 0,
          solarValueSek: 212,
        }
      : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: stubbed }} metric="sek" />
    </div>,
  )
  // 11 priced months × (spot + fees) + 1 stub, last in DOM order: hover the stub.
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(23))
  await hoverBar(screen.container, 22)
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(m.charging_chart_no_price())
    expect(tooltipText()).toContain(m.charging_solar_value_label())
    expect(tooltipText()).toContain(formatSek(212))
  })
})

test('a month charged only from own solar shows 0 kr and then its solar value', async () => {
  const solarJune = costMonths.map((c) =>
    c.month === 6
      ? {
          ...c,
          gridKwh: 0,
          fullKwh: 0,
          solarKwh: c.kwh,
          spotSek: 0,
          feesSek: 0,
          totalSek: 0,
          avgOre: null,
          solarPricedKwh: c.kwh,
          solarUnpricedKwh: 0,
          solarValueSek: 20,
        }
      : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: solarJune }} metric="sek" />
    </div>,
  )
  // June's 0 kr draws no rectangle (index 5 is July's spot bar): point halfway
  // between May's and July's, where June's band is.
  await hoverBetween(screen.container, 4, 5)
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(monthLabel(6))
    expect(tooltipText()).toContain(m.charging_chart_total())
    expect(tooltipText()).toContain(formatSek(0))
    expect(tooltipText()).toContain(formatSek(20))
  })
  expect(tooltipText()).not.toContain(m.charging_chart_no_price())
})

// June as a "Pris saknas" stub (no tariff) carrying the given solar; the stub is
// the last rectangle (11 priced months × spot + fees, then the stub).
const stubJune = (solar: {
  solarPricedKwh: number
  solarUnpricedKwh: number
  solarValueSek: number
}) =>
  costMonths.map((c) =>
    c.month === 6
      ? {
          ...c,
          fullKwh: 0,
          noTariffKwh: c.kwh,
          spotSek: 0,
          feesSek: 0,
          totalSek: 0,
          avgOre: null,
          complete: false,
          ...solar,
        }
      : c,
  )
const hoverStub = async (stubbed: ReturnType<typeof stubJune>) => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: stubbed }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(23))
  await hoverBar(screen.container, 22)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.charging_chart_no_price()))
}

test('a stub month without solar has no solar row', async () => {
  await hoverStub(stubJune({ solarPricedKwh: 0, solarUnpricedKwh: 0, solarValueSek: 0 }))
  expect(tooltipText()).not.toContain(m.charging_solar_value_label())
})

test('a stub month with solar but no spot says why its value is unknown', async () => {
  await hoverStub(stubJune({ solarPricedKwh: 0, solarUnpricedKwh: 300, solarValueSek: 0 }))
  expect(tooltipText()).toContain(m.charging_solar_value_unknown_hint())
})

test('a stub month with partly unpriced solar reads "minst"', async () => {
  await hoverStub(stubJune({ solarPricedKwh: 250, solarUnpricedKwh: 50, solarValueSek: 212 }))
  expect(tooltipText()).toContain(m.charging_cost_min({ total: formatSek(212) }))
})

test('a negative solar value keeps its sign in the tooltip', async () => {
  const negative = withSolar({ solarPricedKwh: 300, solarUnpricedKwh: 0, solarValueSek: -3.4 })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: negative }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 5)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.charging_solar_value_label()))
  expect(tooltipText()).toMatch(/Värde av egen sol−3\skr/)
})

test('the kWh tooltip names the month and its energy', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} />
    </div>,
  )
  await hoverBar(screen.container, 2) // March: 20 kWh
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(monthLabel(3))
    expect(tooltipText()).toContain(`${formatOneDecimal(20)} kWh`)
  })
})

test('the kr legend and tooltip list the series in stack order', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() =>
    expect(legendLabels(screen.container)).toEqual([
      m.charging_chart_series_spot(),
      m.charging_chart_series_fees(),
    ]),
  )
  // The legend is the touch and screen-reader key: never hidden with the chart.
  expect(legend(screen.container)?.closest('[aria-hidden="true"]')).toBeNull()
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.charging_chart_total()))
  const text = tooltipText()
  expect(text).toContain(m.charging_chart_series_spot())
  expect(text.indexOf(m.charging_chart_series_spot())).toBeLessThan(
    text.indexOf(m.charging_chart_series_fees()),
  )
  expect(text.indexOf(m.charging_chart_series_fees())).toBeLessThan(
    text.indexOf(m.charging_chart_total()),
  )
})

test('the stub comes last in the kr legend', async () => {
  const unpriced = costMonths.map((c) =>
    c.month === 1
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
    expect(legendLabels(screen.container)).toEqual([
      m.charging_chart_series_spot(),
      m.charging_chart_series_fees(),
      m.charging_chart_no_price(),
    ]),
  )
})

test('the count axis labels whole, formatted numbers', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months.map((mo) => ({ ...mo, kwh: mo.kwh * 100 }))} />
    </div>,
  )
  await vi.waitFor(() => expect(yTickLabels(screen.container).length).toBeGreaterThan(1))
  for (const label of yTickLabels(screen.container)) {
    // sv-SE groups thousands with a no-break space; never a decimal comma.
    expect(label).toMatch(/^−?\d{1,3}( \d{3})*$/)
  }
})

test('a narrow chart thins the month labels but keeps the first and the last', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 280, height: 300 }}>
      <MonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => expect(xTickLabels(screen.container).length).toBeGreaterThan(1))
  const labels = xTickLabels(screen.container)
  expect(labels[0]).toBe(monthLabel(1))
  expect(labels.at(-1)).toBe(monthLabel(12))
  // No two shown labels touch.
  const boxes = xTickNodes(screen.container).map((t) => t.getBoundingClientRect())
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].left).toBeGreaterThan(boxes[i - 1].right)
  }
})

test('the keyboard reaches the chart and the arrows walk its tooltip a month at a time', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <button type="button">before</button>
      <MonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => expect(focusTarget(screen.container)).not.toBeNull())
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  expect(document.activeElement).toBe(focusTarget(screen.container))
  // → moves to a month, and then one month at a time.
  const shown = () =>
    [...Array(12).keys()]
      .map((i) => monthLabel(i + 1))
      .findIndex((l) => tooltipText().startsWith(l))
  await settle()
  const initial = shown()
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(shown()).not.toBe(initial))
  const before = shown()
  expect(before).toBeGreaterThanOrEqual(0)
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(shown()).toBe(before + 1))
  await userEvent.keyboard('{ArrowLeft}')
  await vi.waitFor(() => expect(shown()).toBe(before))
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

test('the kr view is reachable by keyboard too', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <button type="button">before</button>
      <MonthlyChart months={months} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() => expect(focusTarget(screen.container)).not.toBeNull())
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  expect(document.activeElement).toBe(focusTarget(screen.container))
  await pressUntil('{ArrowRight}', () => tooltipText().includes(m.charging_chart_total()))
})

test('Tab leaves the chart in one step and closes its tooltip', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <button type="button">before</button>
      <MonthlyChart months={months} />
      <button type="button">after</button>
    </div>,
  )
  await vi.waitFor(() => expect(focusTarget(screen.container)).not.toBeNull())
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await pressUntil('{ArrowRight}', () => tooltipText() !== '')
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }).element())
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

test('a partly priced month reads "minst" with the missing share', async () => {
  const partly = costMonths.map((c) =>
    c.month === 3 ? { ...c, fullKwh: c.kwh * 0.6, noPriceKwh: c.kwh * 0.4, complete: false } : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: partly }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 2) // March's spot bar
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(m.charging_cost_min({ total: formatSek(partly[2].totalSek) }))
    expect(tooltipText()).toContain(m.charging_cost_partial_hint({ share: formatShare(0.4) }))
  })
})

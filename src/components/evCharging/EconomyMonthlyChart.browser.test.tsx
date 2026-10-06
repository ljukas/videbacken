import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import {
  barHeight,
  barSeries,
  bars,
  chartSvg,
  focusTarget,
  gridLines,
  hoverBar,
  legend,
  legendLabels,
  legendText,
  pressUntil,
  seriesBars,
  tooltipText,
} from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { EconomyMonthlyChart } from './EconomyMonthlyChart'
import { formatSek, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['economy']['months'][number]
const month = (mo: number, over: Partial<Month> = {}): Month => ({
  month: mo,
  sessions: 0,
  included: 0,
  excluded: { noHourly: 0, noPrice: 0 },
  kwh: 0,
  actualSek: 0,
  immediateSek: 0,
  optimalSek: 0,
  dearestSek: 0,
  savedVsImmediateSek: 0,
  leftOnTableSek: 0,
  score: null,
  paidSpotOre: null,
  avgSpotOre: null,
  ...over,
})
const months = Array.from({ length: 12 }, (_, i) =>
  i === 8
    ? month(9, { sessions: 2, included: 2, actualSek: 90, immediateSek: 120, optimalSek: 70 })
    : month(i + 1),
)

test('draws three bar series, a legend naming them, and no bars for months without comparable sessions', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => {
    const text = legendText(screen.container)
    expect(text).toContain(m.charging_economy_series_immediate())
    expect(text).toContain(m.charging_economy_series_actual())
    expect(text).toContain(m.charging_economy_series_optimal())
  })
  expect(barSeries(screen.container)).toHaveLength(3)
  // One comparable month x three series: the other eleven get no 0 kr bars.
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(3))
})

const stubMonths = months.map((mo) =>
  mo.month === 3 ? month(3, { sessions: 2, excluded: { noHourly: 0, noPrice: 2 } }) : mo,
)

test('a month whose sessions were all excluded draws one quiet stub and no kronor bars', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={stubMonths} />
    </div>,
  )
  await vi.waitFor(() => {
    expect(legendText(screen.container)).toContain(m.charging_economy_series_not_comparable())
  })
  expect(barSeries(screen.container)).toHaveLength(4)
  // Three kronor bars for September + exactly one stub for March.
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(4))
})

test('a year where every session was excluded shows sliver stubs, not "no data" or tall bars', async () => {
  const all = Array.from({ length: 12 }, (_, i) =>
    i < 2 ? month(i + 1, { sessions: 1, excluded: { noHourly: 1, noPrice: 0 } }) : month(i + 1),
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={all} />
    </div>,
  )
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(2))
  expect(screen.getByText(m.charging_economy_chart_no_data()).elements()).toHaveLength(0)
  const plot = chartSvg(screen.container)?.getBoundingClientRect()
  const height = barHeight(bars(screen.container)[0])
  expect(plot && height > 0 && height < plot.height * 0.1).toBe(true)
  expect(gridLines(screen.container)).toHaveLength(0)
})

test('a year with no stub months has no stub series or legend entry', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => expect(legend(screen.container)).not.toBeNull())
  expect(legendText(screen.container)).not.toContain(m.charging_economy_series_not_comparable())
  expect(barSeries(screen.container)).toHaveLength(3)
})

test('a year with nothing comparable says so instead of an empty 0 kr chart', async () => {
  const { screen } = await renderWithProviders(
    <EconomyMonthlyChart months={Array.from({ length: 12 }, (_, i) => month(i + 1))} />,
  )
  await expect.element(screen.getByText(m.charging_economy_chart_no_data())).toBeVisible()
  expect(barSeries(screen.container)).toHaveLength(0)
})

test('tooltips name the stub reason and flag a partly compared month', async () => {
  const mixed = months.map((mo) => {
    if (mo.month === 3) return month(3, { sessions: 1, excluded: { noHourly: 1, noPrice: 0 } })
    if (mo.month === 9) return { ...mo, sessions: 3, excluded: { noHourly: 0, noPrice: 1 } }
    return mo
  })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={mixed} />
    </div>,
  )
  // Rectangles in DOM order: immediate, actual, optimal (Sep), then the stub (Mar).
  await hoverBar(screen.container, 2)
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      m.charging_economy_tooltip_compared({ included: 2, sessions: 3 }),
    ),
  )
  await hoverBar(screen.container, 3)
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(m.charging_economy_series_no_hourly()),
  )
})

test('tooltips: no_price stub reads "Pris saknas", mixed reads "Inte jämförbar"', async () => {
  const two = months.map((mo) => {
    if (mo.month === 2) return month(2, { sessions: 1, excluded: { noHourly: 0, noPrice: 1 } })
    if (mo.month === 3) return month(3, { sessions: 2, excluded: { noHourly: 1, noPrice: 1 } })
    return mo
  })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={two} />
    </div>,
  )
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(5))
  // Hover each rectangle in turn until the tooltip shows the wanted stub reason.
  const reveal = async (text: string) => {
    let i = 0
    await vi.waitFor(async () => {
      if (!tooltipText().includes(text)) await hoverBar(screen.container, i++ % 5)
      expect(tooltipText()).toContain(text)
    })
  }
  await reveal(m.charging_chart_no_price())
  await reveal(m.charging_economy_series_not_comparable())
})

test('a real 0 or near-0 kr counterfactual in an included month is a visible bar', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart
        months={months.map((mo) =>
          mo.month === 9 ? { ...mo, immediateSek: 120, actualSek: 0, optimalSek: 0.01 } : mo,
        )}
      />
    </div>,
  )
  // Three series in the one included month; the other eleven (null) have none.
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(3))
  for (const bar of [0, 1, 2]) {
    const heights = seriesBars(screen.container, bar).map(barHeight)
    expect(heights).toHaveLength(1)
    expect(heights[0]).toBeGreaterThanOrEqual(2)
  }
})

test('the legend lists immediate, actual, optimal, then the stub', async () => {
  const withStub = months.map((mo) =>
    mo.month === 3 ? month(3, { sessions: 1, excluded: { noHourly: 1, noPrice: 0 } }) : mo,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={withStub} />
    </div>,
  )
  await vi.waitFor(() =>
    expect(legendLabels(screen.container)).toEqual([
      m.charging_economy_series_immediate(),
      m.charging_economy_series_actual(),
      m.charging_economy_series_optimal(),
      m.charging_economy_series_not_comparable(),
    ]),
  )
  // The legend is the touch and screen-reader key: never hidden with the chart.
  expect(legend(screen.container)?.closest('[aria-hidden="true"]')).toBeNull()
})

test('a month tooltip lists its three kronor rows in series order', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={months} />
    </div>,
  )
  await hoverBar(screen.container, 1) // September's "actual" bar
  await vi.waitFor(() => expect(tooltipText()).toContain(formatSek(70)))
  const text = tooltipText()
  expect(text).toContain(monthLabel(9))
  // Each row is its label, then its value, before the next row's label.
  const rows = [
    [m.charging_economy_series_immediate(), formatSek(120)],
    [m.charging_economy_series_actual(), formatSek(90)],
    [m.charging_economy_series_optimal(), formatSek(70)],
  ]
  let from = 0
  for (const [label, value] of rows) {
    const l = text.indexOf(label, from)
    expect(l).toBeGreaterThanOrEqual(0)
    const v = text.indexOf(value, l + label.length)
    expect(v).toBeGreaterThanOrEqual(0)
    from = v + value.length
  }
})

test('the keyboard reaches the chart and the arrows walk its tooltip', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <button type="button">before</button>
      <EconomyMonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => expect(focusTarget(screen.container)).not.toBeNull())
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  expect(document.activeElement).toBe(focusTarget(screen.container))
  // Walk right across the months without comparable sessions (no kronor rows)
  // until September's rows appear.
  await pressUntil('{ArrowRight}', () => tooltipText().includes(formatSek(120)))
  expect(tooltipText()).toContain(monthLabel(9))
  // Escape closes it.
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

test('Tab leaves the chart in one step and closes its tooltip', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <button type="button">before</button>
      <EconomyMonthlyChart months={months} />
      <button type="button">after</button>
    </div>,
  )
  await vi.waitFor(() => expect(focusTarget(screen.container)).not.toBeNull())
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await pressUntil('{ArrowRight}', () => tooltipText().includes(formatSek(120)))
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }).element())
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

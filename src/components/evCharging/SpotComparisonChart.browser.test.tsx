import { expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import {
  barHeight,
  barSeries,
  bars,
  hoverBar,
  legendLabels,
  legendText,
  lineCurve,
  lineDots,
  lineSeries,
  tooltipText,
} from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { formatOrePrecise, monthLabel } from './format'
import { SpotComparisonChart } from './SpotComparisonChart'

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
    ? month(9, { sessions: 2, included: 2, paidSpotOre: 80, avgSpotOre: 95 })
    : month(i + 1, { avgSpotOre: 90 + i }),
)

test('draws the paid price as a bar and the month average as a line, both in the legend', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart months={months} />
    </div>,
  )
  await vi.waitFor(() => {
    const legend = legendText(screen.container)
    expect(legend).toContain(m.charging_economy_series_paid())
    expect(legend).toContain(m.charging_economy_series_avg())
  })
  expect(barSeries(screen.container)).toHaveLength(1)
  expect(lineSeries(screen.container)).toHaveLength(1)
  // Only the one month with a paid price has a bar.
  expect(bars(screen.container)).toHaveLength(1)
})

test('a year with no spot data says so', async () => {
  const { screen } = await renderWithProviders(
    <SpotComparisonChart months={Array.from({ length: 12 }, (_, i) => month(i + 1))} />,
  )
  await expect.element(screen.getByText(m.charging_economy_chart_no_data())).toBeVisible()
  expect(barSeries(screen.container)).toHaveLength(0)
})

test('a year where nothing was paid (all excluded) says there is no data, not an average-only chart', async () => {
  const { screen } = await renderWithProviders(
    <SpotComparisonChart
      months={Array.from({ length: 12 }, (_, i) => month(i + 1, { avgSpotOre: 90 + i }))}
    />,
  )
  await expect.element(screen.getByText(m.charging_economy_chart_no_data())).toBeVisible()
  expect(barSeries(screen.container)).toHaveLength(0)
  expect(lineSeries(screen.container)).toHaveLength(0)
})

test('the month average is drawn only for months where the scope has a priced session', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart months={months} />
    </div>,
  )
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(1))
  // Eleven months carry market data but no paid price: no average point for them.
  expect(lineDots(screen.container)).toHaveLength(1)
})

test('the month-average dots are solid, not dashed like the line', async () => {
  const priced = (mo: number, avg: number) =>
    month(mo, { sessions: 1, included: 1, paidSpotOre: 50, avgSpotOre: avg })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart
        months={Array.from({ length: 12 }, (_, i) =>
          i === 7 ? priced(8, 83) : i === 8 ? priced(9, 109) : month(i + 1),
        )}
      />
    </div>,
  )
  await vi.waitFor(() => expect(lineDots(screen.container)).toHaveLength(2))
  // The line itself stays dashed…
  expect(lineCurve(screen.container)?.getAttribute('stroke-dasharray')).toBe('5 4')
  // …but a dot inheriting the dash pattern renders as a broken ring.
  for (const dot of lineDots(screen.container)) {
    expect(dot.getAttribute('stroke-dasharray') ?? 'none').toMatch(/^(none|0)$/)
  }
})

test('a near-zero paid price still draws a visible bar', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart
        months={months.map((mo) =>
          mo.month === 9 ? { ...mo, paidSpotOre: 0.17, avgSpotOre: 100 } : mo,
        )}
      />
    </div>,
  )
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(1))
  expect(barHeight(bars(screen.container)[0])).toBeGreaterThanOrEqual(2)
})

test('the legend lists the paid price, then the month average', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart months={months} />
    </div>,
  )
  await vi.waitFor(() =>
    expect(legendLabels(screen.container)).toEqual([
      m.charging_economy_series_paid(),
      m.charging_economy_series_avg(),
    ]),
  )
})

test('a month tooltip shows what we paid, then the average, in öre', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart months={months} />
    </div>,
  )
  await hoverBar(screen.container, 0) // September: paid 80, average 95
  await vi.waitFor(() => expect(tooltipText()).toContain(monthLabel(9)))
  const text = tooltipText()
  const paid = text.indexOf(m.charging_economy_ore({ value: formatOrePrecise(80) }))
  const avg = text.indexOf(m.charging_economy_ore({ value: formatOrePrecise(95) }))
  expect(paid).toBeGreaterThanOrEqual(0)
  expect(paid).toBeLessThan(avg)
})

test('the average line breaks across a month without a paid price', async () => {
  const priced = (mo: number) =>
    month(mo, { sessions: 1, included: 1, paidSpotOre: 50, avgSpotOre: 90 })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart
        months={Array.from({ length: 12 }, (_, i) =>
          i === 7 ? priced(8) : i === 9 ? priced(10) : month(i + 1, { avgSpotOre: 90 }),
        )}
      />
    </div>,
  )
  await vi.waitFor(() => expect(lineDots(screen.container)).toHaveLength(2))
  // Two separate one-point segments: no line drawn through September.
  const d = lineCurve(screen.container)?.getAttribute('d') ?? ''
  expect(d.match(/M/g)?.length ?? 0).not.toBe(1)
  expect(d).not.toMatch(/L/)
})

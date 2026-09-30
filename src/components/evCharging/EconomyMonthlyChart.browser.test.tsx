import { expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EconomyMonthlyChart } from './EconomyMonthlyChart'

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
    const legend = screen.container.querySelector('.recharts-legend-wrapper')?.textContent
    expect(legend).toContain(m.charging_economy_series_immediate())
    expect(legend).toContain(m.charging_economy_series_actual())
    expect(legend).toContain(m.charging_economy_series_optimal())
  })
  expect(screen.container.querySelectorAll('.recharts-bar')).toHaveLength(3)
  // One comparable month x three series: the other eleven get no 0 kr bars.
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(3),
  )
})

test('a year with nothing comparable says so instead of an empty 0 kr chart', async () => {
  const { screen } = await renderWithProviders(
    <EconomyMonthlyChart months={Array.from({ length: 12 }, (_, i) => month(i + 1))} />,
  )
  await expect.element(screen.getByText(m.charging_economy_chart_no_data())).toBeVisible()
  expect(screen.container.querySelectorAll('.recharts-bar')).toHaveLength(0)
})

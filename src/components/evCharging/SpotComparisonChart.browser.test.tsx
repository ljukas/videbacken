import { expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
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
    const legend = screen.container.querySelector('.recharts-legend-wrapper')?.textContent
    expect(legend).toContain(m.charging_economy_series_paid())
    expect(legend).toContain(m.charging_economy_series_avg())
  })
  expect(screen.container.querySelectorAll('.recharts-bar')).toHaveLength(1)
  expect(screen.container.querySelectorAll('.recharts-line')).toHaveLength(1)
  // Only the one month with a paid price has a bar.
  expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(1)
})

test('a year with no spot data says so', async () => {
  const { screen } = await renderWithProviders(
    <SpotComparisonChart months={Array.from({ length: 12 }, (_, i) => month(i + 1))} />,
  )
  await expect.element(screen.getByText(m.charging_economy_chart_no_data())).toBeVisible()
  expect(screen.container.querySelectorAll('.recharts-bar')).toHaveLength(0)
})

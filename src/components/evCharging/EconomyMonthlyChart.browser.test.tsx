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
    const legend = screen.container.querySelector('.recharts-legend-wrapper')?.textContent
    expect(legend).toContain(m.charging_economy_series_not_comparable())
  })
  expect(screen.container.querySelectorAll('.recharts-bar')).toHaveLength(4)
  // Three kronor bars for September + exactly one stub for March.
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(4),
  )
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
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(2),
  )
  expect(screen.getByText(m.charging_economy_chart_no_data()).elements()).toHaveLength(0)
  const plot = screen.container.querySelector('.recharts-surface')?.getBoundingClientRect()
  const rect = screen.container.querySelector('.recharts-bar-rectangle')?.getBoundingClientRect()
  expect(plot && rect && rect.height > 0 && rect.height < plot.height * 0.1).toBe(true)
  expect(
    screen.container.querySelectorAll('.recharts-cartesian-grid-horizontal line'),
  ).toHaveLength(0)
})

test('a year with no stub months has no stub series or legend entry', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() =>
    expect(screen.container.querySelector('.recharts-legend-wrapper')).not.toBeNull(),
  )
  expect(screen.container.querySelector('.recharts-legend-wrapper')?.textContent).not.toContain(
    m.charging_economy_series_not_comparable(),
  )
  expect(screen.container.querySelectorAll('.recharts-bar')).toHaveLength(3)
})

test('a year with nothing comparable says so instead of an empty 0 kr chart', async () => {
  const { screen } = await renderWithProviders(
    <EconomyMonthlyChart months={Array.from({ length: 12 }, (_, i) => month(i + 1))} />,
  )
  await expect.element(screen.getByText(m.charging_economy_chart_no_data())).toBeVisible()
  expect(screen.container.querySelectorAll('.recharts-bar')).toHaveLength(0)
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
  const hover = async (index: number) => {
    const rects = () => [...screen.container.querySelectorAll('.recharts-bar-rectangle')]
    await vi.waitFor(() => expect(rects().length).toBeGreaterThan(index))
    const box = rects()[index].getBoundingClientRect()
    rects()[index].dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      }),
    )
  }
  // Rectangles in DOM order: immediate, actual, optimal (Sep), then the stub (Mar).
  await hover(2)
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      m.charging_economy_tooltip_compared({ included: 2, sessions: 3 }),
    ),
  )
  await hover(3)
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
  const hover = async (index: number) => {
    const rects = () => [...screen.container.querySelectorAll('.recharts-bar-rectangle')]
    await vi.waitFor(() => expect(rects().length).toBeGreaterThan(index))
    const box = rects()[index].getBoundingClientRect()
    rects()[index].dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      }),
    )
  }
  const tooltip = () => document.querySelector('.recharts-tooltip-wrapper')?.textContent ?? ''
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(5),
  )
  // Hover each rectangle in turn until the tooltip shows the wanted stub reason.
  const reveal = async (text: string) => {
    let i = 0
    await vi.waitFor(async () => {
      if (!tooltip().includes(text)) await hover(i++ % 5)
      expect(tooltip()).toContain(text)
    })
  }
  await reveal(m.charging_chart_no_price())
  await reveal(m.charging_economy_series_not_comparable())
})

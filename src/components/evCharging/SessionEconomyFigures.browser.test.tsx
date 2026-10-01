import { expect, test } from 'vitest'
import { emptyTotals } from '~/lib/evCharging/cost'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { formatSek } from './format'
import { SessionEconomyFigures } from './SessionEconomyFigures'

type Economy = RouterOutputs['evCharging']['session']['economy']

const cost = (totalSek: number) => ({
  ...emptyTotals(),
  kwh: 10,
  gridKwh: 10,
  fullKwh: 10,
  totalSek,
})

// `over` may flip the economy to excluded (excluded + counterfactual: null
// together), which Partial<union> can't express, hence the cast.
const economy = (over: Partial<Economy> = {}) =>
  ({
    actual: cost(41.2),
    actualComplete: true,
    paidSpotOre: 40,
    windowAvgSpotOre: 55,
    excluded: null,
    counterfactual: {
      immediate: cost(53.6),
      optimal: cost(38),
      dearest: cost(70),
      score: 0.9,
      savedVsImmediateSek: 12.4,
      leftOnTableSek: 3.2,
    },
    ...over,
  }) as Economy

test('a comparable session shows its four figures', async () => {
  const { screen } = await renderWithProviders(<SessionEconomyFigures economy={economy()} />)
  for (const [label, value] of [
    [m.charging_session_fig_actual(), /41,20\s?kr/],
    [m.charging_session_fig_immediate(), /53,60\s?kr/],
    [m.charging_session_fig_optimal(), /38,00\s?kr/],
    [m.charging_session_fig_score(), /90\s?%/],
  ] as const) {
    await expect.element(screen.getByRole('group', { name: label })).toHaveTextContent(value)
  }
  expect(screen.getByText(m.charging_session_excluded_no_hourly()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_session_excluded_no_price()).elements()).toHaveLength(0)
})

test('a no_hourly session shows only its actual cost and the reason', async () => {
  const { screen } = await renderWithProviders(
    <SessionEconomyFigures economy={economy({ excluded: 'no_hourly', counterfactual: null })} />,
  )
  await expect.element(screen.getByText(m.charging_session_excluded_no_hourly())).toBeVisible()
  await expect.element(screen.getByText(/41,20/)).toBeVisible()
  expect(screen.getByText(m.charging_session_fig_immediate()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_session_fig_score()).elements()).toHaveLength(0)
})

test('an excluded no_price session with a complete actual shows the cost and the reason', async () => {
  const { screen } = await renderWithProviders(
    <SessionEconomyFigures economy={economy({ excluded: 'no_price', counterfactual: null })} />,
  )
  await expect.element(screen.getByText(/41,20/)).toBeVisible()
  await expect.element(screen.getByText(m.charging_session_excluded_no_price())).toBeVisible()
  expect(screen.getByText(m.charging_sessions_cost_unknown()).elements()).toHaveLength(0)
})

test('an estimated session marks its cost "≈" with the reason for screen readers', async () => {
  const { screen } = await renderWithProviders(
    <SessionEconomyFigures economy={economy()} estimated />,
  )
  const card = screen.getByRole('group', { name: m.charging_session_fig_actual() })
  await expect.element(card).toHaveTextContent(/≈\s41,20/)
  await expect.element(card).toHaveTextContent(m.charging_sessions_cost_estimated())
})

test('an exact session has no "≈"', async () => {
  const { screen } = await renderWithProviders(<SessionEconomyFigures economy={economy()} />)
  expect(screen.getByText(/≈/).elements()).toHaveLength(0)
})

test('a partial actual shows "—" with its reason, never the partial kronor', async () => {
  const { screen } = await renderWithProviders(
    <SessionEconomyFigures
      economy={economy({
        excluded: 'no_price',
        counterfactual: null,
        actualComplete: false,
        actual: cost(17.5),
      })}
    />,
  )
  await expect.element(screen.getByText(m.charging_session_excluded_no_price())).toBeVisible()
  await expect.element(screen.getByText(m.charging_sessions_cost_unknown())).toBeInTheDocument()
  expect(screen.getByText(/17,50/).elements()).toHaveLength(0)
})

test('a session with too little price spread shows "—" for timing, with its reason and the spread', async () => {
  const base = economy()
  const { screen } = await renderWithProviders(
    <SessionEconomyFigures
      economy={economy({
        actual: cost(38.02),
        counterfactual: base.counterfactual && {
          ...base.counterfactual,
          immediate: cost(38.03),
          dearest: cost(38.04),
          score: null,
        },
      })}
    />,
  )
  const reason = m.charging_economy_tile_no_spread({ spread: formatSek(0.04, 2) })
  expect(reason).toMatch(/0,04\s?kr/)
  // Said once, visibly, in place of the hint (not only for screen readers).
  await expect.element(screen.getByText(reason)).toBeVisible()
  expect(screen.getByText(reason).elements()).toHaveLength(1)
  expect(screen.getByText(m.charging_economy_tile_score_hint()).elements()).toHaveLength(0)
  expect(screen.getByText(/0\s?%/).elements()).toHaveLength(0)
})

test('the timing tile shows the spread and its scale on visible lines under the value', async () => {
  const { screen } = await renderWithProviders(<SessionEconomyFigures economy={economy()} />)
  const tile = screen.getByRole('group', { name: m.charging_session_fig_score() })
  // dearest 70 − optimal 38 = 32 kr to choose from.
  await expect
    .element(tile.getByText(m.charging_economy_score_spread({ spread: formatSek(32, 2) })))
    .toBeVisible()
  await expect.element(tile.getByText(m.charging_economy_tile_score_hint())).toBeVisible()
  expect(
    screen.getByText(m.charging_economy_tile_no_spread({ spread: formatSek(32, 2) })).elements(),
  ).toHaveLength(0)
})

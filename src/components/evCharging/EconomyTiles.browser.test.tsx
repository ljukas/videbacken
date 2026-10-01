import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EconomyTiles } from './EconomyTiles'
import { formatSek } from './format'

type Totals = RouterOutputs['evCharging']['economy']['tiles']
const base: Totals = {
  sessions: 3,
  included: 3,
  excluded: { noHourly: 0, noPrice: 0 },
  kwh: 60,
  actualSek: 90,
  immediateSek: 120,
  optimalSek: 70,
  dearestSek: 140,
  savedVsImmediateSek: 30,
  leftOnTableSek: 20,
  score: 0.714,
  paidSpotOre: 62.4,
  avgSpotOre: 80.2,
}

test('shows saved, left on the table, score and paid vs average spot', async () => {
  const { screen } = await renderWithProviders(<EconomyTiles tiles={base} />)
  await expect.element(screen.getByText(m.charging_economy_tile_saved())).toBeVisible()
  await expect.element(screen.getByText('30 kr')).toBeVisible()
  await expect.element(screen.getByText('20 kr')).toBeVisible()
  await expect.element(screen.getByText(/^71\s?%$/)).toBeVisible()
  // dearest 140 − optimal 70 = 70 kr to choose from, above the scale hint.
  await expect
    .element(screen.getByText(m.charging_economy_score_spread({ spread: formatSek(70, 2) })))
    .toBeVisible()
  await expect.element(screen.getByText(m.charging_economy_tile_score_hint())).toBeVisible()
  await expect.element(screen.getByText(m.charging_economy_ore({ value: '62' }))).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_economy_tile_spot_avg({ avg: '80' })))
    .toBeVisible()
})

test('a negative saving keeps its minus sign', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles tiles={{ ...base, savedVsImmediateSek: -12 }} />,
  )
  await expect.element(screen.getByText('−12 kr')).toBeVisible()
})

test('nothing included → "—" with the reason, never 0 kr or 0 %', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles
      tiles={{
        ...base,
        included: 0,
        excluded: { noHourly: 0, noPrice: 3 },
        actualSek: 0,
        immediateSek: 0,
        optimalSek: 0,
        dearestSek: 0,
        savedVsImmediateSek: 0,
        leftOnTableSek: 0,
        score: null,
        paidSpotOre: null,
      }}
    />,
  )
  expect(screen.getByText('0 kr').elements()).toHaveLength(0)
  expect(screen.getByText(/^0\s?%$/).elements()).toHaveLength(0)
  expect(screen.getByText('—').elements()).toHaveLength(4)
  expect(screen.getByText(m.charging_economy_tile_none()).elements().length).toBeGreaterThan(0)
})

test('too little price spread (score null, sessions included) says so with the spread, not "none" or 0 %', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles tiles={{ ...base, dearestSek: 70.04, score: null }} />,
  )
  expect(screen.getByText('—').elements()).toHaveLength(1)
  await expect
    .element(screen.getByText(m.charging_economy_tile_no_spread({ spread: formatSek(0.04, 2) })))
    .toBeVisible()
  expect(screen.getByText(m.charging_economy_tile_none()).elements()).toHaveLength(0)
  expect(screen.getByText(/^0\s?%$/).elements()).toHaveLength(0)
})

const nothing: Totals = {
  ...base,
  included: 0,
  actualSek: 0,
  immediateSek: 0,
  optimalSek: 0,
  dearestSek: 0,
  savedVsImmediateSek: 0,
  leftOnTableSek: 0,
  score: null,
  paidSpotOre: null,
}

test('all excluded for missing hourly data → says hourly data, not prices', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles tiles={{ ...nothing, excluded: { noHourly: 3, noPrice: 0 } }} />,
  )
  expect(screen.getByText(m.charging_economy_tile_none_hourly()).elements().length).toBeGreaterThan(
    0,
  )
  expect(screen.getByText(m.charging_economy_tile_none()).elements()).toHaveLength(0)
})

test('all excluded for mixed reasons → "no comparable sessions"', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles tiles={{ ...nothing, excluded: { noHourly: 1, noPrice: 2 } }} />,
  )
  expect(
    screen.getByText(m.charging_economy_tile_none_comparable()).elements().length,
  ).toBeGreaterThan(0)
  expect(screen.getByText(m.charging_economy_tile_none()).elements()).toHaveLength(0)
})

test('no average-spot hint without a paid price', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles tiles={{ ...base, paidSpotOre: null, avgSpotOre: 80.2 }} />,
  )
  await expect.element(screen.getByText(m.charging_economy_tile_spot())).toBeVisible()
  expect(screen.getByText(m.charging_economy_tile_spot_avg({ avg: '80' })).elements()).toHaveLength(
    0,
  )
})

test('a sub-1 öre paid price never reads as 0', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles tiles={{ ...base, paidSpotOre: 0.17 }} />,
  )
  await expect.element(screen.getByText(m.charging_economy_ore({ value: '0,17' }))).toBeVisible()
})

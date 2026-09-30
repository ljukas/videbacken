import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EconomyTiles } from './EconomyTiles'

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
  expect(screen.getByText(m.charging_economy_tile_none()).elements().length).toBeGreaterThan(0)
})

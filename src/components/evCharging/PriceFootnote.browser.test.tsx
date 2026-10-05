import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { formatDate } from './format'
import { PriceFootnote } from './PriceFootnote'

test('the overview says from when solar and battery count', async () => {
  const from = new Date('2026-01-20T06:00:00Z')
  const { screen } = await renderWithProviders(<PriceFootnote coverage={{ houseDataFrom: from }} />)
  await expect.element(screen.getByText(m.charging_cost_note())).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_cost_note_mix({ date: formatDate(from) })))
    .toBeVisible()
  await expect.element(screen.getByRole('link', { name: 'Elpriset just nu.se' })).toBeVisible()
})

test('without house data the overview says all charging counts as bought', async () => {
  const { screen } = await renderWithProviders(<PriceFootnote coverage={{ houseDataFrom: null }} />)
  await expect.element(screen.getByText(m.charging_cost_note_all_grid())).toBeVisible()
})

test('the economy views carry no coverage line', async () => {
  const { screen } = await renderWithProviders(<PriceFootnote />)
  expect(screen.getByText(/Sol och batteri räknas|All laddning räknas/).elements()).toHaveLength(0)
})

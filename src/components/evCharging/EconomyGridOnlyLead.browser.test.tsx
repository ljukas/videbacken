import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithRouter } from '~test/browser/render'
import { EconomyGridOnlyLead } from './EconomyGridOnlyLead'

test('says the economy counts all energy as bought, and links the cash cost', async () => {
  const { screen } = await renderWithRouter(<EconomyGridOnlyLead year={2026} vehicle={undefined} />)
  await expect
    .element(screen.getByText(m.charging_economy_grid_only_heading(), { exact: false }))
    .toBeVisible()
  const link = screen.getByRole('link', { name: m.charging_economy_grid_only_link() })
  await expect.element(link).toHaveAttribute('href', '/charging?year=2026')
})

test('the link keeps the vehicle scope, so the figures compare', async () => {
  const { screen } = await renderWithRouter(<EconomyGridOnlyLead year={2025} vehicle="other" />)
  await expect
    .element(screen.getByRole('link', { name: m.charging_economy_grid_only_link() }))
    .toHaveAttribute('href', '/charging?year=2025&vehicle=other')
})

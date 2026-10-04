import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EconomyGridOnlyLead } from './EconomyGridOnlyLead'

test('says the economy counts all energy as bought, and where the cash cost is', async () => {
  const { screen } = await renderWithProviders(<EconomyGridOnlyLead />)
  await expect
    .element(screen.getByText(m.charging_economy_grid_only_heading(), { exact: false }))
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_economy_grid_only_lead(), { exact: false }))
    .toBeVisible()
})

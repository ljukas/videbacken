import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithRouter } from '~test/browser/render'
import { CostNotice } from './CostNotice'

test('with no tariff, an admin is asked to add the fees and gets a link to the new-period dialog', async () => {
  const { screen } = await renderWithRouter(<CostNotice reason="noTariff" canAddTariff />)
  await expect.element(screen.getByText(m.charging_cost_notice_setup_admin())).toBeVisible()
  const link = screen.getByRole('link', { name: m.charging_cost_notice_setup_action() })
  await expect.element(link).toHaveAttribute('href', '/charging/settings?dialog=tariffNew')
  // AlertDescription underlines links; the settings link is button-styled.
  await expect.element(link).toHaveClass('no-underline!')
})

test('with no tariff, a member is told the cost comes once fees are added (no link)', async () => {
  const { screen } = await renderWithRouter(<CostNotice reason="noTariff" />)
  await expect.element(screen.getByText(m.charging_cost_notice_setup_member())).toBeVisible()
  expect(screen.getByRole('link').elements()).toHaveLength(0)
})

test('with tariffs but nothing priced, it says prices or fees are missing (no link)', async () => {
  const { screen } = await renderWithRouter(<CostNotice reason="unpriced" canAddTariff />)
  await expect.element(screen.getByText(m.charging_cost_notice_unpriced())).toBeVisible()
  expect(screen.getByRole('link').elements()).toHaveLength(0)
})

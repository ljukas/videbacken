import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders, renderWithRouter } from '~test/browser/render'
import { CostNotice } from './CostNotice'

test('with no tariff, an admin is asked to add the fees and gets a link to the new-period dialog', async () => {
  const { screen } = await renderWithRouter(<CostNotice reason="noTariff" canAddTariff />)
  await expect.element(screen.getByText(m.charging_cost_notice_setup_admin())).toBeVisible()
  await expect
    .element(screen.getByRole('link', { name: m.charging_cost_notice_setup_action() }))
    .toHaveAttribute('href', '/charging/settings?dialog=tariffNew')
})

test('with no tariff, a member is told the cost comes once fees are added (no button)', async () => {
  const { screen } = await renderWithProviders(<CostNotice reason="noTariff" />)
  await expect.element(screen.getByText(m.charging_cost_notice_setup_member())).toBeVisible()
  expect(screen.getByRole('button').elements()).toHaveLength(0)
})

test('with tariffs but nothing priced, it says prices or fees are missing (no link)', async () => {
  const { screen } = await renderWithRouter(<CostNotice reason="unpriced" canAddTariff />)
  await expect.element(screen.getByText(m.charging_cost_notice_unpriced())).toBeVisible()
  expect(screen.getByRole('link').elements()).toHaveLength(0)
})

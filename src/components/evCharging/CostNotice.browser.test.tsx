import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { CostNotice } from './CostNotice'

test('with no tariff, an admin is asked to add the fees and gets the button', async () => {
  const onAddTariff = vi.fn()
  const { screen } = await renderWithProviders(
    <CostNotice reason="noTariff" onAddTariff={onAddTariff} />,
  )
  await expect.element(screen.getByText(m.charging_cost_notice_setup_admin())).toBeVisible()
  await screen.getByRole('button', { name: m.charging_cost_notice_setup_action() }).click()
  expect(onAddTariff).toHaveBeenCalledOnce()
})

test('with no tariff, a member is told the cost comes once fees are added (no button)', async () => {
  const { screen } = await renderWithProviders(<CostNotice reason="noTariff" />)
  await expect.element(screen.getByText(m.charging_cost_notice_setup_member())).toBeVisible()
  expect(screen.getByRole('button').elements()).toHaveLength(0)
})

test('with tariffs but nothing priced, it says prices or fees are missing (no button)', async () => {
  const { screen } = await renderWithProviders(
    <CostNotice reason="unpriced" onAddTariff={() => {}} />,
  )
  await expect.element(screen.getByText(m.charging_cost_notice_unpriced())).toBeVisible()
  expect(screen.getByRole('button').elements()).toHaveLength(0)
})

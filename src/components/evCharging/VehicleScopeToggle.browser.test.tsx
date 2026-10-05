import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { VehicleScopeToggle } from './VehicleScopeToggle'

test('a visible label names the group, and Alla comes first', async () => {
  const { screen } = await renderWithProviders(
    <VehicleScopeToggle value="all" onChange={vi.fn()} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_scope_label())).toBeVisible()
  const group = screen.getByRole('radiogroup', { name: m.charging_vehicle_scope_label() })
  await expect.element(group).toBeVisible()
  const names = group
    .getByRole('radio')
    .elements()
    .map((el) => el.textContent)
  expect(names).toEqual([
    m.charging_vehicle_scope_all(),
    m.charging_vehicle_scope_ours(),
    m.charging_vehicle_scope_other(),
  ])
})

test('shows the active scope and reports a change', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleScopeToggle value="ours" onChange={onChange} />,
  )
  await expect
    .element(screen.getByRole('radio', { name: m.charging_vehicle_scope_ours() }))
    .toHaveAttribute('aria-checked', 'true')
  await screen.getByRole('radio', { name: m.charging_vehicle_scope_other() }).click()
  expect(onChange).toHaveBeenCalledWith('other')
})

test('re-pressing the active scope does not deselect it', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleScopeToggle value="all" onChange={onChange} />,
  )
  await screen.getByRole('radio', { name: m.charging_vehicle_scope_all() }).click()
  expect(onChange).not.toHaveBeenCalled()
})

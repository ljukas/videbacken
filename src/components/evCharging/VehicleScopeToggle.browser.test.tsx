import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { scopeNote, VehicleScopeToggle } from './VehicleScopeToggle'

test('shows the three scopes and reports a change', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleScopeToggle value="ours" onChange={onChange} />,
  )
  await expect
    .element(screen.getByRole('radio', { name: m.charging_vehicle_scope_ours() }))
    .toHaveAttribute('aria-checked', 'true')
  await expect
    .element(screen.getByRole('radio', { name: m.charging_vehicle_scope_all() }))
    .toBeVisible()
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

test('scopeNote names the filtered scopes and stays silent for all', () => {
  expect(scopeNote('ours')).toBe(m.charging_vehicle_note_ours())
  expect(scopeNote('other')).toBe(m.charging_vehicle_note_other())
  expect(scopeNote('all')).toBeUndefined()
})

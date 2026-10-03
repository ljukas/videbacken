import { beforeEach, expect, test, vi } from 'vitest'
import type { VehicleSource } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SessionVehicle } from './SessionVehicle'

// Mock the oRPC client so a save records its payload (or fails on demand);
// spreading `opts` keeps the component's own onSuccess/onError/onSettled.
const { setVehicleFn, toastMock } = vi.hoisted(() => ({
  setVehicleFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    evCharging: {
      setSessionVehicle: {
        mutationOptions: (opts: Record<string, unknown>) => ({ ...opts, mutationFn: setVehicleFn }),
      },
      key: () => ['evCharging'],
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const ID = '00000000-0000-4000-8000-000000000001'

beforeEach(() => {
  setVehicleFn.mockReset()
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

test('everyone sees who charged and why', async () => {
  const { screen } = await renderWithProviders(
    <SessionVehicle sessionId={ID} vehicle="ours" vehicleSource="skoda" isAdmin={false} />,
  )
  await expect
    .element(
      screen.getByText(`${m.charging_vehicle_ours()} · ${m.charging_vehicle_source_skoda()}`),
    )
    .toBeVisible()
  expect(screen.getByRole('combobox').query()).toBeNull()
})

test('an admin retags the session and gets a toast', async () => {
  setVehicleFn.mockResolvedValue({ vehicle: 'other', vehicleSource: 'admin' })
  const { screen } = await renderWithProviders(
    <SessionVehicle sessionId={ID} vehicle="ours" vehicleSource="default" isAdmin />,
  )
  await screen.getByRole('combobox', { name: m.charging_vehicle_who_label() }).click()
  await screen.getByRole('option', { name: m.charging_vehicle_other() }).click()
  await vi.waitFor(() =>
    expect(setVehicleFn).toHaveBeenCalledWith(
      { sessionId: ID, vehicle: 'other' },
      expect.anything(),
    ),
  )
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(m.charging_vehicle_saved()))
})

test('Automatiskt sends null; a failure shows the error toast and keeps the saved value', async () => {
  setVehicleFn.mockRejectedValue(new Error('down'))
  const { screen } = await renderWithProviders(
    <SessionVehicle sessionId={ID} vehicle="other" vehicleSource="admin" isAdmin />,
  )
  const trigger = screen.getByRole('combobox', { name: m.charging_vehicle_who_label() })
  await trigger.click()
  await screen.getByRole('option', { name: m.charging_vehicle_auto() }).click()
  await vi.waitFor(() =>
    expect(setVehicleFn).toHaveBeenCalledWith({ sessionId: ID, vehicle: null }, expect.anything()),
  )
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_vehicle_save_error()),
  )
  // Nothing was saved, so the select still shows the stored tag, not "Automatiskt".
  await expect.element(trigger).toHaveTextContent(m.charging_vehicle_other())
  await expect.element(trigger).not.toHaveTextContent(m.charging_vehicle_auto())
})

test('while saving, focus stays on the trigger and a second choice is ignored', async () => {
  setVehicleFn.mockReturnValue(new Promise(() => {}))
  const { screen } = await renderWithProviders(
    <SessionVehicle sessionId={ID} vehicle="ours" vehicleSource="default" isAdmin />,
  )
  const trigger = screen.getByRole('combobox', { name: m.charging_vehicle_who_label() })
  await trigger.click()
  await screen.getByRole('option', { name: m.charging_vehicle_other() }).click()
  await vi.waitFor(() => expect(setVehicleFn).toHaveBeenCalledTimes(1))
  await expect.element(trigger).toHaveAttribute('aria-disabled', 'true')
  await expect.poll(() => document.activeElement === trigger.element()).toBe(true)
  // aria-disabled isn't native, so the menu still opens; the choice must be ignored.
  await trigger.click({ force: true })
  await screen.getByRole('option', { name: m.charging_vehicle_auto() }).click()
  expect(setVehicleFn).toHaveBeenCalledTimes(1)
})

test('while saving the select shows the chosen value, not the stale stored one', async () => {
  setVehicleFn.mockReturnValue(new Promise(() => {}))
  const { screen } = await renderWithProviders(
    <SessionVehicle sessionId={ID} vehicle="ours" vehicleSource="default" isAdmin />,
  )
  const trigger = screen.getByRole('combobox', { name: m.charging_vehicle_who_label() })
  await expect.element(trigger).toHaveTextContent(m.charging_vehicle_auto())
  await trigger.click()
  await screen.getByRole('option', { name: m.charging_vehicle_other() }).click()
  await vi.waitFor(() => expect(setVehicleFn).toHaveBeenCalled())
  await expect.element(trigger).toHaveTextContent(m.charging_vehicle_other())
  await expect.element(trigger).not.toHaveTextContent(m.charging_vehicle_auto())
})

test('a live-state attribution says it came from the car', async () => {
  const { screen } = await renderWithProviders(
    <SessionVehicle sessionId={ID} vehicle="other" vehicleSource="skoda_live" isAdmin={false} />,
  )
  await expect
    .element(
      screen.getByText(`${m.charging_vehicle_other()} · ${m.charging_vehicle_source_skoda_live()}`),
    )
    .toBeVisible()
})

test('a source this build does not know shows just the vehicle', async () => {
  const { screen } = await renderWithProviders(
    <SessionVehicle
      sessionId={ID}
      vehicle="ours"
      vehicleSource={'future_source' as unknown as VehicleSource}
      isAdmin={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_ours(), { exact: true })).toBeVisible()
})

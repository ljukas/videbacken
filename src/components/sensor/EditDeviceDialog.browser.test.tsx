import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EditDeviceDialog } from './EditDeviceDialog'

// Mock the oRPC client so submitting records the mutation payload instead of
// hitting the network (same idiom as LoginFormCard.browser.test.tsx). Spreading
// `opts` preserves the component's onSuccess/onError so useMutation still runs
// them; mutationFn just captures the call.
const { renameFn } = vi.hoisted(() => ({ renameFn: vi.fn() }))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    sensor: {
      renameDevice: {
        mutationOptions: (opts: Record<string, unknown>) => ({
          ...opts,
          mutationFn: async (vars: unknown) => {
            renameFn(vars)
          },
        }),
      },
      key: () => ['sensor'],
    },
  },
}))

test('prefills the form with the device name and location', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={{ id: 'a', name: 'Kitchen', location: 'Upstairs' }}
      onOpenChange={() => {}}
    />,
  )
  await expect.element(screen.getByLabelText(m.sensors_field_name())).toHaveValue('Kitchen')
  await expect.element(screen.getByLabelText(m.sensors_field_location())).toHaveValue('Upstairs')
})

test('renders blank fields when the device has no name/location', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={{ id: 'a', name: null, location: null }}
      onOpenChange={() => {}}
    />,
  )
  await expect.element(screen.getByLabelText(m.sensors_field_name())).toHaveValue('')
  await expect.element(screen.getByLabelText(m.sensors_field_location())).toHaveValue('')
})

test('submits the entered name/location and closes immediately', async () => {
  const onOpenChange = vi.fn()
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={{ id: 'a', name: 'Old', location: 'Old loc' }}
      onOpenChange={onOpenChange}
    />,
  )
  await screen.getByLabelText(m.sensors_field_name()).fill('New name')
  await screen.getByRole('button', { name: m.common_save() }).click()

  await vi.waitFor(() =>
    expect(renameFn).toHaveBeenCalledWith({ id: 'a', name: 'New name', location: 'Old loc' }),
  )
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('a blank name submits as empty (server clears it to the fallback)', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={{ id: 'a', name: 'Old', location: null }}
      onOpenChange={() => {}}
    />,
  )
  await screen.getByLabelText(m.sensors_field_name()).clear()
  await screen.getByRole('button', { name: m.common_save() }).click()

  await vi.waitFor(() => expect(renameFn).toHaveBeenCalledWith({ id: 'a', name: '', location: '' }))
})

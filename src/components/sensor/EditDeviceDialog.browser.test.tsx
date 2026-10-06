import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type EditableDevice, EditDeviceDialog } from './EditDeviceDialog'

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

const device = (over: Partial<EditableDevice> = {}): EditableDevice => ({
  id: 'a',
  name: null,
  location: null,
  mac: 'aabbccddeeff',
  shellyName: null,
  ...over,
})

test('prefills the form with the device name and location', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={device({ name: 'Kitchen', location: 'Upstairs' })}
      onOpenChange={() => {}}
    />,
  )
  await expect
    .element(screen.getByLabelText(m.sensors_field_name(), { exact: true }))
    .toHaveValue('Kitchen')
  await expect.element(screen.getByLabelText(m.sensors_field_location())).toHaveValue('Upstairs')
})

test('renders blank fields when the device has no name/location', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={device({ name: null, location: null })}
      onOpenChange={() => {}}
    />,
  )
  await expect
    .element(screen.getByLabelText(m.sensors_field_name(), { exact: true }))
    .toHaveValue('')
  await expect.element(screen.getByLabelText(m.sensors_field_location())).toHaveValue('')
})

test('submits the entered name/location and closes immediately', async () => {
  const onOpenChange = vi.fn()
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={device({ name: 'Old', location: 'Old loc' })}
      onOpenChange={onOpenChange}
    />,
  )
  await screen.getByLabelText(m.sensors_field_name(), { exact: true }).fill('New name')
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
      device={device({ name: 'Old', location: null })}
      onOpenChange={() => {}}
    />,
  )
  await screen.getByLabelText(m.sensors_field_name(), { exact: true }).clear()
  await screen.getByRole('button', { name: m.common_save() }).click()

  await vi.waitFor(() => expect(renameFn).toHaveBeenCalledWith({ id: 'a', name: '', location: '' }))
})

test('the Enhet box shows the Shelly name and the MAC as the Shelly app shows it', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ shellyName: 'Källare NV' })} onOpenChange={() => {}} />,
  )
  await expect.element(screen.getByText('Källare NV', { exact: true })).toBeVisible()
  await expect.element(screen.getByText('AA:BB:CC:DD:EE:FF')).toBeVisible()
  expect(screen.getByText(m.sensors_identity_shelly_name_missing()).elements()).toHaveLength(0)
})

test('without a Shelly name the box says it has not been sent and how to get it', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device()} onOpenChange={() => {}} />,
  )
  await expect.element(screen.getByText(m.sensors_identity_shelly_name_missing())).toBeVisible()
  await expect.element(screen.getByText(m.sensors_identity_shelly_name_hint())).toBeVisible()
})

test('the badge follows the field: own name, then the Shelly name, then the default', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={device({ name: 'Under köket', shellyName: 'Källare NV' })}
      onOpenChange={() => {}}
    />,
  )
  const input = screen.getByLabelText(m.sensors_field_name(), { exact: true })
  await expect.element(screen.getByText(m.sensors_name_badge_own())).toBeVisible()
  await input.clear()
  await expect.element(screen.getByText(m.sensors_name_badge_shelly())).toBeVisible()
  // Spaces only clear the name server-side, so they count as empty here too.
  await input.fill('   ')
  await expect.element(screen.getByText(m.sensors_name_badge_shelly())).toBeVisible()
  expect(
    screen.getByRole('button', { name: m.sensors_name_reset_label() }).elements(),
  ).toHaveLength(0)
})

test('a device that was never named opens on the Shelly name: badge, placeholder and helper', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ shellyName: 'Källare NV' })} onOpenChange={() => {}} />,
  )
  const input = screen.getByLabelText(m.sensors_field_name(), { exact: true })
  await expect.element(screen.getByText(m.sensors_name_badge_shelly())).toBeVisible()
  await expect.element(input).toHaveAttribute('placeholder', 'Källare NV')
  await expect
    .element(screen.getByText(m.sensors_name_hint({ fallback: 'Källare NV' })))
    .toBeVisible()
})

test('with no Shelly name an empty field shows the default badge, placeholder and helper', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device()} onOpenChange={() => {}} />,
  )
  const input = screen.getByLabelText(m.sensors_field_name(), { exact: true })
  await expect.element(screen.getByText(m.sensors_name_badge_default())).toBeVisible()
  await expect.element(input).toHaveAttribute('placeholder', 'Sensor eeff')
  await expect
    .element(screen.getByText(m.sensors_name_hint({ fallback: 'Sensor eeff' })))
    .toBeVisible()
})

test('Återställ empties the field, focuses it and goes away; the helper names the Shelly name', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={device({ name: 'Källare NV', shellyName: 'Källare NV' })}
      onOpenChange={() => {}}
    />,
  )
  const input = screen.getByLabelText(m.sensors_field_name(), { exact: true })
  await expect.element(screen.getByText(m.sensors_name_badge_own())).toBeVisible()
  await screen.getByRole('button', { name: m.sensors_name_reset_label() }).click()
  await expect.element(input).toHaveValue('')
  await expect.element(input).toHaveFocus()
  await expect.element(input).toHaveAttribute('placeholder', 'Källare NV')
  await expect.element(screen.getByText(m.sensors_name_badge_shelly())).toBeVisible()
  await expect
    .element(screen.getByText(m.sensors_name_hint({ fallback: 'Källare NV' })))
    .toBeVisible()
  expect(
    screen.getByRole('button', { name: m.sensors_name_reset_label() }).elements(),
  ).toHaveLength(0)
})

test('no Återställ while the field is empty', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ shellyName: 'Källare NV' })} onOpenChange={() => {}} />,
  )
  await expect.element(screen.getByLabelText(m.sensors_field_name(), { exact: true })).toBeVisible()
  expect(
    screen.getByRole('button', { name: m.sensors_name_reset_label() }).elements(),
  ).toHaveLength(0)
})

test('Avbryt after Återställ saves nothing', async () => {
  const onOpenChange = vi.fn()
  renameFn.mockClear()
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ name: 'Old' })} onOpenChange={onOpenChange} />,
  )
  await screen.getByRole('button', { name: m.sensors_name_reset_label() }).click()
  await screen.getByRole('button', { name: m.common_cancel() }).click()
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(renameFn).not.toHaveBeenCalled()
})

test('Återställ then Spara submits an empty name', async () => {
  renameFn.mockClear()
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ name: 'Old' })} onOpenChange={() => {}} />,
  )
  await screen.getByRole('button', { name: m.sensors_name_reset_label() }).click()
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() => expect(renameFn).toHaveBeenCalledWith({ id: 'a', name: '', location: '' }))
})

test('the name input has focus when the dialog opens, even with Återställ before it', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ name: 'Old' })} onOpenChange={() => {}} />,
  )
  await expect.element(screen.getByLabelText(m.sensors_field_name(), { exact: true })).toHaveFocus()
})

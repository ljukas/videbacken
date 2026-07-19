import { expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { CurrentReadingTiles } from './CurrentReadingTiles'

type Device = RouterOutputs['sensor']['listDevices'][number]

const device: Device = {
  id: 'a',
  mac: 'a4cf12ab34cd',
  name: null,
  location: null,
  displayName: 'Sensor 34cd',
  batteryPct: 88,
  lastSeenAt: new Date(),
  latest: { temperatureC: 21.7, humidityPct: 46, recordedAt: new Date() },
}

test('shows the latest reading and an admin-only edit button', async () => {
  const onEdit = vi.fn()
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles devices={[device]} isAdmin onEdit={onEdit} />,
  )
  await expect.element(screen.getByText('21.7°C')).toBeVisible()
  await expect.element(screen.getByText('46%')).toBeVisible()

  await screen.getByRole('button', { name: m.sensors_edit_device() }).click()
  expect(onEdit).toHaveBeenCalledWith('a')
})

test('renders an em-dash when a device has no reading yet', async () => {
  const noReading: Device = { ...device, latest: null }
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles devices={[noReading]} isAdmin={false} onEdit={() => {}} />,
  )
  await expect.element(screen.getByText('—').first()).toBeVisible()
  // No edit button for a non-admin.
  expect(screen.getByRole('button', { name: m.sensors_edit_device() }).elements()).toHaveLength(0)
})

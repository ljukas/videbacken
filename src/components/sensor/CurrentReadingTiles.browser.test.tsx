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
  shellyName: null,
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

  await screen
    .getByRole('button', { name: m.sensors_edit_device_named({ name: 'Sensor 34cd' }) })
    .click()
  expect(onEdit).toHaveBeenCalledWith('a')
})

test('shows the battery percentage and last-seen line', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles devices={[device]} isAdmin={false} onEdit={() => {}} />,
  )
  // Battery + last-seen share one line joined by " · "; match the battery part.
  await expect
    .element(screen.getByText(m.sensors_battery({ pct: 88 }), { exact: false }))
    .toBeVisible()
})

test('renders an em-dash when a device has no reading yet', async () => {
  const noReading: Device = { ...device, latest: null }
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles devices={[noReading]} isAdmin={false} onEdit={() => {}} />,
  )
  await expect.element(screen.getByText('—').first()).toBeVisible()
  // No edit button for a non-admin.
  expect(
    screen
      .getByRole('button', { name: m.sensors_edit_device_named({ name: 'Sensor 34cd' }) })
      .elements(),
  ).toHaveLength(0)
})

test('shows each sensor’s location under its name', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[{ ...device, displayName: 'NV', location: 'Under köket' }]}
      isAdmin={false}
      onEdit={() => {}}
    />,
  )
  await expect.element(screen.getByText('Under köket')).toBeVisible()
})

test('a sensor without a location keeps the line when another has one, so figures line up', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[
        { ...device, id: 'a', displayName: 'NV', location: 'Under köket' },
        { ...device, id: 'b', displayName: 'SÖ', location: null },
      ]}
      isAdmin={false}
      onEdit={() => {}}
    />,
  )
  await expect.element(screen.getByText('Under köket')).toBeVisible()
  expect(document.querySelectorAll('[data-slot="sensor-location"]')).toHaveLength(2)
})

test('with no locations at all there is no location line', async () => {
  await renderWithProviders(
    <CurrentReadingTiles devices={[device]} isAdmin={false} onEdit={() => {}} />,
  )
  expect(document.querySelectorAll('[data-slot="sensor-location"]')).toHaveLength(0)
})

test('the readable sizes: 16 px name that truncates, 14 px detail, a 40 px edit button', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles devices={[device]} isAdmin onEdit={() => {}} />,
  )
  const name = screen.getByRole('heading', { name: 'Sensor 34cd' })
  await expect.element(name).toBeVisible()
  expect(name.element().className).toContain('text-base')
  expect(name.element().className).toContain('truncate')
  const edit = screen.getByRole('button', {
    name: m.sensors_edit_device_named({ name: 'Sensor 34cd' }),
  })
  expect(edit.element().className).toContain('size-10')
  // No 12 px text left in a tile (browser tests have no app.css: classes, not pixels).
  expect(document.querySelector('li .text-xs')).toBeNull()
})

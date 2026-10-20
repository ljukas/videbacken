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
    <CurrentReadingTiles
      devices={[device]}
      isAdmin
      onEdit={onEdit}
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
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
    <CurrentReadingTiles
      devices={[device]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  // Battery + last-seen share one line joined by " · "; match the battery part.
  await expect
    .element(screen.getByText(m.sensors_battery({ pct: 88 }), { exact: false }))
    .toBeVisible()
})

test('renders an em-dash when a device has no reading yet', async () => {
  const noReading: Device = { ...device, latest: null }
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[noReading]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
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
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  await expect.element(screen.getByText('Under köket')).toBeVisible()
})

test('only the name shares its row with the buttons; the location spans the tile below', async () => {
  await renderWithProviders(
    <CurrentReadingTiles
      devices={[{ ...device, displayName: 'NV', location: 'Krypgrunden under köket' }]}
      isAdmin
      onEdit={() => {}}
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  const location = document.querySelector('[data-slot="sensor-location"]')
  const name = document.querySelector('li h3')
  const edit = document.querySelector(
    `button[aria-label="${m.sensors_edit_device_named({ name: 'NV' })}"]`,
  )
  const row = name?.closest('[data-slot="sensor-tile-header"]')
  expect(row).not.toBeNull()
  expect(row?.contains(edit ?? null)).toBe(true)
  expect(row?.contains(location)).toBe(false)
  // A direct child of the tile: the full width, not a column beside the buttons.
  expect(location?.parentElement?.tagName).toBe('LI')
  expect(location?.className).toContain('truncate')
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
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  await expect.element(screen.getByText('Under köket')).toBeVisible()
  expect(document.querySelectorAll('[data-slot="sensor-location"]')).toHaveLength(2)
})

test('with no locations at all there is no location line', async () => {
  await renderWithProviders(
    <CurrentReadingTiles
      devices={[device]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  expect(document.querySelectorAll('[data-slot="sensor-location"]')).toHaveLength(0)
})

test('the readable sizes: 16 px name that wraps to two lines, 14 px detail, 40 px buttons', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[device]}
      isAdmin
      onEdit={() => {}}
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  const name = screen.getByRole('heading', { name: 'Sensor 34cd' })
  await expect.element(name).toBeVisible()
  expect(name.element().className).toContain('text-base')
  // Two buttons leave a phone tile little room: the name wraps (two lines) instead of
  // collapsing into an ellipsis.
  expect(name.element().className).toContain('line-clamp-2')
  expect(name.element().className).not.toContain('truncate')
  const edit = screen.getByRole('button', {
    name: m.sensors_edit_device_named({ name: 'Sensor 34cd' }),
  })
  const bell = screen.getByRole('button', {
    name: m.sensors_alerts_open_named({ name: 'Sensor 34cd' }),
  })
  expect(edit.element().className).toContain('size-10')
  expect(bell.element().className).toContain('size-10')
  // The group, not a button, pulls into the tile's padding, so both buttons line up.
  expect(edit.element().className).not.toMatch(/-m[tr]-/)
  expect(bell.element().className).not.toMatch(/-m[tr]-/)
  expect(edit.element().parentElement?.className).toContain('-mt-2')
  expect(edit.element().parentElement?.className).toContain('-mr-2')
  // No 12 px text left in a tile (browser tests have no app.css: classes, not pixels).
  expect(document.querySelector('li .text-xs')).toBeNull()
})

test('four columns only once the tiles themselves have room, not from a viewport width', async () => {
  await renderWithProviders(
    <CurrentReadingTiles
      devices={[device]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  // With the sidebar open, a tablet viewport leaves ~67 px per tile in four
  // columns: the 30 px temperature overflows. The tiles' own width decides
  // (container query), so two columns until each tile fits its figure.
  const list = document.querySelector('ul')
  // One column on the narrowest phones (a 320 px viewport leaves a ~256 px card), two from a
  // 19rem container, four from @2xl.
  expect(list?.className.split(' ')).toContain('grid-cols-1')
  expect(list?.className.split(' ')).not.toContain('grid-cols-2')
  expect(list?.className).toContain('@[19rem]:grid-cols-2')
  expect(list?.className).toContain('@2xl:grid-cols-4')
  expect(list?.className).not.toContain('@xl:grid-cols-4')
  expect(list?.className).not.toContain('md:grid-cols-4')
  expect(list?.parentElement?.className).toContain('@container')
})

const bellName = (name: string) => m.sensors_alerts_open_named({ name })

test('every signed-in user gets the alerts bell, and it opens that sensor', async () => {
  const onOpenAlerts = vi.fn()
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[{ ...device, displayName: 'Förråd' }]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{}}
      firingCounts={{}}
      onOpenAlerts={onOpenAlerts}
    />,
  )
  await screen.getByRole('button', { name: bellName('Förråd') }).click()
  expect(onOpenAlerts).toHaveBeenCalledWith('a')
  // No badge without switched-on rules.
  expect(document.querySelector('[data-slot="badge"]')).toBeNull()
})

test('a count shows a badge and is part of the bell label', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[{ ...device, displayName: 'Förråd' }]}
      isAdmin
      onEdit={() => {}}
      alertCounts={{ a: 2 }}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  const bell = screen.getByRole('button', {
    name: m.sensors_alerts_open_named_count({ name: 'Förråd', count: 2 }),
  })
  await expect.element(bell).toBeVisible()
  expect(document.querySelector('[data-slot="badge"]')?.textContent).toBe('2')
  // The edit button stays alongside.
  await expect
    .element(screen.getByRole('button', { name: m.sensors_edit_device_named({ name: 'Förråd' }) }))
    .toBeVisible()
})

test('a count of 0 shows no badge and the plain bell label', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[{ ...device, displayName: 'Förråd' }]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{ a: 0 }}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  await expect.element(screen.getByRole('button', { name: bellName('Förråd') })).toBeVisible()
  expect(document.querySelector('[data-slot="badge"]')).toBeNull()
})

test('the badge sits tight in its 16 px pill, so the 14 px number isn’t clipped', async () => {
  await renderWithProviders(
    <CurrentReadingTiles
      devices={[device]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{ a: 3 }}
      firingCounts={{}}
      onOpenAlerts={() => {}}
    />,
  )
  const badge = document.querySelector('[data-slot="badge"]')
  // twMerge keeps the last padding: py-0, never the base's py-0.5.
  expect(badge?.className.split(' ')).toContain('py-0')
  expect(badge?.className.split(' ')).not.toContain('py-0.5')
  expect(badge?.className).toContain('leading-none')
})

test('a firing rule turns the bell red: the firing count on a destructive badge, in the label', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[{ ...device, displayName: 'Förråd' }]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{ a: 3 }}
      firingCounts={{ a: 1 }}
      onOpenAlerts={() => {}}
    />,
  )
  const bell = screen.getByRole('button', { name: 'Larm för Förråd, 1 larmar nu' })
  await expect.element(bell).toBeVisible()
  expect(bell.element().className).toContain('text-destructive')
  // The firing count, not the switched-on one.
  const badge = document.querySelector('[data-slot="badge"]')
  expect(badge?.textContent).toBe('1')
  expect(badge?.getAttribute('data-variant')).toBe('destructive')
  expect(document.querySelector('li')?.className).toContain('border-destructive')
})

test('nothing firing: a neutral bell and tile', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[{ ...device, displayName: 'Förråd' }]}
      isAdmin={false}
      onEdit={() => {}}
      alertCounts={{ a: 2 }}
      firingCounts={{ a: 0 }}
      onOpenAlerts={() => {}}
    />,
  )
  const bell = screen.getByRole('button', {
    name: m.sensors_alerts_open_named_count({ name: 'Förråd', count: 2 }),
  })
  await expect.element(bell).toBeVisible()
  expect(bell.element().className).not.toContain('text-destructive')
  expect(document.querySelector('[data-slot="badge"]')?.getAttribute('data-variant')).toBe(
    'secondary',
  )
  expect(document.querySelector('li')?.className).not.toContain('border-destructive')
})

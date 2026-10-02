import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { VehicleLogCard } from './VehicleLogCard'

test('shows the count and the covered dates', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard
      coverage={{
        from: new Date('2025-10-10T10:00:00Z'),
        to: new Date('2026-09-29T10:00:00Z'),
        count: 95,
      }}
      onImport={() => {}}
    />,
  )
  await expect.element(screen.getByText(/Laddlogg: 95 laddningar/)).toBeVisible()
  await expect.element(screen.getByText(/10 okt\.? 2025/)).toBeVisible()
  await expect.element(screen.getByText(/29 sep\.? 2026/)).toBeVisible()
})

test('says so when no log is imported', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard coverage={null} onImport={() => {}} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_log_none())).toBeVisible()
})

test('the import button calls onImport', async () => {
  const onImport = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleLogCard coverage={null} onImport={onImport} />,
  )
  await screen.getByRole('button', { name: m.charging_vehicle_import_button() }).click()
  expect(onImport).toHaveBeenCalledOnce()
})

test('a failed coverage read shows an error with retry, never "none imported"', async () => {
  const refetch = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleLogCard
      coverage={undefined}
      loadError={{
        data: undefined,
        isPlaceholderData: false,
        errorUpdateCount: 1,
        isFetching: false,
        refetch,
      }}
      onImport={() => {}}
    />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_log_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_log_none()).elements()).toHaveLength(0)
  await screen.getByRole('button', { name: m.common_try_again() }).click()
  expect(refetch).toHaveBeenCalled()
})

test('shows the last contact with the car as a <time>', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard
      coverage={null}
      live={{
        polledAt: new Date('2026-05-04T09:08:13Z'),
        capturedAt: new Date('2026-05-04T09:08:10Z'),
      }}
      onImport={() => {}}
    />,
  )
  await expect
    .element(screen.getByText(m.charging_vehicle_live_last_contact(), { exact: false }))
    .toBeVisible()
  await expect.element(screen.getByText(/11:08/)).toBeVisible()
  expect(screen.container.querySelector('time')?.getAttribute('datetime')).toBe(
    '2026-05-04T09:08:10.000Z',
  )
})

test('says there has been no contact yet', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard coverage={null} live={null} onImport={() => {}} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_live_none())).toBeVisible()
})

test('a failed last-contact read shows its error, never "no contact yet"', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard
      coverage={null}
      live={undefined}
      liveLoadError={{
        data: undefined,
        isPlaceholderData: false,
        errorUpdateCount: 1,
        isFetching: false,
        refetch: vi.fn(),
      }}
      onImport={() => {}}
      onSyncLive={() => {}}
    />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_live_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_live_none()).elements()).toHaveLength(0)
})

test('an unknown last contact renders neither the row nor the button', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard coverage={null} live={undefined} onImport={() => {}} onSyncLive={() => {}} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_log_none())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_live_none()).elements()).toHaveLength(0)
  expect(
    screen.getByText(m.charging_vehicle_live_last_contact(), { exact: false }).elements(),
  ).toHaveLength(0)
  expect(screen.getByRole('button', { name: m.charging_sync_skoda_now() }).elements()).toHaveLength(
    0,
  )
})

test('the card fetches the car status with its own labelled button', async () => {
  const onSyncLive = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleLogCard
      coverage={null}
      live={null}
      onImport={() => {}}
      onSyncLive={onSyncLive}
      syncingLive={false}
    />,
  )
  await screen.getByRole('button', { name: m.charging_sync_skoda_now() }).click()
  expect(onSyncLive).toHaveBeenCalledOnce()
})

test('shows until when the Škoda key is valid', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard
      coverage={null}
      live={null}
      keyExpiresAt={new Date('2099-01-15T12:00:00.500Z')}
      onImport={() => {}}
    />,
  )
  await expect.element(screen.getByText(/Nyckeln går ut den 15 jan\. 2099/)).toBeVisible()
})

test('no key expiry renders no expiry line', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard coverage={null} live={null} onImport={() => {}} />,
  )
  expect(screen.getByText(/Nyckeln/).elements()).toHaveLength(0)
})

test('a past key expiry says the key expired', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard
      coverage={null}
      live={null}
      keyExpiresAt={new Date('2020-01-15T12:00:00.500Z')}
      onImport={() => {}}
    />,
  )
  await expect.element(screen.getByText(/Nyckeln gick ut den 15 jan\. 2020/)).toBeVisible()
})

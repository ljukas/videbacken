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
  await expect.element(screen.getByText(/95 laddningar/)).toBeVisible()
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

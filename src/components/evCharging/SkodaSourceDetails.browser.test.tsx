import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SkodaSourceDetails, VehicleLogImportButton } from './SkodaSourceDetails'

const failed = (refetch = vi.fn()) => ({
  data: undefined,
  isPlaceholderData: false,
  errorUpdateCount: 1,
  isFetching: false,
  refetch,
})

test('shows the log’s count and how far it reaches', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails
      live={undefined}
      coverage={{
        from: new Date('2025-10-10T10:00:00Z'),
        to: new Date('2026-09-29T10:00:00Z'),
        count: 95,
      }}
    />,
  )
  await expect
    .element(screen.getByText(/^Laddlogg: 95 laddningar t\.o\.m\. 29 sep\.? 2026$/))
    .toBeVisible()
})

test('one logged session is singular', async () => {
  const at = new Date('2026-09-29T10:00:00Z')
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={undefined} coverage={{ from: at, to: at, count: 1 }} />,
  )
  await expect.element(screen.getByText(/^Laddlogg: 1 laddning t\.o\.m\./)).toBeVisible()
})

test('says so when no log is imported', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={undefined} coverage={null} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_log_none())).toBeVisible()
})

test('a failed log read shows an error with retry, never "none imported"', async () => {
  const refetch = vi.fn()
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={undefined} coverage={undefined} coverageQuery={failed(refetch)} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_log_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_log_none()).elements()).toHaveLength(0)
  await screen.getByRole('button', { name: m.common_try_again(), exact: false }).click()
  expect(refetch).toHaveBeenCalled()
})

test('shows when the car last reported, relative and exact, as a <time>', async () => {
  const capturedAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={{ polledAt: new Date(), capturedAt }} coverage={undefined} />,
  )
  // The exact time is visible text, not a hover-only title (touch never shows those).
  await expect
    .element(screen.getByText(/^Bilen hörde av sig tre timmar sedan · \d{1,2} \w+\.? \d{2}:\d{2}$/))
    .toBeVisible()
  // The car's own timestamp, not the poll's: a poll can succeed while the car sleeps.
  expect(screen.container.querySelector('time')?.getAttribute('datetime')).toBe(
    capturedAt.toISOString(),
  )
})

test('falls back to the poll time when the car sent no timestamp', async () => {
  const polledAt = new Date('2026-05-04T09:08:13Z')
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={{ polledAt, capturedAt: null }} coverage={undefined} />,
  )
  expect(screen.container.querySelector('time')?.getAttribute('datetime')).toBe(
    polledAt.toISOString(),
  )
})

test('says there has been no contact yet', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={null} coverage={undefined} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_live_none())).toBeVisible()
})

test('a failed last-contact read shows its error, never "no contact yet"', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={undefined} liveQuery={failed()} coverage={undefined} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_live_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_live_none()).elements()).toHaveLength(0)
})

test('an unknown last contact and log render no lines', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={undefined} coverage={undefined} />,
  )
  // No lines: the wrapper stays empty, so `empty:hidden` drops its hairline.
  expect(screen.container.querySelector('.border-t')?.childNodes).toHaveLength(0)
})

test('two failed reads each name which one their retry is for', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails
      live={undefined}
      liveQuery={failed()}
      coverage={undefined}
      coverageQuery={failed()}
    />,
  )
  const retry = (title: string) =>
    screen.getByRole('button', {
      name: m.charging_source_action_label({ action: m.common_try_again(), source: title }),
    })
  await expect.element(retry(m.charging_vehicle_live_error_title())).toBeVisible()
  await expect.element(retry(m.charging_vehicle_log_error_title())).toBeVisible()
})

test('shows until when the Škoda key is valid, as the server decided', async () => {
  // The server's `expired` flag decides, not the browser clock: a date already
  // past here still reads "expires" when the server said it hadn't.
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails
      live={null}
      coverage={null}
      keyExpiry={{ expiresAt: new Date('2020-01-15T12:00:00.500Z'), expired: false }}
    />,
  )
  await expect.element(screen.getByText(/Nyckeln går ut den 15 jan\. 2020/)).toBeVisible()
})

test('no key expiry renders no expiry line', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails live={null} coverage={null} keyExpiry={null} />,
  )
  expect(screen.getByText(/Nyckeln/).elements()).toHaveLength(0)
})

test('a past key expiry says the key expired', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails
      live={null}
      coverage={null}
      keyExpiry={{ expiresAt: new Date('2020-01-15T12:00:00.500Z'), expired: true }}
    />,
  )
  await expect.element(screen.getByText(/Nyckeln gick ut den 15 jan\. 2020/)).toBeVisible()
})

test('the import button calls onImport', async () => {
  const onImport = vi.fn()
  const { screen } = await renderWithProviders(<VehicleLogImportButton onImport={onImport} />)
  await screen.getByRole('button', { name: m.charging_vehicle_import_button() }).click()
  expect(onImport).toHaveBeenCalledOnce()
})

test('a retry in flight keeps focus: soft-disabled, not disabled', async () => {
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails
      live={undefined}
      coverage={undefined}
      coverageQuery={{ ...failed(), isFetching: true }}
    />,
  )
  const retry = screen.getByRole('button', { name: m.common_try_again(), exact: false })
  await expect.element(retry).toHaveAttribute('aria-disabled', 'true')
  // Not natively disabled, so keyboard focus can stay on it.
  expect(retry.element().hasAttribute('disabled')).toBe(false)
})

test('a click on a retry in flight does not refetch again', async () => {
  const refetch = vi.fn()
  const { screen } = await renderWithProviders(
    <SkodaSourceDetails
      live={undefined}
      coverage={undefined}
      coverageQuery={{ ...failed(refetch), isFetching: true }}
    />,
  )
  ;(
    screen
      .getByRole('button', { name: m.common_try_again(), exact: false })
      .element() as HTMLButtonElement
  ).click()
  expect(refetch).not.toHaveBeenCalled()
})

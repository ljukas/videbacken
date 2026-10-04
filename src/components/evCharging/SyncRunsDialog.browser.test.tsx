import { expect, test, vi } from 'vitest'
import { integrationErrorMessage } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import type { Run } from './RecentRunsTable'
import { type RunsQuery, SyncRunsDialog } from './SyncRunsDialog'

type Health = RouterOutputs['evCharging']['syncStatus']

const okRun: Run = {
  id: 'r1',
  trigger: 'cron',
  startedAt: new Date('2026-09-28T08:00:00Z'), // 10:00 Stockholm (CEST)
  finishedAt: new Date('2026-09-28T08:00:01Z'),
  durationMs: 1250,
  outcome: 'ok',
  errorCode: null,
  errorMessage: null,
  upserted: 4,
  sessionsSeen: 9,
  pages: 1,
}
const failedRun: Run = {
  ...okRun,
  id: 'r2',
  trigger: 'admin',
  durationMs: 420,
  outcome: 'failed',
  errorCode: 'rate_limited',
  upserted: 0,
}

const health: Health = {
  source: 'zaptec',
  state: 'ok',
  running: false,
  lastAttemptAt: new Date('2026-09-28T08:00:00Z'),
  lastSuccessAt: new Date('2026-09-28T08:00:00Z'),
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
}

const loaded = (data: Run[]): RunsQuery => ({
  data,
  isPlaceholderData: false,
  errorUpdateCount: 0,
  isFetching: false,
  refetch: () => {},
})

function dialog(props: Partial<Parameters<typeof SyncRunsDialog>[0]> = {}) {
  return (
    <SyncRunsDialog
      source="zaptec"
      health={health}
      runs={loaded([okRun, failedRun])}
      open
      onOpenChange={() => {}}
      {...props}
    />
  )
}

const title = (source: string) => m.charging_source_dialog_title({ source })

test('shows the source title, state and the run table', async () => {
  const { screen } = await renderWithProviders(dialog())
  const overlay = screen.getByRole('dialog', { name: title('Zaptec') })
  await expect.element(overlay).toBeVisible()
  await expect
    .element(overlay.getByText(m.charging_runs_description({ source: 'Zaptec' })))
    .toBeVisible()
  await expect.element(overlay.getByText('Fungerar', { exact: true })).toBeVisible()
  await expect.element(overlay.getByRole('table')).toBeVisible()
  await expect.element(overlay.getByRole('cell', { name: /10:00/ }).first()).toBeVisible()
  await expect.element(overlay.getByText(m.charging_runs_trigger_cron())).toBeVisible()
  await expect.element(overlay.getByText(m.charging_runs_trigger_admin())).toBeVisible()
  await expect.element(overlay.getByText(m.charging_runs_outcome_ok())).toBeVisible()
  await expect.element(overlay.getByText(m.charging_runs_outcome_failed())).toBeVisible()
  await expect.element(overlay.getByText('1,3 s')).toBeVisible()
  await expect.element(overlay.getByText('420 ms')).toBeVisible()
  await expect.element(overlay.getByRole('cell', { name: 'rate_limited' })).toBeVisible()
})

test('closed, or without a source, nothing shows', async () => {
  const { screen } = await renderWithProviders(
    <>
      {dialog({ open: false })}
      {dialog({ source: undefined })}
    </>,
  )
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

test('closing asks the owner to close', async () => {
  const onOpenChange = vi.fn()
  const { screen } = await renderWithProviders(dialog({ onOpenChange }))
  await screen.getByRole('button', { name: 'Close' }).click()
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('an empty history says so', async () => {
  const { screen } = await renderWithProviders(dialog({ runs: loaded([]) }))
  await expect.element(screen.getByText(m.charging_runs_empty())).toBeVisible()
})

test('a failed runs read is an error, never an empty history', async () => {
  const { screen } = await renderWithProviders(
    dialog({ runs: { ...loaded([]), data: undefined, errorUpdateCount: 1 } }),
  )
  await expect.element(screen.getByText(m.charging_runs_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_runs_empty()).elements()).toHaveLength(0)
  expect(screen.getByRole('table').elements()).toHaveLength(0)
})

test('runs still loading show neither a table nor an empty history', async () => {
  const { screen } = await renderWithProviders(dialog({ runs: { ...loaded([]), data: undefined } }))
  await expect.element(screen.getByRole('dialog', { name: title('Zaptec') })).toBeVisible()
  expect(screen.getByText(m.charging_runs_empty()).elements()).toHaveLength(0)
  expect(screen.getByRole('table').elements()).toHaveLength(0)
})

test('a failing source explains itself, since when, and the admin detail', async () => {
  const { screen } = await renderWithProviders(
    dialog({
      source: 'skoda',
      health: {
        ...health,
        source: 'skoda',
        state: 'failing',
        code: 'auth_failed',
        failingSince: new Date('2026-09-28T06:00:00Z'), // 08:00 Stockholm
        adminDetail: { lastErrorMessage: 'HTTP 401 from /oauth/token', credentialExpiry: null },
      },
    }),
  )
  const overlay = screen.getByRole('dialog', { name: title('Škoda') })
  await expect
    .element(
      overlay.getByText(integrationErrorMessage('auth_failed', { source: 'skoda' }), {
        exact: false,
      }),
    )
    .toBeVisible()
  await expect.element(overlay.getByText(/Har inte fungerat sedan .*08:00/)).toBeVisible()
  await expect.element(overlay.getByText('HTTP 401 from /oauth/token')).toBeVisible()
})

test('an ok source has no explanation box', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect.element(screen.getByRole('table')).toBeVisible()
  expect(screen.getByText(m.charging_health_admin_detail()).elements()).toHaveLength(0)
})

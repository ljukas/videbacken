import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { RecentRunsCard } from './RecentRunsCard'

type Run = RouterOutputs['evCharging']['recentRuns'][number]

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

test('is collapsed by default and expands to the run table', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1024 }}>
      <RecentRunsCard source="zaptec" runs={[okRun, failedRun]} />
    </div>,
  )
  await expect.element(screen.getByText(m.charging_runs_title({ source: 'Zaptec' }))).toBeVisible()
  expect(screen.getByRole('table').elements()).toHaveLength(0)

  await screen.getByRole('button', { name: m.charging_runs_toggle({ source: 'Zaptec' }) }).click()

  await expect.element(screen.getByRole('table')).toBeVisible()
  // Time in Europe/Stockholm, trigger, outcome badge, duration, upserted, code.
  await expect.element(screen.getByRole('cell', { name: /10:00/ }).first()).toBeVisible()
  await expect.element(screen.getByText(m.charging_runs_trigger_cron())).toBeVisible()
  await expect.element(screen.getByText(m.charging_runs_trigger_admin())).toBeVisible()
  await expect.element(screen.getByText(m.charging_runs_outcome_ok())).toBeVisible()
  await expect.element(screen.getByText(m.charging_runs_outcome_failed())).toBeVisible()
  await expect.element(screen.getByText('1,3 s')).toBeVisible()
  await expect.element(screen.getByText('420 ms')).toBeVisible()
  await expect.element(screen.getByRole('cell', { name: 'rate_limited' })).toBeVisible()
})

test('an empty history says so once expanded', async () => {
  const { screen } = await renderWithProviders(<RecentRunsCard source="zaptec" runs={[]} />)
  await screen.getByRole('button', { name: m.charging_runs_toggle({ source: 'Zaptec' }) }).click()
  await expect.element(screen.getByText(m.charging_runs_empty())).toBeVisible()
})

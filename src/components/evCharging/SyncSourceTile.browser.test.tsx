import { expect, test, vi } from 'vitest'
import { integrationErrorMessage, integrationHealthTitle } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SyncSourceTile } from './SyncSourceTile'

type Health = RouterOutputs['evCharging']['syncStatus']

const ok: Health = {
  source: 'zaptec',
  state: 'ok',
  running: false,
  lastAttemptAt: new Date('2026-10-04T08:00:00Z'),
  lastSuccessAt: new Date('2026-10-04T08:00:00Z'),
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
}

function tile(
  health: Health | undefined,
  extra: Partial<Parameters<typeof SyncSourceTile>[0]> = {},
) {
  return (
    <SyncSourceTile
      source={health?.source ?? 'skoda'}
      health={health}
      onSync={() => {}}
      syncing={false}
      onOpenHistory={() => {}}
      {...extra}
    />
  )
}

// Accessible names start with the visible label (WCAG 2.5.3), then the source.
const named = (action: string, source: string) => ({
  name: m.charging_source_action_label({ action, source }),
})
const syncButton = (source: string, action = m.charging_sync_now()) => named(action, source)
const historyButton = (source: string) => named(m.charging_source_history(), source)

test('an ok source shows its name, role, state, last sync and cadence', async () => {
  const { screen } = await renderWithProviders(tile(ok))
  await expect.element(screen.getByRole('heading', { name: 'Zaptec' })).toBeVisible()
  await expect.element(screen.getByText(m.charging_source_role_zaptec())).toBeVisible()
  await expect
    .element(screen.getByText(integrationHealthTitle('ok'), { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByText(/^Senast synkad/)).toBeVisible()
  await expect.element(screen.getByText(m.charging_source_cadence_zaptec())).toBeVisible()
  await expect
    .element(screen.getByRole('button', syncButton('Zaptec')))
    .toHaveTextContent(m.charging_sync_now())
})

test('the tile is a group named by its source', async () => {
  const { screen } = await renderWithProviders(tile(ok))
  await expect.element(screen.getByRole('group', { name: 'Zaptec' })).toBeVisible()
})

test('sync and history call their handlers', async () => {
  const onSync = vi.fn()
  const onOpenHistory = vi.fn()
  const { screen } = await renderWithProviders(tile(ok, { onSync, onOpenHistory }))
  await screen.getByRole('button', syncButton('Zaptec')).click()
  await screen.getByRole('button', historyButton('Zaptec')).click()
  expect(onSync).toHaveBeenCalledOnce()
  expect(onOpenHistory).toHaveBeenCalledOnce()
})

test('a pending sync disables the button', async () => {
  const { screen } = await renderWithProviders(tile(ok, { syncing: true }))
  const button = screen.getByRole('button', syncButton('Zaptec', m.charging_source_syncing()))
  await expect.element(button).toBeDisabled()
  await expect.element(button).toHaveTextContent(m.charging_source_syncing())
})

test('a sync already running on the server disables the button too', async () => {
  const { screen } = await renderWithProviders(tile({ ...ok, source: 'elpris', running: true }))
  const button = screen.getByRole(
    'button',
    syncButton('elprisetjustnu.se', m.charging_source_syncing()),
  )
  await expect.element(button).toBeDisabled()
  await expect.element(button).toHaveTextContent(m.charging_source_syncing())
})

test('not configured has no sync button and says why', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, source: 'emaldo', state: 'not_configured', lastSuccessAt: null }),
  )
  await expect
    .element(screen.getByText(integrationHealthTitle('not_configured'), { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText(integrationErrorMessage('not_configured', { source: 'emaldo' })))
    .toBeVisible()
  await expect.element(screen.getByText(m.charging_source_never_synced())).toBeVisible()
  // History is the only action left.
  expect(screen.getByRole('button').elements()).toHaveLength(1)
  await expect.element(screen.getByRole('button', historyButton('Emaldo'))).toBeVisible()
})

test('failing offers a retry and shows the error copy', async () => {
  const { screen } = await renderWithProviders(
    tile({
      ...ok,
      source: 'skoda',
      state: 'failing',
      code: 'auth_failed',
      failingSince: new Date('2026-10-04T06:00:00Z'),
    }),
  )
  await expect
    .element(screen.getByText(integrationHealthTitle('failing'), { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText(integrationErrorMessage('auth_failed', { source: 'skoda' })))
    .toBeVisible()
  await expect
    .element(screen.getByRole('button', syncButton('Škoda', m.common_try_again())))
    .toHaveTextContent(m.common_try_again())
})

test('stale shows its source-specific copy', async () => {
  const { screen } = await renderWithProviders(tile({ ...ok, source: 'elpris', state: 'stale' }))
  await expect
    .element(screen.getByText(integrationHealthTitle('stale'), { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByText(m.charging_health_stale_elpris())).toBeVisible()
})

test('never synced shows its source-specific copy', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, source: 'skoda', state: 'never_synced', lastSuccessAt: null }),
  )
  await expect.element(screen.getByText(m.charging_health_never_synced_skoda())).toBeVisible()
  await expect.element(screen.getByText(m.charging_source_never_synced())).toBeVisible()
})

test('an unread health still renders a usable tile', async () => {
  const { screen } = await renderWithProviders(tile(undefined))
  await expect.element(screen.getByRole('heading', { name: 'Škoda' })).toBeVisible()
  await expect.element(screen.getByText(m.charging_source_state_unknown())).toBeVisible()
  await expect.element(screen.getByRole('button', syncButton('Škoda'))).toBeEnabled()
})

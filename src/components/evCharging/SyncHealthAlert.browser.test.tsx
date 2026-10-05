import { expect, test, vi } from 'vitest'
import { integrationErrorMessage, integrationHealthTitle } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders, renderWithRouter } from '~test/browser/render'
import { SyncHealthAlert } from './SyncHealthAlert'

type Health = RouterOutputs['evCharging']['syncStatus']

const base: Health = {
  source: 'zaptec',
  state: 'ok',
  running: false,
  progress: null,
  lastAttemptAt: new Date('2026-09-28T10:00:00Z'),
  lastSuccessAt: new Date('2026-09-28T10:00:00Z'),
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
}

const failing: Health = {
  ...base,
  state: 'failing',
  failingSince: new Date('2026-09-28T08:00:00Z'),
  consecutiveFailures: 3,
  code: 'auth_failed',
  adminDetail: { lastErrorMessage: 'HTTP 401 from /oauth/token', credentialExpiry: null },
}

function titleFor(state: Health['state']) {
  return m.charging_health_title({ source: 'Zaptec', state: integrationHealthTitle(state) })
}

const retryButton = (screen: Awaited<ReturnType<typeof renderWithProviders>>['screen']) =>
  screen.getByRole('button', { name: m.common_try_again() })

test('ok renders nothing', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert health={base} isAdmin onRetry={() => {}} retrying={false} />,
  )
  expect(screen.getByRole('alert').elements()).toHaveLength(0)
})

test('failing (admin): code message, raw error detail and a working retry', async () => {
  const onRetry = vi.fn()
  const { screen } = await renderWithProviders(
    <SyncHealthAlert health={failing} isAdmin onRetry={onRetry} retrying={false} />,
  )
  await expect.element(screen.getByText(titleFor('failing'))).toBeVisible()
  await expect
    .element(
      screen.getByText(integrationErrorMessage('auth_failed', { source: 'zaptec' }), {
        exact: false,
      }),
    )
    .toBeVisible()
  await expect.element(screen.getByText('HTTP 401 from /oauth/token')).toBeVisible()

  await retryButton(screen).click()
  expect(onRetry).toHaveBeenCalledOnce()
})

test('failing (non-admin): code message only — no raw detail, no retry', async () => {
  // A non-admin never receives adminDetail from the server; mirror that.
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...failing, adminDetail: null }}
      isAdmin={false}
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect
    .element(
      screen.getByText(integrationErrorMessage('auth_failed', { source: 'zaptec' }), {
        exact: false,
      }),
    )
    .toBeVisible()
  expect(screen.getByText(m.charging_health_admin_detail()).elements()).toHaveLength(0)
  expect(retryButton(screen).elements()).toHaveLength(0)
})

test.each([
  ['admin', true],
  ['non-admin', false],
] as const)('stale (%s): warns figures may be out of date; retry only for admins', async (_, isAdmin) => {
  const stale: Health = { ...base, state: 'stale' }
  const { screen } = await renderWithProviders(
    <SyncHealthAlert health={stale} isAdmin={isAdmin} onRetry={() => {}} retrying={false} />,
  )
  await expect.element(screen.getByText(titleFor('stale'))).toBeVisible()
  await expect.element(screen.getByText(m.charging_health_stale())).toBeVisible()
  expect(retryButton(screen).elements()).toHaveLength(isAdmin ? 1 : 0)
})

test.each([
  ['admin', true],
  ['non-admin', false],
] as const)('never_synced (%s): explains the first sync; only admins can start it', async (_, isAdmin) => {
  const never: Health = { ...base, state: 'never_synced', lastAttemptAt: null, lastSuccessAt: null }
  const { screen } = await renderWithProviders(
    <SyncHealthAlert health={never} isAdmin={isAdmin} onRetry={() => {}} retrying={false} />,
  )
  await expect.element(screen.getByText(titleFor('never_synced'))).toBeVisible()
  await expect.element(screen.getByText(m.charging_health_never_synced())).toBeVisible()
  expect(retryButton(screen).elements()).toHaveLength(isAdmin ? 1 : 0)
})

test.each([
  ['admin', true],
  ['non-admin', false],
] as const)('not_configured (%s): explains missing credentials, never a retry', async (_, isAdmin) => {
  const notConfigured: Health = { ...base, state: 'not_configured', code: 'not_configured' }
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={notConfigured}
      isAdmin={isAdmin}
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(titleFor('not_configured'))).toBeVisible()
  await expect
    .element(screen.getByText(integrationErrorMessage('not_configured', { source: 'zaptec' })))
    .toBeVisible()
  expect(retryButton(screen).elements()).toHaveLength(0)
})

test('an elpris alert that never synced uses the price-specific copy', async () => {
  const never: Health = {
    ...base,
    source: 'elpris',
    state: 'never_synced',
    lastAttemptAt: null,
    lastSuccessAt: null,
  }
  const { screen } = await renderWithProviders(
    <SyncHealthAlert health={never} isAdmin={false} onRetry={() => {}} retrying={false} />,
  )
  await expect.element(screen.getByText(m.charging_health_never_synced_elpris())).toBeVisible()
  // Informational states are a polite status, not an interrupting alert.
  await expect.element(screen.getByRole('status')).toBeVisible()
})

test('a failing elpris alert names its own source and interrupts (role=alert)', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...failing, source: 'elpris', code: 'unreachable', adminDetail: null }}
      isAdmin={false}
      onRetry={() => {}}
      retrying={false}
    />,
  )
  const message = integrationErrorMessage('unreachable', { source: 'elpris' })
  expect(message).not.toContain('Zaptec')
  await expect.element(screen.getByText(message, { exact: false })).toBeVisible()
  await expect.element(screen.getByRole('alert')).toBeVisible()
})

test('a stale elpris alert talks about prices', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'elpris', state: 'stale' }}
      isAdmin={false}
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_health_stale_elpris())).toBeVisible()
})

test('Škoda has its own never-synced copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'skoda', state: 'never_synced' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_health_never_synced_skoda())).toBeVisible()
})

test('Škoda has its own stale copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'skoda', state: 'stale' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_health_stale_skoda())).toBeVisible()
})

test('an expired Škoda key says to create a new one', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...failing, source: 'skoda' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(/Škoda-nyckeln fungerar inte längre/)).toBeVisible()
})

test('Emaldo has its own never-synced copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'emaldo', state: 'never_synced' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_health_never_synced_emaldo())).toBeVisible()
})

test('Emaldo has its own stale copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'emaldo', state: 'stale' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_health_stale_emaldo())).toBeVisible()
})

test('an unexpected Emaldo answer says the app key may have changed', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...failing, source: 'emaldo', code: 'unexpected_response' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect
    .element(
      screen.getByText(m.integration_health_error_unexpected_response_emaldo(), { exact: false }),
    )
    .toBeVisible()
})

test.each([
  ['failing', { state: 'failing', code: 'auth_failed' }],
  ['not configured', { state: 'not_configured' }],
  ['stale', { state: 'stale' }],
  ['never synced', { state: 'never_synced' }],
] as const)('%s (admin, settingsLink): links to the settings page', async (_n, patch) => {
  const { screen } = await renderWithRouter(
    <SyncHealthAlert
      health={{ ...base, ...patch } as Health}
      isAdmin
      settingsLink
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect
    .element(screen.getByRole('link', { name: m.charging_settings_link() }))
    .toHaveAttribute('href', '/charging/settings')
})

test('no settings link for a member, or without the prop', async () => {
  const member = await renderWithRouter(
    <SyncHealthAlert
      health={failing}
      isAdmin={false}
      settingsLink
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(member.screen.getByRole('alert')).toBeVisible()
  expect(member.screen.getByRole('link').elements()).toHaveLength(0)
  member.screen.unmount()
  const noProp = await renderWithRouter(
    <SyncHealthAlert health={failing} isAdmin onRetry={() => {}} retrying={false} />,
  )
  await expect.element(noProp.screen.getByRole('alert')).toBeVisible()
  expect(noProp.screen.getByRole('link').elements()).toHaveLength(0)
})

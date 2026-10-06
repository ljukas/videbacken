import { expect, test, vi } from 'vitest'
import {
  integrationErrorMessage,
  integrationHealthTitle,
  integrationSourceName,
} from '~/lib/integrationHealthMessage'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SyncSourceTile } from './SyncSourceTile'
import type { SourceHealth as Health } from './syncHealth'

const ok: Health = {
  source: 'zaptec',
  state: 'ok',
  running: false,
  progress: null,
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

test('sync and history call their handlers', async () => {
  const onSync = vi.fn()
  const onOpenHistory = vi.fn()
  const { screen } = await renderWithProviders(tile(ok, { onSync, onOpenHistory }))
  await screen.getByRole('button', syncButton('Zaptec')).click()
  await screen.getByRole('button', historyButton('Zaptec')).click()
  expect(onSync).toHaveBeenCalledOnce()
  expect(onOpenHistory).toHaveBeenCalledOnce()
})

test('a pending sync is soft-disabled: focusable, but a click does nothing', async () => {
  const onSync = vi.fn()
  const { screen } = await renderWithProviders(tile(ok, { syncing: true, onSync }))
  const button = screen.getByRole('button', syncButton('Zaptec', m.charging_source_syncing()))
  await expect.element(button).toHaveAttribute('aria-disabled', 'true')
  // Not natively `disabled`, so keyboard focus can stay on it.
  expect(button.element().hasAttribute('disabled')).toBe(false)
  await expect.element(button).toHaveTextContent(m.charging_source_syncing())
  ;(button.element() as HTMLButtonElement).click()
  expect(onSync).not.toHaveBeenCalled()
})

test('a sync already running on the server disables the button too', async () => {
  const { screen } = await renderWithProviders(tile({ ...ok, source: 'elpris', running: true }))
  const button = screen.getByRole(
    'button',
    syncButton('elprisetjustnu.se', m.charging_source_syncing()),
  )
  await expect.element(button).toHaveAttribute('aria-disabled', 'true')
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
  // The badge already says it; no "Aldrig synkad" echo.
  expect(screen.getByText(m.charging_source_never_synced()).elements()).toHaveLength(0)
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
  expect(screen.getByText(m.charging_source_never_synced()).elements()).toHaveLength(0)
})

test('failing before any success says it never synced', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, state: 'failing', code: 'unreachable', lastSuccessAt: null }),
  )
  await expect.element(screen.getByText(m.charging_source_never_synced())).toBeVisible()
})

test('the failing explanation is never clamped', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, source: 'emaldo', state: 'failing', code: 'auth_failed' }),
  )
  const message = screen.getByText(integrationErrorMessage('auth_failed', { source: 'emaldo' }))
  await expect.element(message).toBeVisible()
  expect(message.element().className).not.toMatch(/line-clamp/)
})

test('an unread health still renders a usable tile', async () => {
  const { screen } = await renderWithProviders(tile(undefined))
  await expect.element(screen.getByRole('heading', { name: 'Škoda' })).toBeVisible()
  await expect.element(screen.getByText(m.charging_source_state_unknown())).toBeVisible()
  await expect.element(screen.getByRole('button', syncButton('Škoda'))).toBeEnabled()
})

const emaldoRunning: Health = {
  ...ok,
  source: 'emaldo',
  running: true,
  progress: { done: 12, total: 30 },
}
const progressBar = (screen: Awaited<ReturnType<typeof renderWithProviders>>['screen']) =>
  screen.getByRole('progressbar', {
    name: m.charging_source_progress_label({ source: integrationSourceName('emaldo') }),
  })

test('a run in flight (e.g. the cron’s) shows its progress as a bar and in days', async () => {
  // syncing: false — this tab didn't start it; the server's progress alone shows it.
  const { screen } = await renderWithProviders(tile(emaldoRunning))
  const bar = progressBar(screen)
  // In the document, not "visible": no app CSS here, so the h-1 bar has no height.
  await expect.element(bar).toBeInTheDocument()
  await expect.element(bar).toHaveAttribute('aria-valuenow', '40')
  await expect
    .element(bar)
    .toHaveAttribute('aria-valuetext', m.charging_source_progress({ done: 12, total: 30 }))
  await expect
    .element(screen.getByText(m.charging_source_progress({ done: 12, total: 30 })))
    .toBeVisible()
})

test('no bar before the run reports progress', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...emaldoRunning, progress: null }, { syncing: true }),
  )
  await expect.element(screen.getByRole('progressbar')).not.toBeInTheDocument()
})

test('no bar once the run is no longer in flight', async () => {
  const { screen } = await renderWithProviders(tile({ ...emaldoRunning, running: false }))
  await expect.element(screen.getByRole('progressbar')).not.toBeInTheDocument()
})

test('while progress shows, the cadence stays in the layout but invisible', async () => {
  const cadence = m.charging_source_cadence_emaldo()
  const { screen } = await renderWithProviders(tile(emaldoRunning))
  // Tailwind's `invisible` keeps its height (no layout shift); no app CSS loads here, so pin the class.
  await expect.element(screen.getByText(cadence)).toHaveClass('invisible')
})

test('the cadence line shows when there is no progress', async () => {
  const { screen } = await renderWithProviders(tile({ ...emaldoRunning, progress: null }))
  await expect.element(screen.getByText(m.charging_source_cadence_emaldo())).toBeVisible()
})

test('the caption is singular for one day', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...emaldoRunning, progress: { done: 1, total: 1 } }),
  )
  await expect.element(screen.getByText('1 av 1 dag', { exact: true })).toBeVisible()
})

test('a source’s own details show under its state', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, source: 'skoda' }, { details: <p>Bilen hördes av nyss</p> }),
  )
  await expect.element(screen.getByText('Bilen hördes av nyss')).toBeVisible()
})

test('a source’s own actions get their own row, never paired with sync or history', async () => {
  const onImport = vi.fn()
  const { screen } = await renderWithProviders(
    tile(
      { ...ok, source: 'skoda' },
      {
        actions: (
          <button type="button" onClick={onImport}>
            Importera
          </button>
        ),
      },
    ),
  )
  await expect.element(screen.getByRole('button', syncButton('Škoda'))).toBeVisible()
  await expect.element(screen.getByRole('button', historyButton('Škoda'))).toBeVisible()
  // Not in sync + history's two-column grid: a row of its own above it, so
  // sync + history stay level with the row-mates' at the tile's foot.
  const sync = screen.getByRole('button', syncButton('Škoda')).element()
  const action = screen.getByRole('button', { name: 'Importera' }).element()
  expect(action.parentElement).not.toBe(sync.parentElement)
  expect(sync.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  await screen.getByRole('button', { name: 'Importera' }).click()
  expect(onImport).toHaveBeenCalledOnce()
})

test('a source’s own actions stay when it is not configured', async () => {
  // The car's log import needs no API key: only the sync goes.
  const { screen } = await renderWithProviders(
    tile(
      { ...ok, source: 'skoda', state: 'not_configured', lastSuccessAt: null },
      {
        actions: (
          <button type="button" onClick={() => {}}>
            Importera
          </button>
        ),
      },
    ),
  )
  expect(screen.getByRole('button').elements()).toHaveLength(2)
  await expect.element(screen.getByRole('button', historyButton('Škoda'))).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Importera' })).toBeVisible()
})

test('a credential source has a key button named for it; without the handler there is none', async () => {
  const onOpen = vi.fn()
  const { screen } = await renderWithProviders(tile(ok, { onOpenCredentials: onOpen }))
  await screen
    .getByRole('button', { name: m.charging_credentials_button({ source: 'Zaptec' }) })
    .click()
  expect(onOpen).toHaveBeenCalledOnce()
})

test('without the handler there is no key button and no credentials link', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, state: 'not_configured', code: 'not_configured' }),
  )
  expect(screen.getByRole('button', { name: /Inloggning för/ }).elements()).toHaveLength(0)
  expect(
    screen.getByRole('button', { name: m.charging_credentials_configure() }).elements(),
  ).toHaveLength(0)
})

test('elpris has no credentials, so no key button even with a handler', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, source: 'elpris' }, { onOpenCredentials: () => {} }),
  )
  expect(screen.getByRole('button', { name: /Inloggning för/ }).elements()).toHaveLength(0)
})

test('not configured links to set it up', async () => {
  const onOpen = vi.fn()
  const { screen } = await renderWithProviders(
    tile({ ...ok, state: 'not_configured', code: 'not_configured' }, { onOpenCredentials: onOpen }),
  )
  await screen.getByRole('button', { name: m.charging_credentials_configure() }).click()
  expect(onOpen).toHaveBeenCalledOnce()
})

test('a refused sign-in links to update it and names the suspect fields', async () => {
  const { screen } = await renderWithProviders(
    tile(
      {
        ...ok,
        source: 'skoda',
        state: 'failing',
        code: 'forbidden',
        adminDetail: {
          lastErrorMessage: null,
          credentialExpiry: null,
          suspectFields: ['vin'],
        } as never,
      },
      { onOpenCredentials: () => {} },
    ),
  )
  await expect
    .element(screen.getByRole('button', { name: m.charging_credentials_update() }))
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_credentials_suspect({ fields: 'VIN' })))
    .toBeVisible()
})

test('an outage that is not about credentials has no credentials link', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, state: 'failing', code: 'unreachable' }, { onOpenCredentials: () => {} }),
  )
  expect(
    screen.getByRole('button', { name: m.charging_credentials_update() }).elements(),
  ).toHaveLength(0)
})

test('the header keeps room for the key button', async () => {
  const { screen } = await renderWithProviders(tile(ok, { onOpenCredentials: () => {} }))
  const heading = screen.getByRole('heading', { level: 3 }).element()
  expect(heading.closest('[data-credentials-room]')).not.toBeNull()
})

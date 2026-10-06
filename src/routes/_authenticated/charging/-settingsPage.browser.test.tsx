import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { credentialsTitle } from '~/lib/integrationCredentialsMessage'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { seedSourcesHealth } from '~test/browser/syncHealth'
import { Route as Settings } from './settings'

// The real settings page mounted under a bare root (routeTree.gen.ts isn't
// loaded), next to a stub overview the admin gate redirects to. The cache is
// seeded through the oRPC-generated keys; anything unseeded fails (the test
// server has no /api/rpc), which is how a failed read is staged. The `-` prefix
// keeps this file out of the route tree.

afterEach(() => {
  vi.restoreAllMocks()
})

const TARIFF = {
  id: '00000000-0000-4000-8000-0000000000aa',
  validFrom: '2026-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

const runsKey = orpc.evCharging.recentRuns.queryOptions({ input: { limit: 20 } }).queryKey
const credentialsKey = orpc.credentials.status.queryOptions().queryKey

// Every credential from env, so the grid card has a status line.
const env = { origin: 'env' } as const
const STATUS = {
  encryptionKeyConfigured: true,
  sources: {
    zaptec: { fields: { username: env, password: env }, updatedAt: null, unreadable: false },
    skoda: {
      fields: { apiKey: env, vin: env, homeCoordinates: env },
      updatedAt: null,
      unreadable: false,
    },
    emaldo: {
      fields: { user: env, password: env, appId: env, appSecret: env },
      updatedAt: null,
      unreadable: false,
    },
    gridTariff: { fields: { facilityId: env }, updatedAt: null, unreadable: false },
  },
}

function seed(qc: QueryClient, opts: { coverage?: boolean; adminReads?: boolean } = {}) {
  qc.setQueryData(orpc.tariff.list.queryOptions().queryKey, [TARIFF] as never)
  seedSourcesHealth(qc)
  if (opts.adminReads !== false) {
    qc.setQueryData(runsKey, { zaptec: [], elpris: [], skoda: [], emaldo: [] } as never)
    qc.setQueryData(credentialsKey, STATUS as never)
  }
  qc.setQueryData(orpc.evCharging.vehicleStateLatest.queryOptions().queryKey, null)
  if (opts.coverage !== false && opts.adminReads !== false)
    qc.setQueryData(orpc.evCharging.vehicleRecordCoverage.queryOptions().queryKey, null)
}

async function renderSettings(
  search: string,
  opts: {
    role?: 'admin' | 'user'
    coverage?: boolean
    adminReads?: boolean
    // Runs after the seed, before the loader: e.g. hold a read pending.
    prepare?: (qc: QueryClient) => void
  } = {},
) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
  seed(qc, opts)
  opts.prepare?.(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  const overviewStub = createRoute({
    getParentRoute: () => root,
    path: '/charging',
    component: () => <p>overview stub</p>,
  })
  ;(Settings as unknown as { update: (o: unknown) => void }).update({
    id: '/charging/settings',
    path: '/charging/settings',
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([overviewStub, Settings as never]),
    context: { queryClient: qc, user: { role: opts.role ?? 'admin' } },
    history: createMemoryHistory({ initialEntries: [`/charging/settings${search}`] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

const sourcesHeading = { name: m.charging_sources_heading(), level: 2 } as const
const historyTitle = (source: string) => m.charging_source_dialog_title({ source })

test('an admin gets the heading, the Datakällor panel and the tariff card, in that order', async () => {
  const { screen } = await renderSettings('')
  await expect
    .element(screen.getByRole('heading', { name: m.charging_settings_title(), level: 1 }))
    .toBeVisible()
  const sources = screen.getByRole('heading', sourcesHeading)
  await expect.element(sources).toBeVisible()
  const tariff = screen.getByRole('heading', { name: m.charging_tariff_title() })
  await expect.element(tariff).toBeVisible()
  expect(
    sources.element().compareDocumentPosition(tariff.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0)
  // The heading's sync-all button.
  await expect
    .element(screen.getByRole('button', { name: m.charging_sync_now(), exact: true }))
    .toBeVisible()
})

test('a household member is redirected to the overview, with no settings UI', async () => {
  // The admin-only reads are left unseeded, so a fired read would leave a cache entry.
  const { screen, router, qc } = await renderSettings('', { role: 'user', adminReads: false })
  await expect.element(screen.getByText('overview stub')).toBeVisible()
  expect(qc.getQueryState(runsKey)).toBeUndefined()
  expect(qc.getQueryState(credentialsKey)).toBeUndefined()
  expect(
    qc.getQueryState(orpc.evCharging.vehicleRecordCoverage.queryOptions().queryKey),
  ).toBeUndefined()
  expect(router.state.location.pathname).toBe('/charging')
  expect(screen.getByRole('heading', sourcesHeading).elements()).toHaveLength(0)
})

test('the Škoda tile shows the car log, and ?dialog=vehicleImport opens the import', async () => {
  const { screen } = await renderSettings('?dialog=vehicleImport')
  await expect.element(screen.getByText(m.charging_vehicle_log_none())).toBeVisible()
  await expect.element(screen.getByText(m.charging_vehicle_import_title())).toBeVisible()
})

test('a failed coverage read shows an error on the Škoda tile, not "no log imported"', async () => {
  const { screen } = await renderSettings('', { coverage: false })
  await expect.element(screen.getByText(m.charging_vehicle_log_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_log_none()).elements()).toHaveLength(0)
})

test('Historik opens that source in the URL, and closing clears it', async () => {
  const { screen, router } = await renderSettings('')
  await screen
    .getByRole('button', {
      name: m.charging_source_action_label({
        action: m.charging_source_history(),
        source: 'elprisetjustnu.se',
      }),
    })
    .click()
  await expect
    .element(screen.getByRole('dialog', { name: historyTitle('elprisetjustnu.se') }))
    .toBeVisible()
  expect(router.state.location.search).toMatchObject({ dialog: 'syncRuns', source: 'elpris' })
  await screen.getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => router.state.location.search).not.toHaveProperty('dialog')
  expect(router.state.location.search).not.toHaveProperty('source')
})

test('a deep link opens that source’s history', async () => {
  const { screen } = await renderSettings('?dialog=syncRuns&source=skoda')
  await expect.element(screen.getByRole('dialog', { name: historyTitle('Škoda') })).toBeVisible()
})

// One distinct error code per source, so a history showing another source's runs is caught.
const RUN_CODE = {
  zaptec: 'unreachable',
  elpris: 'rate_limited',
  skoda: 'auth_failed',
  emaldo: 'forbidden',
} as const
const failedRun = (source: keyof typeof RUN_CODE) => ({
  id: `00000000-0000-4000-8000-00000000000${Object.keys(RUN_CODE).indexOf(source)}`,
  trigger: 'cron',
  startedAt: new Date('2026-10-05T10:00:00Z'),
  finishedAt: new Date('2026-10-05T10:00:01Z'),
  durationMs: 1000,
  outcome: 'failed',
  errorCode: RUN_CODE[source],
  errorMessage: null,
  upserted: 0,
  sessionsSeen: 0,
  pages: 0,
})

test.each(
  Object.keys(RUN_CODE) as (keyof typeof RUN_CODE)[],
)('%s’s history shows its own runs, not another source’s', async (source) => {
  const { screen } = await renderSettings(`?dialog=syncRuns&source=${source}`, {
    prepare: (qc) =>
      qc.setQueryData(runsKey, {
        zaptec: [failedRun('zaptec')],
        elpris: [failedRun('elpris')],
        skoda: [failedRun('skoda')],
        emaldo: [failedRun('emaldo')],
      } as never),
  })
  const dialog = screen.getByRole('dialog', {
    name: historyTitle(integrationSourceName(source)),
  })
  await expect.element(dialog.getByText(RUN_CODE[source], { exact: true })).toBeVisible()
  for (const other of Object.keys(RUN_CODE) as (keyof typeof RUN_CODE)[]) {
    if (other !== source)
      expect(dialog.getByText(RUN_CODE[other], { exact: true }).elements()).toHaveLength(0)
  }
})

test('a failed runs read shows an error with a retry in the history', async () => {
  const { screen } = await renderSettings('?dialog=syncRuns&source=elpris', {
    // Unseeded: the test server has no /api/rpc, so the read fails.
    prepare: (qc) => qc.removeQueries({ queryKey: runsKey }),
  })
  const dialog = screen.getByRole('dialog', { name: historyTitle('elprisetjustnu.se') })
  await expect.element(dialog.getByText(m.charging_runs_error_title())).toBeVisible()
  await expect.element(dialog.getByRole('button', { name: m.common_try_again() })).toBeVisible()
})

test('?dialog=tariffNew opens the new-period dialog', async () => {
  const { screen } = await renderSettings('?dialog=tariffNew')
  await expect
    .element(screen.getByRole('dialog', { name: m.charging_tariff_dialog_new_title() }))
    .toBeVisible()
})

test('?dialog=tariffEdit with an existing tariff opens the edit dialog', async () => {
  const { screen } = await renderSettings(`?dialog=tariffEdit&tariffId=${TARIFF.id}`)
  await expect
    .element(screen.getByRole('dialog', { name: m.charging_tariff_dialog_edit_title() }))
    .toBeVisible()
})

test.each([
  ['a history link with no source', '?dialog=syncRuns'],
  ['a history link with an unknown source', '?dialog=syncRuns&source=tesla'],
  ['an edit link for a tariff that no longer exists', '?dialog=tariffEdit&tariffId=gone'],
  ['a delete link for a tariff that no longer exists', '?dialog=tariffDelete&tariffId=gone'],
  ['a history link to the grid facility (no sync history)', '?dialog=syncRuns&source=gridTariff'],
  ['a credentials link with no source', '?dialog=credentials'],
  ['a credentials link to a source without credentials', '?dialog=credentials&source=elpris'],
])('%s is cleaned from the URL', async (_case, search) => {
  const { screen, router } = await renderSettings(search)
  await expect.poll(() => router.state.location.search).not.toHaveProperty('dialog')
  expect(router.state.location.search).not.toHaveProperty('source')
  expect(router.state.location.search).not.toHaveProperty('tariffId')
  // The dialogs are lazy chunks: give a would-be mount time to resolve before asserting absence.
  await new Promise((r) => setTimeout(r, 50))
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

// --- Credentials (ADR-0026) ----------------------------------------------------

const credentialsButton = (source: string) => ({
  name: m.charging_credentials_button({ source }),
})

test('the credential tiles have key buttons; elpris has none', async () => {
  const { screen } = await renderSettings('')
  for (const source of ['zaptec', 'skoda', 'emaldo'] as const)
    await expect
      .element(screen.getByRole('button', credentialsButton(integrationSourceName(source))))
      .toBeVisible()
  expect(
    screen.getByRole('button', credentialsButton(integrationSourceName('elpris'))).elements(),
  ).toHaveLength(0)
})

test('a key button opens the dialog through the URL', async () => {
  const { screen, router } = await renderSettings('')
  await screen.getByRole('button', credentialsButton('Škoda')).click()
  await expect
    .element(screen.getByRole('dialog', { name: credentialsTitle('skoda') }))
    .toBeVisible()
  expect(router.state.location.search).toMatchObject({ dialog: 'credentials', source: 'skoda' })
})

test('not configured offers "Konfigurera", which opens the dialog', async () => {
  const { screen, router } = await renderSettings('', {
    prepare: (qc) =>
      seedSourcesHealth(qc, { zaptec: { state: 'not_configured', code: 'not_configured' } }),
  })
  await screen.getByRole('button', { name: m.charging_credentials_configure() }).click()
  await expect
    .element(screen.getByRole('dialog', { name: credentialsTitle('zaptec') }))
    .toBeVisible()
  expect(router.state.location.search).toMatchObject({ dialog: 'credentials', source: 'zaptec' })
})

test('the grid card shows where the facility ID comes from, and opens its dialog', async () => {
  const { screen, router } = await renderSettings('')
  await expect.element(screen.getByText(m.charging_grid_status_env())).toBeVisible()
  await screen.getByRole('button', { name: m.charging_grid_button() }).click()
  expect(router.state.location.search).toMatchObject({
    dialog: 'credentials',
    source: 'gridTariff',
  })
  await expect
    .element(screen.getByRole('dialog', { name: credentialsTitle('gridTariff') }))
    .toBeVisible()
})

test('a credentials deep link opens that dialog', async () => {
  const { screen } = await renderSettings('?dialog=credentials&source=emaldo')
  await expect
    .element(screen.getByRole('dialog', { name: credentialsTitle('emaldo') }))
    .toBeVisible()
})

test('closing the credentials dialog clears the URL and returns focus to its key button', async () => {
  const { screen, router } = await renderSettings('')
  const button = screen.getByRole('button', credentialsButton('Škoda'))
  await button.click()
  const dialog = screen.getByRole('dialog', { name: credentialsTitle('skoda') })
  await expect.element(dialog).toBeVisible()
  await dialog.getByRole('button', { name: m.common_cancel() }).click()
  await expect.poll(() => router.state.location.search).not.toHaveProperty('dialog')
  expect(router.state.location.search).not.toHaveProperty('source')
  await expect.element(button).toHaveFocus()
})

// Škoda's last attempt (10:00) blamed the VIN; the status says when Škoda's credentials were saved.
const skodaBlamedVin = (savedAt: Date | null) => (qc: QueryClient) => {
  seedSourcesHealth(qc, {
    skoda: {
      state: 'failing',
      code: 'forbidden',
      lastAttemptAt: new Date('2026-10-06T10:00:00Z'),
      adminDetail: { lastErrorMessage: null, credentialExpiry: null, suspectFields: ['vin'] },
    },
  })
  qc.setQueryData(credentialsKey, {
    ...STATUS,
    sources: { ...STATUS.sources, skoda: { ...STATUS.sources.skoda, updatedAt: savedAt } },
  } as never)
}
const tileSuspect = () => m.charging_credentials_suspect({ fields: 'VIN' })

test('a failed attempt after the last save marks its suspects on the tile and in the dialog', async () => {
  const { screen } = await renderSettings('?dialog=credentials&source=skoda', {
    prepare: skodaBlamedVin(new Date('2026-10-06T09:00:00Z')),
  })
  const dialog = screen.getByRole('dialog', { name: credentialsTitle('skoda') })
  await expect.element(dialog.getByText(m.charging_credentials_field_suspect())).toBeVisible()
  expect(document.body.textContent).toContain(tileSuspect())
})

test('credentials saved after the failed attempt clear its suspects from the tile and the dialog', async () => {
  const { screen } = await renderSettings('?dialog=credentials&source=skoda', {
    prepare: skodaBlamedVin(new Date('2026-10-06T10:05:00Z')),
  })
  const dialog = screen.getByRole('dialog', { name: credentialsTitle('skoda') })
  await expect.element(dialog).toBeVisible()
  // The link stays: the health still blames the credentials until the next run.
  expect(dialog.getByText(m.charging_credentials_field_suspect()).elements()).toHaveLength(0)
  expect(document.body.textContent).not.toContain(tileSuspect())
  expect(document.body.textContent).toContain(m.charging_credentials_update())
})

// --- Deferred loading (ADR-0025) ----------------------------------------------

const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

// A query whose fetch never settles stays `pending`. The seeded copy goes first:
// prefetchQuery won't refetch fresh seeded data under `staleTime: Infinity`.
const pendingForever = (qc: QueryClient, queryKey: readonly unknown[]) => {
  qc.removeQueries({ queryKey, exact: true })
  void qc.prefetchQuery({ queryKey, queryFn: () => new Promise(() => {}) })
}

test('the sources’ state still loading: Datakällor is a skeleton, never "Okänd status"', async () => {
  const { screen } = await renderSettings('', {
    prepare: (qc) => pendingForever(qc, syncHealthQuery.queryKey),
  })
  // Positive signals first: the page rendered past its reads, and the panel's skeleton mounted.
  await expect
    .element(screen.getByRole('heading', { name: m.charging_tariff_title() }))
    .toBeVisible()
  await expect.poll(() => skeleton('charging-sources')).not.toBeNull()
  expect(screen.getByText(m.charging_source_state_unknown()).elements()).toHaveLength(0)
})

test('the sources’ state failed to load: an error with a retry, not just "Okänd status"', async () => {
  const { screen } = await renderSettings('', {
    prepare: (qc) => qc.removeQueries({ queryKey: syncHealthQuery.queryKey }),
  })
  const alert = screen.getByText(m.charging_sources_error_title())
  await expect.element(alert).toBeVisible()
  // Above the tiles, so a phone shows it without scrolling past four unknowns.
  const sources = screen.getByRole('heading', sourcesHeading)
  expect(
    alert.element().compareDocumentPosition(sources.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0)
})

test('tariffs still loading: the tariff card is a skeleton, and the edit dialog stays in the URL', async () => {
  const { screen, router } = await renderSettings(`?dialog=tariffEdit&tariffId=${TARIFF.id}`, {
    prepare: (qc) => pendingForever(qc, orpc.tariff.list.queryOptions().queryKey),
  })
  // Positive signals first: Datakällor rendered (the page got past its reads) and
  // the tariffs' skeleton mounted (hydrated, tariffs pending); then the URL.
  await expect.element(screen.getByRole('heading', sourcesHeading)).toBeVisible()
  await expect.poll(() => skeleton('charging-tariffs')).not.toBeNull()
  await expect
    .poll(() => router.history.location.search)
    .toBe(`?dialog=tariffEdit&tariffId=${TARIFF.id}`)
  expect(router.state.location.search).toMatchObject({ dialog: 'tariffEdit', tariffId: TARIFF.id })
  // Not opened on a guess, and not an error (ADR-0016).
  // The dialogs are lazy chunks: give a would-be mount time to resolve before asserting absence.
  await new Promise((r) => setTimeout(r, 50))
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_tariff_error_title()).elements()).toHaveLength(0)
})

// --- Credentials: loading, failure, focus (ADR-0026) ------------------------------

test('credentials’ origins still loading: a deep link waits, without a dialog or an error', async () => {
  const { screen, router } = await renderSettings('?dialog=credentials&source=emaldo', {
    prepare: (qc) => pendingForever(qc, credentialsKey),
  })
  // Positive signals first: the page rendered past its reads, and the grid card's
  // skeleton mounted (hydrated, origins pending) in place of the card.
  await expect.element(screen.getByRole('heading', sourcesHeading)).toBeVisible()
  await expect.poll(() => skeleton('charging-grid')).not.toBeNull()
  expect(screen.getByRole('heading', { name: m.charging_grid_title() }).elements()).toHaveLength(0)
  expect(router.state.location.search).toMatchObject({ dialog: 'credentials', source: 'emaldo' })
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_credentials_error_title()).elements()).toHaveLength(0)
})

const gridStatusLines = () => [
  m.charging_grid_status_stored(),
  m.charging_grid_status_env(),
  m.charging_grid_status_missing(),
  m.charging_grid_status_unreadable(),
]

test('a failed credentials read: an alert, no grid status line, and the dialog still opens', async () => {
  const { screen } = await renderSettings('?dialog=credentials&source=emaldo', {
    // Unseeded: the test server has no /api/rpc, so the read fails.
    prepare: (qc) => qc.removeQueries({ queryKey: credentialsKey }),
  })
  await expect.element(screen.getByText(m.charging_credentials_error_title())).toBeVisible()
  await expect
    .element(screen.getByRole('dialog', { name: credentialsTitle('emaldo') }))
    .toBeVisible()
  for (const line of gridStatusLines()) expect(screen.getByText(line).elements()).toHaveLength(0)
})

test('closing the grid dialog returns focus to the grid card’s key button', async () => {
  const { screen } = await renderSettings('')
  await screen.getByRole('button', { name: m.charging_grid_button() }).click()
  const dialog = screen.getByRole('dialog', { name: credentialsTitle('gridTariff') })
  await expect.element(dialog).toBeVisible()
  await dialog.getByRole('button', { name: m.common_cancel() }).click()
  await expect.poll(() => document.activeElement?.id).toBe('credentials-gridTariff')
})

test('the dialog swapping sheet → dialog (a rotation) is not a close: focus stays in it', async () => {
  // The default viewport is a phone: the overlay opens as a bottom sheet.
  const { screen } = await renderSettings('')
  const button = screen.getByRole('button', credentialsButton('Škoda'))
  // Held as an element: the open overlay hides it from role queries.
  const keyButton = button.element()
  await button.click()
  await expect
    .element(screen.getByRole('dialog', { name: credentialsTitle('skoda') }))
    .toBeVisible()
  await expect.poll(() => document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
  const focusedButton = vi.fn()
  keyButton.addEventListener('focus', focusedButton)
  try {
    await page.viewport(1280, 800)
    await expect.poll(() => document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
    // Past the old content's unmount (Radix returns focus on a timeout).
    await new Promise((resolve) => setTimeout(resolve, 100))
    const dialog = screen.getByRole('dialog', { name: credentialsTitle('skoda') })
    await expect.element(dialog).toBeVisible()
    expect(dialog.element().contains(document.activeElement)).toBe(true)
    expect(focusedButton).not.toHaveBeenCalled()
  } finally {
    keyButton.removeEventListener('focus', focusedButton)
    await page.viewport(414, 896)
  }
})

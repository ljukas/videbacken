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
import { render } from 'vitest-browser-react'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
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

function seed(qc: QueryClient, opts: { coverage?: boolean; adminReads?: boolean } = {}) {
  qc.setQueryData(orpc.tariff.list.queryOptions().queryKey, [TARIFF] as never)
  seedSourcesHealth(qc)
  for (const source of ['elpris', 'skoda', 'emaldo'] as const) {
    qc.setQueryData(
      orpc.evCharging.recentRuns.queryOptions({ input: { source, limit: 20 } }).queryKey,
      [],
    )
  }
  if (opts.adminReads !== false)
    qc.setQueryData(orpc.evCharging.recentRuns.queryOptions({ input: { limit: 20 } }).queryKey, [])
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
  expect(
    qc.getQueryState(orpc.evCharging.recentRuns.queryOptions({ input: { limit: 20 } }).queryKey),
  ).toBeUndefined()
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
])('%s is cleaned from the URL', async (_case, search) => {
  const { screen, router } = await renderSettings(search)
  await expect.poll(() => router.state.location.search).not.toHaveProperty('dialog')
  expect(router.state.location.search).not.toHaveProperty('source')
  expect(router.state.location.search).not.toHaveProperty('tariffId')
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

// --- Deferred loading (ADR-0025) ----------------------------------------------

const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

// A query whose fetch never settles stays `pending`. The seeded copy goes first:
// prefetchQuery won't refetch fresh seeded data under `staleTime: Infinity`.
const pendingForever = (qc: QueryClient, queryKey: readonly unknown[]) => {
  qc.removeQueries({ queryKey, exact: true })
  void qc.prefetchQuery({ queryKey, queryFn: () => new Promise(() => {}) })
}

test('one source state still loading: Datakällor is a skeleton, never "Okänd status"', async () => {
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
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_tariff_error_title()).elements()).toHaveLength(0)
})

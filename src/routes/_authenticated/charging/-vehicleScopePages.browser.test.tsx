import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { formatDate } from '~/components/evCharging/format'
import { emptyTotals } from '~/lib/evCharging/cost'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { Route as Economy } from './economy'
import { Route as Overview } from './index'
import { Route as Patterns } from './patterns'

// The real pages mounted under a bare root (routeTree.gen.ts isn't loaded), with
// a cache seeded through the oRPC-generated keys. Anything unseeded fails (the
// test server has no /api/rpc), which is how a failed read is staged. The `-`
// prefix keeps this file out of the route tree.
type AnyRoute = typeof Overview | typeof Patterns | typeof Economy

afterEach(() => {
  vi.restoreAllMocks()
})

const health = (source: string) =>
  ({ source, state: 'ok', lastSuccessAt: null, lastError: null }) as never

function seedShell(qc: QueryClient) {
  qc.setQueryData(orpc.evCharging.syncStatus.queryOptions().queryKey, health('zaptec'))
  qc.setQueryData(
    orpc.evCharging.syncStatus.queryOptions({ input: { source: 'elpris' } }).queryKey,
    health('elpris'),
  )
  qc.setQueryData(
    orpc.evCharging.syncStatus.queryOptions({ input: { source: 'skoda' } }).queryKey,
    health('skoda'),
  )
  qc.setQueryData(
    orpc.evCharging.syncStatus.queryOptions({ input: { source: 'emaldo' } }).queryKey,
    health('emaldo'),
  )
}

async function renderPage(
  route: AnyRoute,
  path: string,
  search: string,
  prepare: (qc: QueryClient) => void,
  role: 'admin' | 'user' = 'admin',
  afterLoad?: (qc: QueryClient) => void,
) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
  seedShell(qc)
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  ;(route as unknown as { update: (o: unknown) => void }).update({
    id: path,
    path,
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([route as never]),
    context: { queryClient: qc, user: { role } },
    history: createMemoryHistory({ initialEntries: [`${path}${search}`] }),
  })
  await router.load()
  afterLoad?.(qc)
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

const radio = (screen: Awaited<ReturnType<typeof renderPage>>['screen'], name: string) =>
  screen.getByRole('radio', { name })

test.each([
  ['patterns', Patterns, '/charging/patterns'],
  ['economy', Economy, '/charging/economy'],
] as const)('%s: a failed read keeps the scope toggle, and Vår bil gives a clean URL', async (_n, route, path) => {
  const { screen, router } = await renderPage(route, path, '?vehicle=other', () => {})
  await expect
    .element(radio(screen, m.charging_vehicle_scope_other()))
    .toHaveAttribute('aria-checked', 'true')
  await radio(screen, m.charging_vehicle_scope_ours()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_ours()))
    .toHaveAttribute('aria-checked', 'true')
  expect(router.state.location.search).not.toHaveProperty('vehicle')
})

// --- Översikt ---------------------------------------------------------------

const totals = { kwh: 0, sessions: 0 }
const tiles = { thisMonth: totals, thisYear: totals, allTime: totals }
const session = (id: string, kwh: number) =>
  ({
    id,
    startAt: new Date('2026-09-15T08:00:00Z'),
    endAt: new Date('2026-09-15T10:00:00Z'),
    energyKwh: kwh,
    peakKw: 10,
    offline: false,
    reliableClock: true,
    vehicle: 'ours',
  }) as never

function seedOverview(qc: QueryClient, vehicle: 'ours' | 'other', sessions: unknown[]) {
  qc.setQueryData(
    orpc.evCharging.overview.queryOptions({ input: { year: undefined, vehicle } }).queryKey,
    { year: 2026, years: [2026], months: [], tiles } as never,
  )
  qc.setQueryData(
    orpc.evCharging.costOverview.queryOptions({ input: { year: undefined, vehicle } }).queryKey,
    { year: 2026, months: [], tiles: { thisMonth: {}, thisYear: {}, allTime: {} } } as never,
  )
  qc.setQueryData(
    orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle } }).queryKey,
    {
      sessions,
      total: sessions.length,
      page: 1,
      pageSize: 10,
    } as never,
  )
}

function seedOverviewShell(qc: QueryClient, opts: { coverage?: boolean } = {}) {
  qc.setQueryData(orpc.tariff.list.queryOptions().queryKey, [] as never)
  qc.setQueryData(orpc.evCharging.recentRuns.queryOptions({ input: { limit: 20 } }).queryKey, [])
  qc.setQueryData(
    orpc.evCharging.recentRuns.queryOptions({ input: { source: 'elpris', limit: 20 } }).queryKey,
    [],
  )
  qc.setQueryData(
    orpc.evCharging.recentRuns.queryOptions({ input: { source: 'skoda', limit: 20 } }).queryKey,
    [],
  )
  qc.setQueryData(
    orpc.evCharging.recentRuns.queryOptions({ input: { source: 'emaldo', limit: 20 } }).queryKey,
    [],
  )
  qc.setQueryData(orpc.evCharging.vehicleStateLatest.queryOptions().queryKey, null)
  if (opts.coverage !== false)
    qc.setQueryData(orpc.evCharging.vehicleRecordCoverage.queryOptions().queryKey, null)
}

test('Översikt, guests with nothing: guest copy, no sync button, even for an admin', async () => {
  const { screen } = await renderPage(Overview, '/charging', '?vehicle=other', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'other', [])
  })
  await expect.element(screen.getByText(m.charging_vehicle_sessions_empty_other())).toBeVisible()
  await expect.element(screen.getByText(m.charging_vehicle_empty_other_description())).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_vehicle_chart_empty_other({ year: 2026 })))
    .toBeVisible()
  // Only the heading's "Synka nu" remains; the empty state offers none.
  expect(
    screen.getByRole('button', { name: m.charging_sync_now(), exact: true }).elements(),
  ).toHaveLength(1)
  expect(screen.getByText(m.charging_sessions_empty_description()).elements()).toHaveLength(0)
})

test('Översikt, our car with nothing: the empty state still offers the admin a sync', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'ours', [])
  })
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(
    screen.getByRole('button', { name: m.charging_sync_now(), exact: true }).elements(),
  ).toHaveLength(2)
})

test('Översikt: the component reads the same query keys the loader fetched for the URL', async () => {
  // Only the `other` scope is seeded, so rows can only appear if the page asks for it.
  const { screen } = await renderPage(Overview, '/charging', '?vehicle=other', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'other', [session('s-other', 7.7)])
  })
  await expect.element(screen.getByText('7,7', { exact: false })).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_sessions_empty_other()).elements()).toHaveLength(0)
})

test('Översikt: switching scope never shows the sessions empty state mid-switch', async () => {
  const { screen, qc } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'ours', [session('s-ours', 3.3)])
    seedOverview(qc, 'other', [])
    // The guests' sessions are the slow read; the rest is cached.
    qc.removeQueries({
      queryKey: orpc.evCharging.sessions.queryOptions({
        input: { page: 1, pageSize: 10, vehicle: 'other' },
      }).queryKey,
    })
  })
  const otherKey = orpc.evCharging.sessions.queryOptions({
    input: { page: 1, pageSize: 10, vehicle: 'other' },
  }).queryKey
  const original = qc.prefetchQuery.bind(qc)
  // Released by hand: no timer to race against the assertions under CI load.
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let held = false
  vi.spyOn(qc, 'prefetchQuery').mockImplementation(((opts: { queryKey: unknown[] }) => {
    if (JSON.stringify(opts.queryKey) !== JSON.stringify(otherKey)) return original(opts as never)
    held = true
    return gate.then(() => {
      qc.setQueryData(otherKey, { sessions: [], total: 0, page: 1, pageSize: 10 } as never)
    })
  }) as never)
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  await radio(screen, m.charging_vehicle_scope_other()).click()
  // Mid-switch (the loader is held on the guests' sessions): the old rows stay and
  // no empty state shows.
  await expect.poll(() => held).toBe(true)
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_sessions_empty_other()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
  release()
  await expect.element(screen.getByText(m.charging_vehicle_sessions_empty_other())).toBeVisible()
})

test('Översikt: a sessions read still pending shows no empty state or sync offer', async () => {
  // Staged like a failed SSR prefetch: the loader's read fails and nothing is dehydrated,
  // so the client mounts the query unseeded and its read stays pending (an in-flight
  // fetch is joined by the page's own observer).
  const key = orpc.evCharging.sessions.queryOptions({
    input: { page: 1, pageSize: 10, vehicle: 'ours' },
  }).queryKey
  const { screen } = await renderPage(
    Overview,
    '/charging',
    '',
    (qc) => {
      seedOverviewShell(qc)
      seedOverview(qc, 'ours', [])
      qc.removeQueries({ queryKey: key })
    },
    'admin',
    (qc) => {
      qc.removeQueries({ queryKey: key })
      void qc.prefetchQuery({ queryKey: key, queryFn: () => new Promise(() => {}) })
    },
  )
  await expect
    .element(screen.getByRole('heading', { name: m.charging_sessions_heading() }))
    .toBeVisible()
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_sessions_empty_description()).elements()).toHaveLength(0)
  expect(
    screen.getByRole('button', { name: m.charging_sync_now(), exact: true }).elements(),
  ).toHaveLength(1)
})

test('Översikt: a failed overview read shows the alert and the toggle; Vår bil gives a clean URL', async () => {
  // Nothing seeded for the overview: the loader's prefetch and the page's read both fail.
  const { screen, router } = await renderPage(Overview, '/charging', '?vehicle=other', (qc) => {
    seedOverviewShell(qc)
    qc.setQueryData(
      orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'other' } })
        .queryKey,
      { sessions: [], total: 0, page: 1, pageSize: 10 } as never,
    )
  })
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(m.charging_overview_error_title())
  await expect
    .element(radio(screen, m.charging_vehicle_scope_other()))
    .toHaveAttribute('aria-checked', 'true')
  await radio(screen, m.charging_vehicle_scope_ours()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_ours()))
    .toHaveAttribute('aria-checked', 'true')
  expect(router.state.location.search).not.toHaveProperty('vehicle')
})

test('Översikt: a failed sessions read shows an error, never the empty list or a sync offer', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'ours', [])
    qc.removeQueries({
      queryKey: orpc.evCharging.sessions.queryOptions({
        input: { page: 1, pageSize: 10, vehicle: 'ours' },
      }).queryKey,
    })
  })
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(m.charging_sessions_error_title())
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_sessions_empty_description()).elements()).toHaveLength(0)
  // Only the heading's "Synka nu" remains; the alert's button says "Försök igen".
  expect(
    screen.getByRole('button', { name: m.charging_sync_now(), exact: true }).elements(),
  ).toHaveLength(1)
})

test('Översikt: an admin sees the car log on the Škoda tile, and ?dialog=vehicleImport opens the import', async () => {
  const { screen } = await renderPage(Overview, '/charging', '?dialog=vehicleImport', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'ours', [])
  })
  await expect.element(screen.getByText(m.charging_vehicle_log_none())).toBeVisible()
  await expect.element(screen.getByText(m.charging_vehicle_import_title())).toBeVisible()
})

test('Översikt: a failed coverage read shows an error on the Škoda tile, not "no log imported"', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc, { coverage: false })
    seedOverview(qc, 'ours', [])
  })
  await expect.element(screen.getByText(m.charging_vehicle_log_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_log_none()).elements()).toHaveLength(0)
})

test('Översikt: a non-admin gets no car log, no import, no dialog, and the param is cleared', async () => {
  const { screen, router } = await renderPage(
    Overview,
    '/charging',
    '?dialog=vehicleImport',
    (qc) => {
      seedOverviewShell(qc)
      seedOverview(qc, 'ours', [])
    },
    'user',
  )
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_log_none()).elements()).toHaveLength(0)
  expect(
    screen.getByRole('button', { name: m.charging_vehicle_import_button() }).elements(),
  ).toHaveLength(0)
  expect(screen.getByText(m.charging_vehicle_import_title()).elements()).toHaveLength(0)
  await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('dialog'))
})

// --- Scope switch keeps the year ---------------------------------------------

test.each([
  ['index', Overview, '/charging', '?year=2025&vehicle=other'],
  ['patterns', Patterns, '/charging/patterns', '?year=2025&vehicle=other'],
  ['economy', Economy, '/charging/economy', '?year=2025&vehicle=other'],
] as const)('%s: switching scope keeps the chosen year', async (_n, route, path, search) => {
  const { screen, router } = await renderPage(route, path, search, (qc) => seedOverviewShell(qc))
  await expect
    .element(radio(screen, m.charging_vehicle_scope_other()))
    .toHaveAttribute('aria-checked', 'true')
  await radio(screen, m.charging_vehicle_scope_ours()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_ours()))
    .toHaveAttribute('aria-checked', 'true')
  expect(router.state.location.search).toMatchObject({ year: 2025 })
  expect(router.state.location.search).not.toHaveProperty('vehicle')
})

test('patterns: switching scope clears the month', async () => {
  const { screen, router } = await renderPage(
    Patterns,
    '/charging/patterns',
    '?year=2025&month=3&vehicle=other',
    () => {},
  )
  await radio(screen, m.charging_vehicle_scope_ours()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_ours()))
    .toHaveAttribute('aria-checked', 'true')
  expect(router.state.location.search).toMatchObject({ year: 2025 })
  expect(router.state.location.search).not.toHaveProperty('month')
})

// --- Datakällor -------------------------------------------------------------

const seedEmptyOverview = (qc: QueryClient) => {
  seedOverviewShell(qc)
  seedOverview(qc, 'ours', [])
}
const sourcesHeading = { name: m.charging_sources_heading(), level: 2 } as const
const historyTitle = (source: string) => m.charging_source_dialog_title({ source })

test('Översikt: admins get the Datakällor panel, household members do not', async () => {
  const admin = await renderPage(Overview, '/charging', '', seedEmptyOverview)
  await expect.element(admin.screen.getByRole('heading', sourcesHeading)).toBeVisible()
  admin.screen.unmount()

  const member = await renderPage(Overview, '/charging', '', seedEmptyOverview, 'user')
  await expect.element(member.screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(member.screen.getByRole('heading', sourcesHeading).elements()).toHaveLength(0)
})

test('Översikt: Historik opens that source in the URL, and closing clears it', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '', seedEmptyOverview)
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

test('Översikt: a deep link opens that source’s history', async () => {
  const { screen } = await renderPage(
    Overview,
    '/charging',
    '?dialog=syncRuns&source=skoda',
    seedEmptyOverview,
  )
  await expect.element(screen.getByRole('dialog', { name: historyTitle('Škoda') })).toBeVisible()
})

test.each([
  ['no source', '?dialog=syncRuns', 'admin'],
  ['an unknown source', '?dialog=syncRuns&source=tesla', 'admin'],
  ['a household member', '?dialog=syncRuns&source=skoda', 'user'],
] as const)('Översikt: a sync-history link with %s is cleaned from the URL', async (_case, search, role) => {
  const { screen, router } = await renderPage(
    Overview,
    '/charging',
    search,
    seedEmptyOverview,
    role,
  )
  await expect.poll(() => router.state.location.search).not.toHaveProperty('dialog')
  expect(router.state.location.search).not.toHaveProperty('source')
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

// --- Cash cost (ADR-0023) ----------------------------------------------------

const TARIFF_ROW = {
  id: '00000000-0000-4000-8000-0000000000aa',
  validFrom: '2026-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}
const summary = (over: Record<string, unknown>) => ({
  ...emptyTotals(),
  avgOre: null,
  complete: true,
  ...over,
})

function seedCost(qc: QueryClient, allTime: Record<string, unknown>, houseDataFrom: Date | null) {
  const t = summary(allTime)
  qc.setQueryData(orpc.tariff.list.queryOptions().queryKey, [TARIFF_ROW] as never)
  qc.setQueryData(
    orpc.evCharging.overview.queryOptions({ input: { year: undefined, vehicle: 'ours' } }).queryKey,
    {
      year: 2026,
      years: [2026],
      months: [],
      tiles: { thisMonth: totals, thisYear: totals, allTime: { kwh: t.kwh, sessions: 1 } },
    } as never,
  )
  qc.setQueryData(
    orpc.evCharging.costOverview.queryOptions({ input: { year: undefined, vehicle: 'ours' } })
      .queryKey,
    {
      year: 2026,
      months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...summary({}) })),
      tiles: { thisMonth: summary({}), thisYear: summary({}), allTime: t },
      houseDataFrom,
    } as never,
  )
  qc.setQueryData(
    orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'ours' } })
      .queryKey,
    { sessions: [], total: 0, page: 1, pageSize: 10 } as never,
  )
}

test('Översikt: energy that was all own solar is a priced 0 kr, with the house-data note', async () => {
  const from = new Date('2026-01-20T06:00:00Z')
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedCost(qc, { kwh: 10, solarKwh: 10, gridKwh: 0 }, from)
  })
  await expect
    .element(screen.getByText(m.charging_cost_note_mix({ date: formatDate(from) })))
    .toBeVisible()
  expect(screen.getByText(m.charging_cost_notice_unpriced()).elements()).toHaveLength(0)
})

test('Översikt: bought energy with no price is the notice, not a 0 kr cost', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedCost(qc, { kwh: 10, solarKwh: 7, gridKwh: 3, noPriceKwh: 3, complete: false }, new Date())
  })
  await expect.element(screen.getByText(m.charging_cost_notice_unpriced())).toBeVisible()
  expect(screen.getByText(/Sol och batteri räknas in/).elements()).toHaveLength(0)
})

test('Översikt: before any house data the note says all charging counts as bought', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedCost(qc, { kwh: 10, gridKwh: 10, fullKwh: 10, totalSek: 20, avgOre: 200 }, null)
  })
  await expect.element(screen.getByText(m.charging_cost_note_all_grid())).toBeVisible()
  expect(screen.getByText(/Sol och batteri räknas in/).elements()).toHaveLength(0)
})

// --- Ekonomi: the grid-only lead ------------------------------------------------

const economyTotals = (sessions: number) => ({
  sessions,
  included: sessions,
  excluded: { noHourly: 0, noPrice: 0 },
  kwh: sessions * 10,
  actualSek: sessions * 20,
  immediateSek: sessions * 22,
  optimalSek: sessions * 15,
  dearestSek: sessions * 25,
  savedVsImmediateSek: sessions * 2,
  leftOnTableSek: sessions * 5,
  score: sessions > 0 ? 0.5 : null,
  paidSpotOre: sessions > 0 ? 100 : null,
  avgSpotOre: sessions > 0 ? 110 : null,
})

function seedEconomy(qc: QueryClient, vehicle: 'ours' | 'other', sessions: number) {
  qc.setQueryData(
    orpc.evCharging.economy.queryOptions({ input: { year: undefined, vehicle } }).queryKey,
    {
      year: 2026,
      years: [2026],
      tiles: economyTotals(sessions),
      months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...economyTotals(0) })),
      sessions: [],
    } as never,
  )
}

test.each([
  ['our car', '', 'ours', '/charging?year=2026'],
  ['guests', '?vehicle=other', 'other', '/charging?year=2026&vehicle=other'],
] as const)('Ekonomi, %s: the grid-only lead links the overview for the same year and scope', async (_n, search, vehicle, href) => {
  const { screen } = await renderPage(Economy, '/charging/economy', search, (qc) =>
    seedEconomy(qc, vehicle, 3),
  )
  await expect
    .element(screen.getByRole('link', { name: m.charging_economy_grid_only_link() }))
    .toHaveAttribute('href', href)
})

test('Ekonomi: no lead without sessions or when the read fails; the scope toggle stays', async () => {
  const empty = await renderPage(Economy, '/charging/economy', '', (qc) =>
    seedEconomy(qc, 'ours', 0),
  )
  await expect
    .element(empty.screen.getByText(m.charging_economy_empty_title({ year: 2026 })))
    .toBeVisible()
  expect(
    empty.screen.getByText(m.charging_economy_grid_only_heading(), { exact: false }).elements(),
  ).toHaveLength(0)
  await empty.screen.unmount()

  const failed = await renderPage(Economy, '/charging/economy', '', () => {})
  await expect
    .element(radio(failed.screen, m.charging_vehicle_scope_ours()))
    .toHaveAttribute('aria-checked', 'true')
  expect(
    failed.screen.getByText(m.charging_economy_grid_only_heading(), { exact: false }).elements(),
  ).toHaveLength(0)
})

// --- Översikt: the session list's pages -------------------------------------

// One seeded page of the list: `rows` sessions, `total` across all pages, and
// the page the server says it served (the requested one unless it clamped).
function seedSessionsPage(
  qc: QueryClient,
  input: { page: number; pageSize: 10 | 25 | 50; vehicle?: 'ours' | 'other' },
  rows: unknown[],
  total: number,
  served = input.page,
) {
  qc.setQueryData(
    orpc.evCharging.sessions.queryOptions({ input: { vehicle: 'ours', ...input } }).queryKey,
    { sessions: rows, total, page: served, pageSize: input.pageSize } as never,
  )
}

function seedPagedOverview(qc: QueryClient) {
  seedOverviewShell(qc)
  seedOverview(qc, 'ours', [])
  seedOverview(qc, 'other', [])
  seedSessionsPage(qc, { page: 1, pageSize: 10 }, [session('p1', 1.1)], 25)
  seedSessionsPage(qc, { page: 2, pageSize: 10 }, [session('p2', 2.2)], 25)
  seedSessionsPage(qc, { page: 3, pageSize: 10 }, [session('p3', 3.3)], 25)
  seedSessionsPage(qc, { page: 1, pageSize: 25 }, [session('p1-25', 4.4)], 25)
}

test('Översikt: ?page=2 shows the second page of sessions', async () => {
  const { screen } = await renderPage(Overview, '/charging', '?page=2', seedPagedOverview)
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent(m.charging_sessions_pagination_range({ from: 11, to: 20, total: 25 }))
  await expect
    .element(screen.getByRole('button', { name: '2', exact: true }))
    .toHaveAttribute('aria-current', 'page')
})

test('Översikt: a page link puts the page in the URL; page 1 is a clean URL', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '', seedPagedOverview)
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  await screen.getByRole('button', { name: '3', exact: true }).click()
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ page: 3 })
  await screen.getByRole('button', { name: '1', exact: true }).click()
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  expect(router.state.location.search).not.toHaveProperty('page')
})

test('Översikt: back steps to the previous page', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?page=2', seedPagedOverview)
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  await screen.getByRole('button', { name: m.charging_sessions_pagination_next() }).click()
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  router.history.back()
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ page: 2 })
})

test('Översikt: a new page size starts over at its first page', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?page=2', seedPagedOverview)
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  await screen.getByRole('combobox', { name: m.charging_sessions_pagination_page_size() }).click()
  await screen.getByRole('option', { name: '25' }).click()
  await expect.element(screen.getByText('4,4', { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ size: 25 })
  expect(router.state.location.search).not.toHaveProperty('page')
})

test('Översikt: another vehicle scope starts at its first page', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?page=2', (qc) => {
    seedPagedOverview(qc)
    seedSessionsPage(qc, { page: 1, pageSize: 10, vehicle: 'other' }, [session('g1', 5.5)], 1)
  })
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  await radio(screen, m.charging_vehicle_scope_other()).click()
  await expect.element(screen.getByText('5,5', { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ vehicle: 'other' })
  expect(router.state.location.search).not.toHaveProperty('page')
})

test('Översikt: a stale page past the end shows the last page the server served', async () => {
  const { screen } = await renderPage(Overview, '/charging', '?page=9', (qc) => {
    seedPagedOverview(qc)
    seedSessionsPage(qc, { page: 9, pageSize: 10 }, [session('p3', 3.3)], 25, 3)
  })
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent(m.charging_sessions_pagination_range({ from: 21, to: 25, total: 25 }))
  await expect
    .element(screen.getByRole('button', { name: '3', exact: true }))
    .toHaveAttribute('aria-current', 'page')
})

test('Översikt: a garbage ?size= falls back to 10 rows', async () => {
  const { screen } = await renderPage(Overview, '/charging', '?size=7', seedPagedOverview)
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  await expect
    .element(screen.getByRole('combobox', { name: m.charging_sessions_pagination_page_size() }))
    .toHaveTextContent('10')
})

test('Översikt: the loader prefetches the page and size in the URL, then that page’s costs', async () => {
  const keys: string[] = []
  await renderPage(Overview, '/charging', '?page=2&size=25', (qc) => {
    seedPagedOverview(qc)
    seedSessionsPage(qc, { page: 2, pageSize: 25 }, [session('p2-25', 6.6)], 40)
    const original = qc.prefetchQuery.bind(qc)
    vi.spyOn(qc, 'prefetchQuery').mockImplementation(((opts: { queryKey: unknown }) => {
      keys.push(JSON.stringify(opts.queryKey))
      return original(opts as never)
    }) as never)
  })
  const key = (input: unknown) => JSON.stringify(input)
  expect(keys).toContain(
    key(
      orpc.evCharging.sessions.queryOptions({ input: { page: 2, pageSize: 25, vehicle: 'ours' } })
        .queryKey,
    ),
  )
  expect(keys).not.toContain(
    key(
      orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'ours' } })
        .queryKey,
    ),
  )
  expect(keys).toContain(
    key(orpc.evCharging.sessionCosts.queryOptions({ input: { sessionIds: ['p2-25'] } }).queryKey),
  )
})

test('Översikt: previous from a page past the end steps back from the page served', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?page=9', (qc) => {
    seedPagedOverview(qc)
    seedSessionsPage(qc, { page: 9, pageSize: 10 }, [session('p3', 3.3)], 25, 3)
  })
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  await screen.getByRole('button', { name: m.charging_sessions_pagination_previous() }).click()
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ page: 2 })
})

test('Översikt: another year keeps the page (the list is all-time)', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?page=2', (qc) => {
    seedPagedOverview(qc)
    qc.setQueryData(
      orpc.evCharging.overview.queryOptions({ input: { year: undefined, vehicle: 'ours' } })
        .queryKey,
      { year: 2026, years: [2026, 2025], months: [], tiles } as never,
    )
  })
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  await screen.getByRole('combobox', { name: m.charging_year_label() }).click()
  await screen.getByRole('option', { name: '2025' }).click()
  await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ year: 2025 }))
  expect(router.state.location.search).toMatchObject({ page: 2 })
})

test('Översikt: another vehicle scope keeps the page size', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?size=25', (qc) => {
    seedPagedOverview(qc)
    seedSessionsPage(qc, { page: 1, pageSize: 25, vehicle: 'other' }, [session('g1', 5.5)], 1)
  })
  await expect.element(screen.getByText('4,4', { exact: false })).toBeVisible()
  await radio(screen, m.charging_vehicle_scope_other()).click()
  await expect.element(screen.getByText('5,5', { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ vehicle: 'other', size: 25 })
})

test('Översikt: choosing 10 rows again gives a clean URL', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?size=25', seedPagedOverview)
  await expect.element(screen.getByText('4,4', { exact: false })).toBeVisible()
  await screen.getByRole('combobox', { name: m.charging_sessions_pagination_page_size() }).click()
  await screen.getByRole('option', { name: '10' }).click()
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  expect(router.state.location.search).not.toHaveProperty('size')
})

test('Översikt: a size change replaces the page it left in history', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?page=2', seedPagedOverview)
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  await screen.getByRole('button', { name: '3', exact: true }).click()
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  await screen.getByRole('combobox', { name: m.charging_sessions_pagination_page_size() }).click()
  await screen.getByRole('option', { name: '25' }).click()
  await expect.element(screen.getByText('4,4', { exact: false })).toBeVisible()
  // Back skips the replaced page-3 entry and lands on page 2.
  router.history.back()
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ page: 2 })
  expect(router.state.location.search).not.toHaveProperty('size')
})

test('Översikt: a page that fails to load keeps the last page, dimmed, under the alert', async () => {
  // Page 2 is unseeded, so its read fails (no /api/rpc in the test server).
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'ours', [])
    seedSessionsPage(qc, { page: 1, pageSize: 10 }, [session('p1', 1.1)], 25)
  })
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  const two = screen.getByRole('button', { name: '2', exact: true })
  await two.click()
  await expect.element(screen.getByText(m.charging_sessions_error_title())).toBeVisible()
  // The rows and the control stay (focus with them), never an empty state.
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  expect(document.activeElement).toBe(two.element())
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
  const list = screen.getByRole('table').element().closest('[aria-busy]')
  expect(list?.getAttribute('aria-busy')).toBe('false')
  expect(list?.className).toContain('opacity-60')
})

// --- Ekonomi: the session table's pages ----------------------------------------

// The year's sessions, newest first: row n (1-based) charged 100 + n + 0.1 kWh,
// so "101,1" is the newest and each row's kWh names it.
function seedEconomyRows(qc: QueryClient, count: number, years = [2026]) {
  const cost = (totalSek: number) => ({ ...emptyTotals(), kwh: 10, gridKwh: 10, totalSek })
  const rows = Array.from({ length: count }, (_, i) => ({
    sessionId: `e${i + 1}`,
    startAt: new Date(Date.UTC(2026, 8, 30 - i, 18)),
    endAt: new Date(Date.UTC(2026, 8, 30 - i, 20)),
    kwh: 100 + i + 1 + 0.1,
    actual: cost(20),
    actualComplete: true,
    paidSpotOre: 40,
    windowAvgSpotOre: 55,
    vehicle: 'ours',
    excluded: null,
    counterfactual: {
      immediate: cost(25),
      optimal: cost(15),
      dearest: cost(30),
      score: 0.5,
      savedVsImmediateSek: 5,
      leftOnTableSek: 5,
    },
  }))
  qc.setQueryData(
    orpc.evCharging.economy.queryOptions({ input: { year: undefined, vehicle: 'ours' } }).queryKey,
    {
      year: 2026,
      years,
      tiles: economyTotals(count),
      months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...economyTotals(0) })),
      sessions: rows,
    } as never,
  )
}

const kwhCell = (n: number) => `${100 + n},1`

test('Ekonomi: the session table shows its newest 10, then pages through the year', async () => {
  const { screen, router } = await renderPage(Economy, '/charging/economy', '', (qc) =>
    seedEconomyRows(qc, 23),
  )
  await expect.element(screen.getByText(kwhCell(1), { exact: false })).toBeVisible()
  await expect.element(screen.getByText(kwhCell(10), { exact: false })).toBeVisible()
  expect(screen.getByText(kwhCell(11), { exact: false }).elements()).toHaveLength(0)
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent(m.charging_sessions_pagination_range({ from: 1, to: 10, total: 23 }))
  await screen.getByRole('button', { name: '3', exact: true }).click()
  await expect.element(screen.getByText(kwhCell(23), { exact: false })).toBeVisible()
  expect(screen.getByText(kwhCell(1), { exact: false }).elements()).toHaveLength(0)
  expect(router.state.location.search).toMatchObject({ page: 3 })
})

test('Ekonomi: 25 rows per page shows the whole year on one page', async () => {
  const { screen, router } = await renderPage(Economy, '/charging/economy', '?page=2', (qc) =>
    seedEconomyRows(qc, 23),
  )
  await expect.element(screen.getByText(kwhCell(11), { exact: false })).toBeVisible()
  await screen.getByRole('combobox', { name: m.charging_sessions_pagination_page_size() }).click()
  await screen.getByRole('option', { name: '25' }).click()
  await expect.element(screen.getByText(kwhCell(1), { exact: false })).toBeVisible()
  await expect.element(screen.getByText(kwhCell(23), { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ size: 25 })
  expect(router.state.location.search).not.toHaveProperty('page')
})

test('Ekonomi: a page past the end shows the last page', async () => {
  const { screen } = await renderPage(Economy, '/charging/economy', '?page=9', (qc) =>
    seedEconomyRows(qc, 23),
  )
  await expect.element(screen.getByText(kwhCell(21), { exact: false })).toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: '3', exact: true }))
    .toHaveAttribute('aria-current', 'page')
})

test('Ekonomi: another year starts the table at its first page', async () => {
  const { screen, router } = await renderPage(Economy, '/charging/economy', '?page=2', (qc) =>
    seedEconomyRows(qc, 23, [2026, 2025]),
  )
  await expect.element(screen.getByText(kwhCell(11), { exact: false })).toBeVisible()
  await screen.getByRole('combobox', { name: m.charging_year_label() }).click()
  await screen.getByRole('option', { name: '2025' }).click()
  await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ year: 2025 }))
  expect(router.state.location.search).not.toHaveProperty('page')
})

test('Ekonomi: another vehicle scope starts the table at its first page', async () => {
  const { screen, router } = await renderPage(Economy, '/charging/economy', '?page=2', (qc) =>
    seedEconomyRows(qc, 23),
  )
  await expect.element(screen.getByText(kwhCell(11), { exact: false })).toBeVisible()
  await radio(screen, m.charging_vehicle_scope_other()).click()
  await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ vehicle: 'other' }))
  expect(router.state.location.search).not.toHaveProperty('page')
})

test('Ekonomi: ten sessions or fewer need no pagination', async () => {
  const { screen } = await renderPage(Economy, '/charging/economy', '', (qc) =>
    seedEconomyRows(qc, 10),
  )
  await expect.element(screen.getByText(kwhCell(10), { exact: false })).toBeVisible()
  expect(
    screen.getByRole('navigation', { name: m.charging_sessions_pagination_label() }).elements(),
  ).toHaveLength(0)
})

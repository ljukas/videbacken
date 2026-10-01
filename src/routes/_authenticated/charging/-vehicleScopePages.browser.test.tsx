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
    orpc.evCharging.sessions.queryOptions({ input: { limit: 20, vehicle } }).queryKey,
    {
      sessions,
      hasMore: false,
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
  expect(screen.getByRole('button', { name: m.charging_sync_now() }).elements()).toHaveLength(1)
  expect(screen.getByText(m.charging_sessions_empty_description()).elements()).toHaveLength(0)
})

test('Översikt, our car with nothing: the empty state still offers the admin a sync', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'ours', [])
  })
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(screen.getByRole('button', { name: m.charging_sync_now() }).elements()).toHaveLength(2)
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
      queryKey: orpc.evCharging.sessions.queryOptions({ input: { limit: 20, vehicle: 'other' } })
        .queryKey,
    })
  })
  const otherKey = orpc.evCharging.sessions.queryOptions({
    input: { limit: 20, vehicle: 'other' },
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
      qc.setQueryData(otherKey, { sessions: [], hasMore: false } as never)
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
    input: { limit: 20, vehicle: 'ours' },
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
  expect(screen.getByRole('button', { name: m.charging_sync_now() }).elements()).toHaveLength(1)
})

test('Översikt: a failed overview read shows the alert and the toggle; Vår bil gives a clean URL', async () => {
  // Nothing seeded for the overview: the loader's prefetch and the page's read both fail.
  const { screen, router } = await renderPage(Overview, '/charging', '?vehicle=other', (qc) => {
    seedOverviewShell(qc)
    qc.setQueryData(
      orpc.evCharging.sessions.queryOptions({ input: { limit: 20, vehicle: 'other' } }).queryKey,
      { sessions: [], hasMore: false } as never,
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
      queryKey: orpc.evCharging.sessions.queryOptions({ input: { limit: 20, vehicle: 'ours' } })
        .queryKey,
    })
  })
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(m.charging_sessions_error_title())
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_sessions_empty_description()).elements()).toHaveLength(0)
  // Only the heading's "Synka nu" remains; the alert's button says "Försök igen".
  expect(screen.getByRole('button', { name: m.charging_sync_now() }).elements()).toHaveLength(1)
})

test('Översikt: an admin sees the car-log card, and ?dialog=vehicleImport opens the import', async () => {
  const { screen } = await renderPage(Overview, '/charging', '?dialog=vehicleImport', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'ours', [])
  })
  await expect.element(screen.getByText(m.charging_vehicle_log_none())).toBeVisible()
  await expect.element(screen.getByText(m.charging_vehicle_import_title())).toBeVisible()
})

test('Översikt: a failed coverage read shows an error in the card, not "no log imported"', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc, { coverage: false })
    seedOverview(qc, 'ours', [])
  })
  await expect.element(screen.getByText(m.charging_vehicle_log_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_log_none()).elements()).toHaveLength(0)
})

test('Översikt: a non-admin gets no card, no dialog, and the param is cleared', async () => {
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
  expect(screen.getByText(m.charging_vehicle_log_title()).elements()).toHaveLength(0)
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

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
    context: { queryClient: qc, user: { role: 'admin' } },
    history: createMemoryHistory({ initialEntries: [`${path}${search}`] }),
  })
  await router.load()
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
  expect('vehicle' in (router.state.location.search as object)).toBe(false)
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

function seedOverviewShell(qc: QueryClient) {
  qc.setQueryData(orpc.tariff.list.queryOptions().queryKey, [] as never)
  qc.setQueryData(orpc.evCharging.recentRuns.queryOptions({ input: { limit: 20 } }).queryKey, [])
  qc.setQueryData(
    orpc.evCharging.recentRuns.queryOptions({ input: { source: 'elpris', limit: 20 } }).queryKey,
    [],
  )
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
  const original = qc.ensureQueryData.bind(qc)
  vi.spyOn(qc, 'ensureQueryData').mockImplementation(((opts: { queryKey: unknown[] }) => {
    if (JSON.stringify(opts.queryKey) !== JSON.stringify(otherKey)) return original(opts as never)
    return new Promise((resolve) =>
      setTimeout(() => {
        const data = { sessions: [], hasMore: false }
        qc.setQueryData(otherKey, data as never)
        resolve(data)
      }, 500),
    )
  }) as never)
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  await radio(screen, m.charging_vehicle_scope_other()).click()
  // Mid-switch: the old rows stay, and the empty state hasn't appeared.
  await new Promise((r) => setTimeout(r, 200))
  expect(screen.getByText(m.charging_vehicle_sessions_empty_other()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
  await expect.element(screen.getByText(m.charging_vehicle_sessions_empty_other())).toBeVisible()
})

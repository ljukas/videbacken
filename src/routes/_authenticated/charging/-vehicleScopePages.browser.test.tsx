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
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { emptyTotals } from '~/lib/evCharging/cost'
import type { EconomyListRow } from '~/lib/evCharging/economy'
import { SESSION_PAGE_SIZES, type SessionPageSize } from '~/lib/evCharging/paging'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { seedSourcesHealth } from '~test/browser/syncHealth'
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

function seedShell(qc: QueryClient) {
  seedSourcesHealth(qc)
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

// A query whose fetch never settles stays `pending`. The seeded copy goes first:
// prefetchQuery won't refetch fresh seeded data under `staleTime: Infinity`.
const pendingForever = (qc: QueryClient, queryKey: readonly unknown[]) => {
  qc.removeQueries({ queryKey, exact: true })
  void qc.prefetchQuery({ queryKey, queryFn: () => new Promise(() => {}) })
}
const overviewKey = orpc.evCharging.overview.queryOptions({
  input: { year: undefined, vehicle: 'all' },
}).queryKey
const tariffsKey = orpc.tariff.list.queryOptions().queryKey
const costKey = orpc.evCharging.costOverview.queryOptions({
  input: { year: undefined, vehicle: 'all' },
}).queryKey

test.each([
  ['patterns', Patterns, '/charging/patterns'],
  ['economy', Economy, '/charging/economy'],
] as const)('%s: a failed read keeps the scope toggle, and Alla gives a clean URL', async (_n, route, path) => {
  const { screen, router } = await renderPage(route, path, '?vehicle=other', () => {})
  await expect
    .element(radio(screen, m.charging_vehicle_scope_other()))
    .toHaveAttribute('aria-checked', 'true')
  await radio(screen, m.charging_vehicle_scope_all()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_all()))
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

function seedOverview(qc: QueryClient, vehicle: VehicleScope, sessions: unknown[]) {
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
      costs: [],
    } as never,
  )
}

function seedOverviewShell(qc: QueryClient) {
  qc.setQueryData(orpc.tariff.list.queryOptions().queryKey, [] as never)
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

test('Översikt, everyone with nothing: the empty state still offers the admin a sync', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'all', [])
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
    seedOverview(qc, 'all', [session('s-all', 3.3)])
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
      qc.setQueryData(otherKey, {
        sessions: [],
        total: 0,
        page: 1,
        pageSize: 10,
        costs: [],
      } as never)
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
    input: { page: 1, pageSize: 10, vehicle: 'all' },
  }).queryKey
  const { screen } = await renderPage(
    Overview,
    '/charging',
    '',
    (qc) => {
      seedOverviewShell(qc)
      seedOverview(qc, 'all', [])
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

test('Översikt: a failed overview read shows the alert and the toggle; Alla gives a clean URL', async () => {
  // Nothing seeded for the overview: the loader's prefetch and the page's read both fail.
  const { screen, router } = await renderPage(Overview, '/charging', '?vehicle=other', (qc) => {
    seedOverviewShell(qc)
    qc.setQueryData(
      orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'other' } })
        .queryKey,
      { sessions: [], total: 0, page: 1, pageSize: 10, costs: [] } as never,
    )
  })
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent(m.charging_overview_error_title())
  expect(
    screen.getByRole('radiogroup', { name: m.charging_vehicle_scope_label() }).elements(),
  ).toHaveLength(1)
  await expect
    .element(radio(screen, m.charging_vehicle_scope_other()))
    .toHaveAttribute('aria-checked', 'true')
  await radio(screen, m.charging_vehicle_scope_all()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_all()))
    .toHaveAttribute('aria-checked', 'true')
  expect(router.state.location.search).not.toHaveProperty('vehicle')
})

test('Översikt: a failed sessions read shows an error, never the empty list or a sync offer', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'all', [])
    qc.removeQueries({
      queryKey: orpc.evCharging.sessions.queryOptions({
        input: { page: 1, pageSize: 10, vehicle: 'all' },
      }).queryKey,
    })
  })
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent(m.charging_sessions_error_title())
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_sessions_empty_description()).elements()).toHaveLength(0)
  // Only the heading's "Synka nu" remains; the alert's button says "Försök igen".
  expect(
    screen.getByRole('button', { name: m.charging_sync_now(), exact: true }).elements(),
  ).toHaveLength(1)
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
  await radio(screen, m.charging_vehicle_scope_all()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_all()))
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
  await radio(screen, m.charging_vehicle_scope_all()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_all()))
    .toHaveAttribute('aria-checked', 'true')
  expect(router.state.location.search).toMatchObject({ year: 2025 })
  expect(router.state.location.search).not.toHaveProperty('month')
})

// --- Seeds shared by the overview tests --------------------------------------

const seedEmptyOverview = (qc: QueryClient) => {
  seedOverviewShell(qc)
  seedOverview(qc, 'all', [])
}

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
    orpc.evCharging.overview.queryOptions({ input: { year: undefined, vehicle: 'all' } }).queryKey,
    {
      year: 2026,
      years: [2026],
      months: [],
      tiles: { thisMonth: totals, thisYear: totals, allTime: { kwh: t.kwh, sessions: 1 } },
    } as never,
  )
  qc.setQueryData(
    orpc.evCharging.costOverview.queryOptions({ input: { year: undefined, vehicle: 'all' } })
      .queryKey,
    {
      year: 2026,
      months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...summary({}) })),
      tiles: { thisMonth: summary({}), thisYear: summary({}), allTime: t },
      houseDataFrom,
    } as never,
  )
  qc.setQueryData(
    orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'all' } })
      .queryKey,
    { sessions: [], total: 0, page: 1, pageSize: 10, costs: [] } as never,
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

test('Översikt: when a page’s costs failed, the rows stay and an alert offers a retry, never 0 kr', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedCost(qc, { kwh: 10, gridKwh: 10, fullKwh: 10, totalSek: 20, avgOre: 200 }, null)
    qc.setQueryData(
      orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'all' } })
        .queryKey,
      { sessions: [session('s1', 7.7)], total: 1, page: 1, pageSize: 10, costs: null } as never,
    )
  })
  await expect.element(screen.getByText('7,7', { exact: false })).toBeVisible()
  await expect.element(screen.getByText(m.charging_sessions_costs_error_title())).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.common_try_again() })).toBeVisible()
  expect(screen.getByText('0,00 kr', { exact: false }).elements()).toHaveLength(0)
})

test('Översikt: costs that loaded show no costs alert', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedCost(qc, { kwh: 10, gridKwh: 10, fullKwh: 10, totalSek: 20, avgOre: 200 }, null)
    qc.setQueryData(
      orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'all' } })
        .queryKey,
      { sessions: [session('s1', 7.7)], total: 1, page: 1, pageSize: 10, costs: [] } as never,
    )
  })
  await expect.element(screen.getByText('7,7', { exact: false })).toBeVisible()
  expect(screen.getByText(m.charging_sessions_costs_error_title()).elements()).toHaveLength(0)
})

// --- Översikt: deferred loading (ADR-0025) ------------------------------------

const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

test('Översikt, overview still loading: totals and chart show skeletons, the scope toggle is usable', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverview(qc, 'all', [session('s1', 5)])
    seedOverviewShell(qc)
    pendingForever(qc, overviewKey)
  })
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  // The skeletons mount once hydrated: wait for them, don't race the first render.
  await expect.poll(() => skeleton('charging-totals')).not.toBeNull()
  await expect.poll(() => skeleton('charging-chart')).not.toBeNull()
  // Loading is not an error (ADR-0016).
  expect(screen.getByText(m.charging_overview_error_title()).elements()).toHaveLength(0)
})

test('Översikt, cost still loading: the totals and chart hold their skeletons, so the kr readout cannot jump in', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedCost(qc, { kwh: 10, gridKwh: 10, fullKwh: 10, totalSek: 20, avgOre: 200 }, null)
    qc.setQueryData(
      orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'all' } })
        .queryKey,
      { sessions: [session('s1', 7.7)], total: 1, page: 1, pageSize: 10, costs: [] } as never,
    )
    pendingForever(qc, costKey)
  })
  // The sessions are in (a positive signal the page has rendered past its loader).
  await expect.element(screen.getByText('7,7', { exact: false })).toBeVisible()
  await expect.poll(() => skeleton('charging-totals')).not.toBeNull()
  expect(skeleton('charging-chart')).not.toBeNull()
  expect(
    screen.getByRole('heading', { name: m.charging_totals_heading() }).elements(),
  ).toHaveLength(0)
  // Nor does the notice show before the cost has settled.
  expect(screen.getByText(m.charging_cost_notice_unpriced()).elements()).toHaveLength(0)
})

test('Översikt, overview, cost and tariffs in: no skeleton above the fold', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedCost(qc, { kwh: 10, gridKwh: 10, fullKwh: 10, totalSek: 20, avgOre: 200 }, null)
  })
  await expect
    .element(screen.getByRole('heading', { name: m.charging_totals_heading() }))
    .toBeInTheDocument()
  await expect.element(screen.getByText(m.charging_cost_note_all_grid())).toBeVisible()
  expect(skeleton('charging-totals')).toBeNull()
  expect(skeleton('charging-chart')).toBeNull()
})

test('Översikt, tariffs still loading: no "set up a tariff" notice', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    // Energy, so the no-tariff notice would show if empty tariffs were assumed.
    seedCost(qc, { kwh: 10, gridKwh: 10 }, null)
    pendingForever(qc, tariffsKey)
  })
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  // Positive signals first: the totals' skeleton (hydrated, tariffs pending) and the
  // sessions' empty state (the page rendered past its reads). The tariff card and
  // Datakällor live on /charging/settings (see -settingsPage.browser.test.tsx).
  await expect.poll(() => skeleton('charging-totals')).not.toBeNull()
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(screen.getByText(m.charging_cost_notice_setup_admin()).elements()).toHaveLength(0)
  expect(skeleton('charging-tariffs')).toBeNull()
  expect(skeleton('charging-sources')).toBeNull()
})

// --- Ekonomi and Mönster: deferred loading (ADR-0025) -------------------------

const economyKey = orpc.evCharging.economy.queryOptions({
  input: { year: undefined, vehicle: 'all' },
}).queryKey
// The economy table's page as the route requests it for a clean URL's scope.
const economySessionsKey = (page: number, pageSize: SessionPageSize = 10) =>
  orpc.evCharging.economySessions.queryOptions({
    input: { year: undefined, vehicle: 'all', page, pageSize },
  }).queryKey
const timelineKey = orpc.evCharging.timeline.queryOptions({
  input: { year: undefined, month: undefined, vehicle: 'all' },
}).queryKey

// A loaded patterns read with one charged hour, so the page shows its sections
// (and the timeline card) rather than the empty state.
function seedPatterns(qc: QueryClient, vehicle: VehicleScope = 'all') {
  const slot = (kwh: number) => ({ kwh, pluggedHours: kwh })
  qc.setQueryData(
    orpc.evCharging.patterns.queryOptions({ input: { year: undefined, vehicle } }).queryKey,
    {
      year: 2026,
      years: [2026],
      weekdayHour: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => slot(0))),
      hourOfDay: Array.from({ length: 24 }, (_, h) => slot(h === 3 ? 5 : 0)),
      daily: [],
      months: Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        kwh: i === 0 ? 5 : 0,
        sessions: i === 0 ? 1 : 0,
      })),
      unhourlySessions: 0,
    } as never,
  )
}

test('Ekonomi still loading: one skeleton for the body, heading and scope toggle usable', async () => {
  const { screen } = await renderPage(Economy, '/charging/economy', '', (qc) => {
    pendingForever(qc, economyKey)
  })
  await expect
    .element(screen.getByRole('heading', { name: m.charging_economy_title() }))
    .toBeVisible()
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  await expect.poll(() => skeleton('charging-economy')).not.toBeNull()
  // Loading is not an error (ADR-0016).
  expect(screen.getByText(m.charging_economy_error_title()).elements()).toHaveLength(0)
})

test('Ekonomi loaded: no skeleton', async () => {
  const { screen } = await renderPage(Economy, '/charging/economy', '', (qc) =>
    seedEconomy(qc, 'all', 3),
  )
  await expect
    .element(screen.getByRole('link', { name: m.charging_economy_grid_only_link() }))
    .toBeVisible()
  expect(skeleton('charging-economy')).toBeNull()
  expect(skeleton('charging-economy-sessions')).toBeNull()
})

test('Ekonomi loaded, session table still loading: only the table is a skeleton', async () => {
  const { screen } = await renderPage(Economy, '/charging/economy', '', (qc) => {
    seedEconomy(qc, 'all', 3)
    pendingForever(qc, economySessionsKey(1))
  })
  await expect
    .element(screen.getByRole('link', { name: m.charging_economy_grid_only_link() }))
    .toBeVisible()
  await expect.poll(() => skeleton('charging-economy-sessions')).not.toBeNull()
  expect(skeleton('charging-economy')).toBeNull()
  expect(screen.getByText(m.charging_sessions_error_title()).elements()).toHaveLength(0)
})

test('Mönster still loading: one skeleton for the body, heading and scope toggle usable', async () => {
  const { screen } = await renderPage(Patterns, '/charging/patterns', '', (qc) => {
    pendingForever(
      qc,
      orpc.evCharging.patterns.queryOptions({ input: { year: undefined, vehicle: 'all' } })
        .queryKey,
    )
  })
  await expect
    .element(screen.getByRole('heading', { name: m.charging_patterns_title() }))
    .toBeVisible()
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  await expect.poll(() => skeleton('charging-patterns')).not.toBeNull()
})

test('Mönster loaded, timeline still loading: only the timeline is a skeleton', async () => {
  const { screen } = await renderPage(Patterns, '/charging/patterns', '', (qc) => {
    seedPatterns(qc)
    pendingForever(qc, timelineKey)
  })
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  await expect.poll(() => skeleton('charging-timeline')).not.toBeNull()
  expect(skeleton('charging-patterns')).toBeNull()
})

test.each([
  ['Ekonomi', Economy, '/charging/economy', () => m.charging_economy_title()],
  ['Mönster', Patterns, '/charging/patterns', () => m.charging_patterns_title()],
] as const)('%s, sync health still loading: no "never synced" line and no health alert', async (_n, route, path, title) => {
  const { screen } = await renderPage(route, path, '', (qc) => {
    pendingForever(qc, syncHealthQuery.queryKey)
  })
  await expect.element(screen.getByRole('heading', { name: title() })).toBeVisible()
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  expect(screen.getByText(m.charging_never_synced()).elements()).toHaveLength(0)
  expect(document.querySelector('[role="alert"]')).toBeNull()
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

// The year's sessions, newest first: row n (1-based) charged 100 + n + 0.1 kWh,
// so "101,1" is the newest and each row's kWh names it.
const economyRow = (n: number): EconomyListRow => ({
  sessionId: `e${n}`,
  startAt: new Date(Date.UTC(2026, 8, 31 - n, 18)),
  endAt: new Date(Date.UTC(2026, 8, 31 - n, 20)),
  kwh: 100 + n + 0.1,
  actualSek: 20,
  vehicle: 'ours',
  excluded: null,
  counterfactual: { score: 0.5, savedVsImmediateSek: 5, leftOnTableSek: 5, spreadSek: 15 },
})

// One page of the economy table as the server serves it: `total` sessions in
// the scope, and the page it says it served (the requested one unless it clamped).
function seedEconomyPage(
  qc: QueryClient,
  input: { page: number; pageSize: SessionPageSize; year?: number; vehicle?: VehicleScope },
  total: number,
  served = input.page,
) {
  const from = (served - 1) * input.pageSize + 1
  const count = Math.max(0, Math.min(input.pageSize, total - from + 1))
  qc.setQueryData(
    orpc.evCharging.economySessions.queryOptions({
      input: { year: undefined, vehicle: 'all', ...input },
    }).queryKey,
    {
      page: served,
      pageSize: input.pageSize,
      total,
      rows: Array.from({ length: count }, (_, i) => economyRow(from + i)),
    },
  )
}

function seedEconomyOverview(
  qc: QueryClient,
  vehicle: VehicleScope,
  sessions: number,
  years = [2026],
) {
  qc.setQueryData(
    orpc.evCharging.economy.queryOptions({ input: { year: undefined, vehicle } }).queryKey,
    {
      year: 2026,
      years,
      tiles: economyTotals(sessions),
      months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...economyTotals(0) })),
    } as never,
  )
}

// The page's overview and its table's first page (what a clean URL reads).
function seedEconomy(qc: QueryClient, vehicle: VehicleScope, sessions: number) {
  seedEconomyOverview(qc, vehicle, sessions)
  seedEconomyPage(qc, { page: 1, pageSize: 10, vehicle }, sessions)
}

test.each([
  ['everyone', '', 'all', '/charging?year=2026'],
  ['our car', '?vehicle=ours', 'ours', '/charging?year=2026&vehicle=ours'],
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
    seedEconomy(qc, 'all', 0),
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
    .element(radio(failed.screen, m.charging_vehicle_scope_all()))
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
  input: { page: number; pageSize: 10 | 25 | 50; vehicle?: VehicleScope },
  rows: unknown[],
  total: number,
  served = input.page,
) {
  qc.setQueryData(
    orpc.evCharging.sessions.queryOptions({ input: { vehicle: 'all', ...input } }).queryKey,
    { sessions: rows, total, page: served, pageSize: input.pageSize, costs: [] } as never,
  )
}

function seedPagedOverview(qc: QueryClient) {
  seedOverviewShell(qc)
  seedOverview(qc, 'all', [])
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
    .toMatchTextContent(m.charging_sessions_pagination_range({ from: 11, to: 20, total: 25 }))
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
    .toMatchTextContent(m.charging_sessions_pagination_range({ from: 21, to: 25, total: 25 }))
  await expect
    .element(screen.getByRole('button', { name: '3', exact: true }))
    .toHaveAttribute('aria-current', 'page')
})

test('Översikt: a garbage ?size= falls back to 10 rows', async () => {
  const { screen } = await renderPage(Overview, '/charging', '?size=7', seedPagedOverview)
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  await expect
    .element(screen.getByRole('combobox', { name: m.charging_sessions_pagination_page_size() }))
    .toMatchTextContent('10')
})

test('Översikt: the loader prefetches the page and size in the URL (its costs come with it)', async () => {
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
      orpc.evCharging.sessions.queryOptions({ input: { page: 2, pageSize: 25, vehicle: 'all' } })
        .queryKey,
    ),
  )
  expect(keys).not.toContain(
    key(
      orpc.evCharging.sessions.queryOptions({ input: { page: 1, pageSize: 10, vehicle: 'all' } })
        .queryKey,
    ),
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
      orpc.evCharging.overview.queryOptions({ input: { year: undefined, vehicle: 'all' } })
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
    seedOverview(qc, 'all', [])
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

// The year's overview with `count` sessions, and every page of its table at
// each size, as the server serves them.
function seedEconomyRows(qc: QueryClient, count: number, years = [2026]) {
  seedEconomyOverview(qc, 'all', count, years)
  for (const pageSize of SESSION_PAGE_SIZES) {
    const pages = Math.max(1, Math.ceil(count / pageSize))
    for (let page = 1; page <= pages; page++) seedEconomyPage(qc, { page, pageSize }, count)
  }
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
    .toMatchTextContent(m.charging_sessions_pagination_range({ from: 1, to: 10, total: 23 }))
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

test('Ekonomi: a page past the end shows the last page the server served', async () => {
  const { screen } = await renderPage(Economy, '/charging/economy', '?page=9', (qc) => {
    seedEconomyRows(qc, 23)
    seedEconomyPage(qc, { page: 9, pageSize: 10 }, 23, 3)
  })
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

test('Ekonomi: a page that fails to load keeps the last page, dimmed, under the alert', async () => {
  // Page 2 is unseeded, so its read fails (no /api/rpc in the test server).
  const { screen } = await renderPage(Economy, '/charging/economy', '', (qc) => {
    seedEconomyOverview(qc, 'all', 23)
    seedEconomyPage(qc, { page: 1, pageSize: 10 }, 23)
  })
  await expect.element(screen.getByText(kwhCell(1), { exact: false })).toBeVisible()
  await screen.getByRole('button', { name: '2', exact: true }).click()
  await expect.element(screen.getByText(m.charging_sessions_error_title())).toBeVisible()
  // The rows, the control and the rest of the page stay.
  await expect.element(screen.getByText(kwhCell(1), { exact: false })).toBeVisible()
  await expect
    .element(screen.getByRole('link', { name: m.charging_economy_grid_only_link() }))
    .toBeVisible()
  const list = screen.getByRole('table').element().closest('[aria-busy]')
  expect(list?.getAttribute('aria-busy')).toBe('false')
  expect(list?.className).toContain('opacity-60')
})

// --- Översikt: the scope is a page filter --------------------------------------

/** a precedes b in document order */
const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

test('Översikt: the scope filter sits above the totals, the chart above the sessions; no admin blocks', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', seedEmptyOverview)
  const scope = screen.getByRole('radiogroup', { name: m.charging_vehicle_scope_label() })
  await expect.element(scope).toBeVisible()
  const scopeEl = scope.element()
  const totals = screen.getByRole('heading', { name: m.charging_totals_heading() }).element()
  const chartTitle = screen.getByRole('heading', { name: m.charging_chart_title() }).element()
  const sessions = screen.getByRole('heading', { name: m.charging_sessions_heading() }).element()
  expect(precedes(scopeEl, totals)).toBe(true)
  expect(precedes(chartTitle, sessions)).toBe(true)
  // The tariffs and the data sources moved to /charging/settings.
  expect(screen.getByRole('heading', { name: m.charging_tariff_title() }).elements()).toHaveLength(
    0,
  )
  expect(
    screen.getByRole('heading', { name: m.charging_sources_heading() }).elements(),
  ).toHaveLength(0)
  // The chart's toolbar holds only chart controls.
  expect(chartTitle.closest('section')?.contains(scopeEl)).toBe(false)
  // The live line sits in the page heading, not in the scoped content.
  const banner = screen.getByRole('banner').element()
  const liveName = screen.getByText(m.charging_live_title(), { exact: false }).element()
  expect(banner.contains(liveName)).toBe(true)
  expect(precedes(liveName, scopeEl)).toBe(true)
})

test.each([
  '?dialog=tariffNew',
  '?dialog=vehicleImport',
  '?dialog=syncRuns&source=skoda',
])('Översikt: an old dialog link %s loads the overview with no dialog', async (search) => {
  const { screen } = await renderPage(Overview, '/charging', search, seedEmptyOverview)
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

test('Översikt: an admin’s failing Škoda alert deep-links into its credentials dialog', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedEmptyOverview(qc)
    seedSourcesHealth(qc, {
      skoda: { state: 'failing', code: 'auth_failed', lastSuccessAt: null, failingSince: null },
    })
  })
  await expect
    .element(
      screen.getByRole('link', {
        name: m.charging_source_action_label({
          action: m.charging_credentials_update(),
          source: integrationSourceName('skoda'),
        }),
      }),
    )
    .toHaveAttribute('href', expect.stringContaining('dialog=credentials&source=skoda'))
})

test.each([
  ['patterns', Patterns, '/charging/patterns'],
  ['economy', Economy, '/charging/economy'],
] as const)('%s: a clean URL shows Alla checked', async (_n, route, path) => {
  const { screen } = await renderPage(route, path, '', () => {})
  await expect
    .element(radio(screen, m.charging_vehicle_scope_all()))
    .toHaveAttribute('aria-checked', 'true')
})

test('Översikt: Vår bil from a clean URL is checked and written to the URL', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '', (qc) => {
    seedEmptyOverview(qc)
    seedOverview(qc, 'ours', [])
  })
  await radio(screen, m.charging_vehicle_scope_ours()).click()
  await expect
    .element(radio(screen, m.charging_vehicle_scope_ours()))
    .toHaveAttribute('aria-checked', 'true')
  expect(router.state.location.search).toMatchObject({ vehicle: 'ours' })
})

// --- Paging while the next page loads, fails, or another scope/year loads ------

// Puts `key` in flight with a fetch released by hand: the page's own observer
// joins it, so the page sits in its loading state until `release(data)`.
function holdQuery(qc: QueryClient, key: readonly unknown[]) {
  let release!: (data: unknown) => void
  const gate = new Promise((r) => {
    release = r
  })
  void qc.fetchQuery({ queryKey: key, queryFn: () => gate } as never)
  return (data: unknown) => release(data)
}

const sessionsKey = (page: number, pageSize: 10 | 25 | 50 = 10) =>
  orpc.evCharging.sessions.queryOptions({ input: { page, pageSize, vehicle: 'all' } }).queryKey

test('Översikt: while the next page loads, the current rows stay, dimmed and busy', async () => {
  const { screen, qc } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'all', [])
    seedSessionsPage(qc, { page: 1, pageSize: 10 }, [session('p1', 1.1)], 25)
  })
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  const release = holdQuery(qc, sessionsKey(2))
  await screen.getByRole('button', { name: '2', exact: true }).click()
  // Not blocked on the loader (the page is no loader dep): the list itself shows it's loading.
  const list = () => screen.getByRole('table').element().closest('[aria-busy]')
  await vi.waitFor(() => expect(list()?.getAttribute('aria-busy')).toBe('true'))
  expect(list()?.className).toContain('opacity-60')
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  release({ sessions: [session('p2', 2.2)], total: 25, page: 2, pageSize: 10, costs: [] })
  await expect.element(screen.getByText('2,2', { exact: false })).toBeVisible()
  expect(list()?.getAttribute('aria-busy')).toBe('false')
  expect(list()?.className).not.toContain('opacity-60')
})

test('Översikt: after a page fails, another page that loads clears the alert', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'all', [])
    seedSessionsPage(qc, { page: 1, pageSize: 10 }, [session('p1', 1.1)], 25)
    seedSessionsPage(qc, { page: 3, pageSize: 10 }, [session('p3', 3.3)], 25)
  })
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  await screen.getByRole('button', { name: '2', exact: true }).click()
  await expect.element(screen.getByText(m.charging_sessions_error_title())).toBeVisible()
  await screen.getByRole('button', { name: '3', exact: true }).click()
  await expect.element(screen.getByText('3,3', { exact: false })).toBeVisible()
  expect(screen.getByText(m.charging_sessions_error_title()).elements()).toHaveLength(0)
})

test('Översikt: a scope that fails to load never keeps the previous scope’s rows', async () => {
  // Gäster is unseeded, so its read fails: the Alla rows must not stay under its toggle.
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'all', [])
    seedSessionsPage(qc, { page: 1, pageSize: 10 }, [session('p1', 1.1)], 25)
  })
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  await radio(screen, m.charging_vehicle_scope_other()).click()
  await expect.element(screen.getByText(m.charging_sessions_error_title())).toBeVisible()
  await vi.waitFor(() =>
    expect(screen.getByText('1,1', { exact: false }).elements()).toHaveLength(0),
  )
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
})

test('Ekonomi: while another year loads, the table keeps the page it showed', async () => {
  const year2025 = orpc.evCharging.economy.queryOptions({
    input: { year: 2025, vehicle: 'all' },
  }).queryKey
  const list2025 = orpc.evCharging.economySessions.queryOptions({
    input: { year: 2025, vehicle: 'all', page: 1, pageSize: 10 },
  }).queryKey
  const { screen, qc, router } = await renderPage(Economy, '/charging/economy', '?page=2', (qc) =>
    seedEconomyRows(qc, 23, [2026, 2025]),
  )
  await expect.element(screen.getByText(kwhCell(11), { exact: false })).toBeVisible()
  // The year's reads stay in flight, and the loader doesn't wait for them, so
  // the page renders the old year's as placeholders while they load.
  holdQuery(qc, year2025)
  holdQuery(qc, list2025)
  const held = new Set([year2025, list2025].map((k) => JSON.stringify(k)))
  const original = qc.prefetchQuery.bind(qc)
  vi.spyOn(qc, 'prefetchQuery').mockImplementation(((opts: { queryKey: unknown[] }) =>
    held.has(JSON.stringify(opts.queryKey)) ? Promise.resolve() : original(opts as never)) as never)
  await screen.getByRole('combobox', { name: m.charging_year_label() }).click()
  await screen.getByRole('option', { name: '2025' }).click()
  await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ year: 2025 }))
  expect(router.state.location.search).not.toHaveProperty('page')
  // Still the old year's second page (dimmed and busy), not a flash of its first.
  await expect.element(screen.getByText(kwhCell(11), { exact: false })).toBeVisible()
  expect(screen.getByText(kwhCell(1), { exact: false }).elements()).toHaveLength(0)
  const list = screen.getByRole('table').element().closest('[aria-busy]')
  expect(list?.getAttribute('aria-busy')).toBe('true')
})

test('Ekonomi: back steps to the previous page of the table', async () => {
  const { screen, router } = await renderPage(Economy, '/charging/economy', '?page=2', (qc) =>
    seedEconomyRows(qc, 23),
  )
  await expect.element(screen.getByText(kwhCell(11), { exact: false })).toBeVisible()
  await screen.getByRole('button', { name: '3', exact: true }).click()
  await expect.element(screen.getByText(kwhCell(21), { exact: false })).toBeVisible()
  router.history.back()
  await expect.element(screen.getByText(kwhCell(11), { exact: false })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ page: 2 })
})

test('Översikt: after a page fails, stepping to it again from the control retries it', async () => {
  const { screen, qc } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverviewShell(qc)
    seedOverview(qc, 'all', [])
    seedSessionsPage(qc, { page: 1, pageSize: 10 }, [session('p1', 1.1)], 25)
    qc.setQueryDefaults(sessionsKey(2), { retry: false })
  })
  await expect.element(screen.getByText('1,1', { exact: false })).toBeVisible()
  await screen.getByRole('button', { name: m.charging_sessions_pagination_next() }).click()
  await expect.element(screen.getByText(m.charging_sessions_error_title())).toBeVisible()
  const failures = () => qc.getQueryState(sessionsKey(2))?.errorUpdateCount ?? 0
  await vi.waitFor(() => expect(qc.getQueryState(sessionsKey(2))?.fetchStatus).toBe('idle'))
  const before = failures()
  // The control still shows page 1 (the last that loaded): "next" asks for page 2
  // again, which the URL already holds. That must still fetch it, not no-op.
  await screen.getByRole('button', { name: m.charging_sessions_pagination_next() }).click()
  await vi.waitFor(() => expect(failures()).toBeGreaterThan(before))
})

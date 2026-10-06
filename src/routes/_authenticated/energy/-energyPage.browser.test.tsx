import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { energyOverviewQuery } from '~/components/energy/energyQueries'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { clickOn, legendText, xTickTexts } from '~test/browser/chartDom'
import { makeTestQueryClient } from '~test/browser/render'
import { seedSourcesHealth } from '~test/browser/syncHealth'
import { Route as Overview } from './index'

// Step 2 widens this union with the battery route.
type AnyRoute = typeof Overview

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561,
  gridExportKwh: 114,
  solarKwh: 509,
  loadKwh: 947,
  batteryDischargeKwh: 225,
  batteryChargeSolarKwh: 173,
  batteryChargeGridKwh: 68,
  carKwh: 312,
  firstSocPct: 30,
  lastSocPct: 40,
  buckets: 8640,
  expectedBuckets: 8640,
  ...over,
})

const withData = {
  year: 2026,
  availableYears: [2026],
  firstReadingDay: '2026-01-20',
  monthsWithReadings: [
    '2026-01',
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
  ],
  yearTotal: sums({ solarKwh: 5000 }),
  allTime: sums({ solarKwh: 6000 }),
  months: Array.from({ length: 12 }, (_, i) => (i < 9 ? sums({ solarKwh: 100 + i }) : null)),
}
const empty = {
  year: 2026,
  availableYears: [2026],
  firstReadingDay: null,
  monthsWithReadings: [],
  yearTotal: null,
  allTime: null,
  months: Array(12).fill(null),
}

// The page always asks for a concrete year: the period's, else the current
// Stockholm year (2026 under the pinned clock), so the default and any month of
// this year share one cache entry.
const seedOverview = (data: unknown) => (qc: QueryClient) =>
  qc.setQueryData(energyOverviewQuery(2026).queryKey, data as never)

// The default month is September 2026. Only `Date` is faked: TanStack Query
// and the router keep their real timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

// Anything unseeded fails (the test server has no /api/rpc), which is how a
// failed read is staged. The health is seeded unless `prepare` removes it.
// `staleTime` is the client's default (Infinity: seeded data never refetches);
// the energy overview query carries its own.
async function renderPage(
  route: AnyRoute,
  path: string,
  prepare: (qc: QueryClient) => void,
  { staleTime = Number.POSITIVE_INFINITY }: { staleTime?: number } = {},
) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime, retry: false } })
  // The health never goes stale here: its refetch isn't what these tests watch.
  qc.setQueryDefaults(syncHealthQuery.queryKey, { staleTime: Number.POSITIVE_INFINITY })
  seedSourcesHealth(qc)
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  // The route's path is the pathname; the search goes to the history only.
  const pathname = path.split('?')[0]
  ;(route as unknown as { update: (o: unknown) => void }).update({
    id: pathname,
    path: pathname,
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([route as never]),
    context: { queryClient: qc, user: { role: 'user' } },
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

// A query whose fetch never settles stays `pending`. The seeded copy goes first:
// prefetchQuery won't refetch fresh seeded data under `staleTime: Infinity`.
const pendingForever = (qc: QueryClient, queryKey: readonly unknown[]) => {
  qc.removeQueries({ queryKey, exact: true })
  void qc.prefetchQuery({ queryKey, queryFn: () => new Promise(() => {}) })
}
// A figure on the flow diagram's node (the same number also sits in the table under "Visa som tabell").
const figure = (screen: Awaited<ReturnType<typeof renderPage>>['screen'], text: string | RegExp) =>
  screen.getByLabelText(m.energy_flow_description()).getByText(text)

const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

const periodControl = /Välj period|Choose period/

// Every fetch any query starts (the loader's prefetch or a component's query):
// a month switch must start none. A spy on qc.fetchQuery would miss both paths,
// since neither prefetchQuery nor useQuery calls it.
function recordFetches(qc: QueryClient) {
  const fetched: unknown[] = []
  const stop = qc.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' && e.action.type === 'fetch') fetched.push(e.query.queryKey)
  })
  return { fetched, stop }
}

test('no readings yet: the empty state, no tiles', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(empty))
  await expect.element(screen.getByText(m.energy_empty_title())).toBeVisible()
  expect(screen.getByRole('button', { name: periodControl }).elements()).toHaveLength(0)
  expect(skeleton('energy-tiles')).toBeNull()
  expect(skeleton('energy-chart')).toBeNull()
})

test('with data: the tiles card with its period control, the chart with its metric toggle and year', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() })
  await expect.element(tiles).toBeVisible()
  await expect.element(tiles.getByRole('heading', { name: m.energy_tiles_heading() })).toBeVisible()
  await expect.element(tiles.getByRole('button', { name: periodControl })).toBeVisible()
  await expect
    .element(screen.getByRole('heading', { name: m.energy_chart_title({ year: '2026' }) }))
    .toBeVisible()
  await expect
    .element(screen.getByRole('radiogroup', { name: m.energy_metric_label() }))
    .toBeVisible()
  await expect.element(screen.getByRole('radio', { name: m.energy_metric_solar() })).toBeChecked()
  // The toggle is sized for reading: 14 px text, 40 px tap target.
  const toggleItem = screen.getByRole('radio', { name: m.energy_metric_solar() }).element()
  expect(toggleItem.className).toContain('h-10')
  expect(toggleItem.className).toContain('text-sm')
  expect(toggleItem.className).not.toContain('text-[0.8rem]')
  // The chart lost its own year selector: the period's year is the chart's.
  expect(screen.getByRole('combobox').elements()).toHaveLength(0)
  expect(skeleton('energy-tiles')).toBeNull()
  expect(skeleton('energy-chart')).toBeNull()
})

test('defaults to the current month; its figures fill the tiles', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await expect.element(screen.getByRole('button', { name: /september 2026/i })).toBeVisible()
  await expect.element(figure(screen, '108,0 kWh')).toBeVisible() // months[8].solarKwh
})

test.each([
  ['/energy?period=2026-02', '101,0 kWh'],
  ['/energy?period=2026', /^5\s000,0 kWh$/],
  ['/energy?period=all', /^6\s000,0 kWh$/],
] as const)('%s shows its period (February, the year, all time)', async (path, expected) => {
  const { screen } = await renderPage(Overview, path, seedOverview(withData))
  await expect.element(figure(screen, expected)).toBeVisible()
})

test('the legacy ?year=2026 reads as the year', async () => {
  const { screen } = await renderPage(Overview, '/energy?year=2026', seedOverview(withData))
  await expect.element(screen.getByText(/^5\s000,0 kWh$/)).toBeVisible()
})

test('a stale ?period= falls back to the default month', async () => {
  const { screen } = await renderPage(Overview, '/energy?period=2026-11', seedOverview(withData))
  await expect.element(screen.getByRole('button', { name: /september 2026/i })).toBeVisible()
  await expect.element(figure(screen, '108,0 kWh')).toBeVisible()
})

test('stepping writes ?period= and replaces the history entry; a month switch sends no request', async () => {
  // No Infinity default here: the overview's own staleTime (5 min) is what
  // keeps the year fresh.
  const { screen, router, qc } = await renderPage(Overview, '/energy', seedOverview(withData), {
    staleTime: 0,
  })
  await expect.element(figure(screen, '108,0 kWh')).toBeVisible()
  // Idle for a minute: past the app's 20 s default query staleTime.
  vi.setSystemTime(new Date('2026-09-15T12:01:00Z'))
  const before = router.history.length
  const fetches = recordFetches(qc)
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  await expect
    .poll(() => (router.state.location.search as { period?: string }).period)
    .toBe('2026-08')
  await expect.element(figure(screen, '107,0 kWh')).toBeVisible()
  expect(router.history.length).toBe(before)
  // Settled (the loader ran, the page re-rendered on the new search): still no fetch.
  await expect.poll(() => router.state.status).toBe('idle')
  fetches.stop()
  expect(fetches.fetched).toEqual([])
})

test('the flow box keeps its reserved height and place across periods', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await expect.element(figure(screen, '108,0 kWh')).toBeVisible()
  const boxEl = () => screen.container.querySelector('[data-slot="energy-flow-box"]') as HTMLElement
  // Browser tests carry no Tailwind, so pin the reservation classes (what holds the height in the app)...
  expect(boxEl().className).toContain('h-[490px]')
  expect(boxEl().className).toContain('@[860px]:h-[360px]')
  // ...and that the box neither resizes nor moves when the period changes.
  const before = boxEl().getBoundingClientRect()
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  await expect.element(figure(screen, '107,0 kWh')).toBeVisible()
  const after = boxEl().getBoundingClientRect()
  expect(after.height).toBe(before.height)
  expect(after.top).toBe(before.top)
})

test('stepping into a cached year and back within 5 minutes sends no request (hourly data)', async () => {
  // Without the overview's own staleTime, the client default (0 here, 20 s in
  // the app) would refetch each year as its query mounts again.
  const { screen, qc } = await renderPage(
    Overview,
    '/energy?period=2026-01',
    (qc) => {
      qc.setQueryData(energyOverviewQuery(2026).queryKey, twoYears as never)
      qc.setQueryData(energyOverviewQuery(2025).queryKey, {
        ...twoYears,
        year: 2025,
        months: Array.from({ length: 12 }, (_, i) => (i === 11 ? sums({ solarKwh: 42 }) : null)),
      } as never)
    },
    { staleTime: 0 },
  )
  await expect.element(figure(screen, '100,0 kWh')).toBeVisible()
  vi.setSystemTime(new Date('2026-09-15T12:01:00Z'))
  const fetches = recordFetches(qc)
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  await expect.element(figure(screen, '42,0 kWh')).toBeVisible()
  vi.setSystemTime(new Date('2026-09-15T12:02:00Z'))
  await screen.getByRole('button', { name: m.energy_period_next_month() }).click()
  await expect.element(figure(screen, '100,0 kWh')).toBeVisible()
  fetches.stop()
  expect(fetches.fetched).toEqual([])
})

test('picking a whole year writes ?period=2026 unquoted; Totalt writes ?period=all', async () => {
  const { screen, router } = await renderPage(Overview, '/energy', seedOverview(withData))
  await screen.getByRole('button', { name: periodControl }).click()
  await screen.getByRole('button', { name: m.energy_period_whole_year({ year: '2026' }) }).click()
  await expect.poll(() => router.state.location.searchStr).toBe('?period=2026')
  await expect.element(screen.getByText(/^5\s000,0 kWh$/)).toBeVisible()
  await screen.getByRole('button', { name: periodControl }).click()
  await screen.getByRole('button', { name: m.charging_tile_all_time(), exact: true }).click()
  await expect.poll(() => router.state.location.searchStr).toBe('?period=all')
  await expect.element(screen.getByText(/^6\s000,0 kWh$/)).toBeVisible()
})

test('clicking a month in the chart selects it', async () => {
  const { screen, router } = await renderPage(Overview, '/energy', seedOverview(withData))
  const chart = screen
    .getByRole('region', { name: m.energy_chart_title({ year: '2026' }) })
    .element()
  // By position: on a narrow test page the labels shorten to initials.
  const ticks = () => xTickTexts(chart)
  await expect.poll(() => ticks().length, { timeout: 5000 }).toBe(12)
  await clickOn(chart, ticks()[2]) // March
  await expect
    .poll(() => (router.state.location.search as { period?: string }).period)
    .toBe('2026-03')
  await expect.element(figure(screen, '102,0 kWh')).toBeVisible()
  await expect.element(screen.getByRole('button', { name: /mars 2026/i })).toBeVisible()
  await expect.poll(() => ticks().findIndex((t) => t.getAttribute('font-weight') === '600')).toBe(2)
})

const twoYears = {
  ...withData,
  availableYears: [2026, 2025],
  monthsWithReadings: ['2025-12', ...withData.monthsWithReadings],
}

test('another year: one request; the old figures stay, dimmed, while it loads', async () => {
  const { screen, qc } = await renderPage(Overview, '/energy?period=2026-01', (qc) => {
    qc.setQueryData(energyOverviewQuery(2026).queryKey, twoYears as never)
  })
  await expect.element(figure(screen, '100,0 kWh')).toBeVisible()
  let release: (v: unknown) => void = () => {}
  const gate = new Promise((r) => {
    release = r
  })
  // Held in flight; the page's own query joins it (the RPC link binds fetch early).
  const held = qc.fetchQuery({
    queryKey: energyOverviewQuery(2025).queryKey,
    queryFn: () => gate as never,
  })
  const fetches = recordFetches(qc)
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  const chart = screen
    .getByRole('region', { name: m.energy_chart_title({ year: '2026' }) })
    .element()
  await expect.poll(() => chart.querySelector('[aria-busy="true"]')).not.toBeNull()
  // The control already shows the requested month; the tiles keep January's
  // figures, dimmed, until December 2025 lands.
  await expect.element(screen.getByRole('button', { name: /december 2025/i })).toBeVisible()
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() }).element()
  expect(tiles.querySelector('[aria-busy="true"]')).not.toBeNull()
  // Only the figures dim: the control stays fully visible and operable.
  expect(
    screen.getByRole('button', { name: periodControl }).element().closest('[aria-busy]'),
  ).toBeNull()
  await expect.element(figure(screen, '100,0 kWh')).toBeVisible()
  release({
    ...twoYears,
    year: 2025,
    months: Array.from({ length: 12 }, (_, i) => (i === 11 ? sums({ solarKwh: 42 }) : null)),
  })
  await held
  await expect.poll(() => chart.querySelector('[aria-busy="true"]')).toBeNull()
  expect(tiles.querySelector('[aria-busy="true"]')).toBeNull()
  await expect.element(figure(screen, '42,0 kWh')).toBeVisible()
  await expect
    .element(screen.getByRole('heading', { name: m.energy_chart_title({ year: '2025' }) }))
    .toBeVisible()
  fetches.stop()
  // The page joined the held request rather than starting its own.
  expect(fetches.fetched).toEqual([])
})

test('while another year loads, the control still steps', async () => {
  const { screen, router, qc } = await renderPage(Overview, '/energy?period=2026-01', (qc) => {
    qc.setQueryData(energyOverviewQuery(2026).queryKey, twoYears as never)
  })
  await expect.element(figure(screen, '100,0 kWh')).toBeVisible()
  // 2025 never lands.
  void qc.prefetchQuery({
    queryKey: energyOverviewQuery(2025).queryKey,
    queryFn: () => new Promise(() => {}),
  })
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() }).element()
  await expect.poll(() => tiles.querySelector('[aria-busy="true"]')).not.toBeNull()
  await screen.getByRole('button', { name: m.energy_period_next_month() }).click()
  await expect
    .poll(() => (router.state.location.search as { period?: string }).period)
    .toBe('2026-01')
  await expect.poll(() => tiles.querySelector('[aria-busy="true"]')).toBeNull()
  await expect.element(figure(screen, '100,0 kWh')).toBeVisible()
})

test('a stale ?period= in another year with readings moves the URL to the default month', async () => {
  // 2025 has readings, but only in December: March 2025 can't be shown.
  const { screen, router } = await renderPage(Overview, '/energy?period=2025-03', (qc) => {
    qc.setQueryData(energyOverviewQuery(2025).queryKey, { ...twoYears, year: 2025 } as never)
    qc.setQueryData(energyOverviewQuery(2026).queryKey, twoYears as never)
  })
  await expect.poll(() => router.state.location.searchStr).toBe('?period=2026-09')
  await expect.element(screen.getByRole('button', { name: /september 2026/i })).toBeVisible()
  await expect.element(figure(screen, '108,0 kWh')).toBeVisible()
  await expect
    .element(screen.getByRole('heading', { name: m.energy_chart_title({ year: '2026' }) }))
    .toBeVisible()
})

test('a legacy ?year= without readings moves the URL to the default month', async () => {
  const { screen, router } = await renderPage(Overview, '/energy?year=2021', (qc) => {
    // The service answers a year without readings with the current year.
    qc.setQueryData(energyOverviewQuery(2021).queryKey, withData as never)
    seedOverview(withData)(qc)
  })
  await expect.poll(() => router.state.location.searchStr).toBe('?period=2026-09')
  await expect.element(figure(screen, '108,0 kWh')).toBeVisible()
})

test.each([
  '/energy?period=garbage',
  '/energy?period=2026-13',
])('%s (nothing valid requested) goes back to a bare /energy', async (path) => {
  const { screen, router } = await renderPage(Overview, path, seedOverview(withData))
  await expect.poll(() => router.state.location.searchStr).toBe('')
  expect(router.state.location.search).toEqual({})
  await expect.element(screen.getByRole('button', { name: /september 2026/i })).toBeVisible()
  await expect.element(figure(screen, '108,0 kWh')).toBeVisible()
})

test('a stale but valid ?period= in the current year moves the URL to the default month', async () => {
  const { router } = await renderPage(Overview, '/energy?period=2026-11', seedOverview(withData))
  await expect.poll(() => router.state.location.searchStr).toBe('?period=2026-09')
})

const announcement = () =>
  document.querySelector('[data-slot="period-announcement"][aria-live="polite"]')

test('each period change is announced in a polite live region', async () => {
  const { screen } = await renderPage(Overview, '/energy?period=2026-08', seedOverview(withData))
  await expect.element(figure(screen, '107,0 kWh')).toBeVisible()
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() }).element()
  expect(tiles.contains(announcement())).toBe(true)
  expect(announcement()?.className).toContain('sr-only')
  expect(announcement()?.textContent).toMatch(/^augusti 2026$/i)
  // Outside the figures that go busy while a year loads.
  expect(announcement()?.closest('[aria-busy]')).toBeNull()
  await screen.getByRole('button', { name: m.energy_period_next_month() }).click()
  await expect
    .poll(() => announcement()?.textContent?.toLowerCase())
    .toBe(`september 2026 (${m.energy_chart_so_far()})`)
  await screen.getByRole('button', { name: periodControl }).click()
  await screen.getByRole('button', { name: m.charging_tile_all_time(), exact: true }).click()
  await expect.poll(() => announcement()?.textContent).toBe(m.charging_tile_all_time())
})

test('switching to Totalt while its year loads shows all time at once, not dimmed', async () => {
  // On December 2025 with only 2025 cached: Totalt asks for 2026, which never
  // lands, so the page shows 2025 as the placeholder. All time doesn't depend
  // on the year: the placeholder's figure is the answer.
  const { screen } = await renderPage(Overview, '/energy?period=2025-12', (qc) => {
    qc.setQueryData(energyOverviewQuery(2025).queryKey, {
      ...twoYears,
      year: 2025,
      months: Array.from({ length: 12 }, (_, i) => (i === 11 ? sums({ solarKwh: 42 }) : null)),
    } as never)
    pendingForever(qc, energyOverviewQuery(2026).queryKey)
  })
  await expect.element(figure(screen, '42,0 kWh')).toBeVisible()
  await screen.getByRole('button', { name: periodControl }).click()
  await screen.getByRole('button', { name: m.charging_tile_all_time(), exact: true }).click()
  const chart = screen
    .getByRole('region', { name: m.energy_chart_title({ year: '2025' }) })
    .element()
  // The chart waits for 2026, dimmed; the tiles don't.
  await expect.poll(() => chart.querySelector('[aria-busy="true"]')).not.toBeNull()
  await expect.element(screen.getByText(/^6\s000,0 kWh$/)).toBeVisible()
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() }).element()
  expect(tiles.querySelector('[aria-busy="true"]')).toBeNull()
  expect(tiles.querySelector('.opacity-60')).toBeNull()
})

test('the default leaves a bare /energy alone', async () => {
  const { screen, router } = await renderPage(Overview, '/energy', seedOverview(withData))
  await expect.element(figure(screen, '108,0 kWh')).toBeVisible()
  await expect.poll(() => router.state.status).toBe('idle')
  expect(router.state.location.searchStr).toBe('')
})

// --- Deferred loading (ADR-0025) ----------------------------------------------

test('overview still loading: tiles and chart show skeletons, never the empty state or the error', async () => {
  const { screen } = await renderPage(Overview, '/energy', (qc) => {
    pendingForever(qc, energyOverviewQuery(2026).queryKey)
  })
  await expect.element(screen.getByRole('heading', { name: m.energy_title() })).toBeVisible()
  // The skeletons mount once hydrated: wait for them, don't race the first render.
  await expect.poll(() => skeleton('energy-tiles')).not.toBeNull()
  await expect.poll(() => skeleton('energy-chart')).not.toBeNull()
  expect(screen.getByText(m.energy_empty_title()).elements()).toHaveLength(0)
  // Loading is not an error (ADR-0016).
  expect(screen.getByText(m.energy_error_title()).elements()).toHaveLength(0)
  // The control appears with the first data, inside the skeleton's footprint.
  expect(screen.getByRole('button', { name: periodControl }).elements()).toHaveLength(0)
})

const failingHealth = {
  source: 'emaldo',
  state: 'failing',
  running: false,
  progress: null,
  lastAttemptAt: new Date('2026-09-28T10:00:00Z'),
  lastSuccessAt: null,
  failingSince: new Date('2026-09-28T08:00:00Z'),
  consecutiveFailures: 3,
  code: 'auth_failed',
  adminDetail: null,
}

// The failing case is the control: the same page does show the health alert
// once a health that warrants one is in.
test.each([
  ['failing', (qc: QueryClient) => seedSourcesHealth(qc, { emaldo: failingHealth }), true],
  ['still loading', (qc: QueryClient) => pendingForever(qc, syncHealthQuery.queryKey), false],
  ['failed', (qc: QueryClient) => qc.removeQueries({ queryKey: syncHealthQuery.queryKey }), false],
] as const)('Emaldo health %s: the page renders; the health alert only for a failing source', async (_n, health, alerted) => {
  const { screen } = await renderPage(Overview, '/energy', (qc) => {
    seedOverview(withData)(qc)
    health(qc)
  })
  await expect.element(screen.getByRole('heading', { name: m.energy_title() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: periodControl })).toBeVisible()
  if (alerted) {
    await expect.element(screen.getByRole('alert')).toBeVisible()
    await expect.element(screen.getByText(m.charging_never_synced())).toBeVisible()
  } else {
    expect(screen.getByText(m.charging_never_synced()).elements()).toHaveLength(0)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  }
})

test('Nät switches the chart to the grid series', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await screen.getByRole('radio', { name: m.energy_metric_grid() }).click()
  // From the legend: a tooltip under a stray pointer would repeat the label.
  await vi.waitFor(() =>
    expect(legendText(screen.container)).toContain(m.energy_series_import_direct()),
  )
})

test('a failed read of another year keeps the period control, so the user can step back', async () => {
  const { screen } = await renderPage(Overview, '/energy?period=2026-01', (qc) => {
    // 2025 stays unseeded, so its read fails.
    qc.setQueryData(energyOverviewQuery(2026).queryKey, twoYears as never)
  })
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  await expect.element(screen.getByText(m.energy_error_title())).toBeVisible()
  // The failed year's chart is gone; the tiles card and its control stay (lastShown).
  await expect.element(screen.getByRole('button', { name: /december 2025/i })).toBeVisible()
  await expect.element(screen.getByRole('region', { name: m.energy_tiles_heading() })).toBeVisible()
  // The readouts go blank under the alert: January's figures would sit under
  // December's label, and "no data" would be a false empty claim.
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() }).element()
  await expect.poll(() => tiles.querySelector('[aria-hidden="true"].invisible')).not.toBeNull()
  expect(figure(screen, '100,0 kWh').elements()).toHaveLength(0)
  expect(screen.getByText(m.energy_period_no_data()).elements()).toHaveLength(0)
  expect(document.querySelectorAll('section')).toHaveLength(1) // the tiles; the chart is gone
  await screen.getByRole('button', { name: m.energy_period_next_month() }).click()
  await expect
    .element(screen.getByRole('heading', { name: m.energy_chart_title({ year: '2026' }) }))
    .toBeVisible()
  await expect.element(figure(screen, '100,0 kWh')).toBeVisible()
  expect(screen.getByText(m.energy_error_title()).elements()).toHaveLength(0)
})

test('a failed read: the error under a working heading, no skeleton', async () => {
  const { screen } = await renderPage(Overview, '/energy', () => {})
  await expect.element(screen.getByRole('heading', { name: m.energy_title() })).toBeVisible()
  await expect.element(screen.getByText(m.energy_error_title())).toBeVisible()
  expect(skeleton('energy-tiles')).toBeNull()
  expect(skeleton('energy-chart')).toBeNull()
  expect(screen.getByText(m.energy_empty_title()).elements()).toHaveLength(0)
})

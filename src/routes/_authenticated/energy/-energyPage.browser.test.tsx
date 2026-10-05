import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { emaldoHealthQuery, energyOverviewQuery } from '~/components/energy/energyQueries'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
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
  tiles: { thisMonth: sums(), thisYear: sums(), allTime: sums() },
  months: Array.from({ length: 12 }, (_, i) => (i < 9 ? sums() : null)),
}
const empty = {
  year: 2026,
  availableYears: [2026],
  firstReadingDay: null,
  tiles: { thisMonth: null, thisYear: null, allTime: null },
  months: Array(12).fill(null),
}

const seedOverview = (data: unknown) => (qc: QueryClient) =>
  qc.setQueryData(energyOverviewQuery(undefined).queryKey, data as never)

// Anything unseeded fails (the test server has no /api/rpc), which is how a
// failed read is staged. The health is seeded unless `prepare` removes it.
async function renderPage(route: AnyRoute, path: string, prepare: (qc: QueryClient) => void) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } })
  qc.setQueryData(emaldoHealthQuery.queryKey, {
    source: 'emaldo',
    state: 'ok',
    lastSuccessAt: null,
    lastError: null,
  } as never)
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
const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

test('no readings yet: the empty state, no tiles', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(empty))
  await expect.element(screen.getByText(m.energy_empty_title())).toBeVisible()
  expect(screen.getByRole('tablist').elements()).toHaveLength(0)
  expect(skeleton('energy-tiles')).toBeNull()
  expect(skeleton('energy-chart')).toBeNull()
})

test('with data: tiles, the chart with its metric toggle and year', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await expect
    .element(screen.getByRole('tablist', { name: m.energy_tiles_heading() }))
    .toBeVisible()
  await expect.element(screen.getByRole('heading', { name: m.energy_chart_title() })).toBeVisible()
  await expect.element(screen.getByRole('radio', { name: m.energy_metric_solar() })).toBeVisible()
  const year = screen.getByRole('combobox', { name: m.charging_year_label() })
  await expect.element(year).toBeVisible()
  await expect.element(year).toHaveTextContent('2026')
  await expect
    .element(screen.getByRole('radiogroup', { name: m.energy_metric_label() }))
    .toBeVisible()
  await expect.element(screen.getByRole('radio', { name: m.energy_metric_solar() })).toBeChecked()
  await expect.element(screen.getByRole('region', { name: m.energy_tiles_heading() })).toBeVisible()
  expect(skeleton('energy-tiles')).toBeNull()
  expect(skeleton('energy-chart')).toBeNull()
})

// --- Deferred loading (ADR-0025) ----------------------------------------------

test('overview still loading: tiles and chart show skeletons, never the empty state or the error', async () => {
  const { screen } = await renderPage(Overview, '/energy', (qc) => {
    pendingForever(qc, energyOverviewQuery(undefined).queryKey)
  })
  await expect.element(screen.getByRole('heading', { name: m.energy_title() })).toBeVisible()
  // The skeletons mount once hydrated: wait for them, don't race the first render.
  await expect.poll(() => skeleton('energy-tiles')).not.toBeNull()
  await expect.poll(() => skeleton('energy-chart')).not.toBeNull()
  expect(screen.getByText(m.energy_empty_title()).elements()).toHaveLength(0)
  // Loading is not an error (ADR-0016).
  expect(screen.getByText(m.energy_error_title()).elements()).toHaveLength(0)
  expect(screen.getByRole('tablist').elements()).toHaveLength(0)
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
  [
    'failing',
    (qc: QueryClient) => qc.setQueryData(emaldoHealthQuery.queryKey, failingHealth as never),
    true,
  ],
  ['still loading', (qc: QueryClient) => pendingForever(qc, emaldoHealthQuery.queryKey), false],
  [
    'failed',
    (qc: QueryClient) => qc.removeQueries({ queryKey: emaldoHealthQuery.queryKey }),
    false,
  ],
] as const)('Emaldo health %s: the page renders; the health alert only for a failing source', async (_n, health, alerted) => {
  const { screen } = await renderPage(Overview, '/energy', (qc) => {
    seedOverview(withData)(qc)
    health(qc)
  })
  await expect.element(screen.getByRole('heading', { name: m.energy_title() })).toBeVisible()
  await expect
    .element(screen.getByRole('tablist', { name: m.energy_tiles_heading() }))
    .toBeVisible()
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
    expect(screen.container.querySelector('.recharts-legend-wrapper')?.textContent ?? '').toContain(
      m.energy_series_import_direct(),
    ),
  )
})

const with2025 = { ...withData, year: 2025, availableYears: [2026, 2025] }

async function pickYear(screen: Awaited<ReturnType<typeof renderPage>>['screen'], y: number) {
  await screen.getByRole('combobox', { name: m.charging_year_label() }).click()
  await screen.getByRole('option', { name: String(y) }).click()
}

test('picking a year puts it in the URL, replacing the history entry', async () => {
  const { screen, router } = await renderPage(Overview, '/energy', (qc) => {
    seedOverview({ ...withData, availableYears: [2026, 2025] })(qc)
    qc.setQueryData(energyOverviewQuery(2025).queryKey, with2025 as never)
  })
  const before = router.history.length
  await pickYear(screen, 2025)
  await expect.poll(() => (router.state.location.search as { year?: number }).year).toBe(2025)
  expect(router.history.length).toBe(before)
})

test('another year loading: the old chart stays, dimmed; the tiles do not', async () => {
  const { screen, qc } = await renderPage(Overview, '/energy', (qc) => {
    seedOverview({ ...withData, availableYears: [2026, 2025] })(qc)
  })
  let release: (v: unknown) => void = () => {}
  const gate = new Promise((r) => {
    release = r
  })
  // Held in flight; the page's own query joins it (the RPC link binds fetch early).
  const held = qc.fetchQuery({
    queryKey: energyOverviewQuery(2025).queryKey,
    queryFn: () => gate as never,
  })
  await pickYear(screen, 2025)
  const chart = screen.getByRole('heading', { name: m.energy_chart_title() })
  await expect.element(chart).toBeVisible()
  const busy = screen.getByRole('region', { name: m.energy_chart_title() }).element()
  await expect.poll(() => busy.querySelector('[aria-busy="true"]')).not.toBeNull()
  // The selector shows the requested year while it loads, not the old one.
  await expect
    .element(screen.getByRole('combobox', { name: m.charging_year_label() }))
    .toHaveTextContent('2025')
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() }).element()
  expect(tiles.closest('[aria-busy="true"]')).toBeNull()
  release({ ...with2025, year: 2025, availableYears: [2026, 2025] })
  await held
  await expect.poll(() => busy.querySelector('[aria-busy="true"]')).toBeNull()
})

test('a failed read of another year keeps the year selector, so the user can switch back', async () => {
  const { screen } = await renderPage(Overview, '/energy', (qc) => {
    seedOverview({ ...withData, availableYears: [2026, 2025] })(qc)
    // 2026 picked back is its own key; 2025 stays unseeded, so its read fails.
    qc.setQueryData(energyOverviewQuery(2026).queryKey, {
      ...withData,
      availableYears: [2026, 2025],
    } as never)
  })
  await pickYear(screen, 2025)
  await expect.element(screen.getByText(m.energy_error_title())).toBeVisible()
  const selector = screen.getByRole('combobox', { name: m.charging_year_label() })
  await expect.element(selector).toBeVisible()
  await expect.element(selector).toHaveTextContent('2025')
  // The tiles are the current periods, whatever the year: the last ones stay.
  await expect.element(screen.getByRole('region', { name: m.energy_tiles_heading() })).toBeVisible()
  await pickYear(screen, 2026)
  await expect.element(screen.getByRole('heading', { name: m.energy_chart_title() })).toBeVisible()
  await expect.element(selector).toHaveTextContent('2026')
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

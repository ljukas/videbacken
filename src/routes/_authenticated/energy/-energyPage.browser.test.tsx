import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { expect, test } from 'vitest'
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

test('no readings yet: the empty state, no tiles', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(empty))
  await expect.element(screen.getByText(m.energy_empty_title())).toBeVisible()
  expect(screen.getByRole('tablist').elements()).toHaveLength(0)
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
})

test('Nät switches the chart to the grid series', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await screen.getByRole('radio', { name: m.energy_metric_grid() }).click()
  await expect.element(screen.getByText(m.energy_series_import_direct())).toBeVisible()
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
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() }).element()
  expect(tiles.closest('[aria-busy="true"]')).toBeNull()
  release({ ...with2025, year: 2025, availableYears: [2026, 2025] })
  await held
  await expect.poll(() => busy.querySelector('[aria-busy="true"]')).toBeNull()
})

test('a failed read: the error under a working heading', async () => {
  const { screen } = await renderPage(Overview, '/energy', () => {})
  await expect.element(screen.getByRole('heading', { name: m.energy_title() })).toBeVisible()
  await expect.element(screen.getByText(m.energy_error_title())).toBeVisible()
})

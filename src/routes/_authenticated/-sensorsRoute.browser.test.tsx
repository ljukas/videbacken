import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { Route as Sensors } from './sensors'

// The real page under a bare root (routeTree.gen.ts isn't loaded), with the cache
// seeded through the oRPC keys. Anything unseeded fails (no /api/rpc in the test
// server), which is how a failed read is staged. `-` keeps it out of the route tree.
type Device = RouterOutputs['sensor']['listDevices'][number]

const devicesKey = orpc.sensor.listDevices.queryOptions().queryKey
const seriesKey = orpc.sensor.series.queryOptions({ input: { range: '24h' } }).queryKey
const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

const device: Device = {
  id: 'a',
  mac: 'a4cf12ab34cd',
  name: null,
  location: null,
  displayName: 'Sensor 34cd',
  batteryPct: 88,
  // Hours ago, not now: "seen 0 s ago" vs "1 s ago" would differ between two renders.
  lastSeenAt: new Date(Date.now() - 2 * 3_600_000),
  latest: { temperatureC: 21.7, humidityPct: 46, recordedAt: new Date(Date.now() - 2 * 3_600_000) },
}
const noSeries = { buckets: [], bucketSec: 900 }

// A query whose fetch never settles stays `pending`.
const pendingForever = (qc: QueryClient, queryKey: readonly unknown[]) => {
  qc.removeQueries({ queryKey, exact: true })
  void qc.prefetchQuery({ queryKey, queryFn: () => new Promise(() => {}) })
}

async function loadSensors(search: string, prepare: (qc: QueryClient) => void) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  ;(Sensors as unknown as { update: (o: unknown) => void }).update({
    id: '/sensors',
    path: '/sensors',
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([Sensors as never]),
    context: { queryClient: qc, user: { id: 'u1', role: 'admin' } },
    history: createMemoryHistory({ initialEntries: [`/sensors${search}`] }),
  })
  await router.load()
  const ui = (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { ui, router, qc }
}

async function renderSensors(search: string, prepare: (qc: QueryClient) => void) {
  const { ui, router, qc } = await loadSensors(search, prepare)
  const screen = await render(ui)
  return { screen, router, qc }
}

// What the server renders after a failed prefetch (the error isn't dehydrated, so
// the client hydrates with the query missing) must equal the hydrating client's
// first render: both pre-hydration, so renderToString on each side.
const failedOnServer = (qc: QueryClient, queryKey: readonly unknown[]) =>
  qc
    .getQueryCache()
    .build(qc, { queryKey })
    .setState({ status: 'error', error: new Error('x'), errorUpdateCount: 1, fetchStatus: 'idle' })
const firstHtml = async (prepare: (qc: QueryClient) => void) =>
  renderToString((await loadSensors('', prepare)).ui)

test('devices still loading: skeletons, never the "no sensors" empty state', async () => {
  const { screen } = await renderSensors('', (qc) => {
    pendingForever(qc, devicesKey)
    pendingForever(qc, seriesKey)
  })
  await expect.element(screen.getByRole('heading', { name: m.sensors_title() })).toBeVisible()
  await expect.poll(() => skeleton('sensors-tiles')).not.toBeNull()
  expect(skeleton('sensors-temp-chart')).not.toBeNull()
  expect(skeleton('sensors-hum-chart')).not.toBeNull()
  expect(screen.getByText(m.sensors_empty_title()).elements()).toHaveLength(0)
  expect(screen.getByText(m.sensors_devices_error_title()).elements()).toHaveLength(0)
})

test('devices failed: the alert, no empty state, no skeleton', async () => {
  const { screen } = await renderSensors('', (qc) => qc.setQueryData(seriesKey, noSeries))
  await expect.element(screen.getByText(m.sensors_devices_error_title())).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.common_try_again() })).toBeVisible()
  expect(screen.getByText(m.sensors_empty_title()).elements()).toHaveLength(0)
  expect(skeleton('sensors-tiles')).toBeNull()
})

test('no devices: the empty state, as before', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [])
    qc.setQueryData(seriesKey, noSeries)
  })
  await expect.element(screen.getByText(m.sensors_empty_title())).toBeVisible()
})

test('series still loading: tiles render, the charts are skeletons, never "no data"', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    pendingForever(qc, seriesKey)
  })
  await expect.element(screen.getByText('21.7°C')).toBeVisible()
  await expect.poll(() => skeleton('sensors-temp-chart')).not.toBeNull()
  expect(skeleton('sensors-hum-chart')).not.toBeNull()
  expect(skeleton('sensors-tiles')).toBeNull()
  // The chart titles stay real text above their skeletons.
  await expect
    .element(screen.getByRole('heading', { name: m.sensors_temp_chart_title() }))
    .toBeVisible()
  expect(screen.getByText(m.sensors_chart_empty()).elements()).toHaveLength(0)
})

test('series failed: one alert in place of the charts, never "no data"', async () => {
  const { screen } = await renderSensors('', (qc) => qc.setQueryData(devicesKey, [device]))
  await expect.element(screen.getByText(m.sensors_series_error_title())).toBeVisible()
  await expect.element(screen.getByText('21.7°C')).toBeVisible()
  expect(screen.getByText(m.sensors_chart_empty()).elements()).toHaveLength(0)
  expect(skeleton('sensors-temp-chart')).toBeNull()
  expect(skeleton('sensors-hum-chart')).toBeNull()
  expect(screen.getByRole('alert').elements()).toHaveLength(1)
  expect(
    screen.getByRole('heading', { name: m.sensors_temp_chart_title() }).elements(),
  ).toHaveLength(0)
})

test('both cached: no skeleton at all', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, noSeries)
  })
  await expect.element(screen.getByText('21.7°C')).toBeVisible()
  // Empty buckets are "no data", the loaded state.
  await expect.element(screen.getByText(m.sensors_chart_empty()).first()).toBeVisible()
  expect(skeleton('sensors-tiles')).toBeNull()
  expect(skeleton('sensors-temp-chart')).toBeNull()
})

test('an edit deep link keeps its params while the devices load', async () => {
  const { router } = await renderSensors('?dialog=edit&deviceId=a', (qc) => {
    pendingForever(qc, devicesKey)
    qc.setQueryData(seriesKey, noSeries)
  })
  await expect.poll(() => skeleton('sensors-tiles')).not.toBeNull()
  expect(router.state.location.search).toMatchObject({ dialog: 'edit', deviceId: 'a' })
})

test('an edit deep link waits for the devices, then opens', async () => {
  const { screen, qc } = await renderSensors('?dialog=edit&deviceId=a', (qc) => {
    pendingForever(qc, devicesKey)
    qc.setQueryData(seriesKey, noSeries)
  })
  await expect.poll(() => skeleton('sensors-tiles')).not.toBeNull()
  // The dialogs are lazy chunks: give a would-be mount time to resolve before asserting absence.
  await new Promise((r) => setTimeout(r, 50))
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
  qc.setQueryData(devicesKey, [device])
  await expect.element(screen.getByRole('dialog')).toBeVisible()
})

test.each([
  ['devices', devicesKey, seriesKey],
  ['series', seriesKey, devicesKey],
] as const)('%s failed on the server: the HTML matches the hydrating client, no "no data"', async (_n, failedKey, okKey) => {
  const seedOk = (qc: QueryClient) =>
    qc.setQueryData(okKey, okKey === devicesKey ? [device] : noSeries)
  const server = await firstHtml((qc) => {
    seedOk(qc)
    failedOnServer(qc, failedKey)
  })
  const client = await firstHtml(seedOk)
  expect(server).toBe(client)
  expect(server).not.toContain(m.sensors_chart_empty())
  expect(server).not.toContain(m.sensors_empty_title())
})

test("a range switch keeps the shown range's chart, dimmed, with that range's tick labels", async () => {
  const HOUR = 3_600_000
  const t0 = Date.now() - 24 * HOUR
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    t: t0 + i * HOUR,
    perDevice: { a: { tempAvg: 21 + (i % 3) * 0.2, humAvg: 45 } },
  }))
  const yearKey = orpc.sensor.series.queryOptions({ input: { range: '1y' } }).queryKey
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, { buckets, bucketSec: 3600 })
    pendingForever(qc, yearKey)
  })
  // The x-axis ticks: the y-axis ones carry the unit ("21.0°C", "45%").
  const xTicks = () =>
    [...document.querySelectorAll('.recharts-cartesian-axis-tick-value')]
      .map((e) => e.textContent ?? '')
      .filter((text) => !text.endsWith('°C') && !text.endsWith('%'))
  // The chart measures its container before drawing axes: give it time.
  await expect.poll(() => xTicks().length, { timeout: 5000 }).toBeGreaterThan(0)
  expect(document.querySelector('[aria-busy="true"]')).toBeNull()

  await screen.getByRole('radio', { name: m.sensors_range_1y() }).click()
  // The 24 h data stays up while the year loads: dimmed, and still labelled as hours.
  await expect.poll(() => document.querySelectorAll('[aria-busy="true"]').length).toBe(2)
  expect(xTicks().length).toBeGreaterThan(0)
  for (const tick of xTicks()) expect(tick).toMatch(/\d{1,2}[:.]\d{2}/)
})

test('a range switch from an empty range never claims "no data" while the next loads', async () => {
  const yearKey = orpc.sensor.series.queryOptions({ input: { range: '1y' } }).queryKey
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, noSeries)
    pendingForever(qc, yearKey)
  })
  // The 24 h range really is empty: "no data" is the loaded state there.
  await expect.element(screen.getByText(m.sensors_chart_empty()).first()).toBeVisible()
  await screen.getByRole('radio', { name: m.sensors_range_1y() }).click()
  await expect.poll(() => document.querySelectorAll('[aria-busy="true"]').length).toBe(2)
  expect(screen.getByText(m.sensors_chart_empty()).elements()).toHaveLength(0)
})

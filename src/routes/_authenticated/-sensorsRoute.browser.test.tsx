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
  lastSeenAt: new Date(),
  latest: { temperatureC: 21.7, humidityPct: 46, recordedAt: new Date() },
}
const noSeries = { buckets: [], bucketSec: 900 }

// A query whose fetch never settles stays `pending`.
const pendingForever = (qc: QueryClient, queryKey: readonly unknown[]) => {
  qc.removeQueries({ queryKey, exact: true })
  void qc.prefetchQuery({ queryKey, queryFn: () => new Promise(() => {}) })
}

async function renderSensors(search: string, prepare: (qc: QueryClient) => void) {
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
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

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

test('an edit deep link opens once the devices are in', async () => {
  const { screen } = await renderSensors('?dialog=edit&deviceId=a', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, noSeries)
  })
  await expect.element(screen.getByRole('dialog')).toBeVisible()
})

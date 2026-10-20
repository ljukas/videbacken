import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { xTickLabels } from '~test/browser/chartDom'
import { makeTestQueryClient } from '~test/browser/render'
import { Route as Sensors } from './sensors'

// The oRPC link keeps the `fetch` it saw at import, so a test that holds a mutation's request
// installs the stub before any import. Everything else reaches the real fetch (and so fails).
const rpc = vi.hoisted(() => {
  const realFetch = globalThis.fetch.bind(globalThis)
  const state: { hold: ((url: string) => Promise<Response> | null) | null } = { hold: null }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    return state.hold?.(url) ?? realFetch(input, init)
  }) as typeof fetch
  return state
})

// The real page under a bare root (routeTree.gen.ts isn't loaded), with the cache
// seeded through the oRPC keys. Anything unseeded fails (no /api/rpc in the test
// server), which is how a failed read is staged. `-` keeps it out of the route tree.
type Device = RouterOutputs['sensor']['listDevices'][number]

const devicesKey = orpc.sensor.listDevices.queryOptions().queryKey
const alertsKey = orpc.sensor.alerts.list.queryOptions().queryKey
const seriesKey = orpc.sensor.series.queryOptions({ input: { range: '24h' } }).queryKey
const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

const device: Device = {
  id: 'a',
  mac: 'a4cf12ab34cd',
  name: null,
  location: null,
  shellyName: null,
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
  expect(skeleton('sensors-chips')).not.toBeNull()
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
  // The alert sits in the Historik card, under its still-working range control.
  const history = screen.getByRole('region', { name: m.sensors_history_heading() })
  await expect.element(history.getByText(m.sensors_series_error_title())).toBeVisible()
  await expect.element(history.getByRole('radio', { name: m.sensors_range_1y() })).toBeVisible()
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
  expect(skeleton('sensors-chips')).toBeNull()
})

test('the range control sits in the Historik card with the chips and both charts', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, noSeries)
  })
  const history = screen.getByRole('region', { name: m.sensors_history_heading() })
  await expect.element(history).toBeVisible()
  await expect.element(history.getByRole('radio', { name: m.sensors_range_1y() })).toBeVisible()
  await expect
    .element(history.getByRole('button', { name: 'Sensor 34cd', exact: true }))
    .toBeVisible()
  await expect
    .element(history.getByRole('heading', { name: m.sensors_temp_chart_title() }))
    .toBeVisible()
  await expect
    .element(history.getByRole('heading', { name: m.sensors_humidity_chart_title() }))
    .toBeVisible()
  // The tiles are in their own card, outside Historik.
  const current = screen.getByRole('region', { name: m.sensors_current_heading() })
  await expect.element(current.getByText('21.7°C')).toBeVisible()
  expect(history.getByText('21.7°C').elements()).toHaveLength(0)
  expect(document.querySelector('[data-slot="chart-legend"]')).toBeNull()
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
  // The x-axis ticks (the y-axis ones carry the unit and aren't x ticks).
  const xTicks = () => xTickLabels(document)
  // The chart measures its container before drawing axes: give it time.
  await expect.poll(() => xTicks().length, { timeout: 5000 }).toBeGreaterThan(0)
  expect(document.querySelector('[aria-busy="true"]')).toBeNull()

  await screen.getByRole('radio', { name: m.sensors_range_1y() }).click()
  // The 24 h data stays up while the year loads: dimmed, and still labelled as hours.
  await expect.poll(() => document.querySelectorAll('[aria-busy="true"]').length).toBe(2)
  // Only the charts dim: the range control and the chips stay live and in place.
  const radio = screen.getByRole('radio', { name: m.sensors_range_1y() }).element()
  expect(radio.closest('[aria-busy="true"]')).toBeNull()
  const chip = screen.getByRole('button', { name: 'Sensor 34cd', exact: true }).element()
  expect(chip.closest('[aria-busy="true"]')).toBeNull()
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

test('the viewer’s switched-on rules show as a count on the tile bell', async () => {
  const rule = (id: string, enabled: boolean) => ({
    id,
    deviceId: 'a',
    kind: 'temperature' as const,
    enabled,
    direction: 'above' as const,
    threshold: 30,
    count: 1,
    silenceHours: null,
    firingSince: null,
  })
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, noSeries)
    qc.setQueryData(alertsKey, {
      rules: [rule('r1', true), rule('r2', true), rule('r3', false)],
      typicalGapMinutes: {},
    })
  })
  await expect
    .element(
      screen.getByRole('button', {
        name: m.sensors_alerts_open_named_count({ name: 'Sensor 34cd', count: 2 }),
      }),
    )
    .toBeVisible()
})

test('a firing rule turns its tile bell red with the firing count', async () => {
  const rule = (id: string, firingSince: Date | null) => ({
    id,
    deviceId: 'a',
    kind: 'temperature' as const,
    enabled: true,
    direction: 'above' as const,
    threshold: 30,
    count: 2,
    silenceHours: null,
    firingSince,
  })
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, noSeries)
    qc.setQueryData(alertsKey, {
      rules: [rule('r1', new Date(Date.now() - 600_000)), rule('r2', null)],
      typicalGapMinutes: {},
    })
  })
  const bell = screen.getByRole('button', {
    name: m.sensors_alerts_open_named_firing({ name: 'Sensor 34cd', count: 1 }),
  })
  await expect.element(bell).toBeVisible()
  expect(bell.element().querySelector('[data-slot="badge"]')?.textContent).toBe('1')
})

test("the rules' mutations invalidate the alerts key, which covers the history", async () => {
  const qc = makeTestQueryClient()
  const historyKey = orpc.sensor.alerts.history.infiniteOptions({
    input: (before: { startedAt: Date; id: string } | undefined) => ({ deviceId: 'a', before }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  }).queryKey
  qc.setQueryData(historyKey, { pages: [], pageParams: [] })
  await qc.invalidateQueries({ queryKey: orpc.sensor.alerts.key() })
  expect(qc.getQueryState(historyKey)?.isInvalidated).toBe(true)
})

test('the alerts read failing leaves plain bells, tiles intact', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, noSeries)
    failedOnServer(qc, alertsKey)
  })
  await expect.element(screen.getByText('21.7°C')).toBeVisible()
  await expect
    .element(
      screen.getByRole('button', { name: m.sensors_alerts_open_named({ name: 'Sensor 34cd' }) }),
    )
    .toBeVisible()
})

const seedAlertsPage = (qc: QueryClient) => {
  qc.setQueryData(devicesKey, [device])
  qc.setQueryData(seriesKey, noSeries)
  qc.setQueryData(alertsKey, { rules: [], typicalGapMinutes: {} })
}
const bell = m.sensors_alerts_open_named({ name: 'Sensor 34cd' })

test('the alerts dialog: bell, "Nytt larm", close — the URL keeps no dialog state', async () => {
  const { screen, router } = await renderSensors('', seedAlertsPage)
  await screen.getByRole('button', { name: bell }).click()
  const dialog = screen.getByRole('dialog')
  await expect.element(dialog.getByRole('button', { name: m.sensors_alert_new() })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ dialog: 'alerts', deviceId: 'a' })

  await dialog.getByRole('button', { name: m.sensors_alert_new() }).click()
  await expect.element(dialog.getByRole('button', { name: m.common_save() })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ alertId: 'new' })

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0)
  const search = router.state.location.search as Record<string, unknown>
  expect(search.dialog).toBeUndefined()
  expect(search.deviceId).toBeUndefined()
  expect(search.alertId).toBeUndefined()
})

test('a bell opens the list even with a stale alertId in the URL', async () => {
  // Left over from a form whose sensor was deleted, or a hand-edited link.
  const { screen, router } = await renderSensors('?alertId=new', seedAlertsPage)
  await screen.getByRole('button', { name: bell }).click()
  const dialog = screen.getByRole('dialog')
  await expect.element(dialog.getByRole('button', { name: m.sensors_alert_new() })).toBeVisible()
  expect(dialog.getByRole('button', { name: m.common_save() }).elements()).toHaveLength(0)
  expect((router.state.location.search as Record<string, unknown>).alertId).toBeUndefined()
})

test('back from the form to the list leaves no form behind: browser Back then closes', async () => {
  const { screen, router } = await renderSensors('', seedAlertsPage)
  await screen.getByRole('button', { name: bell }).click()
  const dialog = screen.getByRole('dialog')
  await dialog.getByRole('button', { name: m.sensors_alert_new() }).click()
  await dialog.getByRole('button', { name: m.common_back() }).click()
  await expect.element(dialog.getByRole('button', { name: m.sensors_alert_new() })).toBeVisible()
  expect((router.state.location.search as Record<string, unknown>).alertId).toBeUndefined()

  router.history.back()
  await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0)
  expect((router.state.location.search as Record<string, unknown>).dialog).toBeUndefined()
})

const rpcOk = (json: unknown) =>
  new Response(JSON.stringify({ json }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

// Holds the next request to `path` until `release()`, then answers it with oRPC's success body.
// Meanwhile the rules' refetch (after a save) gets an empty list at once: the test server would
// leave it hanging.
afterEach(() => {
  rpc.hold = null
})
function holdRpc(path: string) {
  let release = () => {}
  let seen = false
  rpc.hold = (url) => {
    if (url.includes('/api/rpc/sensor/alerts/list')) {
      return Promise.resolve(rpcOk({ rules: [], typicalGapMinutes: {} }))
    }
    if (!url.includes(path) || seen) return null
    seen = true
    return new Promise<Response>((resolve) => {
      release = () => resolve(rpcOk({ id: 'r1' }))
    })
  }
  return { release: () => release(), seen: () => seen }
}

// A save checks the sensor's id is a uuid.
const SENSOR_ID = '00000000-0000-4000-8000-0000000000d1'
const RULE = {
  id: '00000000-0000-4000-8000-000000000001',
  deviceId: SENSOR_ID,
  kind: 'temperature' as const,
  enabled: true,
  direction: 'below' as const,
  threshold: 5,
  count: 2,
  silenceHours: null,
  firingSince: null,
}

test.each([
  ['save', '/sensor/alerts/create'],
  ['delete', '/sensor/alerts/delete'],
] as const)('a %s that lands after the dialog closed leaves it closed', async (action, path) => {
  const { screen, router, qc } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [{ ...device, id: SENSOR_ID }])
    qc.setQueryData(seriesKey, noSeries)
    qc.setQueryData(alertsKey, {
      rules: action === 'delete' ? [RULE] : [],
      typicalGapMinutes: {},
    })
  })
  const held = holdRpc(path)
  const bellName =
    action === 'delete'
      ? m.sensors_alerts_open_named_count({ name: 'Sensor 34cd', count: 1 })
      : bell
  await screen.getByRole('button', { name: bellName }).click()
  const dialog = screen.getByRole('dialog')
  if (action === 'save') {
    await dialog.getByRole('button', { name: m.sensors_alert_new() }).click()
    await dialog.getByLabelText(m.sensors_alert_field_threshold()).fill('5')
    await dialog.getByRole('button', { name: m.common_save() }).click()
  } else {
    await dialog.getByRole('button', { name: /^Ändra larmet: Temperatur under 5/ }).click()
    await dialog.getByRole('button', { name: m.sensors_alert_delete() }).click()
    await dialog.getByRole('button', { name: m.sensors_alert_delete() }).click()
  }
  await expect.poll(held.seen).toBe(true)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0)

  held.release()
  // Let the late success run its course: the mutation settles (a save first refetches the
  // rules), then the way back and any navigation.
  await expect.poll(() => qc.isMutating(), { timeout: 5000 }).toBe(0)
  await new Promise((r) => setTimeout(r, 200))
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
  const search = router.state.location.search as Record<string, unknown>
  expect(search.dialog).toBeUndefined()
  expect(search.alertId).toBeUndefined()
})

test('back from a deep-linked form stays on the page, even after Back and Forward elsewhere', async () => {
  const { screen, router } = await renderSensors(
    '?dialog=alerts&deviceId=a&alertId=new',
    seedAlertsPage,
  )
  const dialog = screen.getByRole('dialog')
  await expect.element(dialog.getByRole('button', { name: m.common_save() })).toBeVisible()
  // Close, reopen, push a form: then Back to the first entry, the deep-linked form.
  await dialog.getByRole('button', { name: 'Close' }).click()
  await screen.getByRole('button', { name: bell }).click()
  await screen.getByRole('dialog').getByRole('button', { name: m.sensors_alert_new() }).click()
  await expect
    .poll(() => (router.state.location.search as Record<string, unknown>).alertId)
    .toBe('new')
  router.history.back()
  router.history.back()
  router.history.back()
  await expect.poll(() => router.history.location.state.__TSR_index).toBe(0)
  await expect
    .element(screen.getByRole('dialog').getByRole('button', { name: m.common_save() }))
    .toBeVisible()

  // Tillbaka has no list entry to step back onto: it turns this entry into the list.
  await screen.getByRole('dialog').getByRole('button', { name: m.common_back() }).click()
  await expect
    .element(screen.getByRole('dialog').getByRole('button', { name: m.sensors_alert_new() }))
    .toBeVisible()
  const search = router.state.location.search as Record<string, unknown>
  expect(search).toMatchObject({ dialog: 'alerts', deviceId: 'a' })
  expect(search.alertId).toBeUndefined()
  expect(router.history.location.state.__TSR_index).toBe(0)
})

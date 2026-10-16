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
import { formatAgo } from '~/components/evCharging/format'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import {
  heatPumpDaysQuery,
  heatPumpEventsQuery,
  heatPumpMonthsQuery,
} from '~/components/heatPump/heatPumpQueries'
import { m } from '~/paraglide/messages'
import { clickOn, parkPointer, seriesBars } from '~test/browser/chartDom'
import { makeTestQueryClient } from '~test/browser/render'
import { seedSourcesHealth } from '~test/browser/syncHealth'
import { allPayload, cell, daysPayload, MATSAL, monthsPayload } from '~test/fixtures/heatPumpView'
import { Route } from './heat-pumps'

// The default month is September 2026 (the fixture's newest month). Only `Date` is faked.
beforeEach(async () => {
  await parkPointer()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

const seedYear = (qc: QueryClient, data: unknown = monthsPayload()) =>
  qc.setQueryData(heatPumpMonthsQuery(2026).queryKey, data as never)
const seedSeptember = (qc: QueryClient) =>
  qc.setQueryData(
    heatPumpDaysQuery({ from: '2026-09-01', to: '2026-09-30' }).queryKey,
    daysPayload(2026, 9, 15) as never,
  )

// The route's own search schema, read before any test re-points the route (`update` below mutates it).
const routeSearchSchema = Route.options.validateSearch

// As -energyPage.browser.test.tsx: anything unseeded fails (no /api/rpc in the test server).
// The route's loader runs (on the client's path: it starts its reads and awaits none).
async function loadPage(
  path: string,
  prepare: (qc: QueryClient) => void,
  health: Parameters<typeof seedSourcesHealth>[1] = {},
  { role = 'user' }: { role?: 'user' | 'admin' } = {},
) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } })
  qc.setQueryDefaults(syncHealthQuery.queryKey, { staleTime: Number.POSITIVE_INFINITY })
  seedSourcesHealth(qc, health)
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  const pathname = path.split('?')[0]
  ;(Route as unknown as { update: (o: unknown) => void }).update({
    id: pathname,
    path: pathname,
    getParentRoute: () => root,
    validateSearch: routeSearchSchema,
  })
  const router = createRouter({
    routeTree: root.addChildren([Route] as never[]),
    context: { queryClient: qc, user: { id: 'u1', role } },
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  return { router, qc }
}

async function renderPage(...args: Parameters<typeof loadPage>) {
  const { router, qc } = await loadPage(...args)
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

test('the default is the current month: heading, the Förbrukning card, tiles and a bar per day', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
  })
  await expect
    .element(screen.getByRole('heading', { level: 1, name: m.heat_pump_title() }))
    .toBeVisible()
  await expect
    .element(screen.getByRole('heading', { name: m.heat_pump_consumption_heading() }))
    .toBeVisible()
  await expect.element(screen.getByRole('button', { name: /september 2026/i })).toBeVisible()
  expect(screen.container.querySelector(`[data-heat-pump-tile="${MATSAL.id}"]`)).not.toBeNull()
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(15))
})

test("a year: month bars with last year's outline; clicking a month opens its days", async () => {
  const { screen, router } = await renderPage('/energy/heat-pumps?period=2026', (qc) =>
    seedYear(qc),
  )
  await vi.waitFor(() => expect(seriesBars(screen.container, 2)).toHaveLength(12))
  await clickOn(screen.container, seriesBars(screen.container, 0)[2])
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ period: '2026-03' }))
})

test("a period change keeps the page's other search keys (the event dialogs' state)", async () => {
  // An open dialog would cover the chart, so the kept key is the dialog's `eventId` on its own.
  const { screen, router } = await renderPage('/energy/heat-pumps?period=2026&eventId=e1', (qc) =>
    seedYear(qc),
  )
  await vi.waitFor(() => expect(seriesBars(screen.container, 0).length).toBeGreaterThan(2))
  await clickOn(screen.container, seriesBars(screen.container, 0)[2])
  await vi.waitFor(() =>
    expect(router.state.location.search).toEqual({ period: '2026-03', eventId: 'e1' }),
  )
})

test('Totalt reads the whole history: a bar per month, no comparison', async () => {
  const { screen } = await renderPage('/energy/heat-pumps?period=all', (qc) =>
    qc.setQueryData(heatPumpMonthsQuery(undefined).queryKey, allPayload() as never),
  )
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(21))
  expect(screen.container.textContent).not.toMatch(/mot 20\d\d/)
})

test("a new year's first hours, no readings in it yet: the default is Totalt, and the card shows Totalt's bars", async () => {
  vi.setSystemTime(new Date('2026-12-31T23:30:00Z')) // 2027-01-01 00:30 Stockholm
  const { screen, router } = await renderPage('/energy/heat-pumps', (qc) => {
    const year = monthsPayload()
    qc.setQueryData(
      heatPumpMonthsQuery(2027).queryKey,
      monthsPayload({
        year: 2027,
        availableYears: [2027, 2026, 2025],
        months: [],
        lastYear: year.months,
        lastYearSoFar: null,
      }) as never,
    )
    qc.setQueryData(heatPumpMonthsQuery(undefined).queryKey, allPayload() as never)
  })
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(21))
  expect(router.state.location.search).toEqual({})
})

test('the year read and a newer history read disagree on the new year: the year read decides, no render loop', async () => {
  // 2027-01-01 08:00 Stockholm: the cached year read (from before a sync) has no 2027 month; the history, refetched
  // after the sync, has January's first hours.
  vi.setSystemTime(new Date('2027-01-01T07:00:00Z'))
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const all = allPayload()
  const { screen } = await renderPage('/energy/heat-pumps', (qc) => {
    qc.setQueryData(
      heatPumpMonthsQuery(2027).queryKey,
      monthsPayload({
        year: 2027,
        availableYears: [2027, 2026, 2025],
        months: [],
        lastYear: monthsPayload().months,
        lastYearSoFar: null,
      }) as never,
    )
    qc.setQueryData(heatPumpMonthsQuery(undefined).queryKey, {
      ...all,
      monthsWithReadings: [...all.monthsWithReadings, '2027-01'],
      newestMonth: '2027-01',
      months: [...all.months, cell(MATSAL, 2027, 1, { kwh: 1, hours: 7, expectedHours: 7 })],
    } as never)
  })
  await vi.waitFor(() => expect(seriesBars(screen.container, 0).length).toBeGreaterThan(20))
  await expect.element(screen.getByRole('button', { name: /totalt|all time/i })).toBeVisible()
  expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/Too many re-renders/)
  errors.mockRestore()
})

test("the loader reads the days of the month the page shows: the last one, in a new month's first hours", async () => {
  vi.setSystemTime(new Date('2026-10-01T01:30:00Z')) // 03:30 Stockholm: no October hour stored yet
  const { qc } = await loadPage('/energy/heat-pumps', (qc) => seedYear(qc))
  const started = (range: { from: string; to: string }) =>
    qc.getQueryCache().find({ queryKey: heatPumpDaysQuery(range).queryKey, exact: true })
  expect(started({ from: '2026-09-01', to: '2026-09-30' })).toBeDefined()
  expect(started({ from: '2026-10-01', to: '2026-10-31' })).toBeUndefined()
})

test('the loader reads the history when the default resolves to Totalt', async () => {
  vi.setSystemTime(new Date('2026-12-31T23:30:00Z')) // 2027-01-01 00:30 Stockholm
  const { qc } = await loadPage('/energy/heat-pumps', (qc) =>
    qc.setQueryData(
      heatPumpMonthsQuery(2027).queryKey,
      monthsPayload({ year: 2027, months: [], lastYearSoFar: null }) as never,
    ),
  )
  expect(
    qc.getQueryCache().find({ queryKey: heatPumpMonthsQuery(undefined).queryKey, exact: true }),
  ).toBeDefined()
})

test('stepping to another month keeps the last chart, dimmed and busy, until its days land', async () => {
  const { screen, qc } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
  })
  // August's days never arrive.
  void qc.prefetchQuery({
    queryKey: heatPumpDaysQuery({ from: '2026-08-01', to: '2026-08-31' }).queryKey,
    queryFn: () => new Promise(() => {}),
  })
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(15))
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  await expect.element(screen.getByRole('button', { name: /augusti 2026/i })).toBeVisible()
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull(),
  )
  expect(seriesBars(screen.container, 0)).toHaveLength(15) // September's bars, dimmed
})

test('a month without readings moves the URL to the default month', async () => {
  const { router } = await renderPage('/energy/heat-pumps?period=2026-11', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
  })
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ period: '2026-09' }))
})

test('a year without readings moves the URL to the default month', async () => {
  // 2024 is a valid year (2020–2100; outside it the param is dropped), before the first reading (2025).
  const { router } = await renderPage('/energy/heat-pumps?period=2024', (qc) => {
    // The read answers a year without readings with the current year's months.
    qc.setQueryData(heatPumpMonthsQuery(2024).queryKey, monthsPayload() as never)
    seedYear(qc)
    seedSeptember(qc)
  })
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ period: '2026-09' }))
})

const periodControl = /Välj period|Choose period/

test('from a month to its whole year, then to Totalt, through the period control', async () => {
  const { screen, router } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
    qc.setQueryData(heatPumpMonthsQuery(undefined).queryKey, allPayload() as never)
  })
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(15))
  await screen.getByRole('button', { name: periodControl }).click()
  await screen.getByRole('button', { name: m.energy_period_whole_year({ year: '2026' }) }).click()
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ period: 2026 }))
  await vi.waitFor(() => expect(seriesBars(screen.container, 2)).toHaveLength(12)) // last year's outline
  await screen.getByRole('button', { name: periodControl }).click()
  await screen.getByRole('button', { name: m.charging_tile_all_time(), exact: true }).click()
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ period: 'all' }))
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(21))
})

test('from a year to a month whose days are still loading: the year stays, dimmed and busy', async () => {
  const { screen, qc } = await renderPage('/energy/heat-pumps?period=2026', (qc) => seedYear(qc))
  // March's days never arrive.
  void qc.prefetchQuery({
    queryKey: heatPumpDaysQuery({ from: '2026-03-01', to: '2026-03-31' }).queryKey,
    queryFn: () => new Promise(() => {}),
  })
  await vi.waitFor(() => expect(seriesBars(screen.container, 2)).toHaveLength(12))
  await clickOn(screen.container, seriesBars(screen.container, 0)[2])
  await expect.element(screen.getByRole('button', { name: /mars 2026/i })).toBeVisible()
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull(),
  )
  expect(seriesBars(screen.container, 2)).toHaveLength(12) // the year's chart, dimmed
})

test('no readings: the empty state', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', (qc) =>
    seedYear(
      qc,
      monthsPayload({
        units: [],
        availableYears: [2026],
        firstReadingDay: null,
        monthsWithReadings: [],
        newestMonth: null,
        months: [],
        lastYear: [],
        lastYearSoFar: null,
      }),
    ),
  )
  await expect.element(screen.getByText(m.heat_pump_empty_title())).toBeVisible()
})

test('a failed read: the heading stays, the alert shows', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', () => {})
  await expect
    .element(screen.getByRole('heading', { level: 1, name: m.heat_pump_title() }))
    .toBeVisible()
  await expect.element(screen.getByText(m.heat_pump_error_title())).toBeVisible()
})

test('Comfort Cloud\'s health: its alert when unhealthy, its "senast synkad" in the heading', async () => {
  const synced = new Date('2026-09-15T06:00:00Z')
  const { screen } = await renderPage(
    '/energy/heat-pumps',
    (qc) => {
      seedYear(qc)
      seedSeptember(qc)
    },
    {
      comfortCloud: {
        state: 'failing',
        lastSuccessAt: synced,
        failingSince: new Date('2026-09-15T00:20:00Z'),
        consecutiveFailures: 2,
        code: 'unreachable',
      },
      emaldo: { lastSuccessAt: new Date('2026-09-15T11:45:00Z') },
    },
  )
  await expect.element(screen.getByRole('alert')).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_last_synced({ time: formatAgo(synced) })))
    .toBeVisible()
})

// Step 4a: Händelser.
const eventsKey = heatPumpEventsQuery.queryKey
const SERVICE = {
  id: 'e1',
  occurredOn: '2026-09-10',
  heatPumpId: null,
  kind: 'service' as const,
  note: 'Årlig service',
}
const seedPage = (events: unknown) => (qc: QueryClient) => {
  seedYear(qc)
  seedSeptember(qc)
  qc.setQueryData(eventsKey, events as never)
}

test('the events card lists the events, and the day chart marks them', async () => {
  const { screen } = await renderPage(
    '/energy/heat-pumps',
    seedPage([SERVICE]),
    {},
    { role: 'admin' },
  )
  await expect
    .element(screen.getByRole('heading', { name: m.heat_pump_events_title() }))
    .toBeVisible()
  await expect.element(screen.getByText('Årlig service')).toBeVisible()
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('[data-marker="all"]')).toHaveLength(1),
  )
})

// Review Focus 4.
test('a member sees the list but no controls, and an admin link is cleaned', async () => {
  const { screen, router } = await renderPage(
    '/energy/heat-pumps?dialog=eventNew',
    seedPage([SERVICE]),
  )
  await expect.element(screen.getByText('Årlig service')).toBeVisible()
  expect(screen.getByRole('button', { name: m.heat_pump_events_add() }).elements()).toHaveLength(0)
  expect(screen.getByRole('button', { name: /^Åtgärder för/ }).elements()).toHaveLength(0)
  await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('dialog'))
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

test('an admin opens "Lägg till" through the URL', async () => {
  const { screen, router } = await renderPage(
    '/energy/heat-pumps',
    seedPage([SERVICE]),
    {},
    { role: 'admin' },
  )
  await screen.getByRole('button', { name: m.heat_pump_events_add() }).click()
  await expect
    .element(screen.getByRole('dialog', { name: m.heat_pump_event_dialog_new_title() }))
    .toBeVisible()
  expect(router.state.location.search).toMatchObject({ dialog: 'eventNew' })
})

test('an edit deep link opens that event', async () => {
  const { screen } = await renderPage(
    '/energy/heat-pumps?dialog=eventEdit&eventId=e1',
    seedPage([SERVICE]),
    {},
    { role: 'admin' },
  )
  await expect
    .element(screen.getByRole('dialog', { name: m.heat_pump_event_dialog_edit_title() }))
    .toBeVisible()
  await expect
    .element(screen.getByLabelText(m.heat_pump_event_field_note()))
    .toHaveValue('Årlig service')
})

// Review Focus 3.
test('a deep link to a deleted event is cleaned', async () => {
  const { router } = await renderPage(
    '/energy/heat-pumps?dialog=eventDelete&eventId=gone',
    seedPage([SERVICE]),
    {},
    { role: 'admin' },
  )
  await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('dialog'))
  expect(router.state.location.search).not.toHaveProperty('eventId')
})

test('events still loading: the card is a skeleton, never "Inga händelser ännu"', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
    void qc.prefetchQuery({ queryKey: eventsKey, queryFn: () => new Promise(() => {}) })
  })
  await vi.waitFor(() =>
    expect(document.querySelector('[data-boneyard="heat-pumps-events"]')).not.toBeNull(),
  )
  expect(screen.getByText(m.heat_pump_events_empty_title()).elements()).toHaveLength(0)
})

test('events failed: the alert, no empty state', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
  })
  await expect.element(screen.getByText(m.heat_pump_events_error_title())).toBeVisible()
  expect(screen.getByText(m.heat_pump_events_empty_title()).elements()).toHaveLength(0)
})

test('the dialog keys stay on this route: the shared energy schema has none', async () => {
  const { energySearchSchema } = await import('~/components/energy/energySearch')
  expect(energySearchSchema.parse({ dialog: 'eventNew', eventId: 'e1' })).not.toHaveProperty(
    'dialog',
  )
})

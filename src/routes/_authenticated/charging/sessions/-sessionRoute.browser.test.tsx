import { ORPCError } from '@orpc/client'
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  isNotFound,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { NotFound } from '~/components/NotFound'
import { emptyTotals } from '~/lib/evCharging/cost'
import { logger } from '~/lib/logger/browser'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { Route } from './$sessionId'

// The route's own loader, not a copy: an unknown, voided or malformed id must
// reach the app's NotFound (never a 500 or the generic alert), while any other
// failure resolves so the page's LoadErrorAlert shows. The `-` prefix keeps
// this file out of the route tree.
type LoaderArgs = {
  context: { queryClient: Pick<QueryClient, 'ensureQueryData'> }
  params: { sessionId: string }
}
const loader = Route.options.loader as unknown as (args: LoaderArgs) => Promise<unknown>

const SESSION_ID = '00000000-0000-4000-8000-000000000001'

function run(sessionId: string, ensureQueryData: () => Promise<unknown>) {
  const ensure = vi.fn(ensureQueryData)
  const queryClient = { ensureQueryData: ensure } as unknown as LoaderArgs['context']['queryClient']
  return { ensure, result: loader({ context: { queryClient }, params: { sessionId } }) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('an unknown or voided session throws a router notFound', async () => {
  const { result } = run(SESSION_ID, () =>
    Promise.reject(new ORPCError('EV_SESSION_NOT_FOUND', { status: 404, defined: true })),
  )
  const thrown = await result.then(
    () => null,
    (err: unknown) => err,
  )
  expect(isNotFound(thrown)).toBe(true)
})

test('a malformed id throws notFound without fetching', async () => {
  const { ensure, result } = run('nope', () => Promise.resolve(null))
  const thrown = await result.then(
    () => null,
    (err: unknown) => err,
  )
  expect(isNotFound(thrown)).toBe(true)
  expect(ensure).not.toHaveBeenCalled()
})

test('any other failure resolves (the page shows its load-error alert) and is logged', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const { ensure, result } = run(SESSION_ID, () =>
    Promise.reject(new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 })),
  )
  await expect(result).resolves.toBeUndefined()
  expect(ensure).toHaveBeenCalledOnce()
  expect(warn).toHaveBeenCalledWith(
    'session prefetch failed',
    expect.objectContaining({ sessionId: SESSION_ID }),
  )
})

test('a found session resolves', async () => {
  const { ensure, result } = run(SESSION_ID, () => Promise.resolve({}))
  await expect(result).resolves.toBeUndefined()
  expect(ensure).toHaveBeenCalledOnce()
})

// The page itself, mounted under a bare root with the app's NotFound, so the
// loader's outcome is seen as the visitor sees it. The route is re-parented
// onto that root (routeTree.gen.ts, which pulls in every route, isn't loaded).
async function renderPage(
  sessionId: string,
  prepare: (queryClient: QueryClient) => void = () => {},
  role: 'admin' | 'user' = 'user',
) {
  const queryClient = makeTestQueryClient()
  prepare(queryClient)
  const root = createRootRouteWithContext<{
    queryClient: typeof queryClient
    user: { role: 'admin' | 'user' }
  }>()({
    component: Outlet,
    notFoundComponent: () => <NotFound />,
  })
  Route.update({
    id: '/_authenticated/charging/sessions/$sessionId',
    path: '/charging/sessions/$sessionId',
    getParentRoute: () => root,
  } as never)
  const router = createRouter({
    routeTree: root.addChildren([Route]),
    context: { queryClient, user: { role } },
    history: createMemoryHistory({ initialEntries: [`/charging/sessions/${sessionId}`] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return screen
}

test('a malformed id renders the app NotFound, not the load-error alert', async () => {
  const screen = await renderPage('nope')
  await expect.element(screen.getByText(m.notfound_body())).toBeVisible()
  expect(screen.getByRole('alert').elements()).toHaveLength(0)
})

test('a failed load keeps one h1 above the load-error alert', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  // The loader's prefetch fails; the page's own query then fails too, since the
  // test server has no /api/rpc (a plain 404, not the session's not-found code).
  const screen = await renderPage(SESSION_ID, (queryClient) =>
    vi
      .spyOn(queryClient, 'ensureQueryData')
      .mockRejectedValue(new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 })),
  )
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent(m.charging_session_error_title())
  expect(screen.getByRole('heading', { level: 1 }).elements()).toHaveLength(1)
  await expect
    .element(screen.getByRole('heading', { level: 1 }))
    .toMatchTextContent(m.meta_charging_session_title())
  expect(warn).toHaveBeenCalledWith('session prefetch failed', expect.anything())
})

// One found session through the real route component: the summary and the
// chart render together under one h1.
const foundDetail = (vehicle: 'ours' | 'other' = 'ours') => {
  const at = (hhmm: string) => Date.parse(`2026-09-15T${hhmm}:00Z`)
  const QUARTER = 15 * 60_000
  const cost = (totalSek: number) => ({
    ...emptyTotals(),
    kwh: 10,
    gridKwh: 10,
    fullKwh: 10,
    totalSek,
  })
  const detail = {
    cost: { ...cost(20), avgOre: 200, complete: true, noHouseDataKwh: 10 },
    session: {
      id: SESSION_ID,
      startAt: new Date(at('08:00')),
      endAt: new Date(at('10:00')),
      kwh: 10,
      peakKw: 10,
      estimated: false,
      vehicle: 'ours',
      vehicleSource: 'default',
    },
    window: { startMs: at('08:00'), endMs: at('10:00') },
    intervals: [{ startMs: at('08:00'), endMs: at('09:00'), kwh: 10 }],
    prices: Array.from({ length: 16 }, (_, i) => ({
      startMs: at('07:00') + i * QUARTER,
      endMs: at('07:00') + (i + 1) * QUARTER,
      spotOre: 125,
    })),
    optimalSchedule: [0, 1, 2, 3].map((i) => ({
      startMs: at('09:00') + i * QUARTER,
      endMs: at('09:00') + (i + 1) * QUARTER,
      kwh: 2.5,
    })),
    rateKw: 10,
    economy: {
      actual: cost(20),
      actualComplete: true,
      paidSpotOre: 125,
      windowAvgSpotOre: 125,
      excluded: null,
      counterfactual: {
        immediate: cost(22),
        optimal: cost(15),
        dearest: cost(30),
        score: 0.67,
        savedVsImmediateSek: 2,
        leftOnTableSek: 5,
      },
    },
  } as unknown as RouterOutputs['evCharging']['session']
  detail.session.vehicle = vehicle
  return detail
}

const renderFound = (vehicle: 'ours' | 'other', role: 'admin' | 'user' = 'user') =>
  renderPage(
    SESSION_ID,
    (queryClient) => {
      queryClient.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
      queryClient.setQueryData(
        orpc.evCharging.session.queryOptions({ input: { sessionId: SESSION_ID } }).queryKey,
        foundDetail(vehicle),
      )
    },
    role,
  )

test('a found session shows the header, summary and chart together', async () => {
  const screen = await renderFound('ours')
  await expect.element(screen.getByRole('heading', { level: 1 })).toBeVisible()
  expect(screen.getByRole('heading', { level: 1 }).elements()).toHaveLength(1)
  // Summary: the verdict pill and the range bar.
  await expect.poll(() => document.querySelector('[data-verdict]')).not.toBeNull()
  await expect
    .element(screen.getByRole('img', { name: new RegExp(`^${m.charging_session_range_actual()}`) }))
    .toBeVisible()
  // Chart: heading and both panels.
  await expect
    .element(screen.getByRole('heading', { level: 2, name: m.charging_session_chart_title() }))
    .toBeVisible()
  await expect.poll(() => document.querySelector('[data-panel="price"]')).not.toBeNull()
  expect(document.querySelector('[data-panel="energy"]')).not.toBeNull()
})

test('a guest session shows the badge; only an admin gets the select', async () => {
  const user = await renderFound('other')
  await expect
    .element(
      user
        .getByText(`${m.charging_vehicle_who_label()}: ${m.charging_vehicle_guest_badge()}`, {
          exact: false,
        })
        .first(),
    )
    .toBeVisible()
  await expect
    .element(user.getByText(m.charging_vehicle_who_label(), { exact: true }).first())
    .toBeVisible()
  expect(user.getByRole('combobox').query()).toBeNull()
  await user.unmount()

  const admin = await renderFound('other', 'admin')
  await expect
    .element(admin.getByRole('combobox', { name: m.charging_vehicle_who_label() }))
    .toBeVisible()
})

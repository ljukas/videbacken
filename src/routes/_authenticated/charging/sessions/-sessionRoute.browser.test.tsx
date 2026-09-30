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
import { logger } from '~/lib/logger/browser'
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
) {
  const queryClient = makeTestQueryClient()
  prepare(queryClient)
  const root = createRootRouteWithContext<{ queryClient: typeof queryClient }>()({
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
    context: { queryClient },
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
    .toHaveTextContent(m.charging_session_error_title())
  expect(screen.getByRole('heading', { level: 1 }).elements()).toHaveLength(1)
  await expect
    .element(screen.getByRole('heading', { level: 1 }))
    .toHaveTextContent(m.meta_charging_session_title())
  expect(warn).toHaveBeenCalledWith('session prefetch failed', expect.anything())
})

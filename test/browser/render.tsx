import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { render } from 'vitest-browser-react'

// Fresh client per test. retry:false → failing queries fail fast instead of
// backing off; gcTime:Infinity → no lingering GC timer to trip Vitest's
// "a timer kept the process alive" warning.
export function makeTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
}

type RenderOptions = { queryClient?: QueryClient }

// Wraps a component in the providers a leaf component needs to read data.
//
// Default data strategy is CACHE-SEEDING — build a client, seed it, pass it in.
// Always seed with the oRPC-generated key (never hand-write or cast it):
//
//   const queryClient = makeTestQueryClient()
//   queryClient.setQueryData(orpc.user.me.key(), fakeMe)
//   const { screen } = await renderWithProviders(<UserMenu />, { queryClient })
//   await expect.element(screen.getByText(fakeMe.name)).toBeVisible()
//
// `render` is async (vitest-browser-react), so await this. Components that also
// need routing (Link/useNavigate/route hooks) use `renderWithRouter` below.
export async function renderWithProviders(
  ui: ReactNode,
  { queryClient = makeTestQueryClient() }: RenderOptions = {},
) {
  const screen = await render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
  return { screen, queryClient }
}

// Like renderWithProviders, inside a memory-history router so <Link> and
// route hooks work. The ui renders as the root route's component at
// `initialPath`; hrefs are built as in the app (paths aren't matched).
export async function renderWithRouter(
  ui: ReactNode,
  {
    queryClient = makeTestQueryClient(),
    initialPath = '/',
  }: RenderOptions & { initialPath?: string } = {},
) {
  // `ui` is captured here: screen.rerender won't swap it — render again instead.
  const rootRoute = createRootRoute({ component: () => ui })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, queryClient, router }
}

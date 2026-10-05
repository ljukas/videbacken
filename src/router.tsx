import '~/lib/zodLocale'
import { StandardRPCJsonSerializer } from '@orpc/client/standard'
import { defaultShouldDehydrateQuery, QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { DefaultCatchBoundary } from './components/DefaultCatchBoundary'
import { NotFound } from './components/NotFound'
import { installGlobalHandlers } from './lib/logger/browser'
import { routeTree } from './routeTree.gen'

const serializer = new StandardRPCJsonSerializer()

export function getRouter() {
  installGlobalHandlers()
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        queryKeyHashFn(queryKey) {
          const [json, meta] = serializer.serialize(queryKey)
          return JSON.stringify({ json, meta })
        },
      },
      dehydrate: {
        serializeData(data) {
          const [json, meta] = serializer.serialize(data)
          return { json, meta }
        },
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
      },
      hydrate: {
        deserializeData(data) {
          return serializer.deserialize(data.json, data.meta)
        },
      },
    },
  })

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 30_000,
    defaultStaleTime: 30_000,
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  })

  // Provides the QueryClient and streams/hydrates the cache across SSR. With no
  // explicit dehydrate/hydrate options it uses the client's defaults above, so
  // the oRPC serializer and the pending-query rule still apply.
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}

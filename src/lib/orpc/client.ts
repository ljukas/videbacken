import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { BatchLinkPlugin } from '@orpc/client/plugins'
import {
  createRouterClient,
  type InferRouterInputs,
  type InferRouterOutputs,
  type RouterClient,
} from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { createRequestLogger } from '~/lib/logger/server'
import { authMemoFor } from './context'
import { appRouter } from './router'

const getORPCClient = createIsomorphicFn()
  .server(() =>
    createRouterClient(appRouter, {
      context: async () => {
        const request = getRequest()
        const { log, requestId } = createRequestLogger(request)
        // One render's calls share one auth lookup (ADR-0025 §5).
        return { headers: request.headers, log, requestId, authMemo: authMemoFor(request) }
      },
    }),
  )
  .client(
    (): RouterClient<typeof appRouter> =>
      createORPCClient(
        new RPCLink({
          url: `${window.location.origin}/api/rpc`,
          plugins: [
            new BatchLinkPlugin({
              // Batch ONLY the per-tile thumbnail URL lookups: a folder of image
              // tiles fires its `document.thumbnail` queries in the same tick,
              // which then leave as a single request. Everything else —
              // mutations, listDocuments — stays unbatched.
              groups: [
                {
                  condition: (options) => options.path.join('.') === 'document.thumbnail',
                  context: {},
                },
              ],
              // Pin the batch endpoint to the prefix root so it lands on the
              // `/api/rpc/$` catch-all as `/__batch__` (where BatchHandlerPlugin
              // looks), rather than the default nested `<firstReqUrl>/__batch__`.
              url: `${window.location.origin}/api/rpc/__batch__`,
              // Tiny JSON responses; buffered avoids streaming edge cases on
              // serverless (Vercel) and gives no downside here.
              mode: 'buffered',
            }),
          ],
        }),
      ),
  )

export const client: RouterClient<typeof appRouter> = getORPCClient()
export const orpc = createTanstackQueryUtils(client)

/**
 * Procedure return types, derived from the router so UI components don't
 * hand-maintain row shapes. E.g. `RouterOutputs['document']['listDocuments'][number]`.
 */
export type RouterOutputs = InferRouterOutputs<typeof appRouter>

/** Procedure input types, derived the same way: `RouterInputs['credentials']['set']`. */
export type RouterInputs = InferRouterInputs<typeof appRouter>

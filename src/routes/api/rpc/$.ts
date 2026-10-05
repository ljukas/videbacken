import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { BatchHandlerPlugin } from '@orpc/server/plugins'
import { createFileRoute } from '@tanstack/react-router'
import { createRequestLogger } from '~/lib/logger/server'
import { createAuthMemo, type RequestTimings } from '~/lib/orpc/context'
import { logRpcError } from '~/lib/orpc/logRpcError'
import { appRouter } from '~/lib/orpc/router'
import { poolStats, watchPool } from '~/lib/services/dbPool'

const handler = new RPCHandler(appRouter, {
  // Accepts batched requests at /api/rpc/__batch__. The client batches only the
  // per-tile `document.thumbnail` lookups (see orpc/client.ts).
  plugins: [new BatchHandlerPlugin()],
  interceptors: [
    // `context` is the object passed to `handler.handle` below, so the line
    // carries this request's requestId/path (not userId — that is added later
    // by sessionMiddleware, whose context this interceptor can't see).
    onError((error, { context }) => {
      logRpcError(context.log, error)
    }),
  ],
})

export const Route = createFileRoute('/api/rpc/$')({
  server: {
    handlers: {
      ANY: async ({ request }: { request: Request }) => {
        const { log, requestId } = createRequestLogger(request)
        // Populated in-place by the auth middlewares (context.ts) as the chain
        // runs; read back after `handle` resolves to attribute the request's time.
        const timings: RequestTimings = {}
        // The pool as this request found it, and what it did while the request
        // ran (ADR-0025 §5): connections opened vs checkouts queued.
        const pool = poolStats()
        const stopPoolWatch = watchPool()
        let poolActivity: ReturnType<typeof stopPoolWatch> | undefined
        const startedAt = performance.now()
        const { response } = await handler
          .handle(request, {
            prefix: '/api/rpc',
            // One auth lookup per HTTP request, however many calls it carries (ADR-0025 §5).
            context: {
              headers: request.headers,
              log,
              requestId,
              timings,
              authMemo: createAuthMemo(),
            },
          })
          // Stop watching even if the handler throws, so no watch outlives its request.
          .finally(() => {
            poolActivity = stopPoolWatch()
          })
        // One structured line per RPC → Vercel Runtime Logs. `region` confirms
        // where the function actually executed (VERCEL_REGION); the sub-timings
        // (getSessionMs, findActiveByIdMs) separate auth round-trips from the
        // procedure's own query time (= totalMs minus the parts). Filter these in
        // Vercel logs by msg "rpc timing". For a "__batch__" request the
        // procedures' sub-timings reflect only the last inner call, and the auth
        // ones the call that ran the lookup (memoized per request, context.ts).
        // `poolTotal` / `poolIdle` / `poolWaiting` are the DB pool at the
        // request's start; `poolOpened` / `poolPeakWaiting` what it did while the
        // request ran (instance-wide, the whole HTTP request even for a batch).
        // Only the app's pool: Supavisor's own queueing doesn't show here.
        log.info('rpc timing', {
          procedure: new URL(request.url).pathname.replace(/^\/api\/rpc\/?/, '') || '(root)',
          region: process.env.VERCEL_REGION ?? 'local',
          totalMs: Math.round(performance.now() - startedAt),
          ...timings,
          ...pool,
          ...poolActivity,
          status: response?.status ?? 404,
        })
        return response ?? new Response('Not Found', { status: 404 })
      },
    },
  },
})

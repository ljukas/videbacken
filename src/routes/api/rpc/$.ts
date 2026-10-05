import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { BatchHandlerPlugin } from '@orpc/server/plugins'
import { createFileRoute } from '@tanstack/react-router'
import { poolStats } from '~/lib/db'
import { createRequestLogger } from '~/lib/logger/server'
import { createAuthMemo, type RequestTimings } from '~/lib/orpc/context'
import { logRpcError } from '~/lib/orpc/logRpcError'
import { appRouter } from '~/lib/orpc/router'

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
        // The pool as this request found it (ADR-0025 §5): connecting vs waiting.
        const pool = poolStats()
        const startedAt = performance.now()
        const { response } = await handler.handle(request, {
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
        // One structured line per RPC → Vercel Runtime Logs. `region` confirms
        // where the function actually executed (VERCEL_REGION); the sub-timings
        // (getSessionMs, findActiveByIdMs) separate auth round-trips from the
        // procedure's own query time (= totalMs minus the parts). Filter these in
        // Vercel logs by msg "rpc timing". For a "__batch__" request the
        // sub-timings reflect only the last inner call (see context.ts).
        // `poolTotal` / `poolIdle` / `poolWaiting` are the DB pool at the
        // request's start: a burst that opens connections vs one that queues.
        log.info('rpc timing', {
          procedure: new URL(request.url).pathname.replace(/^\/api\/rpc\/?/, '') || '(root)',
          region: process.env.VERCEL_REGION ?? 'local',
          totalMs: Math.round(performance.now() - startedAt),
          ...timings,
          ...pool,
          status: response?.status ?? 404,
        })
        return response ?? new Response('Not Found', { status: 404 })
      },
    },
  },
})

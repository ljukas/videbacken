import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { BatchHandlerPlugin } from '@orpc/server/plugins'
import { createFileRoute } from '@tanstack/react-router'
import { createRequestLogger, logger } from '~/lib/logger/server'
import { appRouter } from '~/lib/orpc/router'

const handler = new RPCHandler(appRouter, {
  // Accepts batched requests at /api/rpc/__batch__. The client batches only the
  // per-tile `document.thumbnail` lookups (see orpc/client.ts).
  plugins: [new BatchHandlerPlugin()],
  interceptors: [
    onError((error) => {
      logger.error('orpc handler error', { error })
    }),
  ],
})

export const Route = createFileRoute('/api/rpc/$')({
  server: {
    handlers: {
      ANY: async ({ request }: { request: Request }) => {
        const { log, requestId } = createRequestLogger(request)
        const { response } = await handler.handle(request, {
          prefix: '/api/rpc',
          context: { headers: request.headers, log, requestId },
        })
        return response ?? new Response('Not Found', { status: 404 })
      },
    },
  },
})

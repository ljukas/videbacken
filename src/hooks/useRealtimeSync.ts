import { isDefinedError } from '@orpc/client'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { backOff } from 'exponential-backoff'
import { useEffect } from 'react'
import type { RealtimeEvent } from '~/lib/effects'
import { logger } from '~/lib/logger/browser'
import { client, orpc } from '~/lib/orpc/client'

function dispatch(queryClient: QueryClient, event: RealtimeEvent) {
  switch (event.kind) {
    case 'user.changed':
      void queryClient.invalidateQueries({ queryKey: orpc.user.key() })
      return
    case 'presence.changed':
      void queryClient.invalidateQueries({ queryKey: orpc.presence.key() })
      return
  }
}

// One SSE subscription per authenticated tab. Mounted from
// `_authenticated.tsx` so the connection lives for the whole session and
// every authenticated route benefits without re-subscribing.
export function useRealtimeSync(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const controller = new AbortController()
    const log = logger.child({ scope: 'realtime' })

    void backOff(
      async () => {
        const stream = await client.realtime.events(undefined, { signal: controller.signal })
        log.info('realtime subscription opened')
        for await (const event of stream) {
          dispatch(queryClient, event)
        }
        throw new Error('realtime stream ended')
      },
      {
        startingDelay: 1000,
        timeMultiple: 2,
        maxDelay: 30_000,
        numOfAttempts: Number.POSITIVE_INFINITY,
        jitter: 'full',
        retry: (err, attempt) => {
          if (controller.signal.aborted) return false
          if (isDefinedError(err) && err.code === 'UNAUTHORIZED') {
            log.error('realtime subscription unauthorized', { error: err })
            return false
          }
          log.warn('realtime connection lost', { attempt, error: err })
          return true
        },
      },
    ).catch(() => {
      // backOff only rejects after retry returned false; the reason is already logged
    })

    return () => {
      controller.abort()
      log.debug('realtime subscription closed')
    }
  }, [queryClient])
}

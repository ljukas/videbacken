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
    case 'share.changed':
      void queryClient.invalidateQueries({ queryKey: orpc.share.key() })
      // The Delägare table renders owned shares; keep that view in sync.
      void queryClient.invalidateQueries({ queryKey: orpc.user.listContacts.key() })
      return
    case 'document.changed':
      // Invalidate the document *list* and history, never the whole namespace:
      // `document.thumbnail` is served from a stable public URL and must not be
      // refetched (it would reload every tile). A newly-rendered thumbnail is
      // picked up naturally — the list refetch surfaces its `thumbnailPathname`,
      // which enables the tile's (first) thumbnail fetch.
      void queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() })
      void queryClient.invalidateQueries({ queryKey: orpc.document.documentHistory.key() })
      // Uploads/renames/deletes add, rewrite, or remove search haystacks, so an
      // open search palette must refetch too (same reasoning as folder.changed).
      void queryClient.invalidateQueries({ queryKey: orpc.documentSearch.key() })
      return
    case 'folder.changed':
      // A folder change rewrites descendant paths + document haystacks, so the
      // document list and search results can shift too. Thumbnails are untouched
      // (same reasoning as document.changed).
      void queryClient.invalidateQueries({ queryKey: orpc.folder.key() })
      void queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() })
      void queryClient.invalidateQueries({ queryKey: orpc.document.documentHistory.key() })
      void queryClient.invalidateQueries({ queryKey: orpc.documentSearch.key() })
      return
    case 'bin.changed':
      // Soft-delete / restore / hard-delete move an item in or out of the
      // (admin) bin. Published only by those mutations, so unrelated document
      // and folder edits leave the bin query untouched.
      void queryClient.invalidateQueries({ queryKey: orpc.bin.key() })
      return
    case 'recommendation.changed':
      void queryClient.invalidateQueries({ queryKey: orpc.recommendation.key() })
      return
    case 'booking.changed':
      void queryClient.invalidateQueries({ queryKey: orpc.booking.key() })
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

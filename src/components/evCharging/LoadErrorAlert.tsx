import { useHydrated } from '@tanstack/react-router'
import { AlertTriangleIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { m } from '~/paraglide/messages'
import { SyncNowButton } from './SyncNowButton'

// The slice of a `useQuery` result the alert reads.
export type LoadErrorQuery = {
  data: unknown
  isPlaceholderData: boolean
  errorUpdateCount: number
  isFetching: boolean
  refetch: () => unknown
}

// Whether the query failed and has nothing of its own to show. Keyed on
// errorUpdateCount, not isError: refetching a query that has no data resets it
// to `pending` with `error: null` (query-core's fetchState), so isError drops
// for the whole retry, backoff included. The count survives the reset, and a
// success brings data and ends this. Placeholder data (keepPreviousData) is the
// previous key's, not this one's, so it doesn't count as something to show.
export const loadFailed = (query: LoadErrorQuery) =>
  (query.data === undefined || query.isPlaceholderData) && query.errorUpdateCount > 0

// A query that failed with nothing to show (ADR-0016): the shared destructive
// Alert with a retry, instead of a blank section. Render it where the query's
// data would go, gated on `loadFailed`; its retry refetches the query.
//
// Client-only: a loader prefetch that failed on the server isn't dehydrated
// (router.tsx), so the client hydrates without the error. Rendering the alert
// on the server would mismatch.
export function LoadErrorAlert({ title, query }: { title: string; query: LoadErrorQuery }) {
  const hydrated = useHydrated()
  if (!hydrated || !loadFailed(query)) return null
  return (
    <Alert variant="destructive" role="alert">
      <AlertTriangleIcon />
      <AlertTitle>{title}</AlertTitle>
      {/* Children are divs, not <p>: AlertDescription adds a large bottom margin between paragraphs. */}
      <AlertDescription className="flex flex-col gap-2">
        <div>{m.charging_patterns_error_description()}</div>
        <div>
          <SyncNowButton
            onSync={() => void query.refetch()}
            pending={query.isFetching}
            label={m.common_try_again()}
          />
        </div>
      </AlertDescription>
    </Alert>
  )
}

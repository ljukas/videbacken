import { AlertTriangleIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { m } from '~/paraglide/messages'
import { SyncNowButton } from './SyncNowButton'

// The slice of a `useQuery` result the alert reads.
export type LoadErrorQuery = {
  data: unknown
  errorUpdateCount: number
  isFetching: boolean
  refetch: () => unknown
}

// A query that failed with nothing to show (ADR-0016): the shared destructive
// Alert with a retry, instead of a blank section. Render it where the query's
// data would go; it renders nothing unless the load failed, and its retry
// refetches the query.
//
// Keyed on errorUpdateCount, not isError: refetching a query that has no data
// resets it to `pending` with `error: null` (query-core's fetchState), so
// isError drops for the whole retry, backoff included, and the section would
// blank. The count survives the reset; a success brings data and ends this.
export function LoadErrorAlert({ title, query }: { title: string; query: LoadErrorQuery }) {
  if (query.data !== undefined || query.errorUpdateCount === 0) return null
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

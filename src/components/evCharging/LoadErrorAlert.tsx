import { AlertTriangleIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { m } from '~/paraglide/messages'
import { SyncNowButton } from './SyncNowButton'

// The slice of a `useQuery` result the alert reads.
export type LoadErrorQuery = {
  isError: boolean
  isFetching: boolean
  refetch: () => unknown
}

// A query that failed with nothing to show (ADR-0016): the shared destructive
// Alert with a retry, instead of a blank section. Render it where the query's
// data would go; it renders nothing unless the load failed, and its retry
// refetches the query.
export function LoadErrorAlert({ title, query }: { title: string; query: LoadErrorQuery }) {
  if (!query.isError) return null
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

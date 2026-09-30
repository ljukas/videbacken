import { AlertTriangleIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { m } from '~/paraglide/messages'
import { SyncNowButton } from './SyncNowButton'

// A query that failed with nothing to show (ADR-0016): the shared destructive
// Alert with a retry, instead of a blank section. `onRetry` refetches the query.
export function LoadErrorAlert({
  title,
  onRetry,
  retrying,
}: {
  title: string
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTriangleIcon />
      <AlertTitle>{title}</AlertTitle>
      {/* Children are divs, not <p>: AlertDescription adds a large bottom margin between paragraphs. */}
      <AlertDescription className="flex flex-col gap-2">
        <div>{m.charging_patterns_error_description()}</div>
        <div>
          <SyncNowButton onSync={onRetry} pending={retrying} label={m.common_try_again()} />
        </div>
      </AlertDescription>
    </Alert>
  )
}

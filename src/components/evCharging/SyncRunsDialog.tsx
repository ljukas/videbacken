import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { Skeleton } from '~/components/ui/skeleton'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatDateTime } from './format'
import { LoadErrorAlert, type LoadErrorQuery, loadFailed } from './LoadErrorAlert'
import { RecentRunsTable, type Run } from './RecentRunsTable'
import { syncHealthMessage } from './SyncHealthAlert'
import { SyncSourceMark } from './SyncSourceMark'
import { SyncStateBadge } from './SyncSourceTile'

type Health = RouterOutputs['evCharging']['syncStatus']
/** The slice of the runs `useQuery` result the overlay reads. */
export type RunsQuery = LoadErrorQuery & { data: Run[] | undefined }

// One source's sync history (its last runs) in the shared responsive overlay
// (ADR-0013): a dialog on desktop, a bottom sheet on mobile. A source that
// isn't ok says why above the table, with since-when and the raw (sanitized)
// last error as admin detail. A failed runs read is an error with a retry,
// never an empty history (ADR-0016).
export function SyncRunsDialog({
  source,
  health,
  runs,
  open,
  onOpenChange,
}: {
  source: IntegrationSource | undefined
  health: Health | undefined
  runs: RunsQuery | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ResponsiveDialog open={open && source !== undefined} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-3xl">
        {source ? <Body source={source} health={health} runs={runs} /> : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function Body({
  source,
  health,
  runs,
}: {
  source: IntegrationSource
  health: Health | undefined
  runs: RunsQuery | undefined
}) {
  const name = integrationSourceName(source)
  const message = health ? syncHealthMessage(health) : null
  const failing = health?.state === 'failing'
  const detail = health?.adminDetail?.lastErrorMessage
  return (
    <>
      {/* pr-8 keeps the title clear of the overlay's close button. */}
      <ResponsiveDialogHeader className="flex-row items-start gap-3 pr-8 text-left">
        <SyncSourceMark source={source} />
        <div className="flex min-w-0 flex-col gap-1">
          <ResponsiveDialogTitle className="break-words">
            {m.charging_source_dialog_title({ source: name })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.charging_runs_description({ source: name })}
          </ResponsiveDialogDescription>
          <div className="pt-1">
            <SyncStateBadge health={health} />
          </div>
        </div>
      </ResponsiveDialogHeader>
      {message ? (
        <div
          className={cn(
            'flex flex-col gap-1.5 rounded-lg border px-3.5 py-3 text-sm',
            failing ? 'border-destructive/30 bg-destructive/5' : 'bg-muted/40',
          )}
        >
          <p className={failing ? 'text-destructive' : undefined}>
            {message}
            {failing && health?.failingSince ? (
              <> {m.charging_health_failing_since({ time: formatDateTime(health.failingSince) })}</>
            ) : null}
          </p>
          {detail ? (
            <p className="text-muted-foreground">
              {m.charging_health_admin_detail()}{' '}
              <code className="break-all font-mono text-xs">{detail}</code>
            </p>
          ) : null}
        </div>
      ) : null}
      {runs && loadFailed(runs) ? (
        <LoadErrorAlert title={m.charging_runs_error_title()} query={runs} />
      ) : runs?.data ? (
        <RecentRunsTable runs={runs.data} />
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </>
  )
}

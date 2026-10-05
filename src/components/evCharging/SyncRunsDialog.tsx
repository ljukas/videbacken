import { useId } from 'react'
import { LoadErrorAlert, type LoadErrorQuery, loadFailed } from '~/components/layout/LoadErrorAlert'
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
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatDateTime } from './format'
import { RecentRunsTable, type Run } from './RecentRunsTable'
import { syncHealthMessage } from './SyncHealthAlert'
import { SyncSourceMark } from './SyncSourceMark'
import { SyncStateBadge } from './SyncSourceTile'
import type { SourceHealth as Health } from './syncHealth'

/**
 * The slice of the runs `useQuery` result the overlay reads. Always a real
 * (admin-enabled) query result: undefined only renders the loading state.
 */
export type RunsQuery = LoadErrorQuery & { data: Run[] | undefined }

// One source's sync history (its last runs) in the shared responsive overlay
// (ADR-0013): a dialog on desktop, a bottom sheet on mobile. A source that
// isn't ok says why above the table, with since-when and the raw (sanitized)
// last error as admin detail. A failed runs read is an error with a retry,
// never an empty history (ADR-0016). The header stays put and only the body
// scrolls, so the title and close button are always reachable — 20 runs are
// taller than a laptop screen.
//
// The owner keeps `source` (and its health/runs) set through the close
// animation, and opens it via URL state rather than a Radix trigger, so it
// passes `onCloseAutoFocus` to put focus back on the button that opened it.
export function SyncRunsDialog({
  source,
  health,
  runs,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  source: IntegrationSource | undefined
  health: Health | undefined
  runs: RunsQuery | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const descriptionId = useId()
  const messageId = useId()
  const message = health ? syncHealthMessage(health) : null
  return (
    <ResponsiveDialog open={open && source !== undefined} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="flex max-h-[calc(100svh-2rem)] flex-col sm:max-w-3xl"
        // The state's explanation is part of what the dialog is about: announce it on open.
        aria-describedby={message ? `${descriptionId} ${messageId}` : descriptionId}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {source ? (
          <Body
            source={source}
            health={health}
            message={message}
            runs={runs}
            descriptionId={descriptionId}
            messageId={messageId}
          />
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function Body({
  source,
  health,
  message,
  runs,
  descriptionId,
  messageId,
}: {
  source: IntegrationSource
  health: Health | undefined
  message: string | null
  runs: RunsQuery | undefined
  descriptionId: string
  messageId: string
}) {
  const name = integrationSourceName(source)
  const failing = health?.state === 'failing'
  const detail = health?.adminDetail?.lastErrorMessage
  return (
    <>
      {/* pr-8 keeps the title clear of the overlay's close button. */}
      <ResponsiveDialogHeader className="shrink-0 flex-row items-start gap-3 pr-8 text-left">
        <SyncSourceMark source={source} />
        <div className="flex min-w-0 flex-col gap-1">
          <ResponsiveDialogTitle className="text-balance break-words leading-snug">
            {m.charging_source_dialog_title({ source: name })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription id={descriptionId}>
            {m.charging_runs_description({ source: name })}
          </ResponsiveDialogDescription>
          <div className="pt-1">
            <SyncStateBadge health={health} />
          </div>
        </div>
      </ResponsiveDialogHeader>
      <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4">
        {message ? (
          // No light-mode wash: red text on a red tint drops under 4.5:1.
          <div
            id={messageId}
            className={cn(
              'flex flex-col gap-1.5 rounded-lg border px-3.5 py-3 text-sm',
              failing ? 'border-destructive/30 dark:bg-destructive/5' : 'bg-muted/40',
            )}
          >
            <p className={failing ? 'text-destructive' : undefined}>
              {message}
              {failing && health?.failingSince ? (
                <>
                  {' '}
                  {m.charging_health_failing_since({ time: formatDateTime(health.failingSince) })}
                </>
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
          <div role="status" aria-busy="true">
            <span className="sr-only">{m.charging_runs_loading()}</span>
            <Skeleton className="h-40 w-full motion-reduce:animate-none" />
          </div>
        )}
      </div>
    </>
  )
}

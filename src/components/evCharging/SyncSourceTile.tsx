import { HistoryIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { integrationHealthTitle, integrationSourceName } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatAgo } from './format'
import { syncHealthMessage } from './SyncHealthAlert'
import { SyncNowButton } from './SyncNowButton'
import { SyncSourceMark } from './SyncSourceMark'
import { syncSourceCadence, syncSourceRole } from './syncSourceCopy'

type Health = RouterOutputs['evCharging']['syncStatus']

// The state reads in text; the dot only reinforces it (never colour alone).
const DOT: Record<Health['state'], string> = {
  ok: 'bg-success',
  stale: 'bg-warning',
  failing: 'bg-destructive',
  not_configured: 'bg-muted-foreground',
  never_synced: 'bg-muted-foreground',
}

/** A source's health state as a pill; "Okänd status" while it hasn't been read. */
export function SyncStateBadge({ health }: { health: Health | undefined }) {
  return (
    <Badge variant={health?.state === 'failing' ? 'destructive' : 'outline'} className="gap-1.5">
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', health ? DOT[health.state] : 'bg-muted-foreground')}
      />
      {health ? integrationHealthTitle(health.state) : m.charging_source_state_unknown()}
    </Badge>
  )
}

// One integration on the Datakällor panel: who it is, whether it works, when it
// last synced, and its own sync + history. The state is the server's
// `health.state`, never re-derived here. `health` is undefined while its read
// is pending or failed — the tile still renders (status unknown) so the admin
// can sync or open the history.
export function SyncSourceTile({
  source,
  health,
  onSync,
  syncing,
  onOpenHistory,
}: {
  source: IntegrationSource
  health: Health | undefined
  onSync: () => void
  syncing: boolean
  onOpenHistory: () => void
}) {
  const name = integrationSourceName(source)
  const headingId = `sync-source-${source}`
  const message = health ? syncHealthMessage(health) : null
  // A run the cron (or another tab) started counts too: the lease would skip a second one.
  const pending = syncing || health?.running === true
  const syncLabel = pending
    ? m.charging_source_syncing()
    : health?.state === 'failing'
      ? m.common_try_again()
      : m.charging_sync_now()
  return (
    <Card role="group" aria-labelledby={headingId} className="min-w-0 px-5 py-5">
      <div className="flex items-start gap-3">
        <SyncSourceMark source={source} />
        <div className="flex min-w-0 flex-col">
          <h3
            id={headingId}
            className="break-words font-heading font-semibold text-base leading-snug"
          >
            {name}
          </h3>
          <p className="text-muted-foreground text-xs">{syncSourceRole(source)}</p>
        </div>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <SyncStateBadge health={health} />
        {health ? (
          // Relative to `new Date()`: a benign SSR/hydration mismatch, as in ChargingHeading.
          <p className="text-muted-foreground text-xs tabular-nums" suppressHydrationWarning>
            {health.lastSuccessAt
              ? m.charging_last_synced({ time: formatAgo(health.lastSuccessAt) })
              : m.charging_source_never_synced()}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">{syncSourceCadence(source)}</p>
        {message ? (
          <p
            className={cn(
              'line-clamp-3 text-xs',
              health?.state === 'failing' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {message}
          </p>
        ) : null}
      </div>
      {/* Thumb-sized, full-width pair on phones. */}
      <div className="mt-auto flex flex-wrap gap-2 max-sm:[&>button]:h-11 max-sm:[&>button]:flex-1">
        {/* Retrying can't fix missing credentials, so no sync while unconfigured. */}
        {health?.state !== 'not_configured' ? (
          <SyncNowButton
            onSync={onSync}
            pending={pending}
            label={syncLabel}
            aria-label={m.charging_source_action_label({ action: syncLabel, source: name })}
          />
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          onClick={onOpenHistory}
          aria-label={m.charging_source_action_label({
            action: m.charging_source_history(),
            source: name,
          })}
        >
          <HistoryIcon />
          {m.charging_source_history()}
        </Button>
      </div>
    </Card>
  )
}

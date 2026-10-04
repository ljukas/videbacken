import { HistoryIcon } from 'lucide-react'
import type * as React from 'react'
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

/**
 * A source's health state as a pill; "Okänd status" while it hasn't been read.
 * Always the neutral outline pill: the destructive Badge's red-on-red text is
 * under 4.5:1 at this size, so "failing" is carried by the dot and the red
 * explanation line instead.
 */
export function SyncStateBadge({ health }: { health: Health | undefined }) {
  return (
    <Badge variant="outline" className="max-w-full gap-1.5">
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          health ? DOT[health.state] : 'bg-muted-foreground',
        )}
      />
      <span className="truncate">
        {health ? integrationHealthTitle(health.state) : m.charging_source_state_unknown()}
      </span>
    </Badge>
  )
}

// "Senast synkad …", or "Aldrig synkad" where that adds something: not under a
// badge that already says never-synced / not-configured.
function lastSyncLine(health: Health): string | null {
  if (health.lastSuccessAt) return m.charging_last_synced({ time: formatAgo(health.lastSuccessAt) })
  return health.state === 'never_synced' || health.state === 'not_configured'
    ? null
    : m.charging_source_never_synced()
}

// One integration on the Datakällor panel: who it is, whether it works, when it
// last synced, and its own sync + history. The state is the server's
// `health.state`, never re-derived here. `health` is undefined while its read
// is pending or failed — the tile still renders (status unknown) so the admin
// can sync or open the history. The tile is its own container: narrow tiles
// (four across) stack the mark above the name and the buttons; wider ones sit
// them side by side.
export function SyncSourceTile({
  source,
  health,
  onSync,
  syncing,
  onOpenHistory,
  historyRef,
}: {
  source: IntegrationSource
  health: Health | undefined
  onSync: () => void
  syncing: boolean
  onOpenHistory: () => void
  /** The "Historik" button, so the panel can return focus to it when the overlay closes. */
  historyRef?: React.Ref<HTMLButtonElement>
}) {
  const name = integrationSourceName(source)
  const message = health ? syncHealthMessage(health) : null
  const lastSync = health ? lastSyncLine(health) : null
  // A run the cron (or another tab) started counts too: the lease would skip a second one.
  const pending = syncing || health?.running === true
  const syncLabel = pending
    ? m.charging_source_syncing()
    : health?.state === 'failing'
      ? m.common_try_again()
      : m.charging_sync_now()
  return (
    <Card className="@container h-full min-w-0 px-5 py-5">
      <div className="flex @[15rem]:flex-row flex-col @[15rem]:items-start gap-3">
        <SyncSourceMark source={source} />
        <div className="flex min-w-0 flex-col">
          {/* translate="no": a company/domain name, not prose. */}
          <h3
            translate="no"
            className="text-balance break-words font-heading font-semibold text-base leading-snug"
          >
            {name}
          </h3>
          <p className="text-muted-foreground text-xs">{syncSourceRole(source)}</p>
        </div>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <SyncStateBadge health={health} />
        {lastSync ? (
          // Relative to `new Date()`: a benign SSR/hydration mismatch, as in ChargingHeading.
          <p className="text-muted-foreground text-xs tabular-nums" suppressHydrationWarning>
            {lastSync}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">{syncSourceCadence(source)}</p>
        {/* In full, never clamped: the tail is the next step ("…skapa en ny i MyŠkoda-appen"). */}
        {message ? (
          <p
            className={cn(
              'text-xs',
              health?.state === 'failing' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {message}
          </p>
        ) : null}
      </div>
      {/* Even full-width buttons: stacked in a narrow tile, side by side from
          13rem; 44px tall on touch input, whatever the viewport. */}
      <div className="mt-auto grid @[13rem]:grid-cols-2 grid-cols-1 gap-2 [&>button:only-child]:col-span-full pointer-coarse:[&>button]:h-11 [&>button]:w-full">
        {/* Retrying can't fix missing credentials, so no sync while unconfigured. */}
        {health?.state !== 'not_configured' ? (
          <SyncNowButton
            onSync={onSync}
            pending={pending}
            label={syncLabel}
            aria-label={m.charging_source_action_label({ action: syncLabel, source: name })}
            keepFocusWhilePending
          />
        ) : null}
        <Button
          ref={historyRef}
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

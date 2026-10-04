import { useRef, useState } from 'react'
import type { IntegrationSource } from '~/lib/integrationHealth'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { type RunsQuery, SyncRunsDialog } from './SyncRunsDialog'
import { SyncSourceTile } from './SyncSourceTile'

type Health = RouterOutputs['evCharging']['syncStatus']
export type SourceEntry = {
  source: IntegrationSource
  health: Health | undefined
  runs: RunsQuery | undefined
}

// Admin-only "Datakällor": every integration the page reads, at a glance, with
// its own sync and history. Failures still interrupt at the top of the page
// (SyncHealthAlert); this is the calm overview + diagnostics. One history
// overlay, driven by the route's URL dialog state (ADR-0013).
export function SyncSourcesPanel({
  entries,
  onSync,
  isPendingFor,
  openSource,
  onOpenHistory,
  onCloseHistory,
}: {
  entries: SourceEntry[]
  onSync: (source: IntegrationSource) => void
  isPendingFor: (source: IntegrationSource) => boolean
  openSource: IntegrationSource | undefined
  onOpenHistory: (source: IntegrationSource) => void
  onCloseHistory: () => void
}) {
  // The overlay keeps showing the last opened source after `openSource`
  // clears, so its close animation shows the content rather than an empty
  // box — and focus goes back to that source's "Historik" button.
  const [shown, setShown] = useState(openSource)
  if (openSource !== undefined && openSource !== shown) setShown(openSource)
  const historyButtons = useRef(new Map<IntegrationSource, HTMLButtonElement>())
  const ok = entries.filter((e) => e.health?.state === 'ok').length
  const entry = entries.find((e) => e.source === shown)
  return (
    <section aria-labelledby="sync-sources-heading" className="@container flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="sync-sources-heading" className="font-medium text-sm">
            {m.charging_sources_heading()}
          </h2>
          <p className="text-muted-foreground text-xs">{m.charging_sources_description()}</p>
        </div>
        <p className="text-muted-foreground text-xs tabular-nums">
          {m.charging_sources_summary({ ok, total: entries.length })}
        </p>
      </div>
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style none makes Safari drop the list semantics */}
      <ul role="list" className="grid @3xl:grid-cols-4 @md:grid-cols-2 grid-cols-1 gap-4">
        {entries.map((e) => (
          <li key={e.source} className="min-w-0">
            <SyncSourceTile
              source={e.source}
              health={e.health}
              onSync={() => onSync(e.source)}
              syncing={isPendingFor(e.source)}
              onOpenHistory={() => onOpenHistory(e.source)}
              historyRef={(el) => {
                if (el) historyButtons.current.set(e.source, el)
                else historyButtons.current.delete(e.source)
              }}
            />
          </li>
        ))}
      </ul>
      <SyncRunsDialog
        source={entry?.source}
        health={entry?.health}
        runs={entry?.runs}
        open={openSource !== undefined}
        onOpenChange={(o) => {
          if (!o) onCloseHistory()
        }}
        // Opened via URL state, not a Radix trigger: Radix has nothing to
        // return focus to, so put it back on the button that opened it.
        onCloseAutoFocus={(event) => {
          const opener = shown ? historyButtons.current.get(shown) : undefined
          if (!opener) return
          event.preventDefault()
          opener.focus()
        }}
      />
    </section>
  )
}

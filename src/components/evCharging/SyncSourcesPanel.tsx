import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { m } from '~/paraglide/messages'
import { type RunsQuery, SyncRunsDialog } from './SyncRunsDialog'
import { SyncSourceTile } from './SyncSourceTile'
import type { SourceHealth as Health } from './syncHealth'

export type SourceEntry = {
  source: IntegrationSource
  health: Health | undefined
  runs: RunsQuery | undefined
  /** Source-specific lines and buttons for its tile (see SyncSourceTile). */
  details?: ReactNode
  actions?: ReactNode
}

// Admin-only "Datakällor" on the charging settings page (/charging/settings):
// every integration the charging pages read, at a glance, with its own sync and
// history. Failures still interrupt at the top of /charging
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
  const [historyButtons] = useState(() => new Map<IntegrationSource, HTMLButtonElement>())
  // Read by onCloseAutoFocus, which can fire from a stale render's closure.
  const openRef = useRef(openSource)
  useEffect(() => {
    openRef.current = openSource
  }, [openSource])
  const ok = entries.filter((e) => e.health?.state === 'ok').length
  // An unread state isn't "not working": say it's unknown instead.
  const unknown = entries.filter((e) => e.health === undefined).length
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
          {unknown > 0 ? <> · {m.charging_sources_summary_unknown({ count: unknown })}</> : null}
        </p>
      </div>
      {/* Four across only from 56rem: the shell caps the section at ~60rem, and
          narrower four-column tiles get too tight for their names and messages. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style none makes Safari drop the list semantics */}
      <ul role="list" className="grid @4xl:grid-cols-4 @md:grid-cols-2 grid-cols-1 gap-4">
        {entries.map((e) => (
          <li key={e.source} className="min-w-0">
            <SyncSourceTile
              source={e.source}
              health={e.health}
              onSync={() => onSync(e.source)}
              syncing={isPendingFor(e.source)}
              onOpenHistory={() => onOpenHistory(e.source)}
              details={e.details}
              actions={e.actions}
              historyRef={(el) => {
                if (!el) return
                historyButtons.set(e.source, el)
                return () => {
                  historyButtons.delete(e.source)
                }
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
          // Still open: the overlay only swapped dialog ↔ bottom sheet (a
          // rotation, or a phone deep link hydrating) — not a close.
          if (openRef.current !== undefined) return
          const opener = shown ? historyButtons.get(shown) : undefined
          if (!opener) return
          event.preventDefault()
          opener.focus()
        }}
      />
    </section>
  )
}

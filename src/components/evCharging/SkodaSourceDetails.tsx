import { UploadIcon } from 'lucide-react'
import { LoadErrorLine, type LoadErrorQuery, loadFailed } from '~/components/layout/LoadErrorAlert'
import { Button } from '~/components/ui/button'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatAgo, formatDate, formatRunTime } from './format'

type Props = {
  /** The Škoda poll's last contact; null when never, undefined while unknown. */
  live: RouterOutputs['evCharging']['vehicleStateLatest'] | undefined
  /** The last-contact read; when it failed there is no "no contact" claim (ADR-0016). */
  liveQuery?: LoadErrorQuery
  /** When the Škoda API key expires and whether it has (admin-only detail, server-decided); null/undefined hides the line. */
  keyExpiry?: { expiresAt: Date; expired: boolean } | null
  /** What the imported log covers; null when nothing is imported, undefined while unknown. */
  coverage: { from: Date; to: Date; count: number } | null | undefined
  /** The coverage read; when it failed there is no "none imported" claim (ADR-0016). */
  coverageQuery?: LoadErrorQuery
}

// The Škoda tile's own lines on the Datakällor panel (admin-only). The car's
// state poll (ADR-0022) and its imported MySkoda log (ADR-0021) are one source
// to the admin, so the log lives on the same tile: when the car last reported
// (its own timestamp — a poll can succeed while the car sleeps), until when
// the API key is valid, and how far the log reaches (re-import once it's old).
// Muted xs lines like the tile's own, set off from the source's state by a
// hairline; a failed read is a compact red line with a retry, never an
// "empty" claim.
export function SkodaSourceDetails({ live, liveQuery, keyExpiry, coverage, coverageQuery }: Props) {
  const liveFailed = liveQuery !== undefined && loadFailed(liveQuery)
  const coverageFailed = coverageQuery !== undefined && loadFailed(coverageQuery)
  const heardAt = live ? (live.capturedAt ?? live.polledAt) : null
  return (
    // Hidden while it has no lines (nothing known yet, or an error line before hydration).
    <div className="mt-1 flex flex-col gap-1.5 self-stretch border-t pt-2.5 empty:hidden">
      {liveFailed && liveQuery ? (
        <LoadErrorLine title={m.charging_vehicle_live_error_title()} query={liveQuery} />
      ) : heardAt ? (
        <p className="text-muted-foreground text-xs">
          {/* Relative like "Senast synkad" above it, plus the exact time — the
              car's own timestamp is the diagnostic, and a title never shows on
              touch. The relative part is a benign SSR/hydration mismatch, as there. */}
          <time dateTime={heardAt.toISOString()} suppressHydrationWarning>
            {m.charging_vehicle_live_heard({
              time: formatAgo(heardAt),
              at: formatRunTime(heardAt),
            })}
          </time>
        </p>
      ) : live === null ? (
        <p className="text-muted-foreground text-xs">{m.charging_vehicle_live_none()}</p>
      ) : null}
      {keyExpiry ? (
        <p className="text-muted-foreground text-xs">
          {keyExpiry.expired
            ? m.charging_vehicle_key_expired({ date: formatDate(keyExpiry.expiresAt) })
            : m.charging_vehicle_key_expires({ date: formatDate(keyExpiry.expiresAt) })}
        </p>
      ) : null}
      {coverageFailed && coverageQuery ? (
        <LoadErrorLine title={m.charging_vehicle_log_error_title()} query={coverageQuery} />
      ) : coverage ? (
        <p className="text-muted-foreground text-xs">
          {m.charging_vehicle_log_through({
            count: coverage.count,
            to: formatDate(coverage.to),
          })}
        </p>
      ) : coverage === null ? (
        <p className="text-muted-foreground text-xs">{m.charging_vehicle_log_none()}</p>
      ) : null}
    </div>
  )
}

// The Škoda tile's own action: import the car's MySkoda log (opens the
// route's import dialog). Needs no API key, so it stays while unconfigured.
export function VehicleLogImportButton({ onImport }: { onImport: () => void }) {
  return (
    <Button variant="secondary" size="sm" onClick={onImport}>
      <UploadIcon />
      {m.charging_vehicle_import_button()}
    </Button>
  )
}

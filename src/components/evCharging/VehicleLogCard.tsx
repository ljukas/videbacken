import { UploadIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDate, formatDateTime } from './format'
import { LoadErrorAlert, type LoadErrorQuery, loadFailed } from './LoadErrorAlert'
import { SyncNowButton } from './SyncNowButton'

type Props = {
  /** What the imported log covers; null when nothing is imported, undefined while unknown. */
  coverage: { from: Date; to: Date; count: number } | null | undefined
  /** The coverage read; when it failed there is no "none imported" claim (ADR-0016). */
  loadError?: LoadErrorQuery
  onImport: () => void
  /** The Škoda poll's last contact; null when never, undefined while unknown. */
  live?: RouterOutputs['evCharging']['vehicleStateLatest']
  /** The last-contact read; when it failed there is no "no contact" claim (ADR-0016). */
  liveLoadError?: LoadErrorQuery
  onSyncLive?: () => void
  syncingLive?: boolean
}

// Admin-only: the car's own log decides which sessions are ours (ADR-0021);
// the live poll's last contact shows here (ADR-0022). Shows how much of the
// log is loaded and opens the import.
export function VehicleLogCard({
  coverage,
  loadError,
  onImport,
  live,
  liveLoadError,
  onSyncLive,
  syncingLive,
}: Props) {
  const failed = loadError !== undefined && loadFailed(loadError)
  const liveFailed = liveLoadError !== undefined && loadFailed(liveLoadError)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.charging_vehicle_log_title()}</h2>
        </CardTitle>
        <CardDescription>{m.charging_vehicle_log_description()}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onImport}>
            <UploadIcon />
            {m.charging_vehicle_import_button()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {failed && loadError ? (
          <LoadErrorAlert title={m.charging_vehicle_log_error_title()} query={loadError} />
        ) : coverage ? (
          <p>
            {m.charging_vehicle_log_coverage({
              count: coverage.count,
              from: formatDate(coverage.from),
              to: formatDate(coverage.to),
            })}
          </p>
        ) : coverage === null ? (
          <p className="text-muted-foreground">{m.charging_vehicle_log_none()}</p>
        ) : null}
        {liveFailed && liveLoadError ? (
          <LoadErrorAlert title={m.charging_vehicle_live_error_title()} query={liveLoadError} />
        ) : live !== undefined ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {live ? (
              <p>
                {m.charging_vehicle_live_last_contact()}{' '}
                <time dateTime={(live.capturedAt ?? live.polledAt).toISOString()}>
                  {formatDateTime(live.capturedAt ?? live.polledAt)}
                </time>
              </p>
            ) : (
              <p className="text-muted-foreground">{m.charging_vehicle_live_none()}</p>
            )}
            {onSyncLive ? (
              <SyncNowButton
                onSync={onSyncLive}
                pending={syncingLive ?? false}
                label={m.charging_sync_skoda_now()}
              />
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

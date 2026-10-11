import { handleCronRun } from '~/lib/integrations/cron'
import { runComfortCloudSync } from './sync'

// The 6-hourly (:20) Comfort Cloud cron entrypoint. Kept out of the route file
// so the flow is unit-testable; the secret gate and status mapping are shared
// (`handleCronRun`). The body carries counts only, never readings.
export function handleComfortCloudSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runComfortCloudSync({ trigger: 'cron', deps: { log } }),
    (run) => ({
      units: run.units,
      daysFetched: run.daysFetched,
      hoursStored: run.hoursStored,
      backfillDaysLeft: run.backfillDaysLeft,
    }),
  )
}

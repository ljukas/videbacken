import { handleCronRun } from '~/lib/integrations/cron'
import { runEmaldoSync } from './sync'

// The hourly (:45) Emaldo cron entrypoint. Kept out of the route file so the
// flow is unit-testable; the secret gate and status mapping are shared
// (`handleCronRun`). The body carries counts only, never readings.
export function handleEmaldoSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runEmaldoSync({ trigger: 'cron', deps: { log } }),
    (run) => ({
      daysFetched: run.daysFetched,
      bucketsStored: run.bucketsStored,
      backfillDaysLeft: run.backfillDaysLeft,
    }),
  )
}

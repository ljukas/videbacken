import { handleCronRun } from '~/lib/integrations/cron'
import { runElprisSync } from './sync'

// The daily elpris cron entrypoint. Kept out of the route file so the whole
// flow is unit-testable; the secret gate and status mapping are shared
// (`handleCronRun`).
export function handleElprisSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runElprisSync({ trigger: 'cron', deps: { log } }),
    (run) => ({ days: run.daysFetched, upserted: run.upserted }),
  )
}

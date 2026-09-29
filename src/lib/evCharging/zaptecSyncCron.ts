import { handleCronRun } from '~/lib/integrations/cron'
import { runZaptecSync } from './sync'

export { verifyCronSecret } from '~/lib/integrations/cron'

// The hourly Zaptec cron entrypoint. Kept out of the route file so the whole
// flow is unit-testable; the secret gate and status mapping are shared
// (`handleCronRun`).
export function handleZaptecSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runZaptecSync({ trigger: 'cron', deps: { log } }),
    (run) => ({ upserted: run.upserted }),
  )
}

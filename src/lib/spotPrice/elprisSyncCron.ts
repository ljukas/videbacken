import { handleCronRun } from '~/lib/integrations/cron'
import { runElprisSync } from './sync'

// The elpris cron entrypoint (twice daily). Kept out of the route file so the whole
// flow is unit-testable; the secret gate and status mapping are shared
// (`handleCronRun`).
export function handleElprisSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runElprisSync({ trigger: 'cron', deps: { log } }),
    (run) => ({ daysFetched: run.daysFetched, upserted: run.upserted }),
  )
}

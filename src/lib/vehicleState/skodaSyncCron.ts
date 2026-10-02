import { handleCronRun } from '~/lib/integrations/cron'
import { runSkodaSync } from './sync'

// The 15-min Škoda cron entrypoint. Kept out of the route file so the flow is
// unit-testable; the secret gate and status mapping are shared (`handleCronRun`).
export function handleSkodaSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runSkodaSync({ trigger: 'cron', deps: { log } }),
    (run) => ({ stored: run.stored }),
  )
}

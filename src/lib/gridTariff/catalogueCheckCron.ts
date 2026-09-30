import { verifyCronSecret } from '~/lib/integrations/cron'
import { createRequestLogger } from '~/lib/logger/server'
import { runCatalogueCheck } from './catalogueCheck'

/**
 * The monthly grid-tariff watcher's cron entrypoint. Same status mapping as the
 * pulled-sync crons (`handleCronRun`): every checked outcome — `failed` and
 * `not_configured` included — is a 200 with its summary; only an unexpected
 * throw is a 500 (already logged by the run).
 */
export async function handleCatalogueCheckCron(request: Request): Promise<Response> {
  if (!verifyCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return new Response(null, { status: 401 })
  }
  try {
    return Response.json(await runCatalogueCheck({ log: createRequestLogger(request).log }))
  } catch {
    return new Response(null, { status: 500 })
  }
}

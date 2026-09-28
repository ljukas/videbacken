import { timingSafeEqual } from 'node:crypto'
import { createRequestLogger } from '~/lib/logger/server'
import { runZaptecSync } from './sync'

const BEARER = 'Bearer '

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Constant-time compare
// so a wrong secret can't be probed by timing; false when no server secret is
// configured (fail closed). Mirrors `verifyWebhookToken` in
// `src/lib/sensor/shellyWebhook.ts`.
export function verifyCronSecret(header: string | null, expected: string | undefined): boolean {
  if (!expected || header == null || !header.startsWith(BEARER)) return false
  const a = Buffer.from(header.slice(BEARER.length))
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// The hourly cron entrypoint: secret gate → sync run → response. Kept out of
// the route file so the whole flow is unit-testable. `ok`/`failed`/`skipped`
// are all 200 — a failed Zaptec call is recorded in health, not a server
// fault. Only an unexpected throw is a 500; `runZaptecSync` has already
// logged it (its one run line carries the error), so it isn't logged again.
export async function handleZaptecSyncCron(request: Request): Promise<Response> {
  if (!verifyCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return new Response(null, { status: 401 })
  }
  try {
    const run = await runZaptecSync({
      trigger: 'cron',
      deps: { log: createRequestLogger(request).log },
    })
    return Response.json({ outcome: run.outcome, code: run.code, upserted: run.upserted })
  } catch {
    return new Response(null, { status: 500 })
  }
}

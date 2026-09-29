import { timingSafeEqual } from 'node:crypto'
import type { Logger } from '~/lib/logger'
import { createRequestLogger } from '~/lib/logger/server'
import type { RunBase } from './runPulledSync'

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

/**
 * A pulled-integration cron entrypoint (ADR-0019): secret gate → sync run →
 * response. `ok`/`failed`/`skipped` are all 200 — a failed remote call is
 * recorded in health, not a server fault. Only an unexpected throw is a 500;
 * the run has already logged it (its one run line carries the error), so it
 * isn't logged again.
 */
export async function handleCronRun<R extends RunBase & { upserted: number }>(
  request: Request,
  run: (log: Logger) => Promise<R>,
): Promise<Response> {
  if (!verifyCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return new Response(null, { status: 401 })
  }
  try {
    const result = await run(createRequestLogger(request).log)
    return Response.json({ outcome: result.outcome, code: result.code, upserted: result.upserted })
  } catch {
    return new Response(null, { status: 500 })
  }
}

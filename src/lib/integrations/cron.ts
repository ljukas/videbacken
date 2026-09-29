import type { Logger } from '~/lib/logger'
import { createRequestLogger } from '~/lib/logger/server'
import { secretMatches } from '~/lib/secretMatches'
import type { RunBase } from './runPulledSync'

const BEARER = 'Bearer '

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the token is
// compared in constant time, failing closed without a server secret.
export function verifyCronSecret(header: string | null, expected: string | undefined): boolean {
  if (header == null || !header.startsWith(BEARER)) return false
  return secretMatches(header.slice(BEARER.length), expected)
}

/**
 * A pulled-integration cron entrypoint (ADR-0019): secret gate → sync run →
 * response. `ok`/`failed`/`skipped` are all 200 — a failed remote call is
 * recorded in health, not a server fault. Only an unexpected throw is a 500;
 * the run has already logged it (its one run line carries the error), so it
 * isn't logged again. `summary` adds source-specific counters to the body.
 */
export async function handleCronRun<R extends RunBase>(
  request: Request,
  run: (log: Logger) => Promise<R>,
  summary?: (run: R) => Record<string, unknown>,
): Promise<Response> {
  if (!verifyCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return new Response(null, { status: 401 })
  }
  try {
    const result = await run(createRequestLogger(request).log)
    return Response.json({ outcome: result.outcome, code: result.code, ...summary?.(result) })
  } catch {
    return new Response(null, { status: 500 })
  }
}

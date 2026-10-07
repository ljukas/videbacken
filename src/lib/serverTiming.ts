// Server-only. A `Server-Timing` header on every response, so DevTools shows
// where a request's time went (Network → a request → Timing) without reading
// Vercel's logs. `src/server.ts` wraps each request in `withServerTiming`;
// code on the request's path adds metrics with `recordServerTiming`, which
// is a no-op outside a request (queue consumer, scripts).
//
// `queue` and `app` go on every response, signed in or not: names and
// durations only, never ids or data. Anything describing more than the
// request itself (the RPC route's instance-wide pool gauges) is recorded for
// signed-in callers only.
import { AsyncLocalStorage } from 'node:async_hooks'

export type ServerTimingMetric = { name: string; dur?: number; desc?: string }

type RequestTiming = { metrics: ServerTimingMetric[]; queueMs: number | undefined }

const store = new AsyncLocalStorage<RequestTiming>()

// Vercel's x-vercel-id ends in "<id>-<epoch ms>-<hash>" (e.g.
// "arn1::v9n86-1791382772833-39642b699205"); the stamp is when the edge took
// the request. Undocumented, so a gap outside [0, 60 s] (clock skew, a format
// change) is dropped rather than shown.
const EDGE_STAMP_RE = /-(\d{13})-[0-9a-z]+$/i
const MAX_QUEUE_MS = 60_000

/** Time from Vercel's edge taking the request to `nowMs`; undefined off Vercel or when implausible. */
export function edgeQueueMs(vercelId: string | null, nowMs: number): number | undefined {
  const match = vercelId ? EDGE_STAMP_RE.exec(vercelId) : null
  if (!match) return undefined
  const queueMs = nowMs - Number(match[1])
  return queueMs >= 0 && queueMs <= MAX_QUEUE_MS ? queueMs : undefined
}

/** Adds a metric to the current request's header; outside a request it does nothing. */
export function recordServerTiming(metric: ServerTimingMetric): void {
  store.getStore()?.metrics.push(metric)
}

/** The current request's edge-to-function gap, for the `rpc timing` log line. */
export function currentQueueMs(): number | undefined {
  return store.getStore()?.queueMs
}

// A metric name is an HTTP token: other ASCII becomes "_", non-ASCII goes.
const cleanName = (name: string) =>
  name
    .replace(/[^\x21-\x7e]/g, (c) => (c.charCodeAt(0) < 0x80 ? '_' : ''))
    .replace(/[()<>@,;:\\"/[\]?={}]/g, '_')
// A description is a quoted string of printable ASCII.
const cleanDesc = (desc: string) => desc.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '\\$&')

/** The header value; a metric with no usable name or a non-finite duration is left out. */
export function formatServerTiming(metrics: readonly ServerTimingMetric[]): string {
  const parts: string[] = []
  for (const { name, dur, desc } of metrics) {
    const token = cleanName(name)
    if (!token || (dur !== undefined && !Number.isFinite(dur))) continue
    let part = token
    if (dur !== undefined) part += `;dur=${Math.round(dur * 10) / 10}`
    if (desc !== undefined) part += `;desc="${cleanDesc(desc)}"`
    parts.push(part)
  }
  return parts.join(', ')
}

/**
 * The `rpc timing` log line's numbers as metrics: the handler's total, each
 * sub-timing (`costComputeMs` → `costCompute`), and the pool gauges as one
 * description (`poolOpened` → `opened=2`).
 */
export function rpcServerTimings(line: {
  totalMs: number
  timings: Record<string, number>
  pool: Record<string, number>
  poolActivity: Record<string, number> | undefined
}): ServerTimingMetric[] {
  const pool = Object.entries({ ...line.pool, ...line.poolActivity })
    .map(([key, value]) => `${key.replace(/^pool(.)/, (_, c: string) => c.toLowerCase())}=${value}`)
    .join(' ')
  return [
    { name: 'rpc', dur: line.totalMs },
    ...Object.entries(line.timings).map(([key, dur]) => ({ name: key.replace(/Ms$/, ''), dur })),
    { name: 'pool', desc: pool },
  ]
}

/**
 * Runs `handle` with a metrics collector and returns its response with a
 * `Server-Timing` header: `queue` (edge → here, on Vercel), `app` (here →
 * response headers; for streamed SSR not the end of the body), then whatever
 * the request recorded.
 */
export async function withServerTiming(
  request: Request,
  handle: () => Promise<Response>,
  now: () => number = Date.now,
): Promise<Response> {
  const queueMs = edgeQueueMs(request.headers.get('x-vercel-id'), now())
  const startedAt = performance.now()
  const timing: RequestTiming = { metrics: [], queueMs }
  const response = await store.run(timing, handle)
  const metrics: ServerTimingMetric[] = [
    ...(queueMs === undefined ? [] : [{ name: 'queue', dur: queueMs }]),
    { name: 'app', dur: performance.now() - startedAt },
    ...timing.metrics,
  ]
  return withHeader(response, 'Server-Timing', formatServerTiming(metrics))
}

// Some responses (Response.redirect, a fetch() passthrough) have read-only
// headers; those are rebuilt around the same body rather than failing the request.
function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.append(name, value)
    return response
  } catch {
    const headers = new Headers(response.headers)
    headers.append(name, value)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

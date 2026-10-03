// HTTP for the pulled-integration clients (Zaptec, elpris, Škoda, Emaldo):
// ADR-0019's timeout + retry policy, owned by ky.
import ky, { isHTTPError, isNetworkError, isTimeoutError } from 'ky'

/** Backoff per retry when there is no Retry-After, before ±20 % jitter. */
const BACKOFF_MS = [500, 1500]

export type RequestPolicy = {
  fetch: typeof fetch
  /** Per attempt, a 2xx body included. */
  timeoutMs: number
  /** Statuses to retry; empty disables retries, network failures and timeouts included. */
  retryStatuses: ReadonlySet<number>
  /** Max retries (default 2; backoff reuses the last entry beyond 2); 0 when `retryStatuses` is empty. */
  retryLimit?: number
  /** The caller's signal. Its abort is final — never retried. */
  signal?: AbortSignal
  stats: { requests: number; retries: number }
  /** Receives each attempt's duration. */
  onTiming: (ms: number) => void
}

/**
 * One request under ADR-0019's policy. Resolves with the final response: a
 * 2xx with its body already read; any other status unread (the caller reads
 * or `discard`s it) — or, once a retryable status has used up its retries, a
 * body-less copy of that response. Rejects with the network error, timeout or
 * abort that ended it — report it only through `networkCause`.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  p: RequestPolicy,
): Promise<Response> {
  try {
    return await ky(url, {
      ...init,
      signal: p.signal,
      timeout: p.timeoutMs,
      fetch: (input, rest) => attempt(p, input as Request, rest),
      // A retryable status must throw for ky to retry it; any other is returned.
      throwHttpErrors: (status) => p.retryStatuses.has(status),
      retry: {
        limit: p.retryStatuses.size > 0 ? (p.retryLimit ?? 2) : 0,
        // `post`: the Zaptec login and every Emaldo call — reads, or a login (resending only replaces the token we keep).
        methods: ['get', 'post'],
        statusCodes: [...p.retryStatuses],
        afterStatusCodes: [...p.retryStatuses],
        maxRetryAfter: 10_000,
        delay: (n) => BACKOFF_MS[Math.min(n, BACKOFF_MS.length) - 1],
        jitter: (ms) => ms * (0.8 + 0.4 * Math.random()),
        retryOnTimeout: true,
        // ky decides statuses and timeouts (a caller abort then ends its abortable
        // wait); any other failure is retried unless the caller aborted.
        shouldRetry: ({ error }) => {
          if (isHTTPError(error) || isTimeoutError(error)) return undefined
          return !p.signal?.aborted
        },
      },
      hooks: {
        beforeRetry: [
          () => {
            p.stats.retries++
          },
        ],
      },
    })
  } catch (err) {
    if (isHTTPError(err)) {
      // ky has read this body into the error; hand back its status and headers.
      const { status, statusText, headers } = err.response
      return new Response(null, { status, statusText, headers })
    }
    throw isNetworkError(err) ? err.cause : err
  }
}

/**
 * ky's `fetch`: one attempt. A 2xx body is read here, inside ky's per-attempt
 * timeout, so a download that drops or stalls is retried like any network
 * failure. Other statuses are returned unread — a dropped error body must not
 * turn a final 4xx (a rejected login) into retries.
 */
async function attempt(p: RequestPolicy, request: Request, init?: RequestInit) {
  request.signal.throwIfAborted() // ky's signal: the caller's abort or ky's timeout
  p.stats.requests++
  const started = performance.now()
  let timed = false
  const time = () => {
    if (timed) return
    timed = true
    p.onTiming(performance.now() - started)
  }
  // ky's timeout aborts the signal before it rejects: time the attempt up to there.
  request.signal.addEventListener('abort', time, { once: true })
  try {
    // Our own timeout too, so reading an unread body later is bounded as well.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(p.timeoutMs)])
    const res = await p.fetch(request, { ...init, signal })
    return res.ok && res.body !== null ? new Response(await res.arrayBuffer(), res) : res
  } finally {
    request.signal.removeEventListener('abort', time)
    time()
  }
}

/** Releases an unread response body (so the connection can be reused). */
export async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // ignore — the body is unused
  }
}

/** Keeps only a network error's `name` and `code` — its message may echo the request. */
export function networkCause(err: unknown): { name: string; code?: string } {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null
  const name = typeof e?.name === 'string' ? e.name : 'Error'
  const code =
    typeof e?.code === 'string'
      ? e.code
      : typeof e?.cause?.code === 'string'
        ? e.cause.code
        : undefined
  return code === undefined ? { name } : { name, code }
}

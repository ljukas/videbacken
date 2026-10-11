import { discard, fetchWithRetry, networkCause } from '../http'
import type { ComfortCloudCallStats } from './comfortCloud'
import { ComfortCloudError, type ComfortCloudOp } from './errors'

const TIMEOUT_MS = 10_000
const RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const RETRY_LIMIT = 1

export type SendOpts = {
  stats: ComfortCloudCallStats
  signal?: AbortSignal
  /** `false` for a non-idempotent POST (the password step, the single-use code exchange): no retry. */
  retry?: boolean
}

/**
 * One request under ADR-0019's policy (10 s per attempt, 502/503/504 retried once). Redirects are
 * never followed (`redirect: 'manual'`): fetchWithRetry hands a 302 back unread with its Location
 * and Set-Cookie, and the Auth0 steps follow it themselves. A network failure, timeout or abort
 * becomes `unreachable` with only the error's name and code: its message may quote the URL or
 * the body (the password, a token).
 */
export async function send(
  fetch: typeof globalThis.fetch,
  op: ComfortCloudOp,
  url: string,
  init: RequestInit,
  o: SendOpts,
): Promise<Response> {
  try {
    return await fetchWithRetry(
      url,
      { ...init, redirect: 'manual' },
      {
        fetch,
        timeoutMs: TIMEOUT_MS,
        retryStatuses: RETRY_STATUSES,
        retryLimit: o.retry === false ? 0 : RETRY_LIMIT,
        signal: o.signal,
        stats: o.stats,
        onTiming: (ms) => {
          o.stats.fetchMs += ms
        },
      },
    )
  } catch (err) {
    throw new ComfortCloudError('unreachable', op, undefined, {
      cause: networkCause(err),
      message: `Comfort Cloud ${op} request failed or was cut off`,
    })
  }
}

/** The error for a status nobody asked for. 403/429/5xx by name; anything else is a changed API. */
export function errorForStatus(op: ComfortCloudOp, status: number): ComfortCloudError {
  if (status === 403) return new ComfortCloudError('forbidden', op, status)
  if (status === 429) return new ComfortCloudError('rate_limited', op, status)
  if (status >= 500) return new ComfortCloudError('unreachable', op, status)
  return new ComfortCloudError('unexpected_response', op, status)
}

/** `errorForStatus`, releasing the unread body first (never read into the message). */
export async function statusError(op: ComfortCloudOp, res: Response): Promise<ComfortCloudError> {
  await discard(res)
  return errorForStatus(op, res.status)
}

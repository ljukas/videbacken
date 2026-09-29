import type { PriceSlot } from '~/lib/spotPrice/slots'
import type { PriceZone } from '~/lib/spotPrice/zones'
import { addDays } from '~/lib/time/stockholm'
import { discard, networkCause, retryAfterMs } from '../http'
import { type CallOpts, type ElprisCallStats, type ElprisClient, newCallStats } from './elpris'
import { ElprisError } from './errors'
import { parseDay } from './parse'

const BASE_URL = 'https://www.elprisetjustnu.se/api/v1/prices'
const USER_AGENT = 'videbacken/1.0 (private home dashboard)'

// ADR-0019's policy, as for Zaptec.
const TIMEOUT_MS = 10_000
const MAX_RETRIES = 2
const MAX_RETRY_AFTER_MS = 10_000
const BACKOFF_MS = [500, 1500]
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

type Deps = {
  fetch: typeof fetch
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Per-attempt timeout covering the whole exchange, body included (tests shorten it). */
  timeoutMs?: number
}

/** A completed exchange: the status and, for a 2xx, the whole body as text. */
type Exchange = { status: number; body: string | null }

/**
 * Real elprisetjustnu.se client. Does not log — it fills the caller's `stats`
 * and throws `ElprisError`. See `./elpris.ts` for the interface and selection.
 */
export function createElprisClient(deps: Deps): ElprisClient {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS

  /**
   * One GET with timeout + retries. The body of a 2xx is read inside the
   * attempt, so a connection that drops (or stalls past the timeout) mid-body
   * is retried and then reported as `unreachable` — a network fault, not API
   * drift.
   */
  async function send(
    url: string,
    signal: AbortSignal | undefined,
    stats: ElprisCallStats,
  ): Promise<Exchange> {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < MAX_RETRIES
      if (signal?.aborted) {
        throw new ElprisError('unreachable', 'prices', undefined, {
          cause: networkCause(signal.reason),
        })
      }
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout

      stats.requests++
      const started = performance.now()
      let res: Response
      let body: string | null = null
      try {
        res = await deps.fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: combined })
        if (res.ok) body = await res.text()
      } catch (err) {
        stats.fetchMs += performance.now() - started
        // A caller abort is final; a timeout or network failure may be retried.
        if (canRetry && !signal?.aborted) {
          await backoff(attempt, stats)
          continue
        }
        throw new ElprisError('unreachable', 'prices', undefined, {
          cause: networkCause(err),
          message: 'elpris prices request failed or was cut off',
        })
      }
      stats.fetchMs += performance.now() - started

      if (res.ok || !RETRY_STATUSES.has(res.status)) {
        if (!res.ok) await discard(res)
        return { status: res.status, body }
      }

      const retryAfter = retryAfterMs(res.headers.get('Retry-After'), now().getTime())
      await discard(res)
      if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
        throw new ElprisError(
          res.status === 429 ? 'rate_limited' : 'unreachable',
          'prices',
          res.status,
        )
      }
      if (!canRetry) return { status: res.status, body: null }
      if (retryAfter !== null) {
        stats.retries++
        await sleep(retryAfter)
      } else {
        await backoff(attempt, stats)
      }
    }
  }

  async function backoff(attempt: number, stats: ElprisCallStats) {
    stats.retries++
    await sleep(BACKOFF_MS[attempt] * (0.8 + 0.4 * random()))
  }

  return {
    async dayPrices(day: string, zone: PriceZone, o: CallOpts = {}): Promise<PriceSlot[] | null> {
      // A calendar-invalid day (2026-13-45) would just 404 and read as "not
      // published"; it is a caller bug, so fail loudly before any request.
      addDays(day, 0)
      const [yyyy, mm, dd] = day.split('-')
      const stats = o.stats ?? newCallStats()
      const { status, body } = await send(
        `${BASE_URL}/${yyyy}/${mm}-${dd}_${zone}.json`,
        o.signal,
        stats,
      )
      // Not published (yet) — tomorrow's prices appear ~13:00 CET the day before.
      if (status === 404) return null
      if (body === null) throw statusError(status)
      return parseDay(day, parseJson(body, status))
    },
  }
}

function statusError(status: number): ElprisError {
  // A keyless API behind a CDN: a 403 is a bot/WAF block, reported as ADR-0019's `forbidden`.
  if (status === 403) return new ElprisError('forbidden', 'prices', status)
  if (status === 429) return new ElprisError('rate_limited', 'prices', status)
  if (status >= 500) return new ElprisError('unreachable', 'prices', status)
  return new ElprisError('unexpected_response', 'prices', status)
}

function parseJson(body: string, status: number): unknown {
  try {
    return JSON.parse(body)
  } catch {
    // Never echo the body.
    throw new ElprisError('unexpected_response', 'prices', status, {
      message: `elpris prices response is not valid JSON (HTTP ${status})`,
    })
  }
}

import type { PriceSlot } from '~/lib/spotPrice/slots'
import type { PriceZone } from '~/lib/spotPrice/zones'
import { type CallOpts, type ElprisCallStats, type ElprisClient, newCallStats } from './elpris'
import { ElprisError } from './errors'
import { parseDay } from './parse'

const BASE_URL = 'https://www.elprisetjustnu.se/api/v1/prices'
const USER_AGENT = 'videbacken/1.0 (private home dashboard)'
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

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
}

/**
 * Real elprisetjustnu.se client. Does not log — it fills the caller's `stats`
 * and throws `ElprisError`. See `./elpris.ts` for the interface and selection.
 */
export function createElprisClient(deps: Deps): ElprisClient {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random

  /** One GET with timeout + retries. Returns the final response (any status). */
  async function send(url: string, signal: AbortSignal | undefined, stats: ElprisCallStats) {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < MAX_RETRIES
      if (signal?.aborted) {
        throw new ElprisError('unreachable', 'prices', undefined, {
          cause: networkCause(signal.reason),
        })
      }
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout

      stats.requests++
      const started = performance.now()
      let res: Response
      try {
        res = await deps.fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: combined })
      } catch (err) {
        stats.fetchMs += performance.now() - started
        // A caller abort is final; a timeout or network failure may be retried.
        if (canRetry && !signal?.aborted) {
          await backoff(attempt, stats)
          continue
        }
        throw new ElprisError('unreachable', 'prices', undefined, { cause: networkCause(err) })
      }
      stats.fetchMs += performance.now() - started

      if (res.ok || !RETRY_STATUSES.has(res.status)) return res

      const retryAfter = retryAfterMs(res.headers.get('Retry-After'))
      if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
        await discard(res)
        throw new ElprisError(
          res.status === 429 ? 'rate_limited' : 'unreachable',
          'prices',
          res.status,
        )
      }
      if (!canRetry) return res
      await discard(res)
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

  function retryAfterMs(header: string | null): number | null {
    if (header === null || header.trim() === '') return null
    const trimmed = header.trim()
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000
    const at = Date.parse(trimmed)
    return Number.isNaN(at) ? null : Math.max(0, at - now().getTime())
  }

  return {
    async dayPrices(day: string, zone: PriceZone, o: CallOpts = {}): Promise<PriceSlot[] | null> {
      const match = DAY_RE.exec(day)
      if (!match) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
      const stats = o.stats ?? newCallStats()
      const url = `${BASE_URL}/${match[1]}/${match[2]}-${match[3]}_${zone}.json`
      const res = await send(url, o.signal, stats)
      // Not published (yet) — tomorrow before ~13:00, or a day before 2022-11.
      if (res.status === 404) {
        await discard(res)
        return null
      }
      if (!res.ok) throw statusError(res)
      return parseDay(day, await readJson(res))
    },
  }
}

function statusError(res: Response): ElprisError {
  const { status } = res
  void discard(res)
  if (status === 429) return new ElprisError('rate_limited', 'prices', status)
  if (status >= 500) return new ElprisError('unreachable', 'prices', status)
  return new ElprisError('unexpected_response', 'prices', status)
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch (err) {
    // A body that isn't JSON (or a read that died mid-stream) — never echo it.
    const aborted =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    throw new ElprisError(aborted ? 'unreachable' : 'unexpected_response', 'prices', res.status, {
      cause: networkCause(err),
      message: aborted
        ? 'elpris prices response was cut off'
        : `elpris prices response is not valid JSON (HTTP ${res.status})`,
    })
  }
}

async function discard(res: Response) {
  try {
    await res.body?.cancel()
  } catch {
    // ignore — the body is unused
  }
}

/** Keeps only a network error's `name` and `code` — its message may echo the request. */
function networkCause(err: unknown): { name: string; code?: string } {
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

import type { PriceSlot } from '~/lib/spotPrice/slots'
import type { PriceZone } from '~/lib/spotPrice/zones'
import { addDays } from '~/lib/time/stockholm'
import { discard, fetchWithRetry, networkCause } from '../http'
import { type CallOpts, type ElprisCallStats, type ElprisClient, newCallStats } from './elpris'
import { ElprisError } from './errors'
import { parseDay } from './parse'

const BASE_URL = 'https://www.elprisetjustnu.se/api/v1/prices'
const USER_AGENT = 'videbacken/1.0 (private home dashboard)'

// ADR-0019's policy; retry counts, backoff and the Retry-After cap are in `../http`.
const TIMEOUT_MS = 10_000
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

/**
 * Real elprisetjustnu.se client. Does not log — it fills the caller's `stats`
 * and throws `ElprisError`. See `./elpris.ts` for the interface and selection.
 */
export function createElprisClient(deps: { fetch: typeof fetch }): ElprisClient {
  /** One GET with timeout + retries; a download that drops or stalls is retried too. */
  async function send(url: string, signal: AbortSignal | undefined, stats: ElprisCallStats) {
    try {
      return await fetchWithRetry(
        url,
        { headers: { 'User-Agent': USER_AGENT } },
        {
          fetch: deps.fetch,
          timeoutMs: TIMEOUT_MS,
          retryStatuses: RETRY_STATUSES,
          signal,
          stats,
          onTiming: (ms) => {
            stats.fetchMs += ms
          },
        },
      )
    } catch (err) {
      throw new ElprisError('unreachable', 'prices', undefined, {
        cause: networkCause(err),
        message: 'elpris prices request failed or was cut off',
      })
    }
  }

  return {
    async dayPrices(day: string, zone: PriceZone, o: CallOpts = {}): Promise<PriceSlot[] | null> {
      // A calendar-invalid day (2026-13-45) would just 404 and read as "not
      // published"; it is a caller bug, so fail loudly before any request.
      addDays(day, 0)
      const [yyyy, mm, dd] = day.split('-')
      const stats = o.stats ?? newCallStats()
      const res = await send(`${BASE_URL}/${yyyy}/${mm}-${dd}_${zone}.json`, o.signal, stats)
      if (!res.ok) {
        await discard(res)
        // Not published (yet) — tomorrow's prices appear ~13:00 CET the day before.
        if (res.status === 404) return null
        throw statusError(res.status)
      }
      return parseDay(day, parseJson(await res.text(), res.status))
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

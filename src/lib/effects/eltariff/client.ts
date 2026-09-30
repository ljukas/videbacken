import { discard, fetchWithRetry, networkCause } from '../http'
import { type CallOpts, type Catalogue, type EltariffClient, newCallStats } from './eltariff'
import { EltariffError } from './errors'
import { parseCatalogue } from './parse'

const CATALOGUE_URL = 'https://eltariff.se/tariffcatalogue/all'
const USER_AGENT = 'videbacken/1.0 (private home dashboard)'

// ADR-0019's policy; retry counts, backoff and the Retry-After cap are in `../http`.
const TIMEOUT_MS = 10_000
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

/**
 * Real Eltariff catalogue client. Does not log — it fills the caller's `stats`
 * and throws `EltariffError`. See `./eltariff.ts` for the interface and selection.
 */
export function createEltariffClient(deps: { fetch: typeof fetch }): EltariffClient {
  return {
    async catalogue(o: CallOpts = {}): Promise<Catalogue> {
      const stats = o.stats ?? newCallStats()
      let res: Response
      try {
        res = await fetchWithRetry(
          CATALOGUE_URL,
          { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
          {
            fetch: deps.fetch,
            timeoutMs: TIMEOUT_MS,
            retryStatuses: RETRY_STATUSES,
            signal: o.signal,
            stats,
            onTiming: (ms) => {
              stats.fetchMs += ms
            },
          },
        )
      } catch (err) {
        throw new EltariffError('unreachable', 'catalogue', undefined, {
          cause: networkCause(err),
          message: 'eltariff catalogue request failed or was cut off',
        })
      }
      if (!res.ok) {
        await discard(res)
        throw statusError(res.status)
      }
      return parseCatalogue(parseJson(await res.text(), res.status), res.status)
    },
  }
}

function statusError(status: number): EltariffError {
  // A keyless API: a 403 is a bot/WAF block, reported as ADR-0019's `forbidden`.
  if (status === 403) return new EltariffError('forbidden', 'catalogue', status)
  if (status === 429) return new EltariffError('rate_limited', 'catalogue', status)
  if (status >= 500) return new EltariffError('unreachable', 'catalogue', status)
  return new EltariffError('unexpected_response', 'catalogue', status)
}

function parseJson(body: string, status: number): unknown {
  try {
    return JSON.parse(body)
  } catch {
    // Never echo the body.
    throw new EltariffError('unexpected_response', 'catalogue', status, {
      message: `eltariff catalogue response is not valid JSON (HTTP ${status})`,
    })
  }
}

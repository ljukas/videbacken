import type { PriceSlot } from '~/lib/spotPrice/slots'
import type { PriceZone } from '~/lib/spotPrice/zones'
import { lazy } from '../lazy'

/**
 * Day-ahead spot prices from elprisetjustnu.se (free, keyless), backed by one
 * of two adapters:
 *   - `http` — the real client (`createElprisClient` in `./client`). The
 *     default everywhere: the API needs no credentials, so local dev and
 *     preview deploys use it too.
 *   - `notConfigured` — throws `ElprisError('not_configured')` from every
 *     method. Selected only under VITEST, so no test can reach the network by
 *     accident (tests inject their own client). Deliberately **no devLog or
 *     fake adapter** (ADR-0019): a silent no-op would read as a healthy sync.
 *
 * The client never logs. Callers pass a `stats` sink and log it themselves;
 * errors surface as `ElprisError` with an integration-health `code`.
 */

/** Mutable sink the client fills in; the caller logs it. */
export interface ElprisCallStats {
  fetchMs: number
  requests: number
  retries: number
}

export function newCallStats(): ElprisCallStats {
  return { fetchMs: 0, requests: 0, retries: 0 }
}

export interface CallOpts {
  signal?: AbortSignal
  stats?: ElprisCallStats
}

export interface ElprisClient {
  /**
   * The complete, validated price list for Stockholm `day` ('YYYY-MM-DD'), or
   * `null` when the day isn't published (yet) — the API answers 404.
   */
  dayPrices(day: string, zone: PriceZone, o?: CallOpts): Promise<PriceSlot[] | null>
}

type Env = Record<string, string | undefined>

export function selectElprisAdapter(env: Env): 'notConfigured' | 'http' {
  return env.VITEST === 'true' ? 'notConfigured' : 'http'
}

const getAdapter = lazy(async (): Promise<ElprisClient> => {
  if (selectElprisAdapter(process.env) === 'http') {
    const { createElprisClient } = await import('./client')
    return createElprisClient({ fetch: globalThis.fetch })
  }
  return (await import('./adapters/notConfigured')).notConfigured
})

export const elpris: ElprisClient = {
  async dayPrices(day, zone, o) {
    return (await getAdapter()).dayPrices(day, zone, o)
  },
}

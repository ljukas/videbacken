import { lazy } from '../lazy'

/**
 * Address search for the Škoda home-position picker (ADR-0026, step 3c-2):
 * Nominatim (OpenStreetMap), keyless, proxied by our server so the admin's IP
 * and browser never reach it. Backed by one of two adapters:
 *   - `nominatim` — the real client (`createNominatimClient` in `./client`),
 *     throttled to Nominatim's 1 request/s and cached for 10 minutes, per
 *     instance. The default everywhere.
 *   - `notConfigured` — throws `GeocoderError('not_configured')`. Selected only
 *     under VITEST, so no test reaches the network (tests inject a client).
 *
 * The client never logs: the query and the results are the household's
 * address. Callers log the outcome and the `stats` only.
 */

export interface GeocoderHit {
  label: string
  latitude: number
  longitude: number
}

/** Mutable sink the client fills in; the caller logs it. */
export interface GeocoderCallStats {
  fetchMs: number
  requests: number
  retries: number
  /** Answered from the in-memory cache, without a request. */
  cached: boolean
}

export function newGeocoderStats(): GeocoderCallStats {
  return { fetchMs: 0, requests: 0, retries: 0, cached: false }
}

export interface GeocoderCallOpts {
  signal?: AbortSignal
  stats?: GeocoderCallStats
}

export interface GeocoderClient {
  /** Up to five places in Sweden for `query`. Throws `GeocoderError` when the search can't run. */
  search(query: string, o?: GeocoderCallOpts): Promise<GeocoderHit[]>
}

type Env = Record<string, string | undefined>

export function selectGeocoderAdapter(env: Env): 'notConfigured' | 'nominatim' {
  return env.VITEST === 'true' ? 'notConfigured' : 'nominatim'
}

// One client per process: the throttle and the cache are per instance.
const getAdapter = lazy(async (): Promise<GeocoderClient> => {
  if (selectGeocoderAdapter(process.env) === 'nominatim') {
    const { createNominatimClient } = await import('./client')
    return createNominatimClient({ fetch: globalThis.fetch })
  }
  return (await import('./adapters/notConfigured')).notConfigured
})

export const geocoder: GeocoderClient = {
  async search(query, o) {
    return (await getAdapter()).search(query, o)
  },
}

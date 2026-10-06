import { z } from 'zod'
import { discard, fetchWithRetry, networkCause } from '../http'
import { GeocoderError } from './errors'
import {
  type GeocoderCallOpts,
  type GeocoderClient,
  type GeocoderHit,
  newGeocoderStats,
} from './geocoder'

const SEARCH_URL = 'https://nominatim.openstreetmap.org/search'
// Nominatim's policy asks for an identifying User-Agent.
const USER_AGENT = 'videbacken/1.0 (private home dashboard; home-position address search)'

// Interactive: a short timeout and no retries at all. Nominatim allows one request per
// second, and a retry inside `fetchWithRetry` would go out without taking a new slot;
// the admin can press Sök again, which does.
const TIMEOUT_MS = 5_000
const RETRY_STATUSES: ReadonlySet<number> = new Set()
const RETRY_LIMIT = 0

/** Nominatim's usage policy: at most one request per second (here per instance). */
export const MIN_INTERVAL_MS = 1_000
/** A search that would wait longer than this for its slot fails as `rate_limited` instead. */
export const MAX_QUEUE_WAIT_MS = 3_000
export const CACHE_TTL_MS = 10 * 60_000
const CACHE_MAX_ENTRIES = 100
const MAX_HITS = 5

const DECIMAL = /^[+-]?\d+(\.\d+)?$/
const nominatimPlace = z.object({
  display_name: z.string().trim().min(1),
  lat: z.string().regex(DECIMAL),
  lon: z.string().regex(DECIMAL),
})

/** Trimmed, inner whitespace collapsed: what is sent. */
const tidy = (query: string) => query.trim().replace(/\s+/g, ' ')

/**
 * Real Nominatim client. Does not log — it fills the caller's `stats` and
 * throws `GeocoderError`. See `./geocoder.ts` for the interface and selection.
 */
export function createNominatimClient(deps: { fetch: typeof fetch }): GeocoderClient {
  const cache = new Map<string, { hits: GeocoderHit[]; expiresAt: number }>()
  let nextSlotAt = 0

  // Reserves the next free one-second slot; a burst beyond MAX_QUEUE_WAIT_MS fails fast
  // rather than holding a function invocation open.
  async function waitForSlot(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
      throw new GeocoderError('unreachable', undefined, { cause: networkCause(signal.reason) })
    }
    const now = Date.now()
    const slot = Math.max(now, nextSlotAt)
    if (slot - now > MAX_QUEUE_WAIT_MS) throw new GeocoderError('rate_limited')
    nextSlotAt = slot + MIN_INTERVAL_MS
    if (slot > now) {
      try {
        await sleep(slot - now, signal)
      } catch (err) {
        // Give the slot back, unless a later caller has queued behind it.
        if (nextSlotAt === slot + MIN_INTERVAL_MS) nextSlotAt = slot
        throw new GeocoderError('unreachable', undefined, { cause: networkCause(err) })
      }
    }
  }

  return {
    async search(query: string, o: GeocoderCallOpts = {}): Promise<GeocoderHit[]> {
      const stats = o.stats ?? newGeocoderStats()
      const q = tidy(query)
      const key = q.toLowerCase()
      const cached = cache.get(key)
      if (cached && cached.expiresAt > Date.now()) {
        stats.cached = true
        return cached.hits
      }

      await waitForSlot(o.signal)
      const url = new URL(SEARCH_URL)
      url.search = new URLSearchParams({
        q,
        format: 'jsonv2',
        countrycodes: 'se',
        'accept-language': 'sv',
        limit: String(MAX_HITS),
        addressdetails: '0',
      }).toString()

      let res: Response
      try {
        res = await fetchWithRetry(
          url.toString(),
          { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
          {
            fetch: deps.fetch,
            timeoutMs: TIMEOUT_MS,
            retryStatuses: RETRY_STATUSES,
            retryLimit: RETRY_LIMIT,
            signal: o.signal,
            stats,
            onTiming: (ms) => {
              stats.fetchMs += ms
            },
          },
        )
      } catch (err) {
        throw new GeocoderError('unreachable', undefined, { cause: networkCause(err) })
      }
      if (!res.ok) {
        await discard(res)
        throw statusError(res.status)
      }
      const hits = parseHits(await res.text(), res.status)

      cache.delete(key)
      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(key, { hits, expiresAt: Date.now() + CACHE_TTL_MS })
      return hits
    },
  }
}

function statusError(status: number): GeocoderError {
  // A keyless API: a 403 is a block (usually the User-Agent or the policy).
  if (status === 403) return new GeocoderError('forbidden', status)
  if (status === 429) return new GeocoderError('rate_limited', status)
  if (status >= 500) return new GeocoderError('unreachable', status)
  return new GeocoderError('unexpected_response', status)
}

function parseHits(body: string, status: number): GeocoderHit[] {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new GeocoderError('unexpected_response', status) // never echo the body
  }
  if (!Array.isArray(json)) throw new GeocoderError('unexpected_response', status)
  const hits: GeocoderHit[] = []
  for (const item of json) {
    const parsed = nominatimPlace.safeParse(item)
    if (!parsed.success) continue
    const latitude = Number(parsed.data.lat)
    const longitude = Number(parsed.data.lon)
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue
    hits.push({ label: parsed.data.display_name, latitude, longitude })
    if (hits.length === MAX_HITS) break
  }
  return hits
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

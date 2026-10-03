import { discard, fetchWithRetry, networkCause } from '../http'
import { SkodaError } from './errors'
import { parseKeyExpiry, parseVehicleState } from './parse'
import {
  type CallOpts,
  newCallStats,
  type SkodaCallStats,
  type SkodaClient,
  type SkodaReading,
} from './skoda'

const BASE_URL = 'https://public.api.connect.skoda-auto.cz/api/v1'
const INCLUDE = 'charging,odometer,parkingPosition'
const TIMEOUT_MS = 10_000
// Errors count against the 20 requests/h per VIN (5xx and timeouts included):
// 429 is never retried, gateway errors once → worst case 4 polls × 2 = 8/h.
const RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const RETRY_LIMIT = 1

/** Real MyŠkoda Public API client. Never logs; never reads an error body (it can name the VIN). */
export function createSkodaClient(deps: {
  fetch: typeof fetch
  apiKey: string
  vin: string
}): SkodaClient {
  const url = `${BASE_URL}/vehicles/${encodeURIComponent(deps.vin)}?include=${INCLUDE}`

  async function send(signal: AbortSignal | undefined, stats: SkodaCallStats) {
    try {
      return await fetchWithRetry(
        url,
        {
          headers: { 'X-API-Key': deps.apiKey, Accept: 'application/json' },
          // A redirect must never carry the key to another origin: it fails instead.
          redirect: 'error',
        },
        {
          fetch: deps.fetch,
          timeoutMs: TIMEOUT_MS,
          retryStatuses: RETRY_STATUSES,
          retryLimit: RETRY_LIMIT,
          signal,
          stats,
          onTiming: (ms) => {
            stats.fetchMs += ms
          },
        },
      )
    } catch (err) {
      // ky's errors can carry the URL (with the VIN): keep only name + code.
      throw new SkodaError('unreachable', 'vehicle', undefined, {
        cause: networkCause(err),
        message: 'Škoda vehicle request failed or was cut off',
      })
    }
  }

  return {
    async vehicleState(o: CallOpts = {}): Promise<SkodaReading> {
      const stats = o.stats ?? newCallStats()
      const res = await send(o.signal, stats)
      if (!res.ok) {
        await discard(res)
        throw statusError(res.status)
      }
      let body: unknown
      try {
        body = JSON.parse(await res.text())
      } catch {
        throw new SkodaError('unexpected_response', 'vehicle', res.status, {
          message: `Škoda vehicle response is not valid JSON (HTTP ${res.status})`,
        })
      }
      return {
        state: parseVehicleState(body),
        keyExpiresAt: parseKeyExpiry(res.headers.get('X-API-Key-Expires-At')),
      }
    },
  }
}

function statusError(status: number): SkodaError {
  if (status === 401) return new SkodaError('auth_failed', 'vehicle', status) // api-key-expired
  // 403 api-key-not-authorized (key not for this car); 404 = no vehicle for the VIN.
  if (status === 403 || status === 404) return new SkodaError('forbidden', 'vehicle', status)
  if (status === 429) return new SkodaError('rate_limited', 'vehicle', status)
  if (status >= 500) return new SkodaError('unreachable', 'vehicle', status)
  return new SkodaError('unexpected_response', 'vehicle', status)
}

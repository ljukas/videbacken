import type { CredentialValues } from '~/lib/integrationCredentials'
import { keyedAdapter } from '../keyedAdapter'

/**
 * The car's current state from the official MyŠkoda Public API (ADR-0022),
 * backed by one of two adapters:
 *   - `http` — the real client (`createSkodaClient`), when an API key and a
 *     VIN both resolve.
 *   - `notConfigured` — throws `SkodaError('not_configured')`. Selected when
 *     either is missing, and always under VITEST. Deliberately **no devLog or
 *     fake adapter** (ADR-0019): a silent no-op would read as a healthy sync.
 *
 * Credentials come from the resolver (ADR-0026: stored under Inställningar,
 * else SKODA_API_KEY / SKODA_VIN), checked on every call; the client is rebuilt
 * only when they change. An unreadable stored row fails the call as
 * `credentials_unreadable`.
 *
 * The client never logs; callers pass a `stats` sink. The parked position is
 * returned only so the caller can run the geofence — never store or log it.
 */
export type LatLon = { latitude: number; longitude: number }
export type SkodaPart = 'charging' | 'odometer' | 'parkingPosition'

export type SkodaVehicleState = {
  chargingCapturedAt: Date | null
  chargingState: string | null
  chargeType: string | null
  plugState: string | null
  chargePowerKw: number | null
  socPercent: number | null
  odometerKm: number | null
  odometerCapturedAt: Date | null
  parking: { state: string | null; position: LatLon | null } | null
  /** errors[].type the API reported, filtered to /^[A-Z_]{1,64}$/. */
  missingParts: string[]
  /** Parts present but not matching our schema (dropped, the rest kept). */
  invalidParts: SkodaPart[]
}

export type SkodaReading = { state: SkodaVehicleState; keyExpiresAt: Date | null }

export interface SkodaCallStats {
  fetchMs: number
  requests: number
  retries: number
}

export function newCallStats(): SkodaCallStats {
  return { fetchMs: 0, requests: 0, retries: 0 }
}

export interface CallOpts {
  signal?: AbortSignal
  stats?: SkodaCallStats
}

export interface SkodaClient {
  vehicleState(o?: CallOpts): Promise<SkodaReading>
}

export function selectSkodaAdapter(values: CredentialValues<'skoda'>): 'notConfigured' | 'http' {
  // Must agree with isOptionalCredentialField (the remove confirm relies on it).
  return values.apiKey && values.vin ? 'http' : 'notConfigured'
}

const getAdapter = keyedAdapter({
  source: 'skoda',
  unavailable: async (code) => (await import('./adapters/notConfigured')).unavailable(code),
  build: async (values): Promise<SkodaClient> => {
    const { apiKey, vin } = values
    if (selectSkodaAdapter(values) === 'http' && apiKey && vin) {
      const { createSkodaClient } = await import('./client')
      return createSkodaClient({ fetch: globalThis.fetch, apiKey, vin })
    }
    return (await import('./adapters/notConfigured')).notConfigured
  },
})

export const skoda: SkodaClient = {
  async vehicleState(o) {
    return (await getAdapter()).vehicleState(o)
  },
}

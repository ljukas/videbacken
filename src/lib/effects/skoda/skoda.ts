import { lazy } from '../lazy'

/**
 * The car's current state from the official MyŠkoda Public API (ADR-0022),
 * backed by one of two adapters:
 *   - `http` — the real client (`createSkodaClient`), when `SKODA_API_KEY` and
 *     `SKODA_VIN` are both set.
 *   - `notConfigured` — throws `SkodaError('not_configured')`. Selected when
 *     either is unset, and always under VITEST. Deliberately **no devLog or
 *     fake adapter** (ADR-0019): a silent no-op would read as a healthy sync.
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

type Env = Record<string, string | undefined>

export function selectSkodaAdapter(env: Env): 'notConfigured' | 'http' {
  if (env.VITEST === 'true') return 'notConfigured'
  return env.SKODA_API_KEY && env.SKODA_VIN ? 'http' : 'notConfigured'
}

const getAdapter = lazy(async (): Promise<SkodaClient> => {
  const apiKey = process.env.SKODA_API_KEY
  const vin = process.env.SKODA_VIN
  if (selectSkodaAdapter(process.env) === 'http' && apiKey && vin) {
    const { createSkodaClient } = await import('./client')
    return createSkodaClient({ fetch: globalThis.fetch, apiKey, vin })
  }
  return (await import('./adapters/notConfigured')).notConfigured
})

export const skoda: SkodaClient = {
  async vehicleState(o) {
    return (await getAdapter()).vehicleState(o)
  },
}

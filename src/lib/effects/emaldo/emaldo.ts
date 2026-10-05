import type { CredentialValues } from '~/lib/integrationCredentials'
import { keyedAdapter } from '../keyedAdapter'

/**
 * The house's 5-minute energy flows from the Emaldo cloud (ADR-0023). The
 * client never logs; callers pass a `stats` sink. Readings are a household
 * load profile: never log or echo them.
 *
 * Credentials come from the resolver (ADR-0026: stored under Inställningar,
 * else the EMALDO_* env vars), checked on every call. The client — and its
 * session — is rebuilt only when they change: an Emaldo login ends the
 * account's other sessions. An unreadable stored row fails the call as
 * `credentials_unreadable`; under VITEST every call is `not_configured`.
 */
export type HouseBucket = {
  /** start_time + minute × 60 s (a UTC instant). */
  bucketStart: Date
  /** Grid import, emergency-circuit import included. */
  gridImportKwh: number
  gridExportKwh: number
  /** Every MPPT string + third-party solar. */
  solarKwh: number
  /** House load, the car charger included. */
  loadKwh: number
  batteryDischargeKwh: number
  /** Battery column `charge_mppt`. */
  batteryChargeSolarKwh: number
  batteryChargeGridKwh: number
  batteryChargeAcKwh: number
  /** Battery state of charge, % (0–100), as reported for the minute; null when missing or out of range. */
  batterySocPct: number | null
}

export type EmaldoDay = {
  /** The response's start_time: Stockholm local midnight. */
  dayStart: Date
  /** The next Stockholm midnight (DST-aware), exclusive. */
  dayEnd: Date
  /** Ascending; only buckets present in all four energy series, inside [dayStart, dayEnd). */
  buckets: HouseBucket[]
  /**
   * Buckets seen but not returned: in some energy series only, outside the day, a
   * negative reading, or (offset 0) the still-filling newest bucket.
   */
  droppedBuckets: number
}

export interface EmaldoCallStats {
  fetchMs: number
  requests: number
  retries: number
  logins: number
}

export function newCallStats(): EmaldoCallStats {
  return { fetchMs: 0, requests: 0, retries: 0, logins: 0 }
}

export interface CallOpts {
  signal?: AbortSignal
  stats?: EmaldoCallStats
}

export interface EmaldoClient {
  /** offset 0 = today (Stockholm; newest bucket dropped), -1 = yesterday, … ; offset > 0 throws RangeError. */
  fetchDay(offset: number, o?: CallOpts): Promise<EmaldoDay>
}

/** `http` only when all four fields resolve. */
export function selectEmaldoAdapter(values: CredentialValues<'emaldo'>): 'notConfigured' | 'http' {
  return values.user && values.password && values.appId && values.appSecret
    ? 'http'
    : 'notConfigured'
}

const getAdapter = keyedAdapter({
  source: 'emaldo',
  unavailable: async (code) => (await import('./adapters/notConfigured')).unavailable(code),
  build: async (values): Promise<EmaldoClient> => {
    const { user, password, appId, appSecret } = values
    if (selectEmaldoAdapter(values) === 'http' && user && password && appId && appSecret) {
      const { createEmaldoClient } = await import('./client')
      return createEmaldoClient({ fetch: globalThis.fetch, user, password, appId, appSecret })
    }
    return (await import('./adapters/notConfigured')).notConfigured
  },
})

export const emaldo: EmaldoClient = {
  async fetchDay(offset, o) {
    return (await getAdapter()).fetchDay(offset, o)
  },
}

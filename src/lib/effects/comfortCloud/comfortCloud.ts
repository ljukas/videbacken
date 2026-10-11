/**
 * Panasonic Comfort Cloud: the air-to-air heat pumps' hourly electricity use and temperatures
 * (ADR-0027). Read-only. The client never logs; callers pass a `stats` sink. Hourly rows tell
 * when someone is home and heating: never log or echo them. Unit guids are shortened wherever
 * they are shown and never appear in an error.
 *
 * The keyed, fail-closed `comfortCloud` facade (keyedAdapter + notConfigured + adapter
 * selection) sits at the bottom of this file.
 */
import type { CredentialValues } from '~/lib/integrationCredentials'
import { keyedAdapter } from '../keyedAdapter'

export type ComfortCloudUnit = {
  guid: string
  name: string
  /** `deviceModuleNumber`, e.g. CS-HZ25ZKE. */
  model: string
}

export type ComfortCloudHour = {
  /** The UTC hour the row covers. */
  hourStart: Date
  energyKwh: number
  /** 0…1 as reported; null when Comfort Cloud had no value. */
  heatShare: number | null
  coolShare: number | null
  setpointC: number | null
  insideC: number | null
  outsideC: number | null
}

export type ComfortCloudDay = {
  /** UTC 'YYYY-MM-DD'. */
  day: string
  energyKwh: number
}

export type ComfortCloudHistory<T> = {
  /** 'YYYY-MM-DD' from `deviceRegisterTime` (a UTC day): the unit's first data day (the backfill's end). */
  registeredOn: string
  /** Ascending; only rows with a value. */
  rows: T[]
}

export interface ComfortCloudCallStats {
  fetchMs: number
  requests: number
  retries: number
  logins: number
}

export function newCallStats(): ComfortCloudCallStats {
  return { fetchMs: 0, requests: 0, retries: 0, logins: 0 }
}

export interface ComfortCloudCallOpts {
  /** Stops this call's own requests. A shared login runs on under its own timeouts. */
  signal?: AbortSignal
  stats?: ComfortCloudCallStats
}

export interface ComfortCloudClient {
  /** Every air conditioner on the account (Aquarea and hot-water tanks skipped). */
  units(o?: ComfortCloudCallOpts): Promise<ComfortCloudUnit[]>
  /** One UTC day's hourly rows. A bad day or guid throws RangeError before any request. */
  dayHours(
    guid: string,
    utcDay: string,
    o?: ComfortCloudCallOpts,
  ): Promise<ComfortCloudHistory<ComfortCloudHour>>
  /** One UTC month's daily totals ('YYYY-MM'): which days have data. */
  monthDays(
    guid: string,
    utcMonth: string,
    o?: ComfortCloudCallOpts,
  ): Promise<ComfortCloudHistory<ComfortCloudDay>>
}

/**
 * The heat pumps' facade (ADR-0027). Credentials come from the resolver
 * (ADR-0026: stored under Inställningar, else PANASONIC_USER / PANASONIC_PASSWORD),
 * checked on every call. The client, and the access token in its memory, is
 * rebuilt only when they change, so a warm instance reuses its login. An
 * unreadable stored row fails the call as `credentials_unreadable`; under
 * VITEST every call is `not_configured`.
 */
/** `http` only when both fields resolve. */
export function selectComfortCloudAdapter(
  values: CredentialValues<'comfortCloud'>,
): 'notConfigured' | 'http' {
  return values.user && values.password ? 'http' : 'notConfigured'
}

const getAdapter = keyedAdapter({
  source: 'comfortCloud',
  unavailable: async (code) => (await import('./adapters/notConfigured')).unavailable(code),
  build: async (values): Promise<ComfortCloudClient> => {
    const { user, password } = values
    if (selectComfortCloudAdapter(values) === 'http' && user && password) {
      const { createComfortCloudClient } = await import('./client')
      return createComfortCloudClient({ fetch: globalThis.fetch, user, password })
    }
    return (await import('./adapters/notConfigured')).notConfigured
  },
})

// Forwards each call's options ({ signal, stats }) untouched.
export const comfortCloud: ComfortCloudClient = {
  async units(o) {
    return (await getAdapter()).units(o)
  },
  async dayHours(guid, utcDay, o) {
    return (await getAdapter()).dayHours(guid, utcDay, o)
  },
  async monthDays(guid, utcMonth, o) {
    return (await getAdapter()).monthDays(guid, utcMonth, o)
  },
}

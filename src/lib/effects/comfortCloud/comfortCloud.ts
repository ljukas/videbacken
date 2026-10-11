/**
 * Panasonic Comfort Cloud: the air-to-air heat pumps' hourly electricity use and temperatures
 * (ADR-0027). Read-only. The client never logs; callers pass a `stats` sink. Hourly rows tell
 * when someone is home and heating: never log or echo them. Unit guids are shortened wherever
 * they are shown and never appear in an error.
 *
 * Step 1a builds the client only. The `comfortCloud` facade (keyedAdapter + notConfigured +
 * adapter selection) arrives with the source literal in step 1b: keyedAdapter takes a
 * CredentialSource.
 */
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
  /** 'YYYY-MM-DD' from `deviceRegisterTime`: the unit's first data day (the backfill's end). */
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

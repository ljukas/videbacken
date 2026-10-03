/**
 * The house's 5-minute energy flows from the Emaldo cloud (ADR-0023). The
 * client never logs; callers pass a `stats` sink. Readings are a household
 * load profile: never log or echo them.
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
}

export type EmaldoDay = {
  /** The response's start_time: Stockholm local midnight. */
  dayStart: Date
  /** The next Stockholm midnight (DST-aware), exclusive. */
  dayEnd: Date
  /** Ascending; only buckets present in all four series, inside [dayStart, dayEnd). */
  buckets: HouseBucket[]
  /**
   * Buckets seen but not returned: in some series only, outside the day, a
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

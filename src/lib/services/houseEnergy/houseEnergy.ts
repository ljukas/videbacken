import { millisecondsInHour, millisecondsInMinute } from 'date-fns/constants'
import { and, asc, gte, lt, min, sql } from 'drizzle-orm'
import { type DbOrTx, db } from '~/lib/db'
import { HOUSE_BUCKET_KWH_MAX, houseEnergyMonth, houseEnergyReading } from '~/lib/db/schema'
import { requestDerive } from '~/lib/services/energyMix/deriveRequest'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { HouseEnergyDomainError } from './errors'

/**
 * One 5-minute bucket of the house's energy flows, kWh each (ADR-0023). The
 * same shape as the Emaldo client's `HouseBucket`, declared here so the derive
 * and client code can `import type` it without reaching into an effect.
 */
export type HouseReading = {
  bucketStart: Date
  gridImportKwh: number
  gridExportKwh: number
  solarKwh: number
  loadKwh: number
  batteryDischargeKwh: number
  batteryChargeSolarKwh: number
  batteryChargeGridKwh: number
  batteryChargeAcKwh: number
  /** Battery state of charge, % (0–100), as reported for the minute; null when missing. */
  batterySocPct: number | null
}

const KWH_FIELDS = [
  'gridImportKwh',
  'gridExportKwh',
  'solarKwh',
  'loadKwh',
  'batteryDischargeKwh',
  'batteryChargeSolarKwh',
  'batteryChargeGridKwh',
  'batteryChargeAcKwh',
] as const satisfies readonly (keyof HouseReading)[]

/** Buckets start on 5-minute UTC boundaries (the table's alignment CHECK). */
const BUCKET_MS = 5 * millisecondsInMinute
/** A Stockholm day is 23–25 h; anything longer is a caller bug. */
const MAX_DAY_MS = 25 * millisecondsInHour
/** Problems quoted in one error message. */
const MAX_PROBLEMS = 5

const readingColumns = {
  bucketStart: houseEnergyReading.bucketStart,
  gridImportKwh: houseEnergyReading.gridImportKwh,
  gridExportKwh: houseEnergyReading.gridExportKwh,
  solarKwh: houseEnergyReading.solarKwh,
  loadKwh: houseEnergyReading.loadKwh,
  batteryDischargeKwh: houseEnergyReading.batteryDischargeKwh,
  batteryChargeSolarKwh: houseEnergyReading.batteryChargeSolarKwh,
  batteryChargeGridKwh: houseEnergyReading.batteryChargeGridKwh,
  batteryChargeAcKwh: houseEnergyReading.batteryChargeAcKwh,
  batterySocPct: houseEnergyReading.batterySocPct,
}

// What's wrong with `buckets` as the readings of `[startMs, endMs)`. Messages
// name the bucket index and field only — never a value (ADR-0023, privacy).
function readingProblems(startMs: number, endMs: number, buckets: readonly HouseReading[]) {
  const problems: string[] = []
  const seen = new Set<number>()
  for (const [i, b] of buckets.entries()) {
    const t = b.bucketStart.getTime()
    if (!(t >= startMs && t < endMs)) problems.push(`bucket ${i} starts outside the day`)
    else if (t % BUCKET_MS !== 0) problems.push(`bucket ${i} is off the 5-minute grid`)
    else if (seen.has(t)) problems.push(`bucket ${i} repeats a bucket start`)
    seen.add(t)
    for (const field of KWH_FIELDS) {
      const value = b[field]
      if (!Number.isFinite(value)) problems.push(`bucket ${i}: ${field} is not a finite number`)
      else if (value < 0) problems.push(`bucket ${i}: ${field} is negative`)
      else if (value >= HOUSE_BUCKET_KWH_MAX)
        problems.push(`bucket ${i}: ${field} is implausibly large`)
    }
    const soc = b.batterySocPct
    if (soc !== null && !(Number.isFinite(soc) && soc >= 0 && soc <= 100)) {
      problems.push(`bucket ${i}: batterySocPct is not a percentage`)
    }
  }
  return problems
}

/**
 * Stores one Stockholm day's readings, replacing whatever the day held: delete
 * `[dayStart, dayEnd)`, then insert, in one transaction (like
 * `spotPrice.replaceDay`). Validated first, so a rejected day leaves the stored
 * one untouched. An empty list clears the day — the sync never passes one (an
 * empty answer keeps what's stored). Returns the rows written.
 */
export async function replaceDay(
  day: { dayStart: Date; dayEnd: Date },
  buckets: readonly HouseReading[],
): Promise<number> {
  const startMs = day.dayStart.getTime()
  const endMs = day.dayEnd.getTime()
  if (!(endMs - startMs > 0 && endMs - startMs <= MAX_DAY_MS)) {
    throw new HouseEnergyDomainError('INVALID_DAY', 'A day must end 1 ms to 25 h after it starts')
  }
  const problems = readingProblems(startMs, endMs, buckets)
  if (problems.length > 0) {
    const more = problems.length > MAX_PROBLEMS ? ` (+${problems.length - MAX_PROBLEMS} more)` : ''
    throw new HouseEnergyDomainError(
      'INVALID_READINGS',
      `${problems.slice(0, MAX_PROBLEMS).join('; ')}${more}`,
    )
  }
  await writeDay(day, buckets)
  return buckets.length
}

/**
 * Recomputes the monthly sums view (`house_energy_month`, ADR-0024) from the
 * readings. CONCURRENTLY: readers keep the previous rows until it commits; a
 * second refresh waits for the first. Every writer of readings calls it after
 * writing (the Emaldo sync, once per run).
 *
 * Bounded on the server: the sync's `withDeadline` only stops waiting, it does
 * not cancel the query. The timeouts (a lock wait 5 s, the refresh 8 s, both
 * under the sync's 10 s `REFRESH_BUDGET_MS`) end a stuck refresh and release its
 * lock, so the next run's refresh is not queued behind it.
 */
export async function refreshMonthSums(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`)
    await tx.execute(sql`SET LOCAL statement_timeout = '8s'`)
    await tx.refreshMaterializedView(houseEnergyMonth).concurrently()
  })
}

// The delete + insert, in one transaction. A database failure (a dropped
// connection, a lost race on the primary key) is rethrown without its cause:
// drizzle's error quotes every bound parameter — the day's readings — and pg's
// detail quotes the failing row; the sync would log either (ADR-0023).
async function writeDay(day: { dayStart: Date; dayEnd: Date }, buckets: readonly HouseReading[]) {
  try {
    await insertDay(day, buckets)
  } catch (error) {
    throw new Error(`Storing house energy readings failed${pgSummary(error)}`)
  }
}

/** " (Postgres <code>, <constraint>)" from the pg error under drizzle's wrapper, or "". */
function pgSummary(error: unknown): string {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof pg.code === 'string') {
      const constraint = typeof pg.constraint === 'string' ? `, ${pg.constraint}` : ''
      return ` (Postgres ${pg.code}${constraint})`
    }
    e = pg.cause
  }
  return ''
}

async function insertDay(day: { dayStart: Date; dayEnd: Date }, buckets: readonly HouseReading[]) {
  await db.transaction(async (tx) => {
    await tx
      .delete(houseEnergyReading)
      .where(
        and(
          gte(houseEnergyReading.bucketStart, day.dayStart),
          lt(houseEnergyReading.bucketStart, day.dayEnd),
        ),
      )
    // Queued with the readings (ADR-0023): if the run dies before its derive,
    // the next derive still covers this day.
    await requestDerive(stockholmDayOf(day.dayStart.getTime()), tx)
    if (buckets.length === 0) return
    await tx.insert(houseEnergyReading).values(
      buckets.map((b) => ({
        bucketStart: b.bucketStart,
        gridImportKwh: b.gridImportKwh,
        gridExportKwh: b.gridExportKwh,
        solarKwh: b.solarKwh,
        loadKwh: b.loadKwh,
        batteryDischargeKwh: b.batteryDischargeKwh,
        batteryChargeSolarKwh: b.batteryChargeSolarKwh,
        batteryChargeGridKwh: b.batteryChargeGridKwh,
        batteryChargeAcKwh: b.batteryChargeAcKwh,
        batterySocPct: b.batterySocPct,
      })),
    )
  })
}

/** The readings in `[from, to)`, oldest first — a primary-key range scan. */
export async function listReadings(
  range: { from: Date; to: Date },
  dbOrTx: DbOrTx = db,
): Promise<HouseReading[]> {
  return dbOrTx
    .select(readingColumns)
    .from(houseEnergyReading)
    .where(
      and(
        gte(houseEnergyReading.bucketStart, range.from),
        lt(houseEnergyReading.bucketStart, range.to),
      ),
    )
    .orderBy(asc(houseEnergyReading.bucketStart))
}

/** The earliest stored bucket's start, or null with none. */
export async function firstReadingAt(dbOrTx: DbOrTx = db): Promise<Date | null> {
  const [row] = await dbOrTx
    .select({ first: min(houseEnergyReading.bucketStart) })
    .from(houseEnergyReading)
  return row?.first ?? null
}

import { and, asc, eq, gte, lt, max, min, type SQL, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { pgErrorSummary } from '~/lib/db/pgError'
import {
  HEAT_PUMP_HOUR_KWH_MAX,
  HEAT_PUMP_TEMP_MAX_C,
  HEAT_PUMP_TEMP_MIN_C,
  heatPump,
  heatPumpReading,
} from '~/lib/db/schema'
import { isUtcDay, utcDayBounds, utcDayOf } from '~/lib/time/utc'
import { HeatPumpDomainError } from './errors'

export type HeatPump = typeof heatPump.$inferSelect

/** A unit as Comfort Cloud lists it (the same shape as `ComfortCloudUnit`). */
export type HeatPumpUnitInput = { guid: string; name: string; model: string }

/**
 * One unit-hour (the same shape as `ComfortCloudHour`, declared here so callers needn't reach
 * into an effect). Presence data: never log it.
 */
export type HeatPumpHourInput = {
  hourStart: Date
  energyKwh: number
  heatShare: number | null
  coolShare: number | null
  setpointC: number | null
  insideC: number | null
  outsideC: number | null
}

const HOUR_MS = 3_600_000
/** Problems quoted in one error message. */
const MAX_PROBLEMS = 5
/** The canonical 8-4-4-4-12 form only (ids come from the database); anything else can't be a heat_pump id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHARE_FIELDS = ['heatShare', 'coolShare'] as const
const TEMP_FIELDS = ['setpointC', 'insideC', 'outsideC'] as const

// Runs one query; a failure is rethrown with only the SQLSTATE and constraint, since drizzle's
// error quotes every bound value (guids, names) and chains the pg error as its cause.
async function guarded<T>(what: string, query: () => Promise<T>): Promise<T> {
  try {
    return await query()
  } catch (error) {
    throw new Error(`${what} failed${pgErrorSummary(error)}`)
  }
}

/**
 * Inserts the units Comfort Cloud lists, or refreshes name, model and last_seen_at of known ones
 * (by guid; first_seen_at and the backfill columns are kept). Returns the rows in input order,
 * once per guid (the last entry of a repeated guid wins).
 */
export async function upsertUnits(units: HeatPumpUnitInput[], now: Date): Promise<HeatPump[]> {
  const byGuid = new Map(units.map((u) => [u.guid, u]))
  if (byGuid.size === 0) return []
  const rows = await guarded('Upserting heat pump units', () =>
    db
      .insert(heatPump)
      .values(
        [...byGuid.values()].map((u) => ({
          guid: u.guid,
          name: u.name,
          model: u.model,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: heatPump.guid,
        set: {
          name: sql`excluded.name`,
          model: sql`excluded.model`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      })
      .returning(),
  )
  const byStoredGuid = new Map(rows.map((r) => [r.guid, r]))
  return [...byGuid.keys()].flatMap((guid) => byStoredGuid.get(guid) ?? [])
}

/** Every unit, by name (then guid, for a stable order). */
export async function listUnits(): Promise<HeatPump[]> {
  return guarded('Listing heat pump units', () =>
    db.select().from(heatPump).orderBy(asc(heatPump.name), asc(heatPump.guid)),
  )
}

// What's wrong with `hours` as one unit's readings of `[startMs, endMs)`. Messages name the hour
// index and field only — never a value (ADR-0027: hourly rows are presence data).
function readingProblems(startMs: number, endMs: number, hours: readonly HeatPumpHourInput[]) {
  const problems: string[] = []
  const seen = new Set<number>()
  for (const [i, h] of hours.entries()) {
    const t = h.hourStart.getTime()
    if (!(t >= startMs && t < endMs)) problems.push(`hour ${i} starts outside the day`)
    else if ((t - startMs) % HOUR_MS !== 0) problems.push(`hour ${i} is not on a whole hour`)
    else if (seen.has(t)) problems.push(`hour ${i} repeats an hour`)
    seen.add(t)
    const kwh = h.energyKwh
    if (!(Number.isFinite(kwh) && kwh >= 0 && kwh < HEAT_PUMP_HOUR_KWH_MAX)) {
      problems.push(`hour ${i}: energyKwh is out of range`)
    }
    for (const field of SHARE_FIELDS) {
      const v = h[field]
      if (v !== null && !(Number.isFinite(v) && v >= 0 && v <= 1)) {
        problems.push(`hour ${i}: ${field} is not a share`)
      }
    }
    for (const field of TEMP_FIELDS) {
      const v = h[field]
      if (
        v !== null &&
        !(Number.isFinite(v) && v >= HEAT_PUMP_TEMP_MIN_C && v <= HEAT_PUMP_TEMP_MAX_C)
      ) {
        problems.push(`hour ${i}: ${field} is out of range`)
      }
    }
  }
  return problems
}

/**
 * Stores one unit's UTC day, replacing whatever that unit's day held: delete its hours in
 * `[day, day + 24 h)`, then insert, in one transaction (as `houseEnergy.replaceDay`). Validated
 * first, so a rejected day leaves the stored one untouched. An empty list clears the day. A
 * database failure is rethrown with only the SQLSTATE and constraint (drizzle's error quotes
 * every bound value).
 */
export async function replaceDay(
  heatPumpId: string,
  utcDay: string,
  hours: readonly HeatPumpHourInput[],
): Promise<{ stored: number }> {
  const { startMs, endMs } = utcDayBounds(utcDay)
  const problems = readingProblems(startMs, endMs, hours)
  if (problems.length > 0) {
    const more = problems.length > MAX_PROBLEMS ? ` (+${problems.length - MAX_PROBLEMS} more)` : ''
    throw new HeatPumpDomainError(
      'INVALID_READING',
      `${problems.slice(0, MAX_PROBLEMS).join('; ')}${more}`,
    )
  }
  if (!UUID_RE.test(heatPumpId)) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
  try {
    await db.transaction(async (tx) => {
      const [unit] = await tx
        .select({ id: heatPump.id })
        .from(heatPump)
        .where(eq(heatPump.id, heatPumpId))
      if (!unit) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
      await tx
        .delete(heatPumpReading)
        .where(
          and(
            eq(heatPumpReading.heatPumpId, heatPumpId),
            gte(heatPumpReading.hourStart, new Date(startMs)),
            lt(heatPumpReading.hourStart, new Date(endMs)),
          ),
        )
      if (hours.length === 0) return
      await tx.insert(heatPumpReading).values(
        hours.map((h) => ({
          heatPumpId,
          hourStart: h.hourStart,
          energyKwh: h.energyKwh,
          heatShare: h.heatShare,
          coolShare: h.coolShare,
          setpointC: h.setpointC,
          insideC: h.insideC,
          outsideC: h.outsideC,
        })),
      )
    })
  } catch (error) {
    if (error instanceof HeatPumpDomainError) throw error
    throw new Error(`Storing heat pump readings failed${pgErrorSummary(error)}`)
  }
  return { stored: hours.length }
}

/** The UTC day of the unit's oldest stored hour (the backfill's cursor), or null with none. */
export async function oldestDay(heatPumpId: string): Promise<string | null> {
  if (!UUID_RE.test(heatPumpId)) return null
  const [row] = await guarded('Reading the oldest heat pump day', () =>
    db
      .select({ first: min(heatPumpReading.hourStart) })
      .from(heatPumpReading)
      .where(eq(heatPumpReading.heatPumpId, heatPumpId)),
  )
  return row?.first ? utcDayOf(row.first.getTime()) : null
}

/**
 * The unit's newest stored hour (`hour_start`), or null with none — one max() over the
 * (heat_pump_id, hour_start) primary key. The sync's offline rule reads it.
 */
export async function newestHour(heatPumpId: string): Promise<Date | null> {
  if (!UUID_RE.test(heatPumpId)) return null
  const [row] = await guarded('Reading the newest heat pump hour', () =>
    db
      .select({ newest: max(heatPumpReading.hourStart) })
      .from(heatPumpReading)
      .where(eq(heatPumpReading.heatPumpId, heatPumpId)),
  )
  return row?.newest ?? null
}

/**
 * Records the unit's first data day ('YYYY-MM-DD', from `deviceRegisterTime`). A date earlier
 * than the stored one clears `history_complete_at` in the same statement, so the backfill (which
 * walks units without it) reopens down to the new date. Postgres evaluates every SET expression
 * against the old row, so the CASE compares with the previously stored `registered_on`.
 */
export async function setRegisteredOn(heatPumpId: string, day: string): Promise<void> {
  if (!isUtcDay(day)) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  await updateUnit(heatPumpId, {
    registeredOn: day,
    historyCompleteAt: sql`CASE WHEN ${heatPump.registeredOn} IS NOT NULL AND ${day}::date < ${heatPump.registeredOn} THEN NULL ELSE ${heatPump.historyCompleteAt} END`,
  })
}

/** Marks the unit's backfill as having reached `registered_on`. */
export async function markHistoryComplete(heatPumpId: string, now: Date): Promise<void> {
  await updateUnit(heatPumpId, { historyCompleteAt: now })
}

async function updateUnit(
  heatPumpId: string,
  set: { registeredOn?: string; historyCompleteAt?: Date | SQL },
): Promise<void> {
  if (!UUID_RE.test(heatPumpId)) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
  const rows = await guarded('Updating a heat pump unit', () =>
    db.update(heatPump).set(set).where(eq(heatPump.id, heatPumpId)).returning({ id: heatPump.id }),
  )
  if (rows.length === 0) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
}

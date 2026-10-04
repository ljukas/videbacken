import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { type DbOrTx, db } from '~/lib/db'
import { energyMixDeriveRequest, spotPrice } from '~/lib/db/schema'
import { type DailySpot, type PriceSlot, validateDaySlots } from '~/lib/spotPrice/slots'
import type { PriceZone } from '~/lib/spotPrice/zones'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { SpotPriceDomainError } from './errors'

/**
 * Stores Stockholm `day`'s complete price list for `zone`, replacing whatever
 * that day held: delete the day's range, then insert, in one transaction. A
 * plain upsert on `(zone, slot_start)` would leave stale rows behind when a
 * day comes back split differently (hourly ↔ 15-min), and overlapping slots
 * would double-count energy in the cost math.
 */
export async function replaceDay(
  zone: PriceZone,
  day: string,
  slots: readonly PriceSlot[],
): Promise<{ written: number }> {
  const problems = validateDaySlots(day, slots)
  if (problems.length > 0) {
    throw new SpotPriceDomainError('INVALID_DAY_SLOTS', `${day}: ${problems.join('; ')}`)
  }
  const { startMs, endMs } = stockholmDayBounds(day)
  await db.transaction(async (tx) => {
    await tx
      .delete(spotPrice)
      .where(
        and(
          eq(spotPrice.zone, zone),
          gte(spotPrice.slotStart, new Date(startMs)),
          lt(spotPrice.slotStart, new Date(endMs)),
        ),
      )
    await tx.insert(spotPrice).values(
      slots.map((s) => ({
        zone,
        slotStart: new Date(s.startMs),
        slotEnd: new Date(s.endMs),
        sekPerKwh: s.sekPerKwh,
      })),
    )
    // Queued with the prices (ADR-0023): if the run dies before its derive,
    // the next derive still re-prices the battery from this day.
    await tx.insert(energyMixDeriveRequest).values({ fromDay: day })
  })
  return { written: slots.length }
}

/**
 * Every stored slot of `zone` overlapping any of `ranges` (e.g. charging
 * windows), each slot once, ordered by start. One statement however many
 * ranges: they are joined as `unnest` arrays, and the `slot_start >= start −
 * 1 h` bound (slots are ≤ 1 h, a table CHECK) keeps each probe a PK range scan.
 */
export async function listSlotsOverlapping(
  zone: PriceZone,
  ranges: readonly { startMs: number; endMs: number }[],
  dbOrTx: DbOrTx = db,
): Promise<PriceSlot[]> {
  if (ranges.length === 0) return []
  const pgArray = (ms: number[]) => `{${ms.map((m) => new Date(m).toISOString()).join(',')}}`
  const starts = pgArray(ranges.map((r) => r.startMs))
  const ends = pgArray(ranges.map((r) => r.endMs))
  // Raw `execute` returns timestamptz as strings (drizzle's node-postgres parsers).
  const { rows } = await dbOrTx.execute<{
    slot_start: string
    slot_end: string
    sek_per_kwh: number
  }>(sql`
    SELECT DISTINCT p.slot_start, p.slot_end, p.sek_per_kwh
    FROM unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) AS r(range_start, range_end)
    JOIN ${spotPrice} p
      ON p.zone = ${zone}
     AND p.slot_start < r.range_end
     AND p.slot_end > r.range_start
     AND p.slot_start >= r.range_start - interval '1 hour'
    ORDER BY p.slot_start
  `)
  return rows.map((r) => ({
    startMs: new Date(r.slot_start).getTime(),
    endMs: new Date(r.slot_end).getTime(),
    sekPerKwh: Number(r.sek_per_kwh),
  }))
}

/** The Stockholm days in `[fromDay, toDay]` (inclusive) that have stored slots. */
export async function daysWithSlots(
  zone: PriceZone,
  fromDay: string,
  toDay: string,
): Promise<Set<string>> {
  const from = new Date(stockholmDayBounds(fromDay).startMs)
  const to = new Date(stockholmDayBounds(toDay).endMs)
  const day = sql<string>`(${spotPrice.slotStart} AT TIME ZONE 'Europe/Stockholm')::date::text`
  const rows = await db
    .selectDistinct({ day })
    .from(spotPrice)
    .where(
      and(eq(spotPrice.zone, zone), gte(spotPrice.slotStart, from), lt(spotPrice.slotStart, to)),
    )
  return new Set(rows.map((r) => r.day))
}

/**
 * Per Stockholm day in `[fromDay, toDay]` (inclusive) with stored slots: the
 * time-weighted average SEK/kWh (ex VAT) and how long the day has prices.
 * Aggregated in Postgres — a year is ~35 000 slots but only 365 rows here —
 * over a PK range scan. Slots never straddle local midnight (the sync stores
 * whole validated days), so grouping by the slot start's local day is exact.
 */
export async function dailyAverageSpot(
  zone: PriceZone,
  fromDay: string,
  toDay: string,
): Promise<DailySpot[]> {
  const from = new Date(stockholmDayBounds(fromDay).startMs).toISOString()
  const to = new Date(stockholmDayBounds(toDay).endMs).toISOString()
  const seconds = sql`extract(epoch FROM ${spotPrice.slotEnd} - ${spotPrice.slotStart})`
  // Raw `execute` returns numeric aggregates as strings.
  const { rows } = await db.execute<{ day: string; avg: string; covered_s: string }>(sql`
    SELECT to_char(${spotPrice.slotStart} AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD') AS day,
           sum(${spotPrice.sekPerKwh} * ${seconds}) / sum(${seconds}) AS avg,
           sum(${seconds}) AS covered_s
    FROM ${spotPrice}
    WHERE ${spotPrice.zone} = ${zone}
      AND ${spotPrice.slotStart} >= ${from}::timestamptz
      AND ${spotPrice.slotStart} < ${to}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `)
  return rows.map((r) => ({
    day: r.day,
    avgSekPerKwh: Number(r.avg),
    coveredMs: Math.round(Number(r.covered_s) * 1000),
  }))
}

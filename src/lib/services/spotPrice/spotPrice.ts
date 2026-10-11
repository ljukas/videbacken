import { and, eq, gte, lt, lte, sql } from 'drizzle-orm'
import { type DbOrTx, db } from '~/lib/db'
import { spotPrice, spotPriceDay } from '~/lib/db/schema'
import { requestDerive } from '~/lib/services/energyMix/deriveRequest'
import { bumpOverlapping } from '~/lib/services/sessionCost/invalidate'
import { type DailySpot, type PriceSlot, validateDaySlots } from '~/lib/spotPrice/slots'
import type { PriceZone } from '~/lib/spotPrice/zones'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { SpotPriceDomainError } from './errors'

/** A slot's length in seconds (numeric in Postgres). */
const slotSeconds = sql`extract(epoch FROM ${spotPrice.slotEnd} - ${spotPrice.slotStart})`

/**
 * Stores Stockholm `day`'s complete price list for `zone`, replacing whatever
 * that day held: delete the day's range, then insert, in one transaction. A
 * plain upsert on `(zone, slot_start)` would leave stale rows behind when a
 * day comes back split differently (hourly ↔ 15-min), and overlapping slots
 * would double-count energy in the cost math. It also rewrites the day's
 * `spot_price_day` average in the same transaction (the table's only writer).
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
    // The day's average, from the slots just written (spot_price_day). The
    // same aggregate as the 0024 backfill migration; summed in slot order so
    // the float result is deterministic.
    await tx.execute(sql`
      INSERT INTO ${spotPriceDay} (zone, day, avg_sek_per_kwh, covered_seconds)
      SELECT ${spotPrice.zone}, ${day}::date,
             sum(${spotPrice.sekPerKwh} * ${slotSeconds} ORDER BY ${spotPrice.slotStart})
               / sum(${slotSeconds}),
             sum(${slotSeconds})::integer
      FROM ${spotPrice}
      WHERE ${spotPrice.zone} = ${zone}
        AND ${spotPrice.slotStart} >= ${new Date(startMs).toISOString()}::timestamptz
        AND ${spotPrice.slotStart} < ${new Date(endMs).toISOString()}::timestamptz
      GROUP BY ${spotPrice.zone}
      ON CONFLICT (zone, day) DO UPDATE
        SET avg_sek_per_kwh = excluded.avg_sek_per_kwh,
            covered_seconds = excluded.covered_seconds
    `)
    // Sessions charging this day are priced from these slots (ADR-0020, amended 2026-10-11).
    await bumpOverlapping({ startMs, endMs }, tx)
    // Queued with the prices (ADR-0023): if the run dies before its derive,
    // the next derive still re-prices the battery from this day.
    await requestDerive(day, tx)
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

/**
 * The Stockholm days in `[fromDay, toDay]` (inclusive) stored by `replaceDay`:
 * the days with a `spot_price_day` row. A day whose slots exist without that
 * row (written by code from before the table, e.g. after a rollback) counts as
 * missing, so the sync re-fetches it and `replaceDay` writes both together.
 */
export async function daysStored(
  zone: PriceZone,
  fromDay: string,
  toDay: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ day: spotPriceDay.day })
    .from(spotPriceDay)
    .where(
      and(
        eq(spotPriceDay.zone, zone),
        gte(spotPriceDay.day, fromDay),
        lte(spotPriceDay.day, toDay),
      ),
    )
  return new Set(rows.map((r) => r.day))
}

/**
 * Per Stockholm day in `[fromDay, toDay]` (inclusive) stored by `replaceDay`: the
 * time-weighted average SEK/kWh (ex VAT) and how long the day has prices. Read
 * from `spot_price_day` (written by `replaceDay`), a PK range: ~255 rows a year
 * instead of grouping ~35 000 slots.
 */
export async function dailyAverageSpot(
  zone: PriceZone,
  fromDay: string,
  toDay: string,
): Promise<DailySpot[]> {
  const rows = await db
    .select({
      day: spotPriceDay.day,
      avgSekPerKwh: spotPriceDay.avgSekPerKwh,
      coveredSeconds: spotPriceDay.coveredSeconds,
    })
    .from(spotPriceDay)
    .where(
      and(
        eq(spotPriceDay.zone, zone),
        gte(spotPriceDay.day, fromDay),
        lte(spotPriceDay.day, toDay),
      ),
    )
    .orderBy(spotPriceDay.day)
  return rows.map((r) => ({
    day: r.day,
    avgSekPerKwh: r.avgSekPerKwh,
    coveredMs: r.coveredSeconds * 1000,
  }))
}

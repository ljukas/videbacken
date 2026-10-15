import { type SQL, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { heatPumpDay } from '~/lib/db/schema'
import { addDays, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'

/**
 * Pure: [from, to) as whole Stockholm days [wholeDays.from, wholeDays.to) (calendar days, `to` exclusive), read from
 * `heat_pump_day`, and the partial days around them, read from the readings. A range with no whole day inside is one
 * partial (at most two days of hours, by primary key). DST days follow `stockholmDayBounds`.
 */
export function splitRange(
  from: Date,
  to: Date,
): { wholeDays: { from: string; to: string } | null; partials: { from: Date; to: Date }[] } {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  if (toMs <= fromMs) return { wholeDays: null, partials: [] }
  const fromDay = stockholmDayOf(fromMs)
  const fromBounds = stockholmDayBounds(fromDay)
  const atMidnight = fromBounds.startMs === fromMs
  const wholeFromDay = atMidnight ? fromDay : addDays(fromDay, 1)
  const wholeFromMs = atMidnight ? fromMs : fromBounds.endMs
  const toDay = stockholmDayOf(toMs)
  const toDayStartMs = stockholmDayBounds(toDay).startMs
  if (toDayStartMs <= wholeFromMs) return { wholeDays: null, partials: [{ from, to }] }
  const partials: { from: Date; to: Date }[] = []
  if (wholeFromMs > fromMs) partials.push({ from, to: new Date(wholeFromMs) })
  if (toMs > toDayStartMs) partials.push({ from: new Date(toDayStartMs), to })
  return { wholeDays: { from: wholeFromDay, to: toDay }, partials }
}

/**
 * Recomputes the day sums view (`heat_pump_day`, ADR-0027 decision 6) from the readings. CONCURRENTLY: readers keep
 * the previous rows until it commits; a second refresh waits for the first. Every writer of readings calls it after
 * writing (the Comfort Cloud sync, once per run that stored hours). Bounded on the server like
 * `houseEnergy.refreshMonthSums`: the sync's budget only stops waiting, so a lock wait (5 s) and the refresh (8 s)
 * time out here and release the lock. Serial: a parallel aggregate adds the floats in a varying order, and
 * CONCURRENTLY would then rewrite every row whose sum moved in the last bit (should the planner ever pick a
 * parallel plan as the readings grow; it doesn't at today's size).
 */
export async function refreshDaySums(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`)
    await tx.execute(sql`SET LOCAL statement_timeout = '8s'`)
    await tx.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`)
    await tx.refreshMaterializedView(heatPumpDay).concurrently()
  })
}

/** One unit's sums over one Stockholm month (ADR-0027). */
export type HeatPumpMonthRow = {
  heatPumpId: string
  name: string
  year: number
  /** 1–12, Stockholm. */
  month: number
  kwh: number
  /** Σ kWh × heating share (an hour without a share counts 0); `coolKwh` likewise. */
  heatKwh: number
  coolKwh: number
  /** Hour-weighted means over the hours that have a value; null when none has. */
  insideC: number | null
  outsideC: number | null
  setpointC: number | null
  /** Hours with a reading. */
  hours: number
  firstHour: Date
  lastHour: Date
  /**
   * When Comfort Cloud last listed the unit (step 1b refreshes it every run); `getEnergyOverview` uses it to tell a
   * removed unit from a lagging one. Never sent to the browser.
   */
  lastSeenAt: Date
}

type MonthSumRow = {
  heat_pump_id: string
  name: string
  year: number
  month: number
  kwh: number
  heat_kwh: number
  cool_kwh: number
  inside_c: number | null
  outside_c: number | null
  setpoint_c: number | null
  hours: number
  first_hour: Date | string
  last_hour: Date | string
  last_seen_at: Date | string
}

const nullableNumber = (v: number | string | null) => (v === null ? null : Number(v))

/**
 * Per unit and Stockholm month, the sums over the unit's readings in [from, to), ordered by name, unit, year and month
 * (ADR-0027 decision 6, amended in step 2b). Whole Stockholm days come from `heat_pump_day`; a partial first and last
 * day (`splitRange`) come from the readings, filtered by unit so they run on the primary key, never a scan. Both are
 * the same per-hour sums (a null share counts 0; a temperature keeps its sum and hour count, so the month's mean is
 * hour-weighted), so the union groups into months exactly as the readings would. Stockholm offsets are whole hours, so
 * every UTC hour lies in one Stockholm day and month, DST days included. Months are keyed as dates, so nothing passes
 * through the session time zone. Whole days are as fresh as the last `refreshDaySums`; partial days see an hour as soon
 * as it is stored. Sums only: `firstHour`, `lastHour` and `lastSeenAt` are for `getEnergyOverview`'s expected hours,
 * and an hour never leaves the service. The name is the unit's current one; a unit deleted since the last refresh
 * drops out with the join.
 */
export async function monthSums({
  from,
  to,
}: {
  from: Date
  to: Date
}): Promise<HeatPumpMonthRow[]> {
  const { wholeDays, partials } = splitRange(from, to)
  const parts: SQL[] = []
  if (wholeDays) {
    parts.push(sql`
      SELECT heat_pump_id, date_trunc('month', day::timestamp)::date AS m, kwh, heat_kwh, cool_kwh,
        inside_c_sum, inside_c_hours, outside_c_sum, outside_c_hours, setpoint_c_sum, setpoint_c_hours,
        hours, first_hour, last_hour
      FROM heat_pump_day
      WHERE day >= ${wholeDays.from}::date AND day < ${wholeDays.to}::date`)
  }
  for (const p of partials) {
    parts.push(sql`
      SELECT heat_pump_id, date_trunc('month', hour_start AT TIME ZONE 'Europe/Stockholm')::date AS m,
        energy_kwh, energy_kwh * coalesce(heat_share, 0), energy_kwh * coalesce(cool_share, 0),
        inside_c, (inside_c IS NOT NULL)::int, outside_c, (outside_c IS NOT NULL)::int,
        setpoint_c, (setpoint_c IS NOT NULL)::int,
        1, hour_start, hour_start
      FROM heat_pump_reading
      WHERE heat_pump_id = ANY(ARRAY(SELECT id FROM heat_pump))
        AND hour_start >= ${p.from.toISOString()}::timestamptz
        AND hour_start < ${p.to.toISOString()}::timestamptz`)
  }
  if (parts.length === 0) return []
  const { rows } = await db.execute<MonthSumRow>(sql`
    SELECT s.heat_pump_id, h.name,
      extract(year from s.m)::int AS year, extract(month from s.m)::int AS month,
      s.kwh, s.heat_kwh, s.cool_kwh,
      s.inside_c_sum / nullif(s.inside_c_hours, 0) AS inside_c,
      s.outside_c_sum / nullif(s.outside_c_hours, 0) AS outside_c,
      s.setpoint_c_sum / nullif(s.setpoint_c_hours, 0) AS setpoint_c,
      s.hours, s.first_hour, s.last_hour, h.last_seen_at
    FROM (
      SELECT heat_pump_id, m,
        sum(kwh) AS kwh, sum(heat_kwh) AS heat_kwh, sum(cool_kwh) AS cool_kwh,
        sum(inside_c_sum) AS inside_c_sum, sum(inside_c_hours)::int AS inside_c_hours,
        sum(outside_c_sum) AS outside_c_sum, sum(outside_c_hours)::int AS outside_c_hours,
        sum(setpoint_c_sum) AS setpoint_c_sum, sum(setpoint_c_hours)::int AS setpoint_c_hours,
        sum(hours)::int AS hours, min(first_hour) AS first_hour, max(last_hour) AS last_hour
      FROM (${sql.join(parts, sql` UNION ALL `)}) AS p (
        heat_pump_id, m, kwh, heat_kwh, cool_kwh, inside_c_sum, inside_c_hours, outside_c_sum, outside_c_hours,
        setpoint_c_sum, setpoint_c_hours, hours, first_hour, last_hour
      )
      GROUP BY heat_pump_id, m
    ) s
    JOIN heat_pump h ON h.id = s.heat_pump_id
    ORDER BY h.name, s.heat_pump_id, s.m`)
  return rows.map((r) => ({
    heatPumpId: r.heat_pump_id,
    name: r.name,
    year: Number(r.year),
    month: Number(r.month),
    kwh: Number(r.kwh),
    heatKwh: Number(r.heat_kwh),
    coolKwh: Number(r.cool_kwh),
    insideC: nullableNumber(r.inside_c),
    outsideC: nullableNumber(r.outside_c),
    setpointC: nullableNumber(r.setpoint_c),
    hours: Number(r.hours),
    firstHour: new Date(r.first_hour),
    lastHour: new Date(r.last_hour),
    lastSeenAt: new Date(r.last_seen_at),
  }))
}

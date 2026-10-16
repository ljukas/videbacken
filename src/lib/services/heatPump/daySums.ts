// Heat pump day sums (heat pumps step 3, ADR-0027 decision 6, amended 2026-10-15): the sibling of `monthSums.ts`.
// Whole Stockholm days are read from the `heat_pump_day` view, never by grouping the readings, so they are as fresh as
// the last `refreshDaySums` (every writer of readings calls it). Sums only; the hours never leave the service.
import { sql } from 'drizzle-orm'
import { db } from '~/lib/db'

/** One unit's sums for one Stockholm day. Means are hour-weighted (each reading is one hour); null without a value. */
export type HeatPumpDayRow = {
  heatPumpId: string
  /** Stockholm 'YYYY-MM-DD'. */
  day: string
  kwh: number
  heatKwh: number
  coolKwh: number
  insideC: number | null
  outsideC: number | null
  setpointC: number | null
  hours: number
}

type DayRow = {
  heat_pump_id: string
  day: string
  kwh: number
  heat_kwh: number
  cool_kwh: number
  inside_c: number | null
  outside_c: number | null
  setpoint_c: number | null
  hours: number
}

const nullableNumber = (v: number | string | null) => (v === null ? null : Number(v))

/**
 * Sums per unit per Stockholm day of `[from, to]` (inclusive 'YYYY-MM-DD', validated by the caller), ordered by day,
 * then unit id. The view's day is a date in Stockholm time (DST days hold 23 or 25 hours), compared as a date. A null
 * share counts as 0, as in `monthSums`. Days without readings are absent; the read model adds them back with their
 * expected hours. A unit deleted since the last refresh drops out with the join.
 */
export async function daySums({
  from,
  to,
}: {
  from: string
  to: string
}): Promise<HeatPumpDayRow[]> {
  const { rows } = await db.execute<DayRow>(sql`
    SELECT d.heat_pump_id, d.day::text AS day, d.kwh, d.heat_kwh, d.cool_kwh,
      d.inside_c_sum / nullif(d.inside_c_hours, 0) AS inside_c,
      d.outside_c_sum / nullif(d.outside_c_hours, 0) AS outside_c,
      d.setpoint_c_sum / nullif(d.setpoint_c_hours, 0) AS setpoint_c,
      d.hours
    FROM heat_pump_day d
    JOIN heat_pump h ON h.id = d.heat_pump_id
    WHERE d.day >= ${from}::date AND d.day <= ${to}::date
    ORDER BY d.day, d.heat_pump_id`)
  return rows.map((r) => ({
    heatPumpId: r.heat_pump_id,
    day: r.day,
    kwh: Number(r.kwh),
    heatKwh: Number(r.heat_kwh),
    coolKwh: Number(r.cool_kwh),
    insideC: nullableNumber(r.inside_c),
    outsideC: nullableNumber(r.outside_c),
    setpointC: nullableNumber(r.setpoint_c),
    hours: Number(r.hours),
  }))
}

type SpanRow = { heat_pump_id: string; first_hour: Date | string; last_hour: Date | string }

/**
 * Each unit's first and newest stored hour (as fresh as the view): the read model clips expected hours to them. Read
 * from `heat_pump_day` (about 1,400 rows), never by grouping the readings.
 */
export async function readingSpans(): Promise<
  { heatPumpId: string; firstHour: Date; lastHour: Date }[]
> {
  const { rows } = await db.execute<SpanRow>(sql`
    SELECT d.heat_pump_id, min(d.first_hour) AS first_hour, max(d.last_hour) AS last_hour
    FROM heat_pump_day d
    JOIN heat_pump h ON h.id = d.heat_pump_id
    GROUP BY d.heat_pump_id`)
  return rows.map((r) => ({
    heatPumpId: r.heat_pump_id,
    firstHour: new Date(r.first_hour),
    lastHour: new Date(r.last_hour),
  }))
}

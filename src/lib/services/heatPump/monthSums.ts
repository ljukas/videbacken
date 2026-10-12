import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { heatPump, heatPumpReading } from '~/lib/db/schema'

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

/**
 * Per unit and Stockholm month, the sums over the unit's readings in [from, to), ordered by name, unit, year and month.
 * A reading is already one whole UTC hour (the table's primary key and hour CHECK), so ADR-0024's rule (sum per UTC
 * hour, then convert the hour to Stockholm time) is one GROUP BY here: Stockholm offsets are whole hours, so every UTC
 * hour lies in exactly one Stockholm month, DST days included. Each row is one hour, so `avg` is the hour-weighted
 * mean. It aggregates the readings before joining the unit, so the sort sees one row per unit and month instead of spilling every wide joined reading row to disk. Sums only: an hour never leaves this function (ADR-0027 decision 6). The name is the unit's current one.
 */
export async function monthSums({
  from,
  to,
}: {
  from: Date
  to: Date
}): Promise<HeatPumpMonthRow[]> {
  const s = db
    .select({
      heatPumpId: heatPumpReading.heatPumpId,
      m: sql<Date>`date_trunc('month', ${heatPumpReading.hourStart} AT TIME ZONE 'Europe/Stockholm')`.as(
        'm',
      ),
      kwh: sql<number>`sum(${heatPumpReading.energyKwh})`.mapWith(Number).as('kwh'),
      heatKwh:
        sql<number>`sum(${heatPumpReading.energyKwh} * coalesce(${heatPumpReading.heatShare}, 0))`
          .mapWith(Number)
          .as('heat_kwh'),
      coolKwh:
        sql<number>`sum(${heatPumpReading.energyKwh} * coalesce(${heatPumpReading.coolShare}, 0))`
          .mapWith(Number)
          .as('cool_kwh'),
      insideC: sql<number | null>`avg(${heatPumpReading.insideC})`.mapWith(Number).as('inside_c'),
      outsideC: sql<number | null>`avg(${heatPumpReading.outsideC})`
        .mapWith(Number)
        .as('outside_c'),
      setpointC: sql<number | null>`avg(${heatPumpReading.setpointC})`
        .mapWith(Number)
        .as('setpoint_c'),
      hours: sql<number>`count(*)::int`.as('hours'),
      firstHour: sql<Date>`min(${heatPumpReading.hourStart})`
        .mapWith(heatPumpReading.hourStart)
        .as('first_hour'),
      lastHour: sql<Date>`max(${heatPumpReading.hourStart})`
        .mapWith(heatPumpReading.hourStart)
        .as('last_hour'),
    })
    .from(heatPumpReading)
    .where(and(gte(heatPumpReading.hourStart, from), lt(heatPumpReading.hourStart, to)))
    .groupBy(heatPumpReading.heatPumpId, sql`m`)
    .as('s')
  return db
    .select({
      heatPumpId: s.heatPumpId,
      name: heatPump.name,
      year: sql<number>`extract(year from ${s.m})::int`,
      month: sql<number>`extract(month from ${s.m})::int`,
      kwh: s.kwh,
      heatKwh: s.heatKwh,
      coolKwh: s.coolKwh,
      insideC: s.insideC,
      outsideC: s.outsideC,
      setpointC: s.setpointC,
      hours: s.hours,
      firstHour: s.firstHour,
      lastHour: s.lastHour,
      lastSeenAt: heatPump.lastSeenAt,
    })
    .from(s)
    .innerJoin(heatPump, eq(heatPump.id, s.heatPumpId))
    .orderBy(heatPump.name, s.heatPumpId, s.m)
}

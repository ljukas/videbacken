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
 * mean. Sums only: an hour never leaves this function (ADR-0027 decision 6). The name is the unit's current one.
 */
export async function monthSums({
  from,
  to,
}: {
  from: Date
  to: Date
}): Promise<HeatPumpMonthRow[]> {
  const local = sql`(${heatPumpReading.hourStart} AT TIME ZONE 'Europe/Stockholm')`
  return db
    .select({
      heatPumpId: heatPumpReading.heatPumpId,
      name: heatPump.name,
      year: sql<number>`extract(year from ${local})::int`,
      month: sql<number>`extract(month from ${local})::int`,
      kwh: sql<number>`sum(${heatPumpReading.energyKwh})`.mapWith(Number),
      heatKwh:
        sql<number>`sum(${heatPumpReading.energyKwh} * coalesce(${heatPumpReading.heatShare}, 0))`.mapWith(
          Number,
        ),
      coolKwh:
        sql<number>`sum(${heatPumpReading.energyKwh} * coalesce(${heatPumpReading.coolShare}, 0))`.mapWith(
          Number,
        ),
      insideC: sql<number | null>`avg(${heatPumpReading.insideC})`.mapWith(Number),
      outsideC: sql<number | null>`avg(${heatPumpReading.outsideC})`.mapWith(Number),
      setpointC: sql<number | null>`avg(${heatPumpReading.setpointC})`.mapWith(Number),
      hours: sql<number>`count(*)::int`,
      firstHour: sql<Date>`min(${heatPumpReading.hourStart})`.mapWith(heatPumpReading.hourStart),
      lastHour: sql<Date>`max(${heatPumpReading.hourStart})`.mapWith(heatPumpReading.hourStart),
      lastSeenAt: sql<Date>`max(${heatPump.lastSeenAt})`.mapWith(heatPump.lastSeenAt),
    })
    .from(heatPumpReading)
    .innerJoin(heatPump, eq(heatPump.id, heatPumpReading.heatPumpId))
    .where(and(gte(heatPumpReading.hourStart, from), lt(heatPumpReading.hourStart, to)))
    .groupBy(sql`1, 2, 3, 4`)
    .orderBy(sql`2, 1, 3, 4`)
}

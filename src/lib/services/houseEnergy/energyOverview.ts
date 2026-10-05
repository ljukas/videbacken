// src/lib/services/houseEnergy/energyOverview.ts
import { count, max, min, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { houseEnergyReading } from '~/lib/db/schema'
import { addPeriodSums, type PeriodSums } from '~/lib/houseEnergy/figures'
import { getOverview as getChargingOverview } from '~/lib/services/evCharging'
import {
  stockholmDayBounds,
  stockholmDayOf,
  stockholmMonthBounds,
  stockholmYearMonth,
} from '~/lib/time/stockholm'

const BUCKET_MS = 5 * 60_000

export type EnergyOverview = {
  /** The chart's year: the requested one when it has readings, else the current Stockholm year. */
  year: number
  /** First reading's year … the current year, newest first; just the current year without readings. */
  availableYears: number[]
  /** Stockholm day of the first reading, or null with none. */
  firstReadingDay: string | null
  /** The current month / current year / all time, whatever year the chart shows (like /charging). */
  tiles: { thisMonth: PeriodSums | null; thisYear: PeriodSums | null; allTime: PeriodSums | null }
  /** Jan → Dec of `year`; null = no reading that month. */
  months: (PeriodSums | null)[]
}

type MonthRow = {
  year: number
  month: number
  sums: Omit<PeriodSums, 'carKwh' | 'expectedBuckets'>
  firstBucket: Date
  lastBucket: Date
}

const r = houseEnergyReading
const local = sql`(${r.bucketStart} AT TIME ZONE 'Europe/Stockholm')`
const num = (v: string | number | null) => (v === null ? 0 : Number(v))
const numOrNull = (v: string | number | null) => (v === null ? null : Number(v))

// Every month with readings, oldest first: one scan of the table (ADR-0024;
// ≈40 ms per year of readings locally). Grouped by Stockholm month, so a DST
// day stays in its own month. Returns sums only, never a bucket.
async function monthRows(): Promise<MonthRow[]> {
  const rows = await db
    .select({
      year: sql<number>`extract(year from ${local})::int`,
      month: sql<number>`extract(month from ${local})::int`,
      gridImportKwh: sql<string>`sum(${r.gridImportKwh})`,
      gridExportKwh: sql<string>`sum(${r.gridExportKwh})`,
      solarKwh: sql<string>`sum(${r.solarKwh})`,
      loadKwh: sql<string>`sum(${r.loadKwh})`,
      batteryDischargeKwh: sql<string>`sum(${r.batteryDischargeKwh})`,
      batteryChargeSolarKwh: sql<string>`sum(${r.batteryChargeSolarKwh})`,
      batteryChargeGridKwh: sql<string>`sum(${r.batteryChargeGridKwh} + ${r.batteryChargeAcKwh})`,
      firstSocPct: sql<
        string | null
      >`(array_agg(${r.batterySocPct} ORDER BY ${r.bucketStart}) FILTER (WHERE ${r.batterySocPct} IS NOT NULL))[1]`,
      lastSocPct: sql<
        string | null
      >`(array_agg(${r.batterySocPct} ORDER BY ${r.bucketStart} DESC) FILTER (WHERE ${r.batterySocPct} IS NOT NULL))[1]`,
      buckets: count(),
      firstBucket: min(r.bucketStart),
      lastBucket: max(r.bucketStart),
    })
    .from(r)
    .groupBy(sql`1, 2`)
    .orderBy(sql`1, 2`)
  return rows.map((row) => ({
    year: row.year,
    month: row.month,
    sums: {
      gridImportKwh: num(row.gridImportKwh),
      gridExportKwh: num(row.gridExportKwh),
      solarKwh: num(row.solarKwh),
      loadKwh: num(row.loadKwh),
      batteryDischargeKwh: num(row.batteryDischargeKwh),
      batteryChargeSolarKwh: num(row.batteryChargeSolarKwh),
      batteryChargeGridKwh: num(row.batteryChargeGridKwh),
      firstSocPct: numOrNull(row.firstSocPct),
      lastSocPct: numOrNull(row.lastSocPct),
      buckets: row.buckets,
    },
    // min/max over a non-empty group are never null.
    firstBucket: row.firstBucket as Date,
    lastBucket: row.lastBucket as Date,
  }))
}

/**
 * The house-energy pages' read model (ADR-0024): monthly sums of the chart's
 * year plus the current month, current year and all time. Expected buckets
 * count from the first reading's day, and the newest reading's month ends at
 * that reading (the sync runs hourly; the last hour isn't a gap). Car kWh is
 * the /charging overview's own figure for every vehicle, so the two pages
 * always agree.
 */
export async function getEnergyOverview(
  input: { year?: number; now?: Date } = {},
): Promise<EnergyOverview> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const rows = await monthRows()
  if (rows.length === 0) {
    return {
      year: current.year,
      availableYears: [current.year],
      firstReadingDay: null,
      tiles: { thisMonth: null, thisYear: null, allTime: null },
      months: Array(12).fill(null),
    }
  }

  const first = rows[0]
  const newest = rows[rows.length - 1]
  const firstReadingDay = stockholmDayOf(first.firstBucket.getTime())
  const coverageStartMs = stockholmDayBounds(firstReadingDay).startMs
  const availableYears: number[] = []
  for (let y = Math.max(current.year, newest.year); y >= first.year; y--) availableYears.push(y)
  const year =
    input.year !== undefined && availableYears.includes(input.year) ? input.year : current.year

  const car = await getChargingOverview({ year, now, vehicle: 'all' })

  const withExpected = (row: MonthRow): PeriodSums => {
    const bounds = stockholmMonthBounds(row.year, row.month)
    const startMs = Math.max(bounds.startMs, coverageStartMs)
    const endMs = row === newest ? row.lastBucket.getTime() + BUCKET_MS : bounds.endMs
    const expected = Math.round((endMs - startMs) / BUCKET_MS)
    return { ...row.sums, carKwh: 0, expectedBuckets: Math.max(expected, row.sums.buckets) }
  }
  const total = (selected: MonthRow[]): PeriodSums | null =>
    selected.length === 0 ? null : selected.map(withExpected).reduce(addPeriodSums)
  const withCar = (sums: PeriodSums | null, carKwh: number) => (sums ? { ...sums, carKwh } : null)

  const months: (PeriodSums | null)[] = Array(12).fill(null)
  for (const row of rows) {
    if (row.year !== year) continue
    months[row.month - 1] = withCar(withExpected(row), car.months[row.month - 1]?.kwh ?? 0)
  }

  return {
    year,
    availableYears,
    firstReadingDay,
    tiles: {
      thisMonth: withCar(
        total(rows.filter((row) => row.year === current.year && row.month === current.month)),
        car.tiles.thisMonth.kwh,
      ),
      thisYear: withCar(
        total(rows.filter((row) => row.year === current.year)),
        car.tiles.thisYear.kwh,
      ),
      allTime: withCar(total(rows), car.tiles.allTime.kwh),
    },
    months,
  }
}

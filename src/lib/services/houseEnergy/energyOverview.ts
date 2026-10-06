// src/lib/services/houseEnergy/energyOverview.ts
import { count, max, min, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { houseEnergyReading } from '~/lib/db/schema'
import { addPeriodSums, type PeriodSums } from '~/lib/houseEnergy/figures'
import { monthKey } from '~/lib/houseEnergy/period'
import { getOverview as getChargingOverview } from '~/lib/services/evCharging'
import {
  stockholmDayBounds,
  stockholmDayOf,
  stockholmMonthBounds,
  stockholmYearBounds,
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
  /** 'YYYY-MM' of every month with readings, every year, oldest first (the picker and the stepper). */
  monthsWithReadings: string[]
  /** The chart year's total (expected buckets from the year's bounds), or null without readings that year. */
  yearTotal: PeriodSums | null
  allTime: PeriodSums | null
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
const num = (v: string | number | null) => (v === null ? 0 : Number(v))
const numOrNull = (v: string | number | null) => (v === null ? null : Number(v))

// Readings summed per UTC hour: a cheap hash aggregate with no per-row time
// zone math. Stockholm's offsets are whole hours, so every hour lies inside
// one Stockholm month.
const hourly = db.$with('hourly').as(
  db
    .select({
      hour: sql<Date>`date_bin('1 hour', ${r.bucketStart}, timestamptz '2000-01-01 00:00:00+00')`.as(
        'hour',
      ),
      gridImportKwh: sql<number>`sum(${r.gridImportKwh})`.as('grid_import_kwh'),
      gridExportKwh: sql<number>`sum(${r.gridExportKwh})`.as('grid_export_kwh'),
      solarKwh: sql<number>`sum(${r.solarKwh})`.as('solar_kwh'),
      loadKwh: sql<number>`sum(${r.loadKwh})`.as('load_kwh'),
      batteryDischargeKwh: sql<number>`sum(${r.batteryDischargeKwh})`.as('battery_discharge_kwh'),
      batteryChargeSolarKwh: sql<number>`sum(${r.batteryChargeSolarKwh})`.as(
        'battery_charge_solar_kwh',
      ),
      batteryChargeGridKwh:
        sql<number>`sum(${r.batteryChargeGridKwh} + ${r.batteryChargeAcKwh})`.as(
          'battery_charge_grid_kwh',
        ),
      buckets: count().as('buckets'),
      firstBucket: min(r.bucketStart).as('first_bucket'),
      lastBucket: max(r.bucketStart).as('last_bucket'),
    })
    .from(r)
    .groupBy(sql`1`),
)
const local = sql`(${hourly.hour} AT TIME ZONE 'Europe/Stockholm')`
const monthly = db.$with('monthly').as(
  db
    .with(hourly)
    .select({
      year: sql<number>`extract(year from ${local})::int`.as('year'),
      month: sql<number>`extract(month from ${local})::int`.as('month'),
      gridImportKwh: sql<number>`sum(${hourly.gridImportKwh})`.as('grid_import_kwh'),
      gridExportKwh: sql<number>`sum(${hourly.gridExportKwh})`.as('grid_export_kwh'),
      solarKwh: sql<number>`sum(${hourly.solarKwh})`.as('solar_kwh'),
      loadKwh: sql<number>`sum(${hourly.loadKwh})`.as('load_kwh'),
      batteryDischargeKwh: sql<number>`sum(${hourly.batteryDischargeKwh})`.as(
        'battery_discharge_kwh',
      ),
      batteryChargeSolarKwh: sql<number>`sum(${hourly.batteryChargeSolarKwh})`.as(
        'battery_charge_solar_kwh',
      ),
      batteryChargeGridKwh: sql<number>`sum(${hourly.batteryChargeGridKwh})`.as(
        'battery_charge_grid_kwh',
      ),
      buckets: sql<number>`sum(${hourly.buckets})::int`.as('buckets'),
      firstBucket: sql<Date>`min(${hourly.firstBucket})`.as('first_bucket'),
      lastBucket: sql<Date>`max(${hourly.lastBucket})`.as('last_bucket'),
    })
    .from(hourly)
    .groupBy(sql`1, 2`),
)
// The month's first or last SoC: one primary-key probe inside the month's own
// readings. Spelled out with qualified names: Drizzle drops table names inside
// a single-table select, which would leave the outer columns to name lookup.
const col = (table: string, name: string) => sql`${sql.identifier(table)}.${sql.identifier(name)}`
const probeSoc = col('p', r.batterySocPct.name)
const probeStart = col('p', r.bucketStart.name)
const edgeSoc = (direction: 'asc' | 'desc') =>
  sql<number | null>`(SELECT ${probeSoc} FROM ${r} ${sql.identifier('p')}
    WHERE ${probeStart} BETWEEN ${col('monthly', 'first_bucket')} AND ${col('monthly', 'last_bucket')}
      AND ${probeSoc} IS NOT NULL
    ORDER BY ${probeStart} ${sql.raw(direction)} LIMIT 1)`

// Every month with readings, oldest first: one scan of the table (ADR-0024),
// summed per UTC hour, then per Stockholm month, so a DST day stays in its own
// month. Summing every row per Stockholm month directly converted each row's
// time zone and sorted the whole table on disk: ≈180 ms on prod, against ≈45.
// Returns sums only, never a bucket.
async function monthRows(): Promise<MonthRow[]> {
  const rows = await db
    .with(monthly)
    .select({
      year: monthly.year,
      month: monthly.month,
      gridImportKwh: monthly.gridImportKwh,
      gridExportKwh: monthly.gridExportKwh,
      solarKwh: monthly.solarKwh,
      loadKwh: monthly.loadKwh,
      batteryDischargeKwh: monthly.batteryDischargeKwh,
      batteryChargeSolarKwh: monthly.batteryChargeSolarKwh,
      batteryChargeGridKwh: monthly.batteryChargeGridKwh,
      firstSocPct: edgeSoc('asc'),
      lastSocPct: edgeSoc('desc'),
      buckets: monthly.buckets,
      firstBucket: monthly.firstBucket,
      lastBucket: monthly.lastBucket,
    })
    .from(monthly)
    .orderBy(monthly.year, monthly.month)
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
    // min/max over a non-empty group are never null; raw SQL comes back as the driver's string.
    firstBucket: new Date(row.firstBucket),
    lastBucket: new Date(row.lastBucket),
  }))
}

/**
 * The house-energy pages' read model (ADR-0024): monthly sums of the chart's
 * year, that year's total, all time, and the list of months with readings. Expected buckets
 * count from the first reading's day, and the newest reading's month ends at
 * that reading (the sync runs hourly; the last hour isn't a gap). Car kWh is
 * the /charging overview's own figure for every vehicle, so the two pages
 * always agree.
 */
export async function getEnergyOverview(
  input: {
    year?: number
    now?: Date
    /** Filled with sub-timings (ms) when passed, for the RPC's `context.timings`. */
    timings?: { houseScanMs?: number; carMs?: number }
  } = {},
): Promise<EnergyOverview> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const scanStartedAt = performance.now()
  const rows = await monthRows()
  if (input.timings) input.timings.houseScanMs = Math.round(performance.now() - scanStartedAt)
  if (rows.length === 0) {
    return {
      year: current.year,
      availableYears: [current.year],
      firstReadingDay: null,
      monthsWithReadings: [],
      yearTotal: null,
      allTime: null,
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

  const carStartedAt = performance.now()
  const car = await getChargingOverview({ year, now, vehicle: 'all' })
  if (input.timings) input.timings.carMs = Math.round(performance.now() - carStartedAt)

  const withExpected = (row: MonthRow): PeriodSums => {
    const bounds = stockholmMonthBounds(row.year, row.month)
    const startMs = Math.max(bounds.startMs, coverageStartMs)
    const endMs = row === newest ? row.lastBucket.getTime() + BUCKET_MS : bounds.endMs
    const expected = Math.round((endMs - startMs) / BUCKET_MS)
    return { ...row.sums, carKwh: 0, expectedBuckets: Math.max(expected, row.sums.buckets) }
  }
  const newestEndMs = newest.lastBucket.getTime() + BUCKET_MS
  // A total's expected buckets come from its period bounds, so a month without
  // readings inside it counts as missing (the chart's per-month rule can't see it).
  const total = (
    selected: MonthRow[],
    period: { startMs: number; endMs: number },
  ): PeriodSums | null => {
    if (selected.length === 0) return null
    const sums = selected.map(withExpected).reduce(addPeriodSums)
    const startMs = Math.max(period.startMs, coverageStartMs)
    const endMs = Math.min(period.endMs, newestEndMs)
    const expected = Math.round((endMs - startMs) / BUCKET_MS)
    return { ...sums, expectedBuckets: Math.max(expected, sums.buckets) }
  }
  // Car kWh is the /charging 'Alla' figure, deliberately not clipped to the house-data window.
  const withCar = (sums: PeriodSums | null, carKwh: number) => (sums ? { ...sums, carKwh } : null)

  const months: (PeriodSums | null)[] = Array(12).fill(null)
  for (const row of rows) {
    if (row.year !== year) continue
    months[row.month - 1] = withCar(withExpected(row), car.months[row.month - 1]?.kwh ?? 0)
  }

  const yearCarKwh = car.months.reduce((sum, mo) => sum + mo.kwh, 0)
  return {
    year,
    availableYears,
    firstReadingDay,
    monthsWithReadings: rows.map((row) => monthKey(row.year, row.month)),
    yearTotal: withCar(
      total(
        rows.filter((row) => row.year === year),
        stockholmYearBounds(year),
      ),
      yearCarKwh,
    ),
    allTime: withCar(
      total(rows, { startMs: coverageStartMs, endMs: newestEndMs }),
      car.tiles.allTime.kwh,
    ),
    months,
  }
}

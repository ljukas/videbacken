// src/lib/services/houseEnergy/energyOverview.ts
import { asc } from 'drizzle-orm'
import { db } from '~/lib/db'
import { houseEnergyMonth } from '~/lib/db/schema'
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

// Every month with readings, oldest first, from the monthly sums view
// (ADR-0024, amended 2026-10-07): the Emaldo sync refreshes it once per run,
// so a request reads one row per month instead of scanning the readings.
// Returns sums only, never a bucket.
async function monthRows(): Promise<MonthRow[]> {
  const rows = await db
    .select()
    .from(houseEnergyMonth)
    .orderBy(asc(houseEnergyMonth.year), asc(houseEnergyMonth.month))
  return rows.map((row) => ({
    year: row.year,
    month: row.month,
    sums: {
      gridImportKwh: row.gridImportKwh,
      gridExportKwh: row.gridExportKwh,
      solarKwh: row.solarKwh,
      loadKwh: row.loadKwh,
      batteryDischargeKwh: row.batteryDischargeKwh,
      batteryChargeSolarKwh: row.batteryChargeSolarKwh,
      batteryChargeGridKwh: row.batteryChargeGridKwh,
      firstSocPct: row.firstSocPct,
      lastSocPct: row.lastSocPct,
      buckets: row.buckets,
    },
    firstBucket: row.firstBucket,
    lastBucket: row.lastBucket,
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

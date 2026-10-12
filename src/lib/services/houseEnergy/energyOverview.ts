// src/lib/services/houseEnergy/energyOverview.ts
import { asc } from 'drizzle-orm'
import { db } from '~/lib/db'
import { houseEnergyMonth } from '~/lib/db/schema'
import {
  addPeriodSums,
  byHeatPumpName,
  type HeatPumpPeriod,
  type PeriodSums,
} from '~/lib/houseEnergy/figures'
import { monthKey } from '~/lib/houseEnergy/period'
import { getOverview as getChargingOverview } from '~/lib/services/evCharging'
import { type HeatPumpMonthRow, monthSums } from '~/lib/services/heatPump'
import { STALE_AFTER_MS } from '~/lib/services/integrationSync/policy'
import {
  stockholmDayBounds,
  stockholmDayOf,
  stockholmMonthBounds,
  stockholmYearBounds,
  stockholmYearMonth,
} from '~/lib/time/stockholm'

const BUCKET_MS = 5 * 60_000
const HOUR_MS = 60 * 60_000

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
  sums: Omit<PeriodSums, 'carKwh' | 'expectedBuckets' | 'heatPumps'>
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

type Span = { startMs: number; endMs: number }

/**
 * A period's heat pumps (ADR-0027) from the unit months: each unit's kWh and hours in the period, and its expected
 * hours clipped like the house buckets (ADR-0024): from the latest of the period's start, the first house reading's
 * day and the unit's first hour, to the earlier of the period's end and the unit's end, in whole hours (a partly
 * covered last hour counts). A unit's end is the newest house bucket's end, but a trailing gap after its newest stored
 * hour counts as missing only from the source's stale threshold (13 h, two missed 6-hourly runs): shorter, it is the
 * sync's normal lag, so the unit ends at its newest stored hour. A unit Comfort Cloud stopped listing (another unit was
 * listed after it last was) ends no later than its newest stored hour or its last listing, whichever is later, so a
 * removed unit isn't missing forever; when the whole source fails every unit's last listing freezes together and the
 * gap counts. Gaps inside the stored hours always count. A unit appears in a period when it has hours or expected hours
 * there, or (unless removed) when its first hour lies before the period's clipped end: in a new month's first hours,
 * before the next run, it shows 0 kWh with nothing missing rather than vanishing. So a period before its first reading,
 * or after a removed unit's end, has no node for it. Name order (`byHeatPumpName`).
 */
function heatPumpPeriods(rows: HeatPumpMonthRow[], coverageStartMs: number, newestEndMs: number) {
  const units = new Map<
    string,
    { id: string; name: string; firstMs: number; lastMs: number; lastSeenMs: number }
  >()
  for (const r of rows) {
    const firstMs = r.firstHour.getTime()
    const lastMs = r.lastHour.getTime()
    const lastSeenMs = r.lastSeenAt.getTime()
    const seen = units.get(r.heatPumpId)
    units.set(r.heatPumpId, {
      id: r.heatPumpId,
      name: r.name,
      firstMs: seen ? Math.min(seen.firstMs, firstMs) : firstMs,
      lastMs: seen ? Math.max(seen.lastMs, lastMs) : lastMs,
      lastSeenMs: seen ? Math.max(seen.lastSeenMs, lastSeenMs) : lastSeenMs,
    })
  }
  const newestSeenMs = Math.max(...[...units.values()].map((u) => u.lastSeenMs))
  const removed = (u: { lastSeenMs: number }) => u.lastSeenMs < newestSeenMs
  const unitEndMs = (u: { lastMs: number; lastSeenMs: number }) => {
    const storedEndMs = u.lastMs + HOUR_MS
    if (newestEndMs - storedEndMs < STALE_AFTER_MS.comfortCloud) {
      return Math.min(newestEndMs, storedEndMs)
    }
    return removed(u) ? Math.min(newestEndMs, Math.max(storedEndMs, u.lastSeenMs)) : newestEndMs
  }
  const ordered = [...units.values()].sort(byHeatPumpName)
  return (period: Span, inPeriod: (r: HeatPumpMonthRow) => boolean): HeatPumpPeriod[] => {
    return ordered.flatMap((u) => {
      const endMs = Math.min(period.endMs, unitEndMs(u))
      let kwh = 0
      let hours = 0
      for (const r of rows) {
        if (r.heatPumpId !== u.id || !inPeriod(r)) continue
        kwh += r.kwh
        hours += r.hours
      }
      const startMs = Math.max(period.startMs, coverageStartMs, u.firstMs)
      const expected = endMs > startMs ? Math.ceil((endMs - startMs) / HOUR_MS) : 0
      const begun = !removed(u) && u.firstMs < Math.min(period.endMs, newestEndMs)
      if (expected === 0 && hours === 0 && !begun) return []
      return [{ id: u.id, name: u.name, kwh, hours, expectedHours: Math.max(expected, hours) }]
    })
  }
}

/**
 * The house-energy pages' read model (ADR-0024): monthly sums of the chart's
 * year, that year's total, all time, and the list of months with readings. Expected buckets
 * count from the first reading's day, and the newest reading's month ends at
 * that reading (the sync runs hourly; the last hour isn't a gap). Car kWh is
 * the /charging overview's own figure for every vehicle, so the two pages
 * always agree; and, per period, each heat pump's kWh with its expected hours
 * (heat pumps step 2).
 */
export async function getEnergyOverview(
  input: {
    year?: number
    now?: Date
    /** Filled with sub-timings (ms) when passed, for the RPC's `context.timings`. */
    timings?: { houseScanMs?: number; carMs?: number; heatPumpMs?: number }
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
  const newestEndMs = newest.lastBucket.getTime() + BUCKET_MS
  const availableYears: number[] = []
  for (let y = Math.max(current.year, newest.year); y >= first.year; y--) availableYears.push(y)
  const year =
    input.year !== undefined && availableYears.includes(input.year) ? input.year : current.year

  const timed = async <T>(key: 'carMs' | 'heatPumpMs', read: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now()
    const result = await read()
    if (input.timings) input.timings[key] = Math.round(performance.now() - startedAt)
    return result
  }
  // Independent reads, in parallel. The heat pumps are read over the house data's range only: outside it there is
  // no load to share (ADR-0027).
  const [car, unitMonths] = await Promise.all([
    timed('carMs', () => getChargingOverview({ year, now, vehicle: 'all' })),
    timed('heatPumpMs', () =>
      monthSums({ from: new Date(coverageStartMs), to: new Date(newestEndMs) }),
    ),
  ])
  const heatPumpsIn = heatPumpPeriods(unitMonths, coverageStartMs, newestEndMs)

  const withExpected = (row: MonthRow): PeriodSums => {
    const bounds = stockholmMonthBounds(row.year, row.month)
    const startMs = Math.max(bounds.startMs, coverageStartMs)
    const endMs = row === newest ? row.lastBucket.getTime() + BUCKET_MS : bounds.endMs
    const expected = Math.round((endMs - startMs) / BUCKET_MS)
    return {
      ...row.sums,
      carKwh: 0,
      expectedBuckets: Math.max(expected, row.sums.buckets),
      heatPumps: heatPumpsIn(bounds, (r) => r.year === row.year && r.month === row.month),
    }
  }
  // A total's expected buckets (and each heat pump's expected hours, replacing the
  // merged months') come from its period bounds, so a month without readings inside
  // it counts as missing (the chart's per-month rule can't see it).
  const total = (
    selected: MonthRow[],
    period: Span,
    inPeriod: (r: HeatPumpMonthRow) => boolean,
  ): PeriodSums | null => {
    if (selected.length === 0) return null
    const sums = selected.map(withExpected).reduce(addPeriodSums)
    const startMs = Math.max(period.startMs, coverageStartMs)
    const endMs = Math.min(period.endMs, newestEndMs)
    const expected = Math.round((endMs - startMs) / BUCKET_MS)
    return {
      ...sums,
      expectedBuckets: Math.max(expected, sums.buckets),
      heatPumps: heatPumpsIn(period, inPeriod),
    }
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
        (r) => r.year === year,
      ),
      yearCarKwh,
    ),
    allTime: withCar(
      total(rows, { startMs: coverageStartMs, endMs: newestEndMs }, () => true),
      car.tiles.allTime.kwh,
    ),
    months,
  }
}

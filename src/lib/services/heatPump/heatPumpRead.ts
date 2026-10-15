// src/lib/services/heatPump/heatPumpRead.ts
// The Värmepumpar page's read model (heat pumps step 3, ADR-0027 decision 6): month and day sums per unit with
// their expected hours. Only sums leave here, never an hour. Expected hours come from the Stockholm calendar
// (23–25 h days), clipped to the unit's first stored hour and to the coverage end: the end of the newest stored hour
// of any unit or `now` floored to the hour, whichever is later, so a unit that stops reporting, or a Comfort Cloud
// that stalls for both, shows missing hours (ADR-0024 clips its buckets the same way). Each unit's end is Översikt's
// (`unitEndRule`, step 2): its hours after its own newest stored hour count as missing only once that gap, measured to
// the coverage end, reaches the source's stale threshold (13 h), a shorter lag being the 6-hourly sync's normal delay;
// and a unit Comfort Cloud no longer lists is missing only up to its last listing. Inner gaps always count.
import { millisecondsInHour } from 'date-fns/constants'
import { byHeatPumpName } from '~/lib/houseEnergy/figures'
import { monthKey } from '~/lib/houseEnergy/period'
import {
  addDays,
  stockholmDayBounds,
  stockholmDayOf,
  stockholmMonthBounds,
  stockholmYearBefore,
  stockholmYearMonth,
} from '~/lib/time/stockholm'
import { daySums, readingSpans } from './daySums'
import { listUnits } from './heatPump'
import { type HeatPumpMonthRow, monthSums } from './monthSums'
import { unitEndRule } from './unitEnd'

export type HeatPumpUnitDto = { id: string; name: string }

export type HeatPumpMonthCell = {
  heatPumpId: string
  year: number
  /** 1–12, Stockholm. */
  month: number
  kwh: number
  heatKwh: number
  coolKwh: number
  outsideC: number | null
  hours: number
  expectedHours: number
  /**
   * The month's calendar hours the comparison must see stored: the whole month, or, for the running month (the newest
   * stored hour's) and `lastYearSoFar`, the hours up to the comparison cut. Never clipped to the unit's first hour or
   * end, so a unit's partial first or last month doesn't pass for complete.
   */
  spanHours: number
}

export type HeatPumpMonths = {
  /** Units with readings, in `byHeatPumpName` order: the chart's stack and colour order. */
  units: HeatPumpUnitDto[]
  /** The year asked for (the current Stockholm year when it has no readings); null: the whole history (Totalt). */
  year: number | null
  /** The first reading's year … the current year, newest first. */
  availableYears: number[]
  firstReadingDay: string | null
  /** 'YYYY-MM' of every month with readings (any unit), oldest first: the period control's months. */
  monthsWithReadings: string[]
  /** 'YYYY-MM' of the coverage end (the newest stored hour or now): the running period the comparison cuts. */
  newestMonth: string | null
  /** A year: each unit's months of it inside the unit's history; Totalt: every month of the history. Oldest first. */
  months: HeatPumpMonthCell[]
  /** A year: the same for the year before (the outline, the comparison); Totalt: []. */
  lastYear: HeatPumpMonthCell[]
  /**
   * The newest month a year earlier, cut at the same Stockholm hour (the running period's comparison); null unless
   * `year` holds the coverage end.
   */
  lastYearSoFar: HeatPumpMonthCell[] | null
}

export type HeatPumpDaysOutput = {
  units: HeatPumpUnitDto[]
  /** Per unit (`byHeatPumpName` order), per Stockholm day (oldest first) inside the unit's coverage; gap days have 0 hours. */
  days: {
    heatPumpId: string
    day: string
    kwh: number
    heatKwh: number
    coolKwh: number
    insideC: number | null
    outsideC: number | null
    setpointC: number | null
    hours: number
    expectedHours: number
  }[]
}

type YearMonth = { year: number; month: number }
/** A unit with readings: its first stored hour and where its expected hours end (`capMs`). */
type Covered = HeatPumpUnitDto & { firstMs: number; capMs: number }

/** Whole hours of `[bounds)` from `firstMs` to `endCapMs`; 0 when they don't overlap. Every bound is a whole UTC hour. */
export function expectedHours(
  bounds: { startMs: number; endMs: number },
  firstMs: number,
  endCapMs: number,
): number {
  const start = Math.max(bounds.startMs, firstMs)
  const end = Math.min(bounds.endMs, endCapMs)
  return end > start ? Math.round((end - start) / millisecondsInHour) : 0
}

// The units with readings (byHeatPumpName order, never SQL's), the coverage end (the newest stored hour's end or
// `now` floored to the hour, whichever is later), and each unit's cap: `unitEndRule`'s end against that coverage end
// (Översikt's rule, over the same units: those with readings).
async function coverage(
  nowMs: number,
): Promise<{ units: Covered[]; endMs: number; newestEndMs: number } | null> {
  const [units, spans] = await Promise.all([listUnits(), readingSpans()])
  if (spans.length === 0) return null
  const newestEndMs = Math.max(...spans.map((s) => s.lastHour.getTime())) + millisecondsInHour
  const endMs = Math.max(newestEndMs, Math.floor(nowMs / millisecondsInHour) * millisecondsInHour)
  const byId = new Map(spans.map((s) => [s.heatPumpId, s]))
  const withReadings = units.flatMap((u) => {
    const s = byId.get(u.id)
    return s
      ? [
          {
            id: u.id,
            name: u.name,
            firstMs: s.firstHour.getTime(),
            lastMs: s.lastHour.getTime(),
            lastSeenMs: u.lastSeenAt.getTime(),
          },
        ]
      : []
  })
  if (withReadings.length === 0) return null
  const rule = unitEndRule(withReadings, endMs)
  const covered = withReadings
    .map((u) => ({ id: u.id, name: u.name, firstMs: u.firstMs, capMs: rule.endMs(u) }))
    .sort(byHeatPumpName)
  return { units: covered, endMs, newestEndMs }
}

const dto = (u: Covered): HeatPumpUnitDto => ({ id: u.id, name: u.name })

function monthsFrom(from: YearMonth, to: YearMonth): YearMonth[] {
  const out: YearMonth[] = []
  let { year, month } = from
  while (year < to.year || (year === to.year && month <= to.month)) {
    out.push({ year, month })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

// The calendar hours of `bounds` up to `endMs`.
const spanHoursOf = (bounds: { startMs: number; endMs: number }, endMs: number) =>
  expectedHours(bounds, Number.NEGATIVE_INFINITY, endMs)

function cellOf(
  unitId: string,
  ym: YearMonth,
  row: HeatPumpMonthRow | undefined,
  expected: number,
  spanHours: number,
): HeatPumpMonthCell {
  return row
    ? {
        heatPumpId: unitId,
        year: ym.year,
        month: ym.month,
        kwh: row.kwh,
        heatKwh: row.heatKwh,
        coolKwh: row.coolKwh,
        outsideC: row.outsideC,
        hours: row.hours,
        expectedHours: Math.max(expected, row.hours),
        spanHours,
      }
    : {
        heatPumpId: unitId,
        year: ym.year,
        month: ym.month,
        kwh: 0,
        heatKwh: 0,
        coolKwh: 0,
        outsideC: null,
        hours: 0,
        expectedHours: expected,
        spanHours,
      }
}

const rowKey = (heatPumpId: string, year: number, month: number) =>
  `${heatPumpId}|${monthKey(year, month)}`

/**
 * Month sums for a year and the year before (`year` given), or for the whole history (`year` omitted: Totalt). One
 * grouped read over the history (`monthSums`, ≈ 17,5k rows a year for two units), plus one month for the running
 * comparison when `year` holds the coverage end.
 */
export async function getHeatPumpMonths(
  input: { year?: number; now?: Date } = {},
): Promise<HeatPumpMonths> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const cov = await coverage(now.getTime())
  if (!cov) {
    return {
      units: [],
      year: input.year === undefined ? null : current.year,
      availableYears: [current.year],
      firstReadingDay: null,
      monthsWithReadings: [],
      newestMonth: null,
      months: [],
      lastYear: [],
      lastYearSoFar: null,
    }
  }
  const firstMs = Math.min(...cov.units.map((u) => u.firstMs))
  const newest = stockholmYearMonth(cov.endMs - 1)
  const rows = await monthSums({ from: new Date(firstMs), to: new Date(cov.endMs) })
  const byKey = new Map(rows.map((r) => [rowKey(r.heatPumpId, r.year, r.month), r]))
  // Each unit's months from its first through the newest: a month without hours inside them is a gap. A month the
  // unit's cap doesn't reach (a new month's first hours, the sync not run yet) has nothing to say: left out.
  // A cell's span runs to the newest stored hour's end (any unit): this year's side of the comparison cut.
  const cells = cov.units
    .flatMap((u) =>
      monthsFrom(stockholmYearMonth(u.firstMs), newest).map((ym) => {
        const bounds = stockholmMonthBounds(ym.year, ym.month)
        return cellOf(
          u.id,
          ym,
          byKey.get(rowKey(u.id, ym.year, ym.month)),
          expectedHours(bounds, u.firstMs, u.capMs),
          spanHoursOf(bounds, cov.newestEndMs),
        )
      }),
    )
    .filter((c) => c.expectedHours > 0 || c.hours > 0)
  const first = stockholmYearMonth(firstMs)
  const availableYears: number[] = []
  for (let y = Math.max(current.year, newest.year); y >= first.year; y--) availableYears.push(y)
  const year =
    input.year === undefined
      ? null
      : availableYears.includes(input.year)
        ? input.year
        : current.year

  let lastYearSoFar: HeatPumpMonthCell[] | null = null
  if (year === newest.year) {
    const cutMs = stockholmYearBefore(cov.endMs)
    const ym = { year: newest.year - 1, month: newest.month }
    const bounds = stockholmMonthBounds(ym.year, ym.month)
    const soFar = await monthSums({ from: new Date(bounds.startMs), to: new Date(cutMs) })
    lastYearSoFar = cov.units.flatMap((u) => {
      const expected = expectedHours(bounds, u.firstMs, cutMs)
      const row = soFar.find(
        (r) => r.heatPumpId === u.id && r.year === ym.year && r.month === ym.month,
      )
      return expected === 0 && !row
        ? []
        : [cellOf(u.id, ym, row, expected, spanHoursOf(bounds, cutMs))]
    })
  }

  return {
    units: cov.units.map(dto),
    year,
    availableYears,
    firstReadingDay: stockholmDayOf(firstMs),
    monthsWithReadings: [
      ...new Set(rows.filter((r) => r.hours > 0).map((r) => monthKey(r.year, r.month))),
    ].sort(),
    newestMonth: monthKey(newest.year, newest.month),
    months: year === null ? cells : cells.filter((c) => c.year === year),
    lastYear: year === null ? [] : cells.filter((c) => c.year === year - 1),
    lastYearSoFar,
  }
}

/**
 * Day sums for `[from, to]` (Stockholm days, inclusive; the procedure caps the range at 800 days), never past today.
 * Each unit gets every day inside its coverage, a gap day with 0 hours.
 */
export async function getHeatPumpDays(input: {
  from: string
  to: string
  now?: Date
}): Promise<HeatPumpDaysOutput> {
  const nowMs = (input.now ?? new Date()).getTime()
  const today = stockholmDayOf(nowMs)
  const to = input.to < today ? input.to : today
  const cov = await coverage(nowMs)
  if (!cov) return { units: [], days: [] }
  if (to < input.from) return { units: cov.units.map(dto), days: [] }
  const rows = await daySums({ from: input.from, to })
  const byKey = new Map(rows.map((r) => [`${r.heatPumpId}|${r.day}`, r]))
  const days: HeatPumpDaysOutput['days'] = []
  for (const u of cov.units) {
    for (let day = input.from; day <= to; day = addDays(day, 1)) {
      const expected = expectedHours(stockholmDayBounds(day), u.firstMs, u.capMs)
      const row = byKey.get(`${u.id}|${day}`)
      if (row) days.push({ ...row, expectedHours: Math.max(expected, row.hours) })
      else if (expected > 0)
        days.push({
          heatPumpId: u.id,
          day,
          kwh: 0,
          heatKwh: 0,
          coolKwh: 0,
          insideC: null,
          outsideC: null,
          setpointC: null,
          hours: 0,
          expectedHours: expected,
        })
    }
  }
  return { units: cov.units.map(dto), days }
}

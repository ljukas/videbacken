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
  /**
   * 'YYYY-MM' of the newest stored hour (any unit): the running period, which the comparison cuts where this year's
   * data ends. Cells can run past it to the coverage end (a stall), never complete.
   */
  newestMonth: string | null
  /** A year: each unit's months of it inside the unit's history; Totalt: every month of the history. Oldest first. */
  months: HeatPumpMonthCell[]
  /** A year: the same for the year before (the outline, the comparison); Totalt: []. */
  lastYear: HeatPumpMonthCell[]
  /**
   * The newest month a year earlier, cut at the same Stockholm hour as the newest stored hour's end (the running
   * period's comparison); null unless `year` holds the newest stored hour.
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
type Covered = HeatPumpUnitDto & { firstMs: number; capMs: number; removed: boolean }

/**
 * Hours of `[bounds)` from `firstMs` to `endCapMs`, a partly covered last hour counted whole (Översikt's rule,
 * `energyOverview`); 0 when they don't overlap. Every bound is a whole UTC hour except a removed unit's end, its last
 * listing (the sync's run time, hh:20).
 */
export function expectedHours(
  bounds: { startMs: number; endMs: number },
  firstMs: number,
  endCapMs: number,
): number {
  const start = Math.max(bounds.startMs, firstMs)
  const end = Math.min(bounds.endMs, endCapMs)
  return end > start ? Math.ceil((end - start) / millisecondsInHour) : 0
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
    .map((u) => ({
      id: u.id,
      name: u.name,
      firstMs: u.firstMs,
      capMs: rule.endMs(u),
      removed: rule.removed(u),
    }))
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

/** Sub-timings (ms) for the RPC's `context.timings`, filled when passed. */
export type HeatPumpReadTimings = {
  heatPumpCoverageMs?: number
  heatPumpMonthSumsMs?: number
  heatPumpSoFarMs?: number
  heatPumpDaySumsMs?: number
}

/** `read`, its duration recorded as `timings[key]` when `timings` is passed. */
async function timed<T>(
  timings: HeatPumpReadTimings | undefined,
  key: keyof HeatPumpReadTimings,
  read: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now()
  const out = await read()
  if (timings) timings[key] = Math.round(performance.now() - startedAt)
  return out
}

const rowKey = (heatPumpId: string, year: number, month: number) =>
  `${heatPumpId}|${monthKey(year, month)}`

/**
 * Month sums for a year and the year before (`year` given), or for the whole history (`year` omitted: Totalt). One
 * grouped read over the history (`monthSums`, ≈ 17,5k rows a year for two units), plus, beside it, one month for the
 * running comparison when `year` holds the newest stored hour.
 */
export async function getHeatPumpMonths(
  input: { year?: number; now?: Date; timings?: HeatPumpReadTimings } = {},
): Promise<HeatPumpMonths> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const cov = await timed(input.timings, 'heatPumpCoverageMs', () => coverage(now.getTime()))
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
  const first = stockholmYearMonth(firstMs)
  const availableYears: number[] = []
  for (let y = Math.max(current.year, newest.year); y >= first.year; y--) availableYears.push(y)
  const year =
    input.year === undefined
      ? null
      : availableYears.includes(input.year)
        ? input.year
        : current.year
  // The running month is the newest stored hour's: this year's data ends there (0–6 h before now with the 6-hourly
  // sync). Each unit's comparison runs to its own end in it (`spanEndMs`: the newest stored end, or a unit lagging
  // under 13 h's own end), and last year to that same Stockholm hour, so both sides span the same hours per unit. A
  // removed unit isn't clipped: its span runs to the newest stored end, so its partial month shows no change (F1).
  const running = stockholmYearMonth(cov.newestEndMs - 1)
  const runningBounds = stockholmMonthBounds(running.year, running.month)
  const spanEndMs = (u: Covered) =>
    u.removed ? cov.newestEndMs : Math.min(cov.newestEndMs, u.capMs)
  const cutOf = (u: Covered) => stockholmYearBefore(spanEndMs(u))
  const soFarYm = { year: running.year - 1, month: running.month }
  const soFarBounds = stockholmMonthBounds(soFarYm.year, soFarYm.month)
  // One read per distinct cut (units syncing together share one), none for a cut before the month starts.
  const cuts = [...new Set(cov.units.map(cutOf))].filter((c) => c > soFarBounds.startMs)
  // Independent reads, side by side: the history and (a running year only) last year's running month.
  const [rows, soFarByCut] = await Promise.all([
    timed(input.timings, 'heatPumpMonthSumsMs', () =>
      monthSums({ from: new Date(firstMs), to: new Date(cov.endMs) }),
    ),
    year === running.year
      ? timed(input.timings, 'heatPumpSoFarMs', async () => {
          const reads = await Promise.all(
            cuts.map((c) => monthSums({ from: new Date(soFarBounds.startMs), to: new Date(c) })),
          )
          return new Map(cuts.map((c, i) => [c, reads[i]]))
        })
      : null,
  ])
  const byKey = new Map(rows.map((r) => [rowKey(r.heatPumpId, r.year, r.month), r]))
  // Each unit's months from its first through the newest: a month without hours inside them is a gap. A month the
  // unit's cap doesn't reach (a new month's first hours, the sync not run yet) has nothing to say: left out.
  // A cell's span is its whole month, the running month's up to the unit's `spanEndMs` (this year's side of the
  // comparison); a month past the running one (a stall) up to the newest stored end: none.
  const cells = cov.units
    .flatMap((u) =>
      monthsFrom(stockholmYearMonth(u.firstMs), newest).map((ym) => {
        const bounds = stockholmMonthBounds(ym.year, ym.month)
        const spanEnd = bounds.startMs === runningBounds.startMs ? spanEndMs(u) : cov.newestEndMs
        return cellOf(
          u.id,
          ym,
          byKey.get(rowKey(u.id, ym.year, ym.month)),
          expectedHours(bounds, u.firstMs, u.capMs),
          spanHoursOf(bounds, spanEnd),
        )
      }),
    )
    .filter((c) => c.expectedHours > 0 || c.hours > 0)
  const lastYearSoFar =
    soFarByCut === null
      ? null
      : cov.units.flatMap((u) => {
          const cutMs = cutOf(u)
          const expected = expectedHours(soFarBounds, u.firstMs, cutMs)
          const row = soFarByCut
            .get(cutMs)
            ?.find(
              (r) => r.heatPumpId === u.id && r.year === soFarYm.year && r.month === soFarYm.month,
            )
          return expected === 0 && !row
            ? []
            : [cellOf(u.id, soFarYm, row, expected, spanHoursOf(soFarBounds, cutMs))]
        })

  return {
    units: cov.units.map(dto),
    year,
    availableYears,
    firstReadingDay: stockholmDayOf(firstMs),
    monthsWithReadings: [
      ...new Set(rows.filter((r) => r.hours > 0).map((r) => monthKey(r.year, r.month))),
    ].sort(),
    newestMonth: monthKey(running.year, running.month),
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
  timings?: HeatPumpReadTimings
}): Promise<HeatPumpDaysOutput> {
  const nowMs = (input.now ?? new Date()).getTime()
  const today = stockholmDayOf(nowMs)
  const to = input.to < today ? input.to : today
  // The sums don't depend on the coverage: read side by side.
  const [cov, rows] = await Promise.all([
    timed(input.timings, 'heatPumpCoverageMs', () => coverage(nowMs)),
    to < input.from
      ? []
      : timed(input.timings, 'heatPumpDaySumsMs', () => daySums({ from: input.from, to })),
  ])
  if (!cov) return { units: [], days: [] }
  if (to < input.from) return { units: cov.units.map(dto), days: [] }
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

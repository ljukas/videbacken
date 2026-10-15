// src/components/heatPump/heatPumpView.ts
// Client-safe, pure (heat pumps step 3, ADR-0027): what the Förbrukning card shows for a period: the chart's rows (a
// year's 12 months, every month of the history for Totalt, or a month's days) and the tiles, from the
// `heatPump.months` and `heatPump.days` reads. Types only from the service.
import { formatDay, monthLabel, monthName } from '~/components/evCharging/format'
import { monthDays } from '~/lib/heatPump/period'
import { byHeatPumpName, COVERAGE_COMPLETE } from '~/lib/houseEnergy/figures'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { type EnergyPeriod, monthKey } from '~/lib/houseEnergy/period'
import type {
  HeatPumpDaysOutput,
  HeatPumpMonthCell,
  HeatPumpMonths,
  HeatPumpUnitDto,
} from '~/lib/services/heatPump'
import { m } from '~/paraglide/messages'

type YearMonth = { year: number; month: number }
/** What a month cell and a day row share: enough to sum, weigh and count. */
type Sums = {
  heatPumpId: string
  kwh: number
  outsideC: number | null
  hours: number
  expectedHours: number
}

export const LAST_YEAR_KEY = 'lastYear'
export const OUTDOOR_KEY = 'outdoor'

export type HeatPumpChartRow = {
  key: string
  /** The x label; `short` when the full ones don't fit (year view). */
  label: string
  short: string
  /** The tooltip's title. */
  title: string
  /** The month a click selects (year view, Totalt); null for a day. */
  month: YearMonth | null
  selectable: boolean
  /** Per unit id; null: no hours that month or day. */
  kwh: Record<string, number | null>
  total: number | null
  /** The same month a year earlier, all units (year view only). */
  lastYear: number | null
  outdoorC: number | null
  /** The worst unit's expected − stored hours. */
  missingHours: number
  /** The current month or day ("hittills"). */
  running: boolean
}

export type HeatPumpTile = {
  id: string
  name: string
  /** Step 2's `heatPumpColor(units, id)`. */
  color: string
  kwh: number | null
  /** (this − before) ÷ before; null unless both periods are ≥ 99 % complete over the same months (`complete`). */
  change: number | null
}

export type HeatPumpTiles = {
  units: HeatPumpTile[]
  outdoorC: number | null
  /** Hours to name in "Data saknas för N h" (the worst unit's, rounded), or null below 1. */
  missingHours: number | null
  /** The compared period's name ("2025", "sep 2025"); null for Totalt. */
  comparedWith: string | null
  running: boolean
}

export type HeatPumpView = {
  kind: EnergyPeriod['kind']
  year: number | null
  units: HeatPumpUnitDto[]
  rows: HeatPumpChartRow[]
  tiles: HeatPumpTiles
  /** The chart's accessible name. */
  chartLabel: string
  /** The period's name in "Ingen värmepumpsdata för …". */
  periodLabel: string
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
const ofUnit = <T extends Sums>(cells: readonly T[], id: string) =>
  cells.filter((c) => c.heatPumpId === id)
const at = (cells: readonly HeatPumpMonthCell[], ym: YearMonth) =>
  cells.filter((c) => c.year === ym.year && c.month === ym.month)
const missing = (cells: readonly Sums[]) =>
  Math.max(0, sum(cells.map((c) => c.expectedHours)) - sum(cells.map((c) => c.hours)))
const covered = (cells: readonly Sums[]) => {
  const expected = sum(cells.map((c) => c.expectedHours))
  return expected > 0 && sum(cells.map((c) => c.hours)) / expected >= COVERAGE_COMPLETE
}
/**
 * A unit's cells answer for the whole of `months` (a period, or its comparison): a cell for each month, and stored
 * hours ≥ 99 % both of the months' calendar hours (`spanHours`: a partial first or last month of the unit fails) and of
 * the unit's expected hours (a stall fails).
 */
const complete = (cells: readonly HeatPumpMonthCell[], months: readonly YearMonth[]) => {
  const span = sum(cells.map((c) => c.spanHours))
  return (
    months.every((ym) => at(cells, ym).length > 0) &&
    span > 0 &&
    sum(cells.map((c) => c.hours)) / span >= COVERAGE_COMPLETE &&
    covered(cells)
  )
}
const monthsOf = (year: number, through: number): YearMonth[] =>
  Array.from({ length: through }, (_, i) => ({ year, month: i + 1 }))
/** The cells' kWh, or null when none has an hour. */
const kwhOf = (cells: readonly Sums[]) =>
  cells.some((c) => c.hours > 0) ? sum(cells.map((c) => c.kwh)) : null
const worstMissing = (units: readonly HeatPumpUnitDto[], cells: readonly Sums[]) =>
  Math.max(0, ...units.map((u) => missing(ofUnit(cells, u.id))))

/**
 * The hour-weighted mean outdoor temperature over the cells with a value and hours; null without. Across units each
 * unit's mean is weighted by its hour count: an approximation when a unit has hours without an outdoor value (the
 * reads carry no count of those), exact otherwise.
 */
export function meanOutdoor(cells: readonly Pick<Sums, 'outsideC' | 'hours'>[]): number | null {
  let weighted = 0
  let hours = 0
  for (const c of cells) {
    if (c.outsideC === null || c.hours <= 0) continue
    weighted += c.outsideC * c.hours
    hours += c.hours
  }
  return hours > 0 ? weighted / hours : null
}

type RowBase = Omit<HeatPumpChartRow, 'kwh' | 'total' | 'outdoorC' | 'missingHours'>

function rowOf(
  base: RowBase,
  units: readonly HeatPumpUnitDto[],
  cells: readonly Sums[],
): HeatPumpChartRow {
  const kwh: Record<string, number | null> = {}
  for (const u of units) kwh[u.id] = kwhOf(ofUnit(cells, u.id))
  const values = Object.values(kwh).filter((v): v is number => v !== null)
  return {
    ...base,
    kwh,
    total: values.length > 0 ? sum(values) : null,
    outdoorC: meanOutdoor(cells),
    missingHours: worstMissing(units, cells),
  }
}

const monthTitle = (ym: YearMonth) =>
  m.energy_period_month({ month: monthName(ym.month), year: String(ym.year) })
const monthShort = (ym: YearMonth) =>
  m.energy_period_month({ month: monthLabel(ym.month), year: String(ym.year) })

function yearRows(data: HeatPumpMonths, year: number, now: YearMonth): HeatPumpChartRow[] {
  return Array.from({ length: 12 }, (_, i) => {
    const ym = { year, month: i + 1 }
    const key = monthKey(year, ym.month)
    return rowOf(
      {
        key,
        label: monthLabel(ym.month),
        short: monthLabel(ym.month).charAt(0).toUpperCase(),
        title: monthTitle(ym),
        month: ym,
        selectable: data.monthsWithReadings.includes(key),
        lastYear: kwhOf(at(data.lastYear, { year: year - 1, month: ym.month })),
        running: year === now.year && ym.month === now.month,
      },
      data.units,
      at(data.months, ym),
    )
  })
}

function allRows(data: HeatPumpMonths, now: YearMonth): HeatPumpChartRow[] {
  if (data.months.length === 0) return []
  const index = data.months.map((c) => c.year * 12 + c.month - 1)
  const first = Math.min(...index)
  const last = Math.max(...index)
  return Array.from({ length: last - first + 1 }, (_, i) => {
    const ym = { year: Math.floor((first + i) / 12), month: ((first + i) % 12) + 1 }
    const key = monthKey(ym.year, ym.month)
    return rowOf(
      {
        key,
        label: monthShort(ym),
        short: monthShort(ym),
        title: monthTitle(ym),
        month: ym,
        selectable: data.monthsWithReadings.includes(key),
        lastYear: null,
        running: ym.year === now.year && ym.month === now.month,
      },
      data.units,
      at(data.months, ym),
    )
  })
}

function dayRows(
  days: HeatPumpDaysOutput,
  units: readonly HeatPumpUnitDto[],
  ym: YearMonth,
  today: string,
): HeatPumpChartRow[] {
  const { from, to } = monthDays(ym.year, ym.month)
  return Array.from({ length: Number(to.slice(8)) }, (_, i) => {
    const day = `${from.slice(0, 8)}${String(i + 1).padStart(2, '0')}`
    return rowOf(
      {
        key: day,
        label: String(i + 1),
        short: String(i + 1),
        title: formatDay(day),
        month: null,
        selectable: false,
        lastYear: null,
        running: day === today,
      },
      units,
      days.days.filter((d) => d.day === day),
    )
  })
}

// The period's cells and what each unit is compared with. A running period (it holds the newest stored hour)
// compares with the same span a year earlier: last year's months before the newest month plus `lastYearSoFar`. A
// change needs both sides complete over the same months (`complete`): Jan … the newest month of a running year, all 12
// of a past one, or the one month.
function tilesOf(data: HeatPumpMonths, period: EnergyPeriod, now: YearMonth): HeatPumpTiles {
  const newest = data.newestMonth
  let cells: HeatPumpMonthCell[]
  let before: HeatPumpMonthCell[] | null
  let comparedMonths: { mine: YearMonth[]; theirs: YearMonth[] } | null
  let comparedWith: string | null
  let running: boolean
  if (period.kind === 'all') {
    cells = data.months
    before = null
    comparedMonths = null
    comparedWith = null
    running = false
  } else if (period.kind === 'year') {
    cells = data.months.filter((c) => c.year === period.year)
    const soFar = newest?.startsWith(`${period.year}-`) ? data.lastYearSoFar : null
    const through = soFar && newest ? Number(newest.slice(5, 7)) : 12
    before = soFar ? [...data.lastYear.filter((c) => c.month < through), ...soFar] : data.lastYear
    comparedMonths = {
      mine: monthsOf(period.year, through),
      theirs: monthsOf(period.year - 1, through),
    }
    comparedWith = String(period.year - 1)
    running = period.year === now.year
  } else {
    cells = at(data.months, period)
    const soFar = newest === monthKey(period.year, period.month) ? data.lastYearSoFar : null
    const lastYear = { year: period.year - 1, month: period.month }
    before = soFar ?? at(data.lastYear, lastYear)
    comparedMonths = { mine: [period], theirs: [lastYear] }
    comparedWith = m.energy_period_month({
      month: monthLabel(period.month),
      year: String(period.year - 1),
    })
    running = period.year === now.year && period.month === now.month
  }
  const units = data.units.map((u) => {
    const mine = ofUnit(cells, u.id)
    const theirs = before ? ofUnit(before, u.id) : []
    const kwh = kwhOf(mine)
    const base = kwhOf(theirs)
    const change =
      kwh !== null &&
      base !== null &&
      base > 0 &&
      comparedMonths !== null &&
      complete(mine, comparedMonths.mine) &&
      complete(theirs, comparedMonths.theirs)
        ? (kwh - base) / base
        : null
    return { id: u.id, name: u.name, color: heatPumpColor(data.units, u.id), kwh, change }
  })
  const gap = Math.round(worstMissing(data.units, cells))
  return {
    units,
    outdoorC: meanOutdoor(cells),
    missingHours: gap >= 1 ? gap : null,
    comparedWith,
    running,
  }
}

/** The card's view of `period`, or null when the reads don't answer it (another year's placeholder, days not in). */
export function heatPumpView({
  months,
  days,
  period,
  now,
  today,
}: {
  months: HeatPumpMonths
  days: HeatPumpDaysOutput | null
  period: EnergyPeriod
  now: YearMonth
  today: string
}): HeatPumpView | null {
  // Step 2's order everywhere (Swedish collation, then id), whatever order the read sent.
  const data: HeatPumpMonths = { ...months, units: [...months.units].sort(byHeatPumpName) }
  if (period.kind === 'all') {
    if (data.year !== null) return null
    return {
      kind: 'all',
      year: null,
      units: data.units,
      rows: allRows(data, now),
      tiles: tilesOf(data, period, now),
      chartLabel: m.heat_pump_chart_title_all({
        since: data.firstReadingDay ? formatDay(data.firstReadingDay) : '',
      }),
      periodLabel: m.charging_tile_all_time(),
    }
  }
  if (data.year !== period.year) return null
  if (period.kind === 'year') {
    return {
      kind: 'year',
      year: period.year,
      units: data.units,
      rows: yearRows(data, period.year, now),
      tiles: tilesOf(data, period, now),
      chartLabel: m.heat_pump_chart_title_year({ year: String(period.year) }),
      periodLabel: String(period.year),
    }
  }
  if (!days) return null
  const label = monthTitle(period)
  return {
    kind: 'month',
    year: period.year,
    units: data.units,
    rows: dayRows(days, data.units, period, today),
    tiles: tilesOf(data, period, now),
    chartLabel: m.heat_pump_chart_title_month({ period: label }),
    periodLabel: label,
  }
}

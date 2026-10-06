// Client-safe (ADR-0024, step 1b): the Energi pages' period — a month, a year
// or all time — as it lives in the URL (`?period=2026-08 | 2026 | all`), its
// default, and stepping. `monthsWithReadings` ('YYYY-MM', oldest first) comes
// from the overview; nothing here touches the clock or the server.
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'

export type EnergyPeriod =
  | { kind: 'month'; year: number; month: number }
  | { kind: 'year'; year: number }
  | { kind: 'all' }

type YearMonth = { year: number; month: number }

const inRange = (year: number) => year >= OVERVIEW_MIN_YEAR && year <= OVERVIEW_MAX_YEAR

export const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`

export function parsePeriod(value: string | undefined): EnergyPeriod | null {
  if (!value) return null
  if (value === 'all') return { kind: 'all' }
  const month = /^(\d{4})-(\d{2})$/.exec(value)
  if (month) {
    const year = Number(month[1])
    const m = Number(month[2])
    return inRange(year) && m >= 1 && m <= 12 ? { kind: 'month', year, month: m } : null
  }
  if (/^\d{4}$/.test(value)) {
    const year = Number(value)
    return inRange(year) ? { kind: 'year', year } : null
  }
  return null
}

export function formatPeriod(p: EnergyPeriod): string {
  if (p.kind === 'all') return 'all'
  return p.kind === 'year' ? String(p.year) : monthKey(p.year, p.month)
}

/** `?period=` wins; the step-1 `?year=Y` still reads as the year Y. */
export function periodFromSearch(search: { period?: string; year?: number }): EnergyPeriod | null {
  return (
    parsePeriod(search.period) ??
    (search.year === undefined ? null : parsePeriod(String(search.year)))
  )
}

/** The overview year to request; undefined lets the service pick the current year (Totalt, the default). */
export function periodQueryYear(p: EnergyPeriod | null): number | undefined {
  return p && p.kind !== 'all' ? p.year : undefined
}

/**
 * The current month; in a new month's first hour (no reading yet) the newest
 * month with readings this year; with none this year yet, Totalt.
 */
export function defaultPeriod(monthsWithReadings: string[], now: YearMonth): EnergyPeriod {
  if (monthsWithReadings.includes(monthKey(now.year, now.month))) {
    return { kind: 'month', year: now.year, month: now.month }
  }
  const thisYear = monthsWithReadings.filter((k) => k.startsWith(`${now.year}-`))
  const newest = thisYear[thisYear.length - 1]
  return newest ? (parsePeriod(newest) as EnergyPeriod) : { kind: 'all' }
}

const yearsOf = (monthsWithReadings: string[]) => [
  ...new Set(monthsWithReadings.map((k) => Number(k.slice(0, 4)))),
]

/** The period to show: the requested one when it has readings, else the default. */
export function resolvePeriod(
  p: EnergyPeriod | null,
  monthsWithReadings: string[],
  now: YearMonth,
): EnergyPeriod {
  if (p?.kind === 'all') return p
  if (p?.kind === 'month' && monthsWithReadings.includes(monthKey(p.year, p.month))) return p
  if (p?.kind === 'year' && yearsOf(monthsWithReadings).includes(p.year)) return p
  return defaultPeriod(monthsWithReadings, now)
}

/** The next / previous month (or year) with readings; null at the ends and for Totalt. */
export function stepPeriod(
  p: EnergyPeriod,
  delta: 1 | -1,
  monthsWithReadings: string[],
): EnergyPeriod | null {
  if (p.kind === 'all') return null
  if (p.kind === 'year') {
    const years = yearsOf(monthsWithReadings).sort((a, b) => a - b)
    const next = years[years.indexOf(p.year) + delta]
    return next === undefined || !years.includes(p.year) ? null : { kind: 'year', year: next }
  }
  const sorted = [...monthsWithReadings].sort()
  const i = sorted.indexOf(monthKey(p.year, p.month))
  const next = i === -1 ? undefined : sorted[i + delta]
  return next ? parsePeriod(next) : null
}

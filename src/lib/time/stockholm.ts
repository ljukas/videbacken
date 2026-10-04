// Client-safe calendar helpers for Europe/Stockholm, the one time zone every
// charging/price bucket is defined in — and, outside SQL (`AT TIME ZONE
// 'Europe/Stockholm'` in the overview and spot-price queries), the one module
// that names it. A
// "day" is a 'YYYY-MM-DD' string naming a local calendar day; instants are
// epoch ms. DST-aware via @date-fns/tz — a Stockholm day is 23, 24 or 25 hours
// long.
import { TZDate, tz } from '@date-fns/tz'
import {
  addDays as addCalendarDays,
  differenceInCalendarDays,
  formatISO,
  startOfMonth,
} from 'date-fns'

/** The IANA zone, for formatters that take one (Intl `timeZone`). */
export const STOCKHOLM_TIME_ZONE = 'Europe/Stockholm'
const inStockholm = tz(STOCKHOLM_TIME_ZONE)
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Local midnight of Stockholm `day`, or null unless `day` is a real
 * 'YYYY-MM-DD' day in 1970–2999. An impossible date (2025-02-30) is rejected
 * rather than rolled over into the next month; the year range keeps clear of
 * Date's 0–99 → 1900s mapping and of dates Postgres can't store sensibly.
 * Swedish DST switches at 02:00/03:00, so midnight always exists.
 */
function parseDay(day: string): TZDate | null {
  const match = DAY_RE.exec(day)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (y < 1970 || y > 2999) return null
  const midnight = TZDate.tz(STOCKHOLM_TIME_ZONE, y, m - 1, d)
  return midnight.getMonth() === m - 1 && midnight.getDate() === d ? midnight : null
}

function midnightOf(day: string): TZDate {
  const midnight = parseDay(day)
  if (!midnight) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  return midnight
}

// The Stockholm 'YYYY-MM-DD' of an instant. formatISO rather than format():
// the same string, without pulling date-fns' locale-aware formatter into the
// client bundle.
function toDay(date: Date | number): string {
  return formatISO(date, { representation: 'date', in: inStockholm })
}

/** Whether `day` is a real 'YYYY-MM-DD' day in 1970–2999 (the days the helpers accept). */
export function isStockholmDay(day: string): boolean {
  return parseDay(day) !== null
}

/** The Stockholm calendar day the instant falls in. */
export function stockholmDayOf(ms: number): string {
  return toDay(ms)
}

/** The first day of the Stockholm calendar month the instant falls in. */
export function stockholmFirstOfMonth(ms: number): string {
  return toDay(startOfMonth(ms, { in: inStockholm }))
}

/** The Stockholm calendar year/month (1-based) the instant falls in. */
export function stockholmYearMonth(ms: number): { year: number; month: number } {
  const local = inStockholm(ms)
  return { year: local.getFullYear(), month: local.getMonth() + 1 }
}

/** `day` shifted by `n` calendar days (calendar arithmetic; DST never shifts it). */
export function addDays(day: string, n: number): string {
  return toDay(addCalendarDays(midnightOf(day), n))
}

/** Calendar days from `from` to `to` (negative when `to` is earlier); DST never shifts it. */
export function daysBetween(from: string, to: string): number {
  return differenceInCalendarDays(midnightOf(to), midnightOf(from), { in: inStockholm })
}

/** `[startMs, endMs)` of a Stockholm calendar day — 23, 24 or 25 h long. */
export function stockholmDayBounds(day: string): { startMs: number; endMs: number } {
  return { startMs: midnightOf(day).getTime(), endMs: midnightOf(addDays(day, 1)).getTime() }
}

/**
 * `[startMs, endMs)` of a Stockholm calendar year: local midnight 1 January to
 * the next. (1 January is always CET, so this is 23:00 UTC on 31 December.)
 */
export function stockholmYearBounds(year: number): { startMs: number; endMs: number } {
  return {
    startMs: TZDate.tz(STOCKHOLM_TIME_ZONE, year, 0, 1).getTime(),
    endMs: TZDate.tz(STOCKHOLM_TIME_ZONE, year + 1, 0, 1).getTime(),
  }
}

/** `[startMs, endMs)` of Stockholm calendar month `month` (1–12) of `year`. */
export function stockholmMonthBounds(
  year: number,
  month: number,
): { startMs: number; endMs: number } {
  return {
    startMs: TZDate.tz(STOCKHOLM_TIME_ZONE, year, month - 1, 1).getTime(),
    endMs: TZDate.tz(STOCKHOLM_TIME_ZONE, year, month, 1).getTime(),
  }
}

/**
 * The two night stretches of Stockholm `day`, as true instants: 00:00–06:00
 * and 22:00–24:00 (the next midnight). On a DST day the early one is 5 or 7 h
 * long. The session timeline's night band.
 */
export function stockholmNightsOfDay(day: string): { startMs: number; endMs: number }[] {
  const midnight = midnightOf(day)
  const at = (hour: number) =>
    TZDate.tz(
      STOCKHOLM_TIME_ZONE,
      midnight.getFullYear(),
      midnight.getMonth(),
      midnight.getDate(),
      hour,
    ).getTime()
  const { startMs, endMs } = stockholmDayBounds(day)
  return [
    { startMs, endMs: at(6) },
    { startMs: at(22), endMs },
  ]
}

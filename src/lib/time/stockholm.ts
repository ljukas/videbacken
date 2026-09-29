// Client-safe calendar helpers for Europe/Stockholm, the one time zone every
// charging/price bucket is defined in — and the one module that names it. A
// "day" is a 'YYYY-MM-DD' string naming a local calendar day; instants are
// epoch ms. DST-aware via @date-fns/tz — a Stockholm day is 23, 24 or 25 hours
// long.
import { TZDate, tz } from '@date-fns/tz'
import { addDays as addCalendarDays, format } from 'date-fns'

const TIME_ZONE = 'Europe/Stockholm'
const inStockholm = tz(TIME_ZONE)
const DAY_FORMAT = 'yyyy-MM-dd'
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
  const midnight = TZDate.tz(TIME_ZONE, y, m - 1, d)
  return midnight.getMonth() === m - 1 && midnight.getDate() === d ? midnight : null
}

function midnightOf(day: string): TZDate {
  const midnight = parseDay(day)
  if (!midnight) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  return midnight
}

/** The Stockholm calendar day the instant falls in. */
export function stockholmDayOf(ms: number): string {
  return format(ms, DAY_FORMAT, { in: inStockholm })
}

/** The Stockholm calendar year/month (1-based) the instant falls in. */
export function stockholmYearMonth(ms: number): { year: number; month: number } {
  const local = inStockholm(ms)
  return { year: local.getFullYear(), month: local.getMonth() + 1 }
}

/** `day` shifted by `n` calendar days (calendar arithmetic; DST never shifts it). */
export function addDays(day: string, n: number): string {
  return format(addCalendarDays(midnightOf(day), n), DAY_FORMAT)
}

/** `[startMs, endMs)` of a Stockholm calendar day — 23, 24 or 25 h long. */
export function stockholmDayBounds(day: string): { startMs: number; endMs: number } {
  return { startMs: midnightOf(day).getTime(), endMs: midnightOf(addDays(day, 1)).getTime() }
}

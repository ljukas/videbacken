// Client-safe UTC calendar helpers for sources that report whole UTC days (Comfort Cloud,
// ADR-0027). Deliberately tiny: a UTC day needs only Date.UTC. Stockholm days live in
// stockholm.ts, the one module that names that zone.
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^\d{4}-\d{2}$/
const DAY_MS = 86_400_000

/** Midnight UTC of `day` in ms, or null unless it is a real 'YYYY-MM-DD' day in 1970–2999. */
function parseUtcDay(day: string): number | null {
  const match = DAY_RE.exec(day)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (y < 1970 || y > 2999) return null
  const ms = Date.UTC(y, m - 1, d)
  const date = new Date(ms)
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? ms : null
}

/** Whether `day` is a real 'YYYY-MM-DD' day in 1970–2999. */
export function isUtcDay(day: string): boolean {
  return parseUtcDay(day) !== null
}

/** Whether `month` is a real 'YYYY-MM' month in 1970–2999. */
export function isUtcMonth(month: string): boolean {
  return MONTH_RE.test(month) && isUtcDay(`${month}-01`)
}

/** `[startMs, endMs)` of UTC `day`: always 24 h. Throws RangeError for anything but a real day. */
export function utcDayBounds(day: string): { startMs: number; endMs: number } {
  const startMs = parseUtcDay(day)
  if (startMs === null) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  return { startMs, endMs: startMs + DAY_MS }
}

/** The UTC 'YYYY-MM-DD' an instant falls in. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

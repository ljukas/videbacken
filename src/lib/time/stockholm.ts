// Dependency-free, client-safe calendar helpers for Europe/Stockholm, the one
// time zone every charging/price bucket is defined in. A "day" is a
// 'YYYY-MM-DD' string naming a local calendar day; instants are epoch ms.
// DST-aware via Intl — a Stockholm day is 23, 24 or 25 hours long.

const TIME_ZONE = 'Europe/Stockholm'
const HOUR_MS = 60 * 60 * 1000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

let cachedParts: Intl.DateTimeFormat | undefined

// en-CA gives a zero-padded numeric year/month/day; hourCycle h23 keeps
// midnight as 00 (never 24).
function partsFormat(): Intl.DateTimeFormat {
  cachedParts ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return cachedParts
}

function localParts(ms: number) {
  const parts = partsFormat().formatToParts(ms)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

function parseDay(day: string): { y: number; m: number; d: number } {
  const match = DAY_RE.exec(day)
  const y = Number(match?.[1])
  const m = Number(match?.[2])
  const d = Number(match?.[3])
  // Round-trip through Date.UTC so an impossible date (2025-02-30) is rejected
  // rather than rolled over into the next month.
  const date = new Date(Date.UTC(y, m - 1, d))
  if (!match || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  }
  return { y, m, d }
}

/** The Stockholm calendar day the instant falls in. */
export function stockholmDayOf(ms: number): string {
  const p = localParts(ms)
  return `${p.year}-${p.month}-${p.day}`
}

/** The Stockholm calendar year/month (1-based) the instant falls in. */
export function stockholmYearMonth(ms: number): { year: number; month: number } {
  const p = localParts(ms)
  return { year: Number(p.year), month: Number(p.month) }
}

/** `day` shifted by `n` calendar days (pure date arithmetic, no time zone). */
export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDay(day)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * The UTC instant of a Stockholm day's local midnight. Swedish DST switches at
 * 02:00/03:00, so midnight always exists and is UTC+1 or UTC+2.
 */
function localMidnightMs(day: string): number {
  const { y, m, d } = parseDay(day)
  for (const offsetHours of [1, 2]) {
    const ms = Date.UTC(y, m - 1, d) - offsetHours * HOUR_MS
    const p = localParts(ms)
    if (`${p.year}-${p.month}-${p.day}` === day && p.hour === '00' && p.minute === '00') return ms
  }
  throw new RangeError(`No Stockholm midnight found for ${day}`)
}

/** `[startMs, endMs)` of a Stockholm calendar day — 23, 24 or 25 h long. */
export function stockholmDayBounds(day: string): { startMs: number; endMs: number } {
  return { startMs: localMidnightMs(day), endMs: localMidnightMs(addDays(day, 1)) }
}

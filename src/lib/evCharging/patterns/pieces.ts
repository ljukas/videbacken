// Client-safe. Splits a span into Stockholm clock hours. Stockholm's UTC
// offset has been a whole number of hours since 1900, so its hour boundaries
// are UTC hour boundaries: splitting in absolute time with d3-time's utcHour
// is DST-safe by construction (the fall-back night simply yields two pieces
// labelled 02, spring-forward none). Local labels come from date-fns in the
// Stockholm zone — no offset arithmetic here.
import { tz } from '@date-fns/tz'
import { utcHour } from 'd3-time'
import { getHours, getISODay } from 'date-fns'
import { STOCKHOLM_TIME_ZONE, stockholmDayOf } from '~/lib/time/stockholm'

export const HOUR_MS = 3_600_000
const inStockholm = tz(STOCKHOLM_TIME_ZONE)

export type HourPiece = {
  startMs: number
  endMs: number
  /** ISO weekday − 1: 0 = Monday … 6 = Sunday (Stockholm). */
  weekday: number
  /** Stockholm clock hour 0–23 the piece starts in. */
  hour: number
  /** Stockholm 'YYYY-MM-DD' the piece starts in. */
  day: string
}

export function splitByStockholmHour(startMs: number, endMs: number): HourPiece[] {
  if (!(endMs > startMs)) return []
  // Every hour boundary strictly inside the span, plus the span's own ends.
  const inner = utcHour
    .range(new Date(startMs), new Date(endMs))
    .map((d) => d.getTime())
    .filter((ms) => ms > startMs)
  const edges = [startMs, ...inner, endMs]
  const pieces: HourPiece[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const at = edges[i]
    pieces.push({
      startMs: at,
      endMs: edges[i + 1],
      weekday: getISODay(at, { in: inStockholm }) - 1,
      hour: getHours(at, { in: inStockholm }),
      day: stockholmDayOf(at),
    })
  }
  return pieces
}

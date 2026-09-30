// Client-safe: when-we-charge aggregates for one Stockholm year, from counted
// sessions and their intervals. Hourly views split pro rata by time; daily and
// monthly kWh bucket each interval whole by its own start (the overview's
// rule, so the calendar and /charging's monthly chart can never disagree).
import { range, rollup, sum } from 'd3-array'
import { stockholmDayOf, stockholmYearBounds, stockholmYearMonth } from '~/lib/time/stockholm'
import { HOUR_MS, type HourPiece, splitByStockholmHour } from './pieces'
import type { DayTotal, MonthTotal, PatternAggregates, PatternSession, Slot } from './types'

type HourContribution = { weekday: number; hour: number; kwh: number; plugged: number }
type DayContribution = { day: string; month: number; kwh: number; sessions: number }

export function buildPatterns(sessions: PatternSession[], year: number): PatternAggregates {
  const { startMs, endMs } = stockholmYearBounds(year)
  const inYear = (ms: number) => ms >= startMs && ms < endMs
  const hours: HourContribution[] = []
  const days: DayContribution[] = []
  const dayContribution = (ms: number, kwh: number, count: number) =>
    days.push({
      day: stockholmDayOf(ms),
      month: stockholmYearMonth(ms).month,
      kwh,
      sessions: count,
    })
  const hourContribution = (p: HourPiece, kwh: number, plugged: number) =>
    hours.push({ weekday: p.weekday, hour: p.hour, kwh, plugged })
  let unhourlySessions = 0

  for (const s of sessions) {
    const sessionStart = s.startAt.getTime()
    for (const p of splitByStockholmHour(sessionStart, s.endAt.getTime())) {
      if (inYear(p.startMs)) hourContribution(p, 0, (p.endMs - p.startMs) / HOUR_MS)
    }
    if (inYear(sessionStart)) dayContribution(sessionStart, 0, 1)

    if (s.intervals.length === 0) {
      if (inYear(sessionStart)) {
        unhourlySessions += 1
        dayContribution(sessionStart, s.energyKwh, 0)
      }
      continue
    }
    for (const i of s.intervals) {
      const a = i.startAt.getTime()
      const b = i.endAt.getTime()
      if (inYear(a)) dayContribution(a, i.energyKwh, 0)
      for (const p of splitByStockholmHour(a, b)) {
        if (inYear(p.startMs))
          hourContribution(p, (i.energyKwh * (p.endMs - p.startMs)) / (b - a), 0)
      }
    }
  }

  const slotOf = (rows: HourContribution[] | undefined): Slot => ({
    kwh: sum(rows ?? [], (r) => r.kwh),
    pluggedHours: sum(rows ?? [], (r) => r.plugged),
  })
  const byWeekdayHour = rollup(
    hours,
    (rows) => rows,
    (r) => r.weekday,
    (r) => r.hour,
  )
  const weekdayHour = range(7).map((w) =>
    range(24).map((h) => slotOf(byWeekdayHour.get(w)?.get(h))),
  )
  const hourOfDay = range(24).map(
    (h): Slot => ({
      kwh: sum(weekdayHour, (row) => row[h].kwh),
      pluggedHours: sum(weekdayHour, (row) => row[h].pluggedHours),
    }),
  )

  const totals = (rows: DayContribution[]) => ({
    kwh: sum(rows, (r) => r.kwh),
    sessions: sum(rows, (r) => r.sessions),
  })
  const byDay = rollup(days, totals, (r) => r.day)
  const daily: DayTotal[] = [...byDay]
    .map(([day, t]) => ({ day, ...t }))
    .filter((t) => t.kwh > 0 || t.sessions > 0)
    .sort((x, y) => (x.day < y.day ? -1 : 1))
  const byMonth = rollup(days, totals, (r) => r.month)
  const months: MonthTotal[] = range(1, 13).map((month) => ({
    month,
    ...(byMonth.get(month) ?? { kwh: 0, sessions: 0 }),
  }))

  return { weekdayHour, hourOfDay, daily, months, unhourlySessions }
}

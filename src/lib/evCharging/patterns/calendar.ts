import { tz } from '@date-fns/tz'
import { differenceInCalendarWeeks, eachDayOfInterval, getDate, getISODay } from 'date-fns'
import { STOCKHOLM_TIME_ZONE, stockholmDayOf, stockholmMonthBounds } from '~/lib/time/stockholm'

const inStockholm = tz(STOCKHOLM_TIME_ZONE)

/** One day of a month grid: `weekday` 0 = Monday, `week` = 0-based row in the month. */
export type CalendarDay = { day: string; date: number; weekday: number; week: number }

/** A Monday-first month grid in Stockholm calendar days. */
export function monthGrid(year: number, month: number): CalendarDay[] {
  const { startMs, endMs } = stockholmMonthBounds(year, month)
  const first = inStockholm(startMs)
  return eachDayOfInterval({ start: startMs, end: endMs - 1 }, { in: inStockholm }).map((d) => ({
    day: stockholmDayOf(d.getTime()),
    date: getDate(d),
    weekday: getISODay(d) - 1,
    week: differenceInCalendarWeeks(d, first, { weekStartsOn: 1, in: inStockholm }),
  }))
}

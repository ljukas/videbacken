import {
  type CountableTimeInterval,
  type TimeInterval,
  timeDay,
  timeHour,
  timeMonday,
  timeMonth,
} from 'd3-time'
import type { SeriesRange } from '~/lib/sensor/range'

// Range-aware x-axis / tooltip-header time label. Client-safe and locale-explicit
// (the caller passes a BCP 47 tag from getIntlLocale()) so it stays a pure
// function the chart ranges can be tested against.
//
// Three levels of precision, each matching its range's bucket width:
//   24h (10-min buckets)  → time of day; the window never repeats an hour.
//   1w  (2-h buckets)     → weekday + time; ~12 points a day would otherwise all
//                           carry the same date, in the tooltip header too.
//   coarser (3h..1 day)   → short date; the time of day is noise at that scale.
export function makeTickFormatter(range: SeriesRange, locale: string): (t: number) => string {
  const options: Intl.DateTimeFormatOptions =
    range === '24h'
      ? { hour: '2-digit', minute: '2-digit' }
      : range === '1w'
        ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric' }
  const fmt = new Intl.DateTimeFormat(locale, options)
  return (t: number) => fmt.format(new Date(t))
}

/**
 * A time axis: its candidate tick intervals, finest first, its tick label, and
 * the finer `fallbacks` (finest first) for data shorter than its range, used
 * only when `intervals` leave the axis with fewer than two ticks.
 */
export type TimeAxis = {
  intervals: readonly TimeInterval[]
  fallbacks: readonly TimeInterval[]
  format: (t: number) => string
}

// `every` is null only for a non-positive step.
const every = (interval: CountableTimeInterval, step: number): TimeInterval =>
  interval.every(step) ?? interval
// The 1st and the 16th: twice a month without drifting off the calendar.
const halfMonth = timeDay.filter((d) => d.getDate() === 1 || d.getDate() === 16)

// Round local times per range (owner's choice, step 5c). The chart takes the
// finest interval whose labels fit its width (pickTimeTicks).
const INTERVALS: Record<SeriesRange, readonly TimeInterval[]> = {
  '24h': [every(timeHour, 3), every(timeHour, 6), every(timeHour, 12)],
  '1w': [timeDay, every(timeDay, 2)],
  '1m': [timeMonday, halfMonth],
  '3m': [halfMonth, timeMonth],
  '6m': [halfMonth, timeMonth, every(timeMonth, 2)],
  '1y': [timeMonth, every(timeMonth, 2), every(timeMonth, 3)],
  all: [
    timeMonth,
    every(timeMonth, 2),
    every(timeMonth, 3),
    every(timeMonth, 6),
    every(timeMonth, 12),
  ],
}

// Finer intervals for a sensor whose data is shorter than the range (a new
// sensor on 1 y): never a blank axis. Coarser ranges list more of them.
const FALLBACKS: Record<SeriesRange, readonly TimeInterval[]> = {
  '24h': [timeHour],
  '1w': [],
  '1m': [timeDay, every(timeDay, 2)],
  '3m': [timeDay, every(timeDay, 2), timeMonday],
  '6m': [timeDay, every(timeDay, 2), timeMonday],
  '1y': [timeDay, every(timeDay, 2), timeMonday, halfMonth],
  all: [timeDay, every(timeDay, 2), timeMonday, halfMonth],
}

// The axis label matches its ticks: the time of day for hours, the weekday for
// midnights, the date beyond a week. (The card's header keeps makeTickFormatter.)
export function makeTimeAxis(range: SeriesRange, locale: string): TimeAxis {
  const options: Intl.DateTimeFormatOptions =
    range === '24h'
      ? { hour: '2-digit', minute: '2-digit' }
      : range === '1w'
        ? { weekday: 'short' }
        : { month: 'short', day: 'numeric' }
  const fmt = new Intl.DateTimeFormat(locale, options)
  return {
    intervals: INTERVALS[range],
    fallbacks: FALLBACKS[range],
    format: (t) => fmt.format(new Date(t)),
  }
}

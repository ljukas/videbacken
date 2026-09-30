// Client-safe types for the when-we-charge read models.

/** One metered interval of a session (hour-aligned in practice). */
export type PatternInterval = { startAt: Date; endAt: Date; energyKwh: number }
/** A counted charging session with its intervals. */
export type PatternSession = {
  id: string
  startAt: Date
  endAt: Date
  energyKwh: number
  intervals: PatternInterval[]
}
/** One heatmap / histogram cell: energy and plugged-in hours. */
export type Slot = { kwh: number; pluggedHours: number }
/** One calendar day: kWh and sessions started that day (Stockholm). */
export type DayTotal = { day: string; kwh: number; sessions: number }
/** One calendar month: kWh and sessions started that month (Stockholm). */
export type MonthTotal = { month: number; kwh: number; sessions: number }
/** Aggregates for one Stockholm year. */
export type PatternAggregates = {
  /** [7][24], Monday first. */
  weekdayHour: Slot[][]
  /** [24]. */
  hourOfDay: Slot[]
  /** Ascending by day; only days with kWh > 0 or a session start. */
  daily: DayTotal[]
  /** 12 rows, month 1-12. */
  months: MonthTotal[]
  /** Sessions in the year with no intervals (no hourly kWh). */
  unhourlySessions: number
}
/** Aggregates plus the selected year and the years that have data. */
export type ChargingPatterns = PatternAggregates & { year: number; years: number[] }
export type TimelineSegment = { startAt: Date; endAt: Date; kind: 'charging' | 'idle' }
export type TimelineSession = {
  id: string
  startAt: Date
  endAt: Date
  energyKwh: number
  chargingHours: number
  hourly: boolean
  segments: TimelineSegment[]
}
export type ChargingTimeline = {
  year: number
  month: number
  months: number[]
  sessions: TimelineSession[]
}

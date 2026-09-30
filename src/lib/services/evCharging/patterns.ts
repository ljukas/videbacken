import { group } from 'd3-array'
import { and, asc, gt, gte, inArray, lt, type SQL, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { evChargeInterval, evChargeSession } from '~/lib/db/schema'
import {
  buildPatterns,
  type ChargingPatterns,
  type ChargingTimeline,
  type PatternSession,
  toTimelineSession,
} from '~/lib/evCharging/patterns'
import { stockholmMonthBounds, stockholmYearBounds, stockholmYearMonth } from '~/lib/time/stockholm'
import { countedSessionFilter } from './counted'
import { distinctCountedYears } from './overview'

export type PatternTimings = { fetchMs?: number; aggregateMs?: number }

// A session plugged in up to this long before a range still contributes its
// hours inside the range (sessions are hours long; the lookback keeps the
// start_at filter sargable instead of scanning on end_at).
const LOOKBACK_MS = 7 * 24 * 3_600_000

async function fetchSessions(where: SQL | undefined): Promise<PatternSession[]> {
  const sessions = await db
    .select({
      id: evChargeSession.id,
      startAt: evChargeSession.startAt,
      endAt: evChargeSession.endAt,
      energyKwh: evChargeSession.energyKwh,
    })
    .from(evChargeSession)
    .where(and(countedSessionFilter(), where))
    .orderBy(asc(evChargeSession.startAt))
  if (sessions.length === 0) return []
  const intervals = await db
    .select({
      sessionId: evChargeInterval.sessionId,
      startAt: evChargeInterval.startAt,
      endAt: evChargeInterval.endAt,
      energyKwh: evChargeInterval.energyKwh,
    })
    .from(evChargeInterval)
    .where(
      inArray(
        evChargeInterval.sessionId,
        sessions.map((s) => s.id),
      ),
    )
    .orderBy(asc(evChargeInterval.sessionId), asc(evChargeInterval.startAt))
  const bySession = group(intervals, (i) => i.sessionId)
  return sessions.map((s) => ({
    ...s,
    intervals: (bySession.get(s.id) ?? []).map(({ startAt, endAt, energyKwh }) => ({
      startAt,
      endAt,
      energyKwh,
    })),
  }))
}

function overlapping(startMs: number, endMs: number) {
  return and(
    gte(evChargeSession.startAt, new Date(startMs - LOOKBACK_MS)),
    lt(evChargeSession.startAt, new Date(endMs)),
    gt(evChargeSession.endAt, new Date(startMs)),
  )
}

async function timed<T>(
  timings: PatternTimings | undefined,
  key: keyof PatternTimings,
  run: () => Promise<T> | T,
): Promise<T> {
  const started = performance.now()
  try {
    return await run()
  } finally {
    if (timings) timings[key] = Math.round(performance.now() - started)
  }
}

export async function getChargingPatterns(input: {
  year?: number
  now?: Date
  timings?: PatternTimings
}): Promise<ChargingPatterns> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime()).year
  const year = input.year ?? current
  const { startMs, endMs } = stockholmYearBounds(year)
  const [sessions, years] = await timed(input.timings, 'fetchMs', () =>
    Promise.all([fetchSessions(overlapping(startMs, endMs)), distinctCountedYears()]),
  )
  const aggregates = await timed(input.timings, 'aggregateMs', () => buildPatterns(sessions, year))
  years.add(current)
  return { year, years: [...years].sort((a, b) => b - a), ...aggregates }
}

export async function getChargingTimeline(input: {
  year?: number
  month?: number
  now?: Date
  timings?: PatternTimings
}): Promise<ChargingTimeline> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const year = input.year ?? current.year
  const { startMs: yearStart, endMs: yearEnd } = stockholmYearBounds(year)
  const monthOf = sql<number>`extract(month from ${evChargeSession.startAt} AT TIME ZONE 'Europe/Stockholm')::int`
  const { months, month, sessions } = await timed(input.timings, 'fetchMs', async () => {
    const monthRows = await db
      .selectDistinct({ month: monthOf })
      .from(evChargeSession)
      .where(
        and(
          countedSessionFilter(),
          gte(evChargeSession.startAt, new Date(yearStart)),
          lt(evChargeSession.startAt, new Date(yearEnd)),
        ),
      )
    const months = monthRows.map((r) => r.month).sort((a, b) => a - b)
    const month = input.month ?? months.at(-1) ?? current.month
    const { startMs, endMs } = stockholmMonthBounds(year, month)
    const sessions = await fetchSessions(
      and(
        gte(evChargeSession.startAt, new Date(startMs)),
        lt(evChargeSession.startAt, new Date(endMs)),
      ),
    )
    return { months, month, sessions }
  })
  const rows = await timed(input.timings, 'aggregateMs', () => sessions.map(toTimelineSession))
  return { year, month, months, sessions: rows }
}

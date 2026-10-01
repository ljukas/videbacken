import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { evChargeInterval, evChargeSession } from '~/lib/db/schema'
import {
  OVERVIEW_MAX_YEAR,
  OVERVIEW_MIN_YEAR,
  PEAK_MIN_INTERVAL_MS,
} from '~/lib/evCharging/counting'
import type { Vehicle, VehicleScope } from '~/lib/evCharging/vehicle'
import { stockholmYearBounds, stockholmYearMonth } from '~/lib/time/stockholm'
import { countedSessionFilter } from './counted'

export type Totals = { kwh: number; sessions: number }

export type ChargingOverview = {
  year: number
  years: number[]
  tiles: { thisMonth: Totals; thisYear: Totals; allTime: Totals }
  months: (Totals & { month: number })[]
}

export type SessionRow = {
  id: string
  startAt: Date
  endAt: Date
  energyKwh: number
  peakKw: number | null
  offline: boolean
  reliableClock: boolean
  vehicle: Vehicle
}

// The driver can return sum()/count() aggregates as strings even over
// `double precision` columns (Task 1 schema note) — coerce like `toNumber` in
// `src/lib/services/sensor/sensor.ts`. Missing group (no matching rows) means
// zero for a total.
function toNumber(v: number | string | null): number {
  return v == null ? 0 : Number(v)
}

// Same coercion, but preserves `null` — used for `peakKw`, where null is
// meaningful ("no interval long enough to compute a peak").
function toNullableNumber(v: number | string | null): number | null {
  return v == null ? null : Number(v)
}

// [start, end) instants spanning one Stockholm calendar year, for a sargable
// `start_at` range filter — never `extract(year from …) = $year`, which can't
// use the `start_at` index.
function stockholmYearRange(year: number): { start: Date; end: Date } {
  const { startMs, endMs } = stockholmYearBounds(year)
  return { start: new Date(startMs), end: new Date(endMs) }
}

// One (month → Totals) map for a single Stockholm calendar year, scoped by a
// `start_at` range (see `stockholmYearRange`). kWh comes from intervals,
// bucketed by each interval's own `start_at` (an overnight session splits its
// kWh across the months its intervals actually fall in); a session with no
// intervals falls back to its own `energy_kwh` in the month of its own
// `start_at`. Session count is always by the session's own `start_at` month,
// regardless of how its kWh split across months.
async function monthlyTotals(year: number, vehicle?: VehicleScope): Promise<Map<number, Totals>> {
  const { start, end } = stockholmYearRange(year)
  const monthOfInterval = sql<number>`extract(month from ${evChargeInterval.startAt} AT TIME ZONE 'Europe/Stockholm')::int`
  const monthOfSession = sql<number>`extract(month from ${evChargeSession.startAt} AT TIME ZONE 'Europe/Stockholm')::int`

  const intervalRows = await db
    .select({ month: monthOfInterval, kwh: sql<string>`sum(${evChargeInterval.energyKwh})` })
    .from(evChargeInterval)
    .innerJoin(evChargeSession, eq(evChargeInterval.sessionId, evChargeSession.id))
    .where(
      and(
        countedSessionFilter({ vehicle }),
        gte(evChargeInterval.startAt, start),
        lt(evChargeInterval.startAt, end),
      ),
    )
    .groupBy(sql`1`)

  const fallbackRows = await db
    .select({ month: monthOfSession, kwh: sql<string>`sum(${evChargeSession.energyKwh})` })
    .from(evChargeSession)
    .leftJoin(evChargeInterval, eq(evChargeInterval.sessionId, evChargeSession.id))
    .where(
      and(
        countedSessionFilter({ vehicle }),
        isNull(evChargeInterval.sessionId),
        gte(evChargeSession.startAt, start),
        lt(evChargeSession.startAt, end),
      ),
    )
    .groupBy(sql`1`)

  const sessionCountRows = await db
    .select({ month: monthOfSession, sessions: sql<string>`count(*)` })
    .from(evChargeSession)
    .where(
      and(
        countedSessionFilter({ vehicle }),
        gte(evChargeSession.startAt, start),
        lt(evChargeSession.startAt, end),
      ),
    )
    .groupBy(sql`1`)

  const totals = new Map<number, Totals>()
  for (let m = 1; m <= 12; m++) totals.set(m, { kwh: 0, sessions: 0 })
  const addKwh = (month: number, kwh: string) => {
    const t = totals.get(month) ?? { kwh: 0, sessions: 0 }
    totals.set(month, { ...t, kwh: t.kwh + toNumber(kwh) })
  }
  const addSessions = (month: number, sessions: string) => {
    const t = totals.get(month) ?? { kwh: 0, sessions: 0 }
    totals.set(month, { ...t, sessions: t.sessions + toNumber(sessions) })
  }
  for (const r of intervalRows) addKwh(r.month, r.kwh)
  for (const r of fallbackRows) addKwh(r.month, r.kwh)
  for (const r of sessionCountRows) addSessions(r.month, r.sessions)
  return totals
}

// All distinct Stockholm calendar years with at least one counted session —
// from either a session's own `start_at` or (for the case where a session's
// intervals land in a different year than the session itself started, e.g.
// spanning New Year's) an interval's `start_at`. Unlike `monthlyTotals`, this
// has no target year to filter against, so there's no sargable alternative to
// scanning + extracting.
export async function distinctCountedYears(): Promise<Set<number>> {
  const yearOfSession = sql<number>`extract(year from ${evChargeSession.startAt} AT TIME ZONE 'Europe/Stockholm')::int`
  const yearOfInterval = sql<number>`extract(year from ${evChargeInterval.startAt} AT TIME ZONE 'Europe/Stockholm')::int`

  const sessionYears = await db
    .selectDistinct({ year: yearOfSession })
    .from(evChargeSession)
    .where(countedSessionFilter())

  const intervalYears = await db
    .selectDistinct({ year: yearOfInterval })
    .from(evChargeInterval)
    .innerJoin(evChargeSession, eq(evChargeInterval.sessionId, evChargeSession.id))
    .where(countedSessionFilter())

  // Only years the `overview` procedure accepts; data outside them still
  // counts toward the all-time tile.
  const years = new Set<number>()
  for (const r of [...sessionYears, ...intervalYears]) {
    if (r.year >= OVERVIEW_MIN_YEAR && r.year <= OVERVIEW_MAX_YEAR) years.add(r.year)
  }
  return years
}

// No year restriction at all — the only tile that spans every year of data.
async function allTimeTotals(vehicle?: VehicleScope): Promise<Totals> {
  const [intervalRow] = await db
    .select({ kwh: sql<string | null>`sum(${evChargeInterval.energyKwh})` })
    .from(evChargeInterval)
    .innerJoin(evChargeSession, eq(evChargeInterval.sessionId, evChargeSession.id))
    .where(countedSessionFilter({ vehicle }))

  const [fallbackRow] = await db
    .select({ kwh: sql<string | null>`sum(${evChargeSession.energyKwh})` })
    .from(evChargeSession)
    .leftJoin(evChargeInterval, eq(evChargeInterval.sessionId, evChargeSession.id))
    .where(and(countedSessionFilter({ vehicle }), isNull(evChargeInterval.sessionId)))

  const [sessionRow] = await db
    .select({ sessions: sql<string>`count(*)` })
    .from(evChargeSession)
    .where(countedSessionFilter({ vehicle }))

  return {
    kwh: toNumber(intervalRow?.kwh ?? null) + toNumber(fallbackRow?.kwh ?? null),
    sessions: toNumber(sessionRow?.sessions ?? null),
  }
}

const ZERO_MONTHS: (Totals & { month: number })[] = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  kwh: 0,
  sessions: 0,
}))

export async function getOverview(input: {
  year?: number
  now?: Date
  vehicle?: VehicleScope
}): Promise<ChargingOverview> {
  const now = input.now ?? new Date()
  // The shared helper (also used by the cost read model) so kWh and cost
  // buckets can never disagree on which month an instant falls in.
  const { year: currentYear, month: currentMonth } = stockholmYearMonth(now.getTime())
  const year = input.year ?? currentYear

  const [selectedYearTotals, currentYearTotals, allTime, years] = await Promise.all([
    monthlyTotals(year, input.vehicle),
    year === currentYear ? Promise.resolve(null) : monthlyTotals(currentYear, input.vehicle),
    allTimeTotals(input.vehicle),
    distinctCountedYears(),
  ])
  const thisYearTotals = currentYearTotals ?? selectedYearTotals

  years.add(currentYear)

  const months = ZERO_MONTHS.map((zero) => ({
    ...zero,
    ...(selectedYearTotals.get(zero.month) ?? zero),
  }))

  const thisYear = Array.from(thisYearTotals.values()).reduce(
    (acc, t) => ({ kwh: acc.kwh + t.kwh, sessions: acc.sessions + t.sessions }),
    { kwh: 0, sessions: 0 },
  )
  const thisMonth = thisYearTotals.get(currentMonth) ?? { kwh: 0, sessions: 0 }

  return {
    year,
    years: [...years].sort((a, b) => b - a),
    tiles: { thisMonth, thisYear, allTime },
    months,
  }
}

const PEAK_MIN_DURATION_SEC = PEAK_MIN_INTERVAL_MS / 1000

export async function listSessions(input: {
  limit: number
  vehicle?: VehicleScope
}): Promise<{ sessions: SessionRow[]; hasMore: boolean }> {
  const rows = await db
    .select({
      id: evChargeSession.id,
      startAt: evChargeSession.startAt,
      endAt: evChargeSession.endAt,
      energyKwh: evChargeSession.energyKwh,
      offline: evChargeSession.offline,
      reliableClock: evChargeSession.reliableClock,
      vehicle: sql<Vehicle>`${evChargeSession.vehicle}`,
    })
    .from(evChargeSession)
    .where(countedSessionFilter({ vehicle: input.vehicle }))
    .orderBy(desc(evChargeSession.startAt))
    .limit(input.limit + 1)

  const hasMore = rows.length > input.limit
  const page = hasMore ? rows.slice(0, input.limit) : rows
  if (page.length === 0) return { sessions: [], hasMore }

  const ids = page.map((r) => r.id)
  const peakRows = await db
    .select({
      sessionId: evChargeInterval.sessionId,
      peakKw: sql<
        string | null
      >`max(${evChargeInterval.energyKwh} / (extract(epoch from (${evChargeInterval.endAt} - ${evChargeInterval.startAt})) / 3600))`,
    })
    .from(evChargeInterval)
    .where(
      and(
        inArray(evChargeInterval.sessionId, ids),
        sql`extract(epoch from (${evChargeInterval.endAt} - ${evChargeInterval.startAt})) >= ${PEAK_MIN_DURATION_SEC}`,
      ),
    )
    .groupBy(evChargeInterval.sessionId)

  const peakBySession = new Map(peakRows.map((r) => [r.sessionId, toNullableNumber(r.peakKw)]))

  return {
    sessions: page.map((r) => ({ ...r, peakKw: peakBySession.get(r.id) ?? null })),
    hasMore,
  }
}

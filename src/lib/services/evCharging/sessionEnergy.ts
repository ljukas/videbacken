import { and, asc, inArray, min } from 'drizzle-orm'
import { db } from '~/lib/db'
import { evChargeInterval, evChargeSession } from '~/lib/db/schema'
import { countedSessionFilter } from './counted'

/** A stretch of a session's energy, as the cost math consumes it. */
export type EnergyStretch = { startMs: number; endMs: number; kwh: number }

/**
 * One counted session's energy over time: its Zaptec intervals, or — for a
 * session without intervals — one `estimated` stretch spreading its whole
 * `energyKwh` over `[startAt, endAt)`. That mirrors the overview's kWh
 * fallback, so priced kWh and shown kWh always agree.
 */
export type SessionEnergy = {
  sessionId: string
  startAt: Date
  endAt: Date
  energyKwh: number
  stretches: EnergyStretch[]
  estimated: boolean
}

/**
 * Counted sessions with their energy stretches, oldest first. Two queries
 * (sessions, then their intervals) regardless of how many sessions.
 */
export async function listSessionEnergy(
  filter: { all: true } | { sessionIds: readonly string[] },
): Promise<SessionEnergy[]> {
  if ('sessionIds' in filter && filter.sessionIds.length === 0) return []
  const sessionFilter =
    'sessionIds' in filter
      ? and(countedSessionFilter(), inArray(evChargeSession.id, [...filter.sessionIds]))
      : countedSessionFilter()
  const sessions = await db
    .select({
      id: evChargeSession.id,
      startAt: evChargeSession.startAt,
      endAt: evChargeSession.endAt,
      energyKwh: evChargeSession.energyKwh,
    })
    .from(evChargeSession)
    .where(sessionFilter)
    .orderBy(asc(evChargeSession.startAt), asc(evChargeSession.id))
  if (sessions.length === 0) return []

  const intervals = await db
    .select({
      sessionId: evChargeInterval.sessionId,
      startAt: evChargeInterval.startAt,
      endAt: evChargeInterval.endAt,
      energyKwh: evChargeInterval.energyKwh,
    })
    .from(evChargeInterval)
    // A subselect, not one bind parameter per session: `{ all: true }` would
    // otherwise hit postgres-js's parameter limit on a long history.
    .where(
      inArray(
        evChargeInterval.sessionId,
        db.select({ id: evChargeSession.id }).from(evChargeSession).where(sessionFilter),
      ),
    )
    .orderBy(asc(evChargeInterval.startAt))

  const bySession = Map.groupBy(intervals, (iv) => iv.sessionId)

  return sessions.map((s) => {
    const stretches = bySession.get(s.id)?.map(
      (iv): EnergyStretch => ({
        startMs: iv.startAt.getTime(),
        endMs: iv.endAt.getTime(),
        kwh: iv.energyKwh,
      }),
    )
    return {
      sessionId: s.id,
      startAt: s.startAt,
      endAt: s.endAt,
      energyKwh: s.energyKwh,
      stretches: stretches ?? [
        { startMs: s.startAt.getTime(), endMs: s.endAt.getTime(), kwh: s.energyKwh },
      ],
      estimated: stretches === undefined,
    }
  })
}

/** Start of the earliest counted session, or null with none. */
export async function earliestCountedStartAt(): Promise<Date | null> {
  const [row] = await db
    .select({ first: min(evChargeSession.startAt) })
    .from(evChargeSession)
    .where(countedSessionFilter())
  return row?.first ?? null
}

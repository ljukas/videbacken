import { and, asc, gt, inArray, min, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type DbOrTx, db } from '~/lib/db'
import { evChargeInterval, evChargeSession } from '~/lib/db/schema'
import type { Vehicle, VehicleScope, VehicleSource } from '~/lib/evCharging/vehicle'
import { countedSessionFilter } from './counted'
import { EvChargingDomainError } from './errors'

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
  vehicle: Vehicle
  vehicleSource: VehicleSource
}

type SessionEnergyFilter =
  | { all: true; vehicle?: VehicleScope }
  | { sessionIds: readonly string[] }
  /** Counted sessions ending after the instant (the energy-mix derive's window, ADR-0023). */
  | { endsAfter: Date }

function sessionFilterOf(filter: SessionEnergyFilter) {
  if ('sessionIds' in filter) {
    return and(countedSessionFilter(), inArray(evChargeSession.id, [...filter.sessionIds]))
  }
  if ('endsAfter' in filter) {
    return and(countedSessionFilter(), gt(evChargeSession.endAt, filter.endsAfter))
  }
  return countedSessionFilter({ vehicle: filter.vehicle })
}

/**
 * Counted sessions with their energy stretches, oldest first. Two queries
 * (sessions, then their intervals) regardless of how many sessions; inside
 * the caller's transaction when given one.
 */
export async function listSessionEnergy(
  filter: SessionEnergyFilter,
  dbOrTx: DbOrTx = db,
): Promise<SessionEnergy[]> {
  if ('sessionIds' in filter && filter.sessionIds.length === 0) return []
  const sessionFilter = sessionFilterOf(filter)
  const sessions = await dbOrTx
    .select({
      id: evChargeSession.id,
      startAt: evChargeSession.startAt,
      endAt: evChargeSession.endAt,
      energyKwh: evChargeSession.energyKwh,
      vehicle: sql<Vehicle>`${evChargeSession.vehicle}`,
      vehicleSource: sql<VehicleSource>`${evChargeSession.vehicleSource}`,
    })
    .from(evChargeSession)
    .where(sessionFilter)
    .orderBy(asc(evChargeSession.startAt), asc(evChargeSession.id))
  if (sessions.length === 0) return []

  const intervals = await dbOrTx
    .select({
      sessionId: evChargeInterval.sessionId,
      startAt: evChargeInterval.startAt,
      endAt: evChargeInterval.endAt,
      energyKwh: evChargeInterval.energyKwh,
    })
    .from(evChargeInterval)
    // A subselect, not one bind parameter per session: `{ all: true }` would
    // otherwise hit Postgres's bind-parameter limit on a long history.
    .where(
      inArray(
        evChargeInterval.sessionId,
        dbOrTx.select({ id: evChargeSession.id }).from(evChargeSession).where(sessionFilter),
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
      vehicle: s.vehicle,
      vehicleSource: s.vehicleSource,
    }
  })
}

/**
 * One counted session's energy; throws `EV_SESSION_NOT_FOUND` for an unknown, uncounted
 * or non-uuid id (checked here, since Postgres would throw on a non-uuid).
 */
export async function getSessionEnergy(sessionId: string): Promise<SessionEnergy> {
  if (!z.uuid().safeParse(sessionId).success)
    throw new EvChargingDomainError('EV_SESSION_NOT_FOUND')
  const [session] = await listSessionEnergy({ sessionIds: [sessionId] })
  if (!session) throw new EvChargingDomainError('EV_SESSION_NOT_FOUND')
  return session
}

/** Start of the earliest counted session, or null with none. */
export async function earliestCountedStartAt(): Promise<Date | null> {
  const [row] = await db
    .select({ first: min(evChargeSession.startAt) })
    .from(evChargeSession)
    .where(countedSessionFilter())
  return row?.first ?? null
}

/**
 * Start of the earliest counted session ending after `after`, or null. The
 * energy-mix derive widens its start day back with it, so a session spanning
 * midnight is always derived whole (ADR-0023).
 */
export async function earliestCountedStartEndingAfter(
  after: Date,
  dbOrTx: DbOrTx = db,
): Promise<Date | null> {
  const [row] = await dbOrTx
    .select({ first: min(evChargeSession.startAt) })
    .from(evChargeSession)
    .where(and(countedSessionFilter(), gt(evChargeSession.endAt, after)))
  return row?.first ?? null
}

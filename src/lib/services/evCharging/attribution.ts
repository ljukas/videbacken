import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/lib/db'
import { evChargeSession, vehicleChargeRecord } from '~/lib/db/schema'
import type { Vehicle, VehicleSource } from '~/lib/evCharging/vehicle'
import { countedSessionFilter } from './counted'
import { EvChargingDomainError } from './errors'

/**
 * Re-derives attribution from the car's own log (ADR-0021): every counted
 * session starting inside the log's coverage, not tagged by an admin, becomes
 * 'ours' when a non-public record overlaps it in time and 'other' otherwise.
 * One statement; rows already right aren't written (updated_at untouched).
 * `ours`/`other` count every session the rule decided, `changed` the rows written.
 */
export async function reattributeSessions(
  opts: { sessionId?: string } = {},
): Promise<{ ours: number; other: number; changed: number }> {
  const s = evChargeSession
  const r = vehicleChargeRecord
  const onlyOne = opts.sessionId ? sql`and ${s.id} = ${opts.sessionId}` : sql``
  const result = await db.execute<{ ours: string; other: string; changed: string }>(sql`
    with coverage as (
      select min(${r.startAt}) as from_at, max(${r.endAt}) as to_at from ${r}
    ),
    target as (
      select ${s.id} as id,
        case when exists (
          select 1 from ${r}
          where not ${r.isPublic} and ${r.startAt} < ${s.endAt} and ${r.endAt} > ${s.startAt}
        ) then 'ours' else 'other' end as vehicle
      from ${s}, coverage
      where coverage.from_at is not null
        and ${s.startAt} between coverage.from_at and coverage.to_at
        and ${s.vehicleSource} <> 'admin'
        and ${countedSessionFilter()}
        ${onlyOne}
    ),
    updated as (
      update ${s} set vehicle = target.vehicle, vehicle_source = 'skoda', updated_at = now()
      from target
      where ${s.id} = target.id
        and (${s.vehicle} <> target.vehicle or ${s.vehicleSource} <> 'skoda')
      returning ${s.id}
    )
    select
      count(*) filter (where target.vehicle = 'ours') as ours,
      count(*) filter (where target.vehicle = 'other') as other,
      (select count(*) from updated) as changed
    from target
  `)
  const row = result.rows[0]
  return {
    ours: Number(row?.ours ?? 0),
    other: Number(row?.other ?? 0),
    changed: Number(row?.changed ?? 0),
  }
}

/**
 * An admin's call on who charged. `null` ("Automatiskt") drops the tag back to
 * 'default' and lets the car's log decide again. Unknown, non-uuid or
 * uncounted ids are EV_SESSION_NOT_FOUND, like the session page.
 */
export async function setSessionVehicle(
  sessionId: string,
  vehicle: Vehicle | null,
): Promise<{ vehicle: Vehicle; vehicleSource: VehicleSource }> {
  if (!z.uuid().safeParse(sessionId).success)
    throw new EvChargingDomainError('EV_SESSION_NOT_FOUND')
  const [row] = await db
    .update(evChargeSession)
    .set(
      vehicle ? { vehicle, vehicleSource: 'admin' } : { vehicle: 'ours', vehicleSource: 'default' },
    )
    .where(and(eq(evChargeSession.id, sessionId), countedSessionFilter()))
    .returning({ vehicle: evChargeSession.vehicle, vehicleSource: evChargeSession.vehicleSource })
  if (!row) throw new EvChargingDomainError('EV_SESSION_NOT_FOUND')
  if (vehicle !== null) return row as { vehicle: Vehicle; vehicleSource: VehicleSource }
  // Reset: the re-match may have just re-decided this session, so read it back.
  await reattributeSessions({ sessionId })
  const [after] = await db
    .select({ vehicle: evChargeSession.vehicle, vehicleSource: evChargeSession.vehicleSource })
    .from(evChargeSession)
    .where(eq(evChargeSession.id, sessionId))
  return after as { vehicle: Vehicle; vehicleSource: VehicleSource }
}

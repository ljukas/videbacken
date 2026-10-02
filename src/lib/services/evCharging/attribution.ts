import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/lib/db'
import { evChargeSession, vehicleChargeRecord, vehicleStateSnapshot } from '~/lib/db/schema'
import type { Vehicle, VehicleSource } from '~/lib/evCharging/vehicle'
import { countedSessionFilter } from './counted'
import { EvChargingDomainError } from './errors'

/**
 * Re-derives attribution (ADR-0021, ADR-0022). Precedence: admin > the car's
 * exported log inside its coverage > the car's live state > default.
 * - Exported log: a counted session starting inside the log's coverage is
 *   'ours' when a non-public record overlaps it, else 'other' (source 'skoda').
 * - Live state, for sessions outside that coverage, ≥ 40 min long and with a
 *   reliable clock: each poll holds until the next one (≤ 20 min) and is *here*
 *   (plug CONNECTED, not known to be away) or *not here* (DISCONNECTED, moving,
 *   or parked elsewhere); unknown polls count for neither but still end the
 *   previous poll's interval. Over the session trimmed by 10 min at each end,
 *   once known time covers half of it, the majority decides, a tie going to
 *   ours (source 'skoda_live'). Otherwise the row is left as it is.
 *   Polls are read per window through a LATERAL bounded on polled_at (index),
 *   so the cost doesn't grow with the snapshot table.
 * One statement; rows already right aren't written (updated_at untouched).
 * `ours`/`other` count every session a rule decided, `changed` the rows written.
 */
export async function reattributeSessions(
  opts: { sessionId?: string } = {},
): Promise<{ ours: number; other: number; changed: number }> {
  // Any given sessionId narrows the pass (even ''); one that can't be a
  // session id decides nothing rather than raising a raw uuid cast error.
  if (opts.sessionId !== undefined && !z.uuid().safeParse(opts.sessionId).success) {
    return { ours: 0, other: 0, changed: 0 }
  }
  const s = evChargeSession
  // Cross-service reads of vehicle_charge_record (services/vehicleCharge) and
  // vehicle_state_snapshot (services/vehicleState): deliberate, read-only, see
  // ADR-0021 and ADR-0022.
  const r = vehicleChargeRecord
  const p = vehicleStateSnapshot
  const onlyOne = opts.sessionId !== undefined ? sql`and ${s.id} = ${opts.sessionId}` : sql``
  const result = await db.execute<{ ours: string; other: string; changed: string }>(sql`
    with coverage as (
      select min(${r.startAt}) as from_at, max(${r.endAt}) as to_at from ${r}
    ),
    candidate as (
      select ${s.id} as id, ${s.startAt} as start_at, ${s.endAt} as end_at,
        ${s.reliableClock} as reliable_clock,
        (coverage.from_at is not null
          and ${s.startAt} between coverage.from_at and coverage.to_at) as in_log
      from ${s}, coverage
      where ${s.vehicleSource} <> 'admin' and ${countedSessionFilter()} ${onlyOne}
    ),
    logged as (
      select c.id,
        case when exists (
          select 1 from ${r}
          where not ${r.isPublic} and ${r.startAt} < c.end_at and ${r.endAt} > c.start_at
        ) then 'ours' else 'other' end as vehicle,
        'skoda'::text as source
      from candidate c
      where c.in_log
    ),
    live_window as (
      select c.id, c.start_at + interval '10 minutes' as w_from, c.end_at - interval '10 minutes' as w_to
      from candidate c
      where not c.in_log and c.reliable_clock and c.end_at - c.start_at >= interval '40 minutes'
    ),
    live_evidence as (
      select w.id, w.w_from, w.w_to,
        coalesce(sum(x.overlap_s) filter (where x.class = 'here'), 0) as here_s,
        coalesce(sum(x.overlap_s) filter (where x.class = 'not_here'), 0) as away_s
      from live_window w
      cross join lateral (
        select extract(epoch from least(q.to_at, w.w_to) - greatest(q.from_at, w.w_from)) as overlap_s, q.class
        from (
          select ${p.polledAt} as from_at,
            least(
              coalesce(lead(${p.polledAt}) over (order by ${p.polledAt}, ${p.id}), ${p.polledAt} + interval '20 minutes'),
              ${p.polledAt} + interval '20 minutes'
            ) as to_at,
            case
              when ${p.atHome} = false or ${p.plugState} = 'DISCONNECTED' then 'not_here'
              when ${p.plugState} = 'CONNECTED' then 'here'
            end as class
          from ${p}
          -- A poll before w_from − 20 min ends before the window; one at or after
          -- w_to starts after it. Polls in between (unknown ones included) are
          -- all that lead() and the overlap can need.
          where ${p.polledAt} > w.w_from - interval '20 minutes' and ${p.polledAt} < w.w_to
        ) q
        where q.class is not null and q.from_at < w.w_to and q.to_at > w.w_from
      ) x
      group by w.id, w.w_from, w.w_to
    ),
    live as (
      select e.id, case when e.here_s >= e.away_s then 'ours' else 'other' end as vehicle,
        'skoda_live'::text as source
      from live_evidence e
      where e.here_s + e.away_s >= extract(epoch from e.w_to - e.w_from) / 2
    ),
    target as (
      select id, vehicle, source from logged
      union all
      select id, vehicle, source from live
    ),
    -- target reads a snapshot from statement start. If an admin tags (or a
    -- sync voids) a row while this UPDATE waits on its lock, READ COMMITTED
    -- re-checks only this WHERE against the new row version, so the admin and
    -- counted rules are repeated here, or the re-match would overwrite the tag.
    updated as (
      update ${s} set vehicle = target.vehicle, vehicle_source = target.source, updated_at = now()
      from target
      where ${s.id} = target.id
        and ${s.vehicleSource} <> 'admin'
        and ${countedSessionFilter()}
        and (${s.vehicle} <> target.vehicle or ${s.vehicleSource} <> target.source)
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
  // Reset: three statements, deliberately without a transaction. If the
  // re-match fails, the session is left as ours/default, a valid state the
  // next re-match (import or sync) decides. It may have just re-decided this
  // session, so read it back.
  await reattributeSessions({ sessionId })
  const [after] = await db
    .select({ vehicle: evChargeSession.vehicle, vehicleSource: evChargeSession.vehicleSource })
    .from(evChargeSession)
    .where(eq(evChargeSession.id, sessionId))
  return after as { vehicle: Vehicle; vehicleSource: VehicleSource }
}

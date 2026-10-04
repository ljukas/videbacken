import { inArray, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import type { ZaptecCharger, ZaptecSession } from '~/lib/evCharging/types'
import { logger } from '~/lib/logger/server'
import { requestDerive } from '~/lib/services/energyMix/deriveRequest'
import { isStockholmDay, stockholmDayOf } from '~/lib/time/stockholm'

// Chargers: `id` is the Zaptec charger id itself, so this is a plain upsert by
// primary key. Always overwrites name/installationId — this is how a
// previously-created stub charger (see `importSessions`) picks up its real
// name once Zaptec lists it again.
export async function upsertChargers(chargers: ZaptecCharger[]): Promise<void> {
  if (chargers.length === 0) return
  await db
    .insert(evCharger)
    .values(chargers.map((c) => ({ id: c.id, name: c.name, installationId: c.installationId })))
    .onConflictDoUpdate({
      target: evCharger.id,
      set: {
        name: sql`excluded.name`,
        installationId: sql`excluded.installation_id`,
        updatedAt: new Date(),
      },
    })
}

export async function listChargers(): Promise<
  { id: string; name: string; installationId: string }[]
> {
  return db
    .select({ id: evCharger.id, name: evCharger.name, installationId: evCharger.installationId })
    .from(evCharger)
    .orderBy(evCharger.name)
}

// The charger the live-status tile reads: the one with the newest session,
// i.e. the charger actually in use. A stub (see `importSessions`) or a
// decommissioned charger only has older sessions, so it never wins over the
// active one; with no sessions at all, the first by name.
export async function findLiveCharger(): Promise<{ id: string } | null> {
  const latestStart = sql`(select max(${evChargeSession.startAt}) from ${evChargeSession} where ${evChargeSession.chargerId} = ${evCharger.id})`
  const [row] = await db
    .select({ id: evCharger.id })
    .from(evCharger)
    .orderBy(sql`${latestStart} desc nulls last`, evCharger.name)
    .limit(1)
  return row ?? null
}

const INTERVAL_INSERT_BATCH = 5_000

export type ImportSessionsResult = {
  upserted: number
  voided: number
  skipped: number
  /**
   * Earliest start (old or new) of a session this page added, or changed in a
   * way the energy mix depends on (times, energy, intervals, void/replaced);
   * null when it changed none. The Zaptec sync re-derives from its day (ADR-0023).
   */
  earliestChangedStartAt: Date | null
}

type StoredSession = {
  id: string
  zaptecSessionId: string
  startAt: Date
  endAt: Date
  energyKwh: number
  voided: boolean
  replacedByZaptecSessionId: string | null
}
type StoredInterval = { sessionId: string; startAt: Date; endAt: Date; energyKwh: number }

const intervalKey = (iv: { startAt: Date; endAt: Date; energyKwh: number }) =>
  `${iv.startAt.getTime()}/${iv.endAt.getTime()}/${iv.energyKwh}`

function earliestChangedStart(
  incoming: readonly ZaptecSession[],
  stored: readonly StoredSession[],
  storedIntervals: readonly StoredInterval[],
): Date | null {
  const byZaptecId = new Map(stored.map((s) => [s.zaptecSessionId, s]))
  const intervalsBySession = Map.groupBy(storedIntervals, (iv) => iv.sessionId)
  let earliest: number | null = null
  const consider = (ms: number) => {
    if (earliest === null || ms < earliest) earliest = ms
  }
  for (const s of incoming) {
    const old = byZaptecId.get(s.id)
    if (!old) {
      consider(s.startAt.getTime())
      continue
    }
    const oldIntervals = (intervalsBySession.get(old.id) ?? []).map(intervalKey).sort().join()
    const newIntervals = s.intervals.map(intervalKey).sort().join()
    const changed =
      old.startAt.getTime() !== s.startAt.getTime() ||
      old.endAt.getTime() !== s.endAt.getTime() ||
      old.energyKwh !== s.energyKwh ||
      old.voided !== s.voided ||
      old.replacedByZaptecSessionId !== s.replacedBySessionId ||
      oldIntervals !== newIntervals
    if (changed) {
      consider(old.startAt.getTime())
      consider(s.startAt.getTime())
    }
  }
  return earliest === null ? null : new Date(earliest)
}

// A session/interval must satisfy the table CHECKs before it ever reaches the
// DB. Checked in JS (not just relying on the CHECK constraints) so one bad
// row can be skipped without rolling back — or even attempting — the rest of
// the page's transaction.
function isValidSession(session: ZaptecSession): boolean {
  if (session.energyKwh < 0) return false
  if (session.endAt < session.startAt) return false
  for (const interval of session.intervals) {
    if (interval.energyKwh < 0) return false
    if (interval.endAt <= interval.startAt) return false
  }
  return true
}

// Columns the sync run (Zaptec) owns and may overwrite on re-import. Later
// phases add admin-owned columns (e.g. a vehicle assignment) to
// `ev_charge_session` that must survive a re-sync untouched, so the update
// set is an explicit allow-list rather than "all columns".
function zaptecOwnedSessionUpdateSet(now: Date) {
  return {
    startAt: sql`excluded.start_at`,
    endAt: sql`excluded.end_at`,
    energyKwh: sql`excluded.energy_kwh`,
    authorizedUserEmail: sql`excluded.authorized_user_email`,
    authorizedUserName: sql`excluded.authorized_user_name`,
    tokenName: sql`excluded.token_name`,
    voided: sql`excluded.voided`,
    replacedByZaptecSessionId: sql`excluded.replaced_by_zaptec_session_id`,
    offline: sql`excluded.offline`,
    reliableClock: sql`excluded.reliable_clock`,
    chargerId: sql`excluded.charger_id`,
    updatedAt: now,
  }
}

// Imports one page of Zaptec sessions in a single transaction (the sync run
// calls this once per page). Invalid sessions are filtered out beforehand and
// counted in `skipped` — never thrown — so one bad row never rolls back the
// rest of the page; the DB CHECKs remain a backstop. An unknown `chargerId`
// gets a stub `ev_charger` row (id/name = the charger id) instead of being
// skipped; `upsertChargers` later fills in the real name for chargers Zaptec
// still lists.
export async function importSessions(
  sessions: ZaptecSession[],
  ctx: { installationId: string },
): Promise<ImportSessionsResult> {
  const validSessions: ZaptecSession[] = []
  let skipped = 0
  for (const session of sessions) {
    if (isValidSession(session)) {
      validSessions.push(session)
    } else {
      skipped += 1
      logger.warn('evCharging: skipping invalid session on import', {
        zaptecSessionId: session.id,
      })
    }
  }
  if (validSessions.length === 0) {
    return { upserted: 0, voided: 0, skipped, earliestChangedStartAt: null }
  }

  const voided = validSessions.filter((s) => s.voided).length
  const now = new Date()
  let earliestChangedStartAt: Date | null = null

  await db.transaction(async (tx) => {
    const chargerIds = [...new Set(validSessions.map((s) => s.chargerId))]
    await tx
      .insert(evCharger)
      .values(chargerIds.map((id) => ({ id, name: id, installationId: ctx.installationId })))
      .onConflictDoNothing({ target: evCharger.id })

    // What the page changes, compared before the upsert overwrites it: the
    // energy-mix derive starts from the earliest changed session (ADR-0023).
    const stored = await tx
      .select({
        id: evChargeSession.id,
        zaptecSessionId: evChargeSession.zaptecSessionId,
        startAt: evChargeSession.startAt,
        endAt: evChargeSession.endAt,
        energyKwh: evChargeSession.energyKwh,
        voided: evChargeSession.voided,
        replacedByZaptecSessionId: evChargeSession.replacedByZaptecSessionId,
      })
      .from(evChargeSession)
      .where(
        inArray(
          evChargeSession.zaptecSessionId,
          validSessions.map((s) => s.id),
        ),
      )
    const storedIntervals =
      stored.length === 0
        ? []
        : await tx
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
                stored.map((s) => s.id),
              ),
            )
    earliestChangedStartAt = earliestChangedStart(validSessions, stored, storedIntervals)
    const changedDay = earliestChangedStartAt
      ? stockholmDayOf(earliestChangedStartAt.getTime())
      : null
    // Queued with the change itself (ADR-0023): if the run dies before its
    // derive, the next derive still covers this page. A start outside the
    // calendar the derive handles (a charger clock reset to 0001 or 1970) is a
    // glitch with no house data: queuing it would only fail the import.
    if (changedDay !== null && isStockholmDay(changedDay)) await requestDerive(changedDay, tx)

    const sessionRows = await tx
      .insert(evChargeSession)
      .values(
        validSessions.map((s) => ({
          zaptecSessionId: s.id,
          chargerId: s.chargerId,
          startAt: s.startAt,
          endAt: s.endAt,
          energyKwh: s.energyKwh,
          authorizedUserEmail: s.authorizedUser?.email ?? null,
          authorizedUserName: s.authorizedUser?.name ?? null,
          tokenName: s.tokenName,
          voided: s.voided,
          replacedByZaptecSessionId: s.replacedBySessionId,
          offline: s.offline,
          reliableClock: s.reliableClock,
        })),
      )
      .onConflictDoUpdate({
        target: evChargeSession.zaptecSessionId,
        set: zaptecOwnedSessionUpdateSet(now),
      })
      .returning({ id: evChargeSession.id, zaptecSessionId: evChargeSession.zaptecSessionId })

    const sessionIdByZaptecId = new Map(sessionRows.map((r) => [r.zaptecSessionId, r.id]))
    const sessionDbIds = sessionRows.map((r) => r.id)

    // Delete + re-insert intervals rather than diffing: cheap at Zaptec's
    // per-session interval counts, and guarantees no stale rows survive a
    // changed interval set.
    await tx.delete(evChargeInterval).where(inArray(evChargeInterval.sessionId, sessionDbIds))

    const intervalRows = validSessions.flatMap((s) => {
      const sessionId = sessionIdByZaptecId.get(s.id)
      if (!sessionId) return []
      return s.intervals.map((iv) => ({
        sessionId,
        startAt: iv.startAt,
        endAt: iv.endAt,
        energyKwh: iv.energyKwh,
      }))
    })
    // Batched: 4 params per row, and Postgres's wire protocol caps a statement
    // at 65,535 bound params — a page of long sessions could otherwise exceed it.
    for (let i = 0; i < intervalRows.length; i += INTERVAL_INSERT_BATCH) {
      await tx.insert(evChargeInterval).values(intervalRows.slice(i, i + INTERVAL_INSERT_BATCH))
    }
  })

  return { upserted: validSessions.length, voided, skipped, earliestChangedStartAt }
}

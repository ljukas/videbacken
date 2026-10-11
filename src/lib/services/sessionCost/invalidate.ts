import { sql } from 'drizzle-orm'
import { type DbOrTx, db } from '~/lib/db'
import { evChargeInterval, evChargeSession, evSessionCost } from '~/lib/db/schema'

// A leaf of the sessionCost service (ADR-0020, amended 2026-10-11): the
// evCharging, energyMix, spotPrice and tariff services bump inside their own
// write transactions, and sessionCost.ts imports the evCharging service, so
// this must not. A bump makes a session's stored cost stale until it is
// repriced; bumping too many only costs a reprice, too few shows a stale
// figure. Every bump locks rows in session_id order, as the write-back does,
// so two of them never deadlock.

/** Bumps these sessions (duplicates ignored), creating their rows as needed. */
export async function bumpSessions(
  sessionIds: readonly string[],
  dbOrTx: DbOrTx = db,
): Promise<void> {
  const ids = [...new Set(sessionIds)].sort()
  if (ids.length === 0) return
  await dbOrTx
    .insert(evSessionCost)
    .values(ids.map((sessionId) => ({ sessionId, generation: 1 })))
    .onConflictDoUpdate({
      target: evSessionCost.sessionId,
      set: { generation: sql`${evSessionCost.generation} + 1` },
    })
}

/**
 * Bumps every session whose energy may lie in `[startMs, endMs)`: one with an
 * interval overlapping it, or whose own window does (an interval-less session
 * is priced over its window). A mix slot lies inside its session's stretches.
 */
export async function bumpOverlapping(
  range: { startMs: number; endMs: number },
  dbOrTx: DbOrTx = db,
): Promise<void> {
  const start = new Date(range.startMs).toISOString()
  const end = new Date(range.endMs).toISOString()
  await dbOrTx.execute(sql`
    INSERT INTO ${evSessionCost} (session_id, generation)
    SELECT id, 1 FROM (
      SELECT ${evChargeSession.id} AS id FROM ${evChargeSession}
       WHERE ${evChargeSession.startAt} < ${end}::timestamptz
         AND ${evChargeSession.endAt} > ${start}::timestamptz
      UNION
      SELECT ${evChargeInterval.sessionId} FROM ${evChargeInterval}
       WHERE ${evChargeInterval.startAt} < ${end}::timestamptz
         AND ${evChargeInterval.endAt} > ${start}::timestamptz
    ) AS overlapping
    ORDER BY id
    ON CONFLICT (session_id) DO UPDATE SET generation = ${evSessionCost.generation} + 1
  `)
}

/**
 * Bumps every session (a tariff edit), creating rows as needed: a session
 * without a row must get one too, or a repricer that read it without a row
 * before this commit could store its old-tariff price as current.
 */
export async function bumpAll(dbOrTx: DbOrTx = db): Promise<void> {
  await dbOrTx.execute(sql`
    INSERT INTO ${evSessionCost} (session_id, generation)
    SELECT ${evChargeSession.id}, 1 FROM ${evChargeSession}
    ORDER BY ${evChargeSession.id}
    ON CONFLICT (session_id) DO UPDATE SET generation = ${evSessionCost.generation} + 1
  `)
}

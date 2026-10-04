import { asc, inArray, lte, max, min, not, sql } from 'drizzle-orm'
import { type DbOrTx, type DbTransaction, db } from '~/lib/db'
import { energyMixDeriveRequest, evChargeEnergyMix, evChargeSession } from '~/lib/db/schema'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import { countedSessionFilter } from '~/lib/services/evCharging/counted'
import { isStockholmDay } from '~/lib/time/stockholm'

// The stored energy mix of charging sessions (ADR-0023): per session × 15-min
// slot, kWh by origin. Written only by the derive; read by the cost model.

/** The transaction a derive runs in (see `withDeriveLock`). */
export type DeriveTx = DbTransaction
export type MixRow = MixSlot & { sessionId: string }

/** 11 bound parameters per row: keeps one INSERT far under Postgres's 65 535. */
export const MIX_INSERT_BATCH = 2_000

/**
 * Runs `fn` in one transaction holding the derive lock, so derives run one at a
 * time and each reads what the previous one committed: a derive can never
 * overwrite a newer one's rows with older data. A transaction-scoped advisory
 * lock — unlike a session lock it is safe behind Supabase's transaction pooler
 * (ADR-0019's lease note). The timeouts keep a stuck derive from holding it:
 * a lock wait fails after 20 s, a statement after 25 s (both under the pool's
 * 30 s query_timeout), and a session left idle inside the transaction (an
 * instance frozen after its response) is ended after 60 s, releasing the lock.
 * A live derive is never idle that long: its compute between statements takes
 * milliseconds. A derive that fails any of these leaves its request queued
 * (`requestDerive`), so the next derive covers it.
 */
export async function withDeriveLock<T>(fn: (tx: DeriveTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '20s'`)
    await tx.execute(sql`SET LOCAL statement_timeout = '25s'`)
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '60s'`)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('videbacken.energy_mix_derive'))`)
    return fn(tx)
  })
}

/**
 * Replaces the mix of `sessionIds` with `rows`: delete them all, then insert in
 * batches, atomically (its own transaction, or the caller's). A row for a
 * session outside `sessionIds` is a programming error: RangeError, nothing
 * written.
 */
export async function replaceForSessions(
  sessionIds: readonly string[],
  rows: readonly MixRow[],
  dbOrTx: DbOrTx = db,
): Promise<void> {
  const ids = new Set(sessionIds)
  if (rows.some((r) => !ids.has(r.sessionId))) {
    throw new RangeError('Energy mix row for a session that is not being replaced')
  }
  if (ids.size === 0) return
  const write = async (tx: DbOrTx) => {
    await tx.delete(evChargeEnergyMix).where(inArray(evChargeEnergyMix.sessionId, [...ids]))
    for (let i = 0; i < rows.length; i += MIX_INSERT_BATCH) {
      await tx.insert(evChargeEnergyMix).values(rows.slice(i, i + MIX_INSERT_BATCH))
    }
  }
  if (dbOrTx === db) await db.transaction(write)
  else await write(dbOrTx)
}

/** The stored mix per session, slots ascending; sessions without rows are absent. One query. */
export async function listForSessions(
  sessionIds: readonly string[],
): Promise<Map<string, MixSlot[]>> {
  const bySession = new Map<string, MixSlot[]>()
  if (sessionIds.length === 0) return bySession
  const rows = await db
    .select()
    .from(evChargeEnergyMix)
    .where(inArray(evChargeEnergyMix.sessionId, [...sessionIds]))
    .orderBy(asc(evChargeEnergyMix.sessionId), asc(evChargeEnergyMix.slotStart))
  for (const { sessionId, ...slot } of rows) {
    const list = bySession.get(sessionId)
    if (list) list.push(slot)
    else bySession.set(sessionId, [slot])
  }
  return bySession
}

/**
 * Deletes the mix of every session that is no longer counted (voided,
 * replaced, under the noise threshold), whenever it ended: a derive rewrites
 * counted sessions only, so their old rows would otherwise linger. Returns
 * how many rows went.
 */
export async function pruneUncounted(dbOrTx: DbOrTx = db): Promise<number> {
  const uncounted = dbOrTx
    .select({ id: evChargeSession.id })
    .from(evChargeSession)
    .where(not(countedSessionFilter()))
  const deleted = await dbOrTx
    .delete(evChargeEnergyMix)
    .where(inArray(evChargeEnergyMix.sessionId, uncounted))
    .returning({ sessionId: evChargeEnergyMix.sessionId })
  return deleted.length
}

function assertDay(day: string): void {
  if (!isStockholmDay(day)) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
}

/**
 * Queues a derive from Stockholm `day` (ADR-0023). A sync calls it for what it
 * stored, before running the derive, so the request outlives a derive that
 * fails. Committed on its own, outside any derive's lock.
 */
export async function requestDerive(day: string, dbOrTx: DbOrTx = db): Promise<void> {
  assertDay(day)
  await dbOrTx.insert(energyMixDeriveRequest).values({ fromDay: day })
}

/** The queued derive requests as one: the earliest day, and the highest id seen. */
export type PendingDerive = { fromDay: string; throughId: number }

/** Reads the queue inside the derive's transaction; null when it is empty. */
export async function pendingDerive(tx: DeriveTx): Promise<PendingDerive | null> {
  const [row] = await tx
    .select({
      fromDay: min(energyMixDeriveRequest.fromDay),
      throughId: max(energyMixDeriveRequest.id),
    })
    .from(energyMixDeriveRequest)
  if (!row?.fromDay || row.throughId === null) return null
  return { fromDay: row.fromDay, throughId: row.throughId }
}

/**
 * Drops the requests a derive covered (ids up to `throughId`), in its
 * transaction: a request queued meanwhile has a higher id and stays.
 */
export async function clearDeriveRequests(throughId: number, tx: DeriveTx): Promise<void> {
  await tx.delete(energyMixDeriveRequest).where(lte(energyMixDeriveRequest.id, throughId))
}

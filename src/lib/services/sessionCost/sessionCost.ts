import { and, asc, eq, inArray, not, type SQL, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { evChargeSession, evSessionCost, evSessionCostMonth } from '~/lib/db/schema'
import { type CostTotals, emptyTotals } from '~/lib/evCharging/cost'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { countedSessionFilter } from '~/lib/services/evCharging'

// Stored charging cost per session and Stockholm month (ADR-0020, amended
// 2026-10-11). Totals are read only while current (`priced_generation =
// generation` at the code's PRICING_VERSION); stale sessions come back as ids
// with the generation read in the same statement, so a repricer can write
// them back under the guard in `writePriced`. Bumps: ./invalidate.ts.

/** A session's generation as read; null when it has no ev_session_cost row. */
export type SessionGeneration = { sessionId: string; generation: number | null }
export type MonthTotals = { year: number; month: number; totals: CostTotals }
export type StoredSessionCost = { sessionId: string; estimated: boolean; totals: CostTotals }
/** A priced session to store: its generation as read before pricing, and its months. */
export type PricedForStore = SessionGeneration & { estimated: boolean; months: MonthTotals[] }

const TOTAL_FIELDS = [
  'kwh',
  'gridKwh',
  'fullKwh',
  'noPriceKwh',
  'noTariffKwh',
  'spotSek',
  'feesSek',
  'totalSek',
  'solarKwh',
  'batteryKwh',
  'noHouseDataKwh',
  'solarValueSek',
  'solarPricedKwh',
  'solarUnpricedKwh',
] as const satisfies readonly (keyof CostTotals)[]

/** 17 bound parameters per month row: keeps one INSERT far under Postgres's 65 535. */
const MONTH_INSERT_BATCH = 2_000

/** The current-totals predicate (false for a session without a row). */
function isCurrent(pricingVersion: number): SQL<boolean> {
  return sql<boolean>`coalesce(${evSessionCost.pricedGeneration} = ${evSessionCost.generation}
    AND ${evSessionCost.pricingVersion} = ${pricingVersion}, false)`
}

/** `sum(<column>)` for every total, keyed by field. Null when no current month row joined. */
function sums() {
  return Object.fromEntries(
    TOTAL_FIELDS.map((f) => [f, sql<number | null>`sum(${evSessionCostMonth[f]})`]),
  ) as Record<(typeof TOTAL_FIELDS)[number], SQL<number | null>>
}

/** Every total's month column, keyed by field. */
function totalColumns() {
  return Object.fromEntries(TOTAL_FIELDS.map((f) => [f, evSessionCostMonth[f]])) as Pick<
    typeof evSessionCostMonth,
    (typeof TOTAL_FIELDS)[number]
  >
}

function toTotals(row: Record<(typeof TOTAL_FIELDS)[number], number | null>): CostTotals {
  const totals = emptyTotals()
  for (const f of TOTAL_FIELDS) totals[f] = row[f] ?? 0
  return totals
}

/**
 * The stored totals per Stockholm month over every current counted session in
 * `vehicle`'s scope, and the stale sessions with their generations — from one
 * statement, so one snapshot: no session is counted twice or not at all.
 */
export async function readMonthSums(input: {
  vehicle?: VehicleScope
  pricingVersion: number
}): Promise<{ months: MonthTotals[]; stale: SessionGeneration[] }> {
  const current = isCurrent(input.pricingVersion)
  const rows = await db
    .select({
      staleId: sql<string | null>`CASE WHEN ${current} THEN NULL ELSE ${evChargeSession.id} END`,
      staleGeneration: sql<number | null>`CASE WHEN ${current} THEN NULL
        ELSE ${evSessionCost.generation} END`,
      year: evSessionCostMonth.year,
      month: evSessionCostMonth.month,
      ...sums(),
    })
    .from(evChargeSession)
    .leftJoin(evSessionCost, eq(evSessionCost.sessionId, evChargeSession.id))
    .leftJoin(
      evSessionCostMonth,
      and(eq(evSessionCostMonth.sessionId, evChargeSession.id), current),
    )
    .where(countedSessionFilter({ vehicle: input.vehicle }))
    // By position: the CASE expressions carry bound parameters, which a
    // repeated expression would renumber.
    .groupBy(sql.raw('1'), sql.raw('2'), sql.raw('3'), sql.raw('4'))

  const months: MonthTotals[] = []
  const stale: SessionGeneration[] = []
  for (const row of rows) {
    if (row.staleId !== null)
      stale.push({ sessionId: row.staleId, generation: row.staleGeneration })
    else if (row.year !== null && row.month !== null) {
      months.push({ year: row.year, month: row.month, totals: toTotals(row) })
    }
  }
  months.sort((a, b) => a.year - b.year || a.month - b.month)
  return { months, stale }
}

/**
 * These sessions' stored totals summed over their months (current ones) and
 * the stale ones with their generations, in one statement. Uncounted or
 * unknown ids are dropped.
 */
export async function readSessionSums(input: {
  sessionIds: readonly string[]
  pricingVersion: number
}): Promise<{ current: StoredSessionCost[]; stale: SessionGeneration[] }> {
  if (input.sessionIds.length === 0) return { current: [], stale: [] }
  const current = isCurrent(input.pricingVersion)
  const rows = await db
    .select({
      sessionId: evChargeSession.id,
      isCurrent: sql<boolean>`bool_or(${current})`,
      generation: sql<number | null>`max(${evSessionCost.generation})`,
      estimated: sql<boolean | null>`bool_or(${evSessionCost.estimated})`,
      ...sums(),
    })
    .from(evChargeSession)
    .leftJoin(evSessionCost, eq(evSessionCost.sessionId, evChargeSession.id))
    .leftJoin(
      evSessionCostMonth,
      and(eq(evSessionCostMonth.sessionId, evChargeSession.id), current),
    )
    .where(and(countedSessionFilter(), inArray(evChargeSession.id, [...input.sessionIds])))
    .groupBy(evChargeSession.id)

  const out = { current: [] as StoredSessionCost[], stale: [] as SessionGeneration[] }
  for (const row of rows) {
    if (row.isCurrent) {
      out.current.push({
        sessionId: row.sessionId,
        estimated: row.estimated ?? false,
        totals: toTotals(row),
      })
    } else {
      out.stale.push({ sessionId: row.sessionId, generation: row.generation })
    }
  }
  return out
}

/** Every stale counted session (any vehicle), oldest first: what `repriceStale` prices. */
export async function listStale(input: { pricingVersion: number }): Promise<SessionGeneration[]> {
  return db
    .select({ sessionId: evChargeSession.id, generation: evSessionCost.generation })
    .from(evChargeSession)
    .leftJoin(evSessionCost, eq(evSessionCost.sessionId, evChargeSession.id))
    .where(and(countedSessionFilter(), not(isCurrent(input.pricingVersion))))
    .orderBy(asc(evChargeSession.startAt), asc(evChargeSession.id))
}

/**
 * The stored month rows of every current counted session (any vehicle), from
 * one statement: what `scripts/checkSessionCosts.ts` compares with on-read
 * pricing. A current session without month rows (nothing to price) is absent.
 */
export async function listCurrentMonths(input: {
  pricingVersion: number
}): Promise<{ sessionId: string; months: MonthTotals[] }[]> {
  const rows = await db
    .select({
      sessionId: evSessionCostMonth.sessionId,
      year: evSessionCostMonth.year,
      month: evSessionCostMonth.month,
      ...totalColumns(),
    })
    .from(evChargeSession)
    .innerJoin(evSessionCost, eq(evSessionCost.sessionId, evChargeSession.id))
    .innerJoin(evSessionCostMonth, eq(evSessionCostMonth.sessionId, evChargeSession.id))
    .where(and(countedSessionFilter(), isCurrent(input.pricingVersion)))
    .orderBy(
      asc(evChargeSession.startAt),
      asc(evChargeSession.id),
      asc(evSessionCostMonth.year),
      asc(evSessionCostMonth.month),
    )

  const out: { sessionId: string; months: MonthTotals[] }[] = []
  for (const row of rows) {
    let last = out.at(-1)
    if (last?.sessionId !== row.sessionId) {
      last = { sessionId: row.sessionId, months: [] }
      out.push(last)
    }
    last.months.push({ year: row.year, month: row.month, totals: toTotals(row) })
  }
  return out
}

/**
 * Stores priced sessions, each only if its generation is still the one read
 * before pricing (a bump since then means newer inputs: the session stays
 * stale). A session read without a row counts as generation 0: its row is
 * inserted unless a writer created one meanwhile (generation ≥ 1 then). One
 * transaction, and one upsert that locks the state rows in session_id order,
 * the order every bump uses, so a write-back and a writer never deadlock. A
 * session deleted meanwhile is skipped, one already current at this
 * generation is not rewritten, and a duplicate id is stored once (its first
 * entry). Waits at most `lockTimeoutMs` (default 1 s) for a lock (a writer's
 * transaction, e.g. a derive, can hold bumped rows for seconds), 5 s for a
 * statement and 5 s idle inside the transaction, so a write-back abandoned
 * past its caller's budget can't hold row locks: a timeout throws, and the
 * callers treat a failed write-back as best effort. Returns how many sessions
 * were written.
 */
export async function writePriced(input: {
  pricingVersion: number
  sessions: readonly PricedForStore[]
  lockTimeoutMs?: number
}): Promise<{ written: number }> {
  // Deduped: a second proposed row for one session would fail the upsert
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  const unique = new Map<string, PricedForStore>()
  for (const s of input.sessions) if (!unique.has(s.sessionId)) unique.set(s.sessionId, s)
  const sorted = [...unique.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
  if (sorted.length === 0) return { written: 0 }
  const pgArray = (xs: readonly (string | number | boolean)[]) => `{${xs.join(',')}}`
  const lockTimeout = `${Math.round(input.lockTimeoutMs ?? 1000)}ms`

  return db.transaction(async (tx) => {
    // Transaction-local (set_config's `true`), in one round trip.
    await tx.execute(sql`SELECT set_config('lock_timeout', ${lockTimeout}, true),
      set_config('statement_timeout', '5s', true),
      set_config('idle_in_transaction_session_timeout', '5s', true)`)
    // EXCLUDED.generation carries the generation read before pricing.
    const { rows } = await tx.execute<{ session_id: string }>(sql`
      INSERT INTO ${evSessionCost}
             (session_id, generation, priced_generation, pricing_version, estimated)
      SELECT v.session_id, v.generation, v.generation, ${input.pricingVersion}, v.estimated
        FROM unnest(
               ${pgArray(sorted.map((s) => s.sessionId))}::uuid[],
               ${pgArray(sorted.map((s) => s.generation ?? 0))}::int[],
               ${pgArray(sorted.map((s) => s.estimated))}::boolean[]
             ) AS v(session_id, generation, estimated)
        JOIN ${evChargeSession} ON ${evChargeSession.id} = v.session_id
       ORDER BY v.session_id
      ON CONFLICT (session_id) DO UPDATE
         SET priced_generation = EXCLUDED.priced_generation,
             pricing_version = EXCLUDED.pricing_version,
             estimated = EXCLUDED.estimated
       WHERE ${evSessionCost.generation} = EXCLUDED.generation
         AND (${evSessionCost.pricedGeneration} IS DISTINCT FROM EXCLUDED.priced_generation
           OR ${evSessionCost.pricingVersion} IS DISTINCT FROM EXCLUDED.pricing_version)
      RETURNING session_id
    `)
    const won = new Set(rows.map((r) => r.session_id))

    if (won.size > 0) {
      await tx.delete(evSessionCostMonth).where(inArray(evSessionCostMonth.sessionId, [...won]))
      const rows = sorted
        .filter((s) => won.has(s.sessionId))
        .flatMap((s) =>
          s.months.map((m) => ({
            sessionId: s.sessionId,
            year: m.year,
            month: m.month,
            ...Object.fromEntries(TOTAL_FIELDS.map((f) => [f, m.totals[f]])),
          })),
        ) as (typeof evSessionCostMonth.$inferInsert)[]
      for (let i = 0; i < rows.length; i += MONTH_INSERT_BATCH) {
        await tx.insert(evSessionCostMonth).values(rows.slice(i, i + MONTH_INSERT_BATCH))
      }
    }
    return { written: won.size }
  })
}

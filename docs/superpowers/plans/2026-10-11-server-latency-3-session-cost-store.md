# Server latency step 3: stored session costs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `evCharging/costOverview` and the `sessions` list's page costs read stored per-session, per-month cost
totals instead of repricing history on every request. Warm `costOverview` goes from 117–125 ms to ≤ 40 ms on prod.

**Architecture:** A new `sessionCost` service owns `ev_session_cost` (per session: `generation`,
`priced_generation`, `pricing_version`, `estimated`) and `ev_session_cost_month` (`CostTotals` per session ×
Stockholm month). Every writer of a cost input bumps the affected sessions' `generation` in its own transaction. A
session's totals are read only while `priced_generation = generation` and `pricing_version = PRICING_VERSION`.
Stale sessions are priced on read by the existing TS pricing and written back under a generation guard, and
`repriceStale` reprices them eagerly after each sync and tariff edit.

**Tech Stack:** Drizzle ORM 0.45 (node-postgres), drizzle-kit, Postgres 17 (local) / Supabase (prod), Vitest
node project with `setupDatabase()`, oRPC.

**Spec:** [`docs/superpowers/specs/2026-10-11-session-cost-store-design.md`](../specs/2026-10-11-session-cost-store-design.md).
Roadmap: [server latency](../roadmaps/2026-10-07-server-latency.md), row 3. One session, one PR.

**Hat:** feature (new tables, a new write path; behavior-preserving for the pages). Follow
`docs/feature-workflow.md` from Phase 3 (Isolate). Worktree `.claude/worktrees/session-cost-store`, branch
`perf/session-cost-store` (from `origin/main` 7018dab, holds the spec commit). PR title:
`perf(charging): store priced session costs per month`.

## Global Constraints

- Every `pgTable(...)` ends with `.enableRLS()` (`test/rls.test.ts` enforces it); re-export the new schema file from
  `src/lib/db/schema/index.ts` (drizzle-kit reads only the barrel).
- Migrations: `bun run db:generate --name=<desc>` then `bun run db:migrate`. Never hand-edit `drizzle/meta/`.
- Schema changes get **`migration-guard` and the schema-design review** (a `general-purpose` subagent loading
  `supabase-postgres-best-practices`) right after Task 1, before anything builds on the tables (Non-negotiable).
- All DB access through `src/lib/services/` (ADR-0002). No `console.*` in `src/` (logging via `~/lib/logger`);
  scripts under `scripts/` may print.
- Writers of cost inputs import the invalidation leaf `~/lib/services/sessionCost/invalidate` directly, never the
  `sessionCost` barrel: the barrel imports the evCharging service, which would be an import cycle (the
  `energyMix/deriveRequest` pattern).
- Every multi-row lock on `ev_session_cost` is taken in `session_id` order (bumps, write-back), so two of them can
  never deadlock.
- `PRICING_VERSION = 1`, beside `priceIntervals`; bump it with any change to what `priceIntervals` or `toIntervals`
  compute.
- Reprice budget after a sync: `REPRICE_BUDGET_MS = 10_000` (240 run + 10 refresh + 30 derive + 10 = 290 s < 300 s).
- Equality tolerance between stored and on-read totals: `1e-9` relative per field (`|a − b| ≤ 1e-9 · max(1, |a|)`).
- Unchanged: the `sessions` and `costOverview` response shapes, `costs: null` on a cost failure, the session page's
  cash-cost hero (`getSessionEconomy`) and `/charging/economy`.
- Commits: Conventional Commits, ≤72 chars, imperative; `git add <paths>`, never `-A`; end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. After each commit paste
  `git log --oneline -3` and `git show --stat HEAD` into the task report.
- Never run vitest while a reviewer does (shared local DB; per-worker schema names collide).
- Tests need the local DB: `bun run db:up && bun run db:migrate` (from the worktree).

## Review Focus

1. **The read snapshot.** The stored sums and the stale ids must come from **one statement**. Two queries could see a
   session repriced or bumped between them and count it twice or not at all. Task 2 builds `readMonthSums` and
   `readSessionSums` as single statements; reviewers check that no later change splits them.
2. **The write-back race.** A writer committing between the repricer's generation read and its write-back must leave
   the session stale, never current with old totals. The repricer reads generations **before** inputs. Task 2 pins
   it: a bump between `readSessionSums` and `writePriced` makes `writePriced` write nothing for that session.
3. **A writer that doesn't bump.** Any path that changes intervals, mix, spot slots or tariffs without bumping leaves
   a stale figure on screen forever. Task 3 pins each writer, including a rolled-back write (no bump) and a spot
   day that misses a session (no bump). Reviewers grep for other writers of `ev_charge_interval`,
   `ev_charge_energy_mix`, `spot_price` and `electricity_tariff`.
4. **Stored ≠ on-read figures.** Per-session month totals summed in SQL differ from today's whole-month pricing only
   by float order. Task 4 runs every existing costing test through both paths (`pricedTwice`), so any bucketing
   difference fails a test that already pins figures (month boundary, interval-less sessions, mix pieces, vehicle
   scope).
5. **Deadlocks between a sync's bump and a write-back.** Both lock several `ev_session_cost` rows. Every path is one
   statement that locks in `session_id` order (Global Constraints; the write-back is a single sorted upsert, not
   lock-then-insert, per the schema review). Reviewers check `bumpSessions`, `bumpOverlapping`, `bumpAll` and
   `writePriced`.

---

### Task 0: Verify main and re-measure the baseline

**Files:** none committed (a throwaway bench script, deleted in Task 6).

- [ ] **Step 1: Confirm the code still matches the spec**

Run:
```bash
git fetch -q origin && git log --oneline -3 origin/main && ls drizzle/*.sql | tail -2 \
  && grep -n "export async function getCostOverview\|export async function getSessionCosts" src/lib/evCharging/costing.ts
```
Expected: both functions present; the last migration is `0025_comfort_cloud_sync.sql`. If `origin/main` has a newer
migration (a parallel session), `git rebase origin/main` first so ours gets the next number.

- [ ] **Step 2: Prod baseline (read-only)**

Fetch the last 72 h of `rpc timing` lines in 15-minute windows (halve a window that returns 5,000), de-duplicate by
`requestId`, and parse every `logs[].message` of each entry, not only `message`:

```bash
vercel logs --project videbacken --scope lukas-lindqvists-projects --environment production --no-branch \
  --since <ISO start> --until <ISO end> --limit 5000 --json -q "rpc timing"
```

For `procedure` `evCharging/costOverview` record n and min / median / max of `totalMs`, `costSlotsMs`,
`costMixMs`, `costComputeMs`; for `evCharging/sessions` the same for `totalMs` and `sessionCostsMs`. Check each
line's deployment is current `main`. Keep the numbers for Task 6.

- [ ] **Step 3: Local baseline**

Create `.bench-cost.ts` in the worktree root (path aliases resolve there; `.env` supplies the local DB):

```ts
// .bench-cost.ts — throwaway, never commit
import { getCostOverview, getSessionCosts } from '~/lib/evCharging/costing'
import { listSessions } from '~/lib/services/evCharging'

const overview: number[] = []
const page: number[] = []
const { sessions } = await listSessions({ page: 1, pageSize: 25 })
for (let i = 0; i < 10; i++) {
  let t = performance.now()
  await getCostOverview({})
  overview.push(Math.round(performance.now() - t))
  t = performance.now()
  await getSessionCosts({ sessionIds: sessions.map((s) => s.id) })
  page.push(Math.round(performance.now() - t))
}
console.log('costOverview ms', overview.join(' '))
console.log('sessionCosts ms', page.join(' '))
process.exit(0)
```

Run: `bun .bench-cost.ts`. Expected: ten timings each. Keep the file for Task 6.

---

### Task 1: `ev_session_cost` and `ev_session_cost_month` tables

**Files:**
- Create: `src/lib/db/schema/sessionCost.ts`
- Modify: `src/lib/db/schema/index.ts`
- Create (generated): `drizzle/0026_session_cost.sql`, `drizzle/meta/0026_snapshot.json`, journal entry

**Interfaces:**
- Produces: `evSessionCost` (`sessionId: string`, `generation: number`, `pricedGeneration: number | null`,
  `pricingVersion: number | null`, `estimated: boolean | null`) and `evSessionCostMonth` (`sessionId`, `year`,
  `month`, and the 14 `CostTotals` fields as `number`), both exported from `~/lib/db/schema`.

- [ ] **Step 1: Add the schema file**

`src/lib/db/schema/sessionCost.ts`:

```ts
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core'
import { evChargeSession } from './evCharging'

// Stored charging cost (ADR-0020, amended 2026-10-11): each counted session's
// priced totals per Stockholm month, written by the TS pricing
// (lib/evCharging/costing.ts) and read by costOverview and the session list.
//
// One `ev_session_cost` row per session that has been invalidated or priced.
// Every writer of a cost input (intervals, energy mix, spot slots, tariffs)
// bumps `generation` in its own transaction (services/sessionCost/invalidate).
// The month rows are current only while `priced_generation = generation` and
// `pricing_version` is the code's PRICING_VERSION; anything else, a missing row
// included, is stale and never read. Money in SEK incl VAT, energy in kWh.
export const evSessionCost = pgTable(
  'ev_session_cost',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => evChargeSession.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull().default(0),
    /** The generation the month rows were priced at; null = never priced. */
    pricedGeneration: integer('priced_generation'),
    /** PRICING_VERSION the month rows were priced with. */
    pricingVersion: integer('pricing_version'),
    /** The session has no Zaptec intervals: priced over its whole window. */
    estimated: boolean('estimated'),
  },
  (table) => [
    // A write-back only ever sets priced_generation to the generation it read.
    check(
      'ev_session_cost_generation_check',
      sql`${table.generation} >= 0 AND (${table.pricedGeneration} IS NULL
        OR (${table.pricedGeneration} >= 0 AND ${table.pricedGeneration} <= ${table.generation}))`,
    ),
    // Priced columns are written together, or not at all.
    check(
      'ev_session_cost_priced_check',
      sql`(${table.pricedGeneration} IS NULL) = (${table.pricingVersion} IS NULL)
        AND (${table.pricedGeneration} IS NULL) = (${table.estimated} IS NULL)`,
    ),
  ],
).enableRLS()

export const evSessionCostMonth = pgTable(
  'ev_session_cost_month',
  {
    // Cascades from ev_session_cost, which cascades from the session.
    sessionId: uuid('session_id')
      .notNull()
      .references(() => evSessionCost.sessionId, { onDelete: 'cascade' }),
    /** Stockholm calendar year and month (1–12), as house_energy_month. */
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    kwh: doublePrecision('kwh').notNull(),
    gridKwh: doublePrecision('grid_kwh').notNull(),
    fullKwh: doublePrecision('full_kwh').notNull(),
    noPriceKwh: doublePrecision('no_price_kwh').notNull(),
    noTariffKwh: doublePrecision('no_tariff_kwh').notNull(),
    spotSek: doublePrecision('spot_sek').notNull(),
    feesSek: doublePrecision('fees_sek').notNull(),
    totalSek: doublePrecision('total_sek').notNull(),
    solarKwh: doublePrecision('solar_kwh').notNull(),
    batteryKwh: doublePrecision('battery_kwh').notNull(),
    noHouseDataKwh: doublePrecision('no_house_data_kwh').notNull(),
    solarValueSek: doublePrecision('solar_value_sek').notNull(),
    solarPricedKwh: doublePrecision('solar_priced_kwh').notNull(),
    solarUnpricedKwh: doublePrecision('solar_unpriced_kwh').notNull(),
  },
  (table) => [
    // Serves the reads' join by session, the write-back's delete by session
    // ids and the FK cascade. The month sums scan every row (a few hundred).
    primaryKey({
      name: 'ev_session_cost_month_pk',
      columns: [table.sessionId, table.year, table.month],
    }),
    check('ev_session_cost_month_month_check', sql`${table.month} BETWEEN 1 AND 12`),
    // Finite only ('Infinity' bounds also refuse NaN, which Postgres sorts
    // above every number). No sign bound: spot money is negative on negative
    // prices, and a float residue of −1e-17 kWh would fail a whole write-back.
    check(
      'ev_session_cost_month_finite_check',
      sql.join(
        [
          table.kwh,
          table.gridKwh,
          table.fullKwh,
          table.noPriceKwh,
          table.noTariffKwh,
          table.spotSek,
          table.feesSek,
          table.totalSek,
          table.solarKwh,
          table.batteryKwh,
          table.noHouseDataKwh,
          table.solarValueSek,
          table.solarPricedKwh,
          table.solarUnpricedKwh,
        ].map((c) => sql`${c} > '-Infinity' AND ${c} < 'Infinity'`),
        sql` AND `,
      ),
    ),
  ],
).enableRLS()
```

If drizzle-kit can't render the `sql.join` CHECK (Step 3 shows an empty or broken `CHECK`), write the 14 pairs out
literally in one `sql` template instead.

- [ ] **Step 2: Re-export from the barrel**

In `src/lib/db/schema/index.ts`, add after `export * from './sensor'`:

```ts
export * from './sessionCost'
```

- [ ] **Step 3: Generate and inspect the migration**

Run: `bun run db:generate --name=session_cost`
Expected: `drizzle/0026_session_cost.sql` with two `CREATE TABLE`s, both `ENABLE ROW LEVEL SECURITY`, the two FKs
with `ON DELETE cascade`, the PK `ev_session_cost_month_pk`, and the four CHECKs. No statement touches another
table.

- [ ] **Step 4: Apply and run the RLS test**

Run: `bun run db:migrate && bunx vitest run test/rls.test.ts`
Expected: migration applied; RLS test PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add src/lib/db/schema/sessionCost.ts src/lib/db/schema/index.ts drizzle/0026_session_cost.sql drizzle/meta/
git commit -m "feat(charging): add the stored session cost tables"
```

- [ ] **Step 6: Schema gate (Non-negotiable)**

Dispatch in parallel (one message):
- `migration-guard` (agent) on `drizzle/0026_session_cost.sql` and `src/lib/db/schema/sessionCost.ts`.
- Schema-design reviewer (`general-purpose`, told to load `supabase-postgres-best-practices` and to assume the
  schema is wrong), judging against the queries that will run:
  1. `readMonthSums`: `ev_charge_session` (counted filter, optional vehicle) LEFT JOIN `ev_session_cost` ON
     session_id LEFT JOIN `ev_session_cost_month` ON session_id AND current, GROUP BY positions (stale id, stale
     generation, year, month); ~300 sessions, ~350 month rows.
  2. `readSessionSums`: the same joins for ≤ 50 session ids, GROUP BY session.
  3. `listStale`: sessions LEFT JOIN `ev_session_cost` WHERE not current.
  4. Bumps: `INSERT … ON CONFLICT (session_id) DO UPDATE SET generation = generation + 1` for an id list; the same
     from a `SELECT` over sessions/intervals overlapping one Stockholm day (seq scan of `ev_charge_interval`,
     ~5k rows); `UPDATE ev_session_cost SET generation = generation + 1` over all rows (tariff edit).
  5. Write-back (one transaction): `SELECT … FOR UPDATE ORDER BY session_id`, `UPDATE … FROM unnest(…) WHERE
     generation = v.generation`, `INSERT … ON CONFLICT DO NOTHING`, `DELETE` month rows by session ids, batched
     `INSERT` of month rows.

Fix or explicitly rule on every finding (amend the schema, regenerate, re-migrate with
`bun run db:migrate` after `bun run db:down && bun run db:up` only if the generated migration changed and the local
DB already applied the old one), commit any fix as `fix(charging): <what>`, and only then start Task 2.

---

### Task 2: The `sessionCost` service

**Files:**
- Create: `src/lib/services/sessionCost/invalidate.ts`
- Create: `src/lib/services/sessionCost/sessionCost.ts`
- Create: `src/lib/services/sessionCost/index.ts`
- Test: `src/lib/services/sessionCost/sessionCost.test.ts`

**Interfaces:**
- Consumes: `evSessionCost`, `evSessionCostMonth` (Task 1); `countedSessionFilter` from
  `~/lib/services/evCharging`; `CostTotals`, `emptyTotals` from `~/lib/evCharging/cost`; `VehicleScope` from
  `~/lib/evCharging/vehicle`.
- Produces (all exported from `~/lib/services/sessionCost`; the three bumps also from
  `~/lib/services/sessionCost/invalidate`):
  ```ts
  bumpSessions(sessionIds: readonly string[], dbOrTx?: DbOrTx): Promise<void>
  bumpOverlapping(range: { startMs: number; endMs: number }, dbOrTx?: DbOrTx): Promise<void>
  bumpAll(dbOrTx?: DbOrTx): Promise<void>
  type SessionGeneration = { sessionId: string; generation: number | null } // null: no ev_session_cost row
  type MonthTotals = { year: number; month: number; totals: CostTotals }
  type StoredSessionCost = { sessionId: string; estimated: boolean; totals: CostTotals }
  type PricedForStore = SessionGeneration & { estimated: boolean; months: MonthTotals[] }
  readMonthSums(input: { vehicle?: VehicleScope; pricingVersion: number }):
    Promise<{ months: MonthTotals[]; stale: SessionGeneration[] }>
  readSessionSums(input: { sessionIds: readonly string[]; pricingVersion: number }):
    Promise<{ current: StoredSessionCost[]; stale: SessionGeneration[] }>
  listStale(input: { pricingVersion: number }): Promise<SessionGeneration[]>
  writePriced(input: { pricingVersion: number; sessions: readonly PricedForStore[] }): Promise<{ written: number }>
  ```

- [ ] **Step 1: Write the failing tests**

`src/lib/services/sessionCost/sessionCost.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeSession, evSessionCost } from '~/lib/db/schema'
import { type CostTotals, emptyTotals } from '~/lib/evCharging/cost'
import { insertInterval, insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import {
  bumpAll,
  bumpOverlapping,
  bumpSessions,
  listStale,
  type PricedForStore,
  readMonthSums,
  readSessionSums,
  writePriced,
} from '.'

setupDatabase()

const V = 1

const session = (
  startIso: string,
  endIso: string,
  over: Partial<typeof evChargeSession.$inferInsert> = {},
) => insertSession({ startAt: new Date(startIso), endAt: new Date(endIso), ...over })

const totals = (kwh: number, totalSek: number): CostTotals => ({
  ...emptyTotals(),
  kwh,
  gridKwh: kwh,
  fullKwh: kwh,
  totalSek,
})

const priced = (
  sessionId: string,
  generation: number | null,
  months: [number, number, CostTotals][],
  estimated = false,
): PricedForStore => ({
  sessionId,
  generation,
  estimated,
  months: months.map(([year, month, t]) => ({ year, month, totals: t })),
})

async function state(sessionId: string) {
  const [row] = await db.select().from(evSessionCost).where(eq(evSessionCost.sessionId, sessionId))
  return row
}

test('a session with no row is stale; once written it is current and summed per month', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const b = await session('2026-09-30T21:00:00Z', '2026-09-30T23:00:00Z')

  const before = await readMonthSums({ pricingVersion: V })
  expect(before.months).toEqual([])
  expect(before.stale.map((s) => s.sessionId).sort()).toEqual([a, b].sort())
  expect(before.stale.every((s) => s.generation === null)).toBe(true)

  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [
      priced(a, null, [[2026, 9, totals(5, 10)]]),
      priced(b, null, [
        [2026, 9, totals(2, 4)],
        [2026, 10, totals(3, 6)],
      ]),
    ],
  })
  expect(written).toBe(2)

  const after = await readMonthSums({ pricingVersion: V })
  expect(after.stale).toEqual([])
  const byMonth = new Map(after.months.map((m) => [m.year * 100 + m.month, m.totals]))
  expect(byMonth.get(202609)).toMatchObject({ kwh: 7, totalSek: 14 })
  expect(byMonth.get(202610)).toMatchObject({ kwh: 3, totalSek: 6 })
  expect(await state(a)).toMatchObject({ generation: 0, pricedGeneration: 0, pricingVersion: V })
})

test('a bump makes a written session stale, with its generation', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  await bumpSessions([a, a])

  const read = await readMonthSums({ pricingVersion: V })
  expect(read.months).toEqual([])
  expect(read.stale).toEqual([{ sessionId: a, generation: 1 }])
})

test('another pricing version is stale', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  const read = await readMonthSums({ pricingVersion: V + 1 })
  expect(read.months).toEqual([])
  expect(read.stale).toEqual([{ sessionId: a, generation: 0 }])
  expect(await listStale({ pricingVersion: V + 1 })).toEqual([{ sessionId: a, generation: 0 }])
  expect(await listStale({ pricingVersion: V })).toEqual([])
})

test('the write-back loses to a bump that came after the generation read', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  await bumpSessions([a])
  const { stale } = await readSessionSums({ sessionIds: [a], pricingVersion: V })
  expect(stale).toEqual([{ sessionId: a, generation: 1 }])

  await bumpSessions([a]) // a writer commits while the repricer is pricing
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, 1, [[2026, 9, totals(99, 99)]])],
  })

  expect(written).toBe(0)
  expect(await state(a)).toMatchObject({ generation: 2, pricedGeneration: 0 })
  const again = await readSessionSums({ sessionIds: [a], pricingVersion: V })
  expect(again.current).toEqual([])
  expect(again.stale).toEqual([{ sessionId: a, generation: 2 }])
})

test('a first write-back loses to a writer that created the row meanwhile', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  // Read as "no row" (generation null), then a writer bumps before the write-back.
  await bumpSessions([a])
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])],
  })
  expect(written).toBe(0)
  expect(await state(a)).toMatchObject({ generation: 1, pricedGeneration: null })
})

test('a re-price replaces the month rows', async () => {
  const a = await session('2026-09-30T21:00:00Z', '2026-09-30T23:00:00Z')
  await writePriced({
    pricingVersion: V,
    sessions: [priced(a, null, [[2026, 9, totals(2, 4)], [2026, 10, totals(3, 6)]])],
  })
  await bumpSessions([a])
  await writePriced({ pricingVersion: V, sessions: [priced(a, 1, [[2026, 9, totals(5, 10)]])] })

  const { months } = await readMonthSums({ pricingVersion: V })
  expect(months).toEqual([{ year: 2026, month: 9, totals: totals(5, 10) }])
})

test('readSessionSums: current sums over months, stale ids, uncounted ids dropped', async () => {
  const a = await session('2026-09-30T21:00:00Z', '2026-09-30T23:00:00Z')
  const b = await session('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')
  const voided = await session('2026-09-03T10:00:00Z', '2026-09-03T11:00:00Z', { voided: true })
  await writePriced({
    pricingVersion: V,
    sessions: [
      priced(a, null, [[2026, 9, totals(2, 4)], [2026, 10, totals(3, 6)]], true),
      priced(voided, null, [[2026, 9, totals(1, 1)]]),
    ],
  })

  const read = await readSessionSums({ sessionIds: [a, b, voided], pricingVersion: V })
  expect(read.current).toEqual([{ sessionId: a, estimated: true, totals: totals(5, 10) }])
  expect(read.stale).toEqual([{ sessionId: b, generation: null }])
  expect(await readSessionSums({ sessionIds: [], pricingVersion: V })).toEqual({
    current: [],
    stale: [],
  })
})

test('readMonthSums follows the counted filter and the vehicle scope', async () => {
  const ours = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const guest = await session('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z', {
    vehicle: 'guest',
    vehicleSource: 'admin',
  })
  const noise = await session('2026-09-03T10:00:00Z', '2026-09-03T11:00:00Z', { energyKwh: 0.01 })
  await writePriced({
    pricingVersion: V,
    sessions: [
      priced(ours, null, [[2026, 9, totals(5, 10)]]),
      priced(guest, null, [[2026, 9, totals(7, 14)]]),
      priced(noise, null, [[2026, 9, totals(0.01, 1)]]),
    ],
  })

  const all = await readMonthSums({ pricingVersion: V })
  expect(all.months).toEqual([{ year: 2026, month: 9, totals: totals(12, 24) }])
  const oursOnly = await readMonthSums({ vehicle: 'ours', pricingVersion: V })
  expect(oursOnly.months).toEqual([{ year: 2026, month: 9, totals: totals(5, 10) }])
  const guests = await readMonthSums({ vehicle: 'guest', pricingVersion: V })
  expect(guests.months).toEqual([{ year: 2026, month: 9, totals: totals(7, 14) }])
  expect(all.stale).toEqual([])
})

test('bumpOverlapping bumps sessions with energy in the range, by interval or window', async () => {
  const dayStart = Date.parse('2026-09-19T22:00:00Z') // Stockholm 2026-09-20
  const dayEnd = Date.parse('2026-09-20T22:00:00Z')
  const byWindow = await session('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z')
  const byInterval = await session('2026-09-19T20:00:00Z', '2026-09-19T21:00:00Z')
  await insertInterval(
    byInterval,
    new Date('2026-09-19T21:45:00Z'),
    new Date('2026-09-19T22:15:00Z'),
    1,
  )
  const before = await session('2026-09-19T20:00:00Z', '2026-09-19T22:00:00Z') // ends at the day's start
  const after = await session('2026-09-20T22:00:00Z', '2026-09-20T23:00:00Z') // starts at its end

  await bumpOverlapping({ startMs: dayStart, endMs: dayEnd })

  expect((await state(byWindow))?.generation).toBe(1)
  expect((await state(byInterval))?.generation).toBe(1)
  expect(await state(before)).toBeUndefined()
  expect(await state(after)).toBeUndefined()
})

test('bumpAll bumps every session, creating the missing rows', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const b = await session('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  await bumpAll()
  expect((await state(a))?.generation).toBe(1)
  expect(await state(b)).toMatchObject({ generation: 1, pricedGeneration: null })
})

test('a repricer that read a session without a row loses to a tariff edit', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  // Read as "no row" (generation null), priced with the old tariff, then a tariff edit commits.
  await bumpAll()
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])],
  })
  expect(written).toBe(0)
  expect((await readSessionSums({ sessionIds: [a], pricingVersion: V })).stale).toEqual([
    { sessionId: a, generation: 1 },
  ])
})

test('a second write-back of the same generation rewrites nothing', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  const again = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, 0, [[2026, 9, totals(5, 10)]])],
  })
  expect(again.written).toBe(0)
  expect((await readMonthSums({ pricingVersion: V })).months).toEqual([
    { year: 2026, month: 9, totals: totals(5, 10) },
  ])
})

test('deleting a session deletes its stored cost', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  await db.delete(evChargeSession).where(eq(evChargeSession.id, a))
  expect(await state(a)).toBeUndefined()
  expect((await readMonthSums({ pricingVersion: V })).months).toEqual([])
})

test('a write-back skips a session deleted meanwhile', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await db.delete(evChargeSession).where(eq(evChargeSession.id, a))
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])],
  })
  expect(written).toBe(0)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run src/lib/services/sessionCost`
Expected: FAIL (cannot resolve `.`).

- [ ] **Step 3: The invalidation leaf**

`src/lib/services/sessionCost/invalidate.ts`:

```ts
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
```

- [ ] **Step 4: Reads and the write-back**

`src/lib/services/sessionCost/sessionCost.ts`:

```ts
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
    if (row.staleId !== null) stale.push({ sessionId: row.staleId, generation: row.staleGeneration })
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
 * Stores priced sessions, each only if its generation is still the one read
 * before pricing (a bump since then means newer inputs: the session stays
 * stale). A session read without a row counts as generation 0: its row is
 * inserted unless a writer created one meanwhile (generation ≥ 1 then). One
 * transaction, and one upsert that locks the state rows in session_id order,
 * the order every bump uses, so a write-back and a writer never deadlock. A
 * session deleted meanwhile is skipped, and one already current at this
 * generation is not rewritten. Waits at most 1 s for a lock (a writer's
 * transaction, e.g. a derive, can hold bumped rows for seconds): a timeout
 * throws, and the callers treat a failed write-back as best effort. Returns
 * how many sessions were written.
 */
export async function writePriced(input: {
  pricingVersion: number
  sessions: readonly PricedForStore[]
}): Promise<{ written: number }> {
  const sorted = [...input.sessions].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
  if (sorted.length === 0) return { written: 0 }
  const pgArray = (xs: readonly (string | number | boolean)[]) => `{${xs.join(',')}}`

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`)
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`)
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
```

`src/lib/services/sessionCost/index.ts`:

```ts
export * from './invalidate'
export * from './sessionCost'
```

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run src/lib/services/sessionCost`
Expected: all PASS. If the positional `GROUP BY` fails to render, print the SQL with `.toSQL()` and fix it there;
don't switch to two queries (Review Focus 1).

- [ ] **Step 6: Typecheck, lint, commit**

Run: `bun run typecheck && bun run check`
Expected: clean (commit anything `check` rewrote).

```bash
git add src/lib/services/sessionCost/
git commit -m "feat(charging): add the session cost store service"
```

---

### Task 3: Every cost-input writer bumps

**Files:**
- Modify: `src/lib/services/evCharging/evCharging.ts` (`importSessions`)
- Modify: `src/lib/services/energyMix/energyMix.ts` (`replaceForSessions`)
- Modify: `src/lib/services/spotPrice/spotPrice.ts` (`replaceDay`)
- Modify: `src/lib/services/tariff/tariff.ts` (`create`, `update`, `remove`)
- Test: `src/lib/services/evCharging/evCharging.test.ts`, `src/lib/services/energyMix/energyMix.test.ts`,
  `src/lib/services/spotPrice/spotPrice.test.ts`, `src/lib/services/tariff/tariff.test.ts`

**Interfaces:**
- Consumes: `bumpSessions`, `bumpOverlapping`, `bumpAll` from `~/lib/services/sessionCost/invalidate` (Task 2).
- Produces: no new exports; each writer's transaction now also bumps.

Every test below reads the state with this helper; add it to each of the four test files (with the imports it
needs: `eq` from `drizzle-orm`, `db` from `~/lib/db`, `evSessionCost` from `~/lib/db/schema`). Sessions come from
`insertSession(overrides)` in `~test/fixtures/evCharging` (it creates its charger; default window
2026-01-01 10:00–11:00Z, 5 kWh).

```ts
async function generationOf(sessionId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ generation: evSessionCost.generation })
    .from(evSessionCost)
    .where(eq(evSessionCost.sessionId, sessionId))
  return row?.generation
}
```

- [ ] **Step 1: Failing test — `importSessions`**

In `src/lib/services/evCharging/evCharging.test.ts` (its `session(overrides)` builds a `ZaptecSession`):

```ts
test('importSessions bumps the stored cost of every session it upserts', async () => {
  const CTX = { installationId: 'install-1' }
  await importSessions([session({ id: 'z-1' }), session({ id: 'z-2' })], CTX)
  const ids = await db
    .select({ id: evChargeSession.id })
    .from(evChargeSession)
    .orderBy(evChargeSession.zaptecSessionId)
  expect(await generationOf(ids[0].id)).toBe(1)
  expect(await generationOf(ids[1].id)).toBe(1)

  await importSessions([session({ id: 'z-1' })], CTX)
  expect(await generationOf(ids[0].id)).toBe(2)
  expect(await generationOf(ids[1].id)).toBe(1)
})
```

- [ ] **Step 2: Failing test — `replaceForSessions`**

In `src/lib/services/energyMix/energyMix.test.ts` (its `slot(iso)` builds a `MixSlot`; `insertSession` is already
imported):

```ts
test('replaceForSessions bumps the sessions it replaces, and nothing on a refused write', async () => {
  const a = await insertSession()
  const b = await insertSession()
  await replaceForSessions([a], [{ ...slot('2026-01-01T10:00:00Z'), sessionId: a }])
  expect(await generationOf(a)).toBe(1)
  expect(await generationOf(b)).toBeUndefined()

  // A row for a session outside the list is refused before anything is written.
  await expect(
    replaceForSessions([a], [{ ...slot('2026-01-01T10:00:00Z'), sessionId: b }]),
  ).rejects.toThrow(RangeError)
  expect(await generationOf(a)).toBe(1)
})
```

- [ ] **Step 3: Failing test — `replaceDay`**

In `src/lib/services/spotPrice/spotPrice.test.ts` (import `insertSession` from `~test/fixtures/evCharging`):

```ts
const chargeSession = (startIso: string, endIso: string) =>
  insertSession({ startAt: new Date(startIso), endAt: new Date(endIso) })

test('replaceDay bumps sessions charging that Stockholm day, and only those', async () => {
  const inDay = await chargeSession('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z')
  const dayBefore = await chargeSession('2026-09-19T08:00:00Z', '2026-09-19T09:00:00Z')
  await replaceDay('SE3', '2026-09-20', daySlots('2026-09-20', 15))
  expect(await generationOf(inDay)).toBe(1)
  expect(await generationOf(dayBefore)).toBeUndefined()
})

test('a rejected day bumps nothing', async () => {
  const inDay = await chargeSession('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z')
  await expect(replaceDay('SE3', '2026-09-20', [])).rejects.toThrow()
  expect(await generationOf(inDay)).toBeUndefined()
})
```

- [ ] **Step 4: Failing test — tariffs**

In `src/lib/services/tariff/tariff.test.ts` (its tariff input constant is `AUG_2026`; import `insertSession` from
`~test/fixtures/evCharging` and `bumpSessions` from `~/lib/services/sessionCost/invalidate`):

```ts
test('every tariff write bumps every stored session; a refused write bumps nothing', async () => {
  const a = await insertSession()
  const b = await insertSession()
  await bumpSessions([a]) // a has a row, b has none: bumpAll must create b's
  const created = await create(AUG_2026)
  expect(await generationOf(a)).toBe(2)
  expect(await generationOf(b)).toBe(1)
  await update(created.id, { ...AUG_2026, gridTransferOre: AUG_2026.gridTransferOre + 1 })
  expect(await generationOf(a)).toBe(3)
  await remove(created.id)
  expect(await generationOf(a)).toBe(4)

  await expect(remove(created.id)).rejects.toMatchObject({ code: 'TARIFF_NOT_FOUND' })
  expect(await generationOf(a)).toBe(4)
})
```

- [ ] **Step 5: Run the four files to see the new tests fail**

Run: `bunx vitest run src/lib/services/evCharging/evCharging.test.ts src/lib/services/energyMix/energyMix.test.ts src/lib/services/spotPrice/spotPrice.test.ts src/lib/services/tariff/tariff.test.ts`
Expected: the new tests FAIL (generation undefined); the rest PASS.

- [ ] **Step 6: Bump in each writer**

`src/lib/services/evCharging/evCharging.ts`, in `importSessions`'s transaction, right after
`const sessionDbIds = sessionRows.map((r) => r.id)`:

```ts
    // Every upserted session may have new energy (ADR-0020, amended
    // 2026-10-11): its stored cost goes stale with this commit.
    await bumpSessions(sessionDbIds, tx)
```

and import `import { bumpSessions } from '~/lib/services/sessionCost/invalidate'`.

`src/lib/services/energyMix/energyMix.ts`, in `replaceForSessions`'s `write`, after the delete:

```ts
    await bumpSessions([...ids], tx)
```

and the same import.

`src/lib/services/spotPrice/spotPrice.ts`, in `replaceDay`'s transaction, after the `spot_price_day` upsert and
before `requestDerive`:

```ts
    // Sessions charging this day are priced from these slots (ADR-0020, amended 2026-10-11).
    await bumpOverlapping({ startMs, endMs }, tx)
```

and import `import { bumpOverlapping } from '~/lib/services/sessionCost/invalidate'`.

`src/lib/services/tariff/tariff.ts`: run each write in a transaction with `bumpAll(tx)`. `create`:

```ts
  return mapValidFromRace(() =>
    db.transaction(async (tx) => {
      const [row] = await tx.insert(electricityTariff).values(columns(input)).returning()
      await bumpAll(tx)
      return row
    }),
  )
```

`update`:

```ts
  const row = await mapValidFromRace(() =>
    db.transaction(async (tx) => {
      const [updated] = await tx
        .update(electricityTariff)
        .set(columns(input))
        .where(eq(electricityTariff.id, id))
        .returning()
      if (updated) await bumpAll(tx)
      return updated
    }),
  )
```

`remove`:

```ts
export async function remove(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(electricityTariff)
      .where(eq(electricityTariff.id, id))
      .returning({ id: electricityTariff.id })
    if (deleted.length === 0) throw new TariffDomainError('TARIFF_NOT_FOUND')
    // A tariff period reaches every day from its validFrom on: every stored cost goes stale.
    await bumpAll(tx)
  })
}
```

and import `import { bumpAll } from '~/lib/services/sessionCost/invalidate'`. Add a one-line comment on `create`
and `update` like `remove`'s.

- [ ] **Step 7: Run the four files and the import-cycle check**

Run: `bunx vitest run src/lib/services/evCharging/evCharging.test.ts src/lib/services/energyMix/energyMix.test.ts src/lib/services/spotPrice/spotPrice.test.ts src/lib/services/tariff/tariff.test.ts && bun run typecheck && grep -rn "services/sessionCost'" src/lib/services`
Expected: all PASS; no errors; the grep prints nothing (writers import only the `invalidate` leaf).

- [ ] **Step 8: Check nothing else writes a cost input**

Run: `grep -rnE "\.(insert|update|delete)\((evChargeInterval|evChargeEnergyMix|spotPrice|electricityTariff)\)|INSERT INTO .*(ev_charge_interval|ev_charge_energy_mix|spot_price |electricity_tariff)" src --include=*.ts | grep -v "\.test\.ts"`
Expected: only the writers changed above (plus `replaceDay`'s `spot_price_day` insert). Anything else: stop and
report it.

- [ ] **Step 9: Commit**

```bash
git add src/lib/services/evCharging/evCharging.ts src/lib/services/evCharging/evCharging.test.ts \
  src/lib/services/energyMix/energyMix.ts src/lib/services/energyMix/energyMix.test.ts \
  src/lib/services/spotPrice/spotPrice.ts src/lib/services/spotPrice/spotPrice.test.ts \
  src/lib/services/tariff/tariff.ts src/lib/services/tariff/tariff.test.ts
git commit -m "feat(charging): invalidate stored costs on every input write"
```

---

### Task 4: The cost reads use the store

**Files:**
- Modify: `src/lib/evCharging/cost/priceIntervals.ts` (`PRICING_VERSION`), `src/lib/evCharging/cost/index.ts`
- Modify: `src/lib/evCharging/costing.ts`
- Test: `src/lib/evCharging/costing.test.ts`, `src/lib/orpc/procedures/evCharging.test.ts`

**Interfaces:**
- Consumes: `readMonthSums`, `readSessionSums`, `writePriced`, `SessionGeneration`, `PricedForStore` (Task 2).
- Produces:
  ```ts
  // ~/lib/evCharging/cost
  export const PRICING_VERSION = 1
  // ~/lib/evCharging/costing
  export type CostTimings = { storedMs?; staleSessions?; energyMs?; slotsMs?; tariffMs?; mixMs?;
    houseFromMs?; computeMs?; writeBackMs? } // all number | undefined
  export type PricedSessionCost = { sessionId: string; estimated: boolean; months: Map<number, CostTotals> }
  export function priceSessions(sessionIds: readonly string[], timings?: CostTimings): Promise<PricedSessionCost[]>
  export function storePriced(stale: readonly SessionGeneration[], priced: readonly PricedSessionCost[]):
    Promise<{ written: number }>
  // getCostOverview / getSessionCosts keep their signatures and return types.
  ```

- [ ] **Step 1: Run every existing costing test through both paths**

In `src/lib/evCharging/costing.test.ts`, add after the imports:

```ts
import type { CostOverview } from './costing'

/** |a − b| ≤ 1e-9 · max(1, |a|) for every number in two equal-shaped values. */
function expectClose(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const ok = Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected))
    if (!ok) throw new Error(`${path}: ${actual} ≠ ${expected}`)
    return
  }
  if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort())
    for (const [k, v] of Object.entries(expected)) {
      expectClose((actual as Record<string, unknown>)[k], v, `${path}.${k}`)
    }
    return
  }
  expect(actual, path).toEqual(expected)
}

/**
 * The overview twice: priced on read (everything stale, written back), then
 * from the store. Asserts they agree and that the second read priced nothing.
 */
async function pricedTwice(input: Parameters<typeof getCostOverview>[0]): Promise<CostOverview> {
  const first = await getCostOverview(input)
  const timings: Record<string, number> = {}
  const second = await getCostOverview({ ...input, timings })
  expectClose(second, first)
  expect(timings.staleSessions).toBe(0)
  expect(timings.slotsMs).toBeUndefined()
  return second
}
```

Then replace every `getCostOverview(` call in the file with `pricedTwice(`, **except** in
`records sub-timings when asked` (replaced in Step 2). Inside `Promise.all([...])` the call shape is unchanged.

- [ ] **Step 2: New tests for the store path**

Replace `records sub-timings when asked` with:

```ts
test('records sub-timings: pricing only when something was stale', async () => {
  await session('2026-09-23T08:00:00Z', '2026-09-23T09:00:00Z', 2)
  const cold: Record<string, number> = {}
  await getCostOverview({ now: NOW, timings: cold })
  expect(cold).toEqual({
    storedMs: expect.any(Number),
    houseFromMs: expect.any(Number),
    staleSessions: 1,
    energyMs: expect.any(Number),
    slotsMs: expect.any(Number),
    tariffMs: expect.any(Number),
    mixMs: expect.any(Number),
    computeMs: expect.any(Number),
    writeBackMs: expect.any(Number),
  })
  const warm: Record<string, number> = {}
  await getCostOverview({ now: NOW, timings: warm })
  expect(warm).toEqual({
    storedMs: expect.any(Number),
    houseFromMs: expect.any(Number),
    staleSessions: 0,
  })
})
```

and add:

```ts
test('a bumped session is repriced on the next read; the others stay stored', async () => {
  await replaceDay('SE3', '2026-09-20', daySlots('2026-09-20', 15, () => 0.5))
  await tariffService.create(TARIFF)
  await session('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', 2, [
    ['2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', 2],
  ])
  await session('2026-09-21T08:00:00Z', '2026-09-21T09:00:00Z', 3, [
    ['2026-09-21T08:00:00Z', '2026-09-21T09:00:00Z', 3],
  ])
  const before = await pricedTwice({ now: NOW })
  expect(before.months[8]).toMatchObject({ kwh: 5, noPriceKwh: 3 })

  // The 21st's prices arrive: only that session is bumped and repriced.
  await replaceDay('SE3', '2026-09-21', daySlots('2026-09-21', 15, () => 0.5))
  const timings: Record<string, number> = {}
  const after = await getCostOverview({ now: NOW, timings })
  expect(timings.staleSessions).toBe(1)
  expect(after.months[8]).toMatchObject({ kwh: 5, noPriceKwh: 0, complete: true })
  await pricedTwice({ now: NOW })
})

test('a failed write-back still returns the figures priced on read', async () => {
  await session('2026-09-23T08:00:00Z', '2026-09-23T09:00:00Z', 2)
  const warn = vi.spyOn(logger, 'warn')
  const spy = vi
    .spyOn(sessionCostService, 'writePriced')
    .mockRejectedValueOnce(new Error('db down'))
  const cost = await getCostOverview({ now: NOW })
  expect(cost.months[8].kwh).toBeCloseTo(2)
  expect(spy).toHaveBeenCalledOnce()
  expect(warn).toHaveBeenCalledWith(
    'session costs: write-back failed; figures priced on read',
    expect.objectContaining({ sessions: 1 }),
  )
  // Still stale: the next read prices it again (and stores it).
  const timings: Record<string, number> = {}
  await getCostOverview({ now: NOW, timings })
  expect(timings.staleSessions).toBe(1)
})

test('session costs: stored and on-read agree, and a read writes back', async () => {
  await replaceDay('SE3', '2026-09-22', daySlots('2026-09-22', 15, () => 1))
  await tariffService.create(TARIFF)
  const a = await session('2026-09-22T08:00:00Z', '2026-09-22T09:00:00Z', 2, [
    ['2026-09-22T08:00:00Z', '2026-09-22T09:00:00Z', 2],
  ])
  const b = await session('2026-09-22T10:00:00Z', '2026-09-22T12:00:00Z', 4)
  const cold: Record<string, number> = {}
  const first = await getSessionCosts({ sessionIds: [a, b], timings: cold })
  expect(cold.staleSessions).toBe(2)
  const warm: Record<string, number> = {}
  const second = await getSessionCosts({ sessionIds: [a, b], timings: warm })
  expect(warm).toEqual({ storedMs: expect.any(Number), staleSessions: 0 })
  const byId = (xs: typeof first) =>
    Object.fromEntries([...xs].map((c) => [c.sessionId, c]))
  expectClose(byId(second), byId(first))
  expect(byId(second)[b]).toMatchObject({ estimated: true, kwh: 4 })
})
```

Two existing tests pin the old pricing-on-every-read behavior; update them to the stored path:

- `a session with a stored mix costs its cash: …`: its `getSessionCosts` now finds the session stored (the overview
  wrote it back), so its last assertion becomes
  `expect(timings).toEqual({ storedMs: expect.any(Number), staleSessions: 0 })`.
- `a mix that no longer matches the session falls back to all grid`: `getSessionCosts` prices and stores the session
  (one warning); the overview then reads the stored total and prices nothing, so the last line becomes
  `expect(warn).toHaveBeenCalledTimes(1) // priced once, then read from the store`.

with the imports `import * as sessionCostService from '~/lib/services/sessionCost'` (the store module is mocked
through the barrel namespace, so `costing.ts` must call it as `sessionCostService.writePriced`, Step 5).

- [ ] **Step 3: Run the costing tests to see them fail**

Run: `bunx vitest run src/lib/evCharging/costing.test.ts`
Expected: FAIL (`staleSessions` undefined, timings differ).

- [ ] **Step 4: `PRICING_VERSION`**

In `src/lib/evCharging/cost/priceIntervals.ts`, above `priceIntervals`:

```ts
/**
 * The pricing math's version (ADR-0020, amended 2026-10-11). Bump it with any
 * change to what `priceIntervals` or `toIntervals` (costInputs.ts) computes:
 * every stored session cost then reads as stale and is repriced.
 */
export const PRICING_VERSION = 1
```

and add `PRICING_VERSION,` to the `./priceIntervals` export list in `src/lib/evCharging/cost/index.ts`.

- [ ] **Step 5: Rewrite the read model in `costing.ts`**

Keep `CostSummary`, `CostOverview`, `SessionCost`, `summarize`, `loadSlots` and `bucketStartMs` as they are. Change
the imports to:

```ts
import {
  avgOre,
  type CostTotals,
  type EnergyInterval,
  emptyTotals,
  isComplete,
  mergeTotals,
  PRICING_VERSION,
  priceIntervals,
  SlotIndex,
} from '~/lib/evCharging/cost'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { logger } from '~/lib/logger/server'
import { listSessionEnergy, type SessionEnergy } from '~/lib/services/evCharging'
import { firstReadingAt } from '~/lib/services/houseEnergy'
import * as sessionCostService from '~/lib/services/sessionCost'
import type { SessionGeneration } from '~/lib/services/sessionCost'
import { listSlotsOverlapping } from '~/lib/services/spotPrice'
import { SPOT_ZONE } from '~/lib/spotPrice/zones'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { loadMix, loadTariffs, timed, toIntervals } from './costInputs'
```

Replace the header comment's last two sentences with:

```ts
// Since ADR-0023 it prices each session's stored solar/battery mix (cash
// cost); a session without one stays all-grid, labelled as without house data.
// Since 2026-10-11 (ADR-0020 amendment) the priced totals are stored per
// session and Stockholm month (services/sessionCost): the reads sum the
// current ones and price only the stale ones here, writing them back.
```

Replace `CostTimings` with:

```ts
/** Optional sub-timings sink (the procedure forwards it to `context.timings`). */
export type CostTimings = {
  /** The stored sums + stale ids (one statement). */
  storedMs?: number
  /** How many sessions in scope were stale and priced on read (a count, not ms). */
  staleSessions?: number
  energyMs?: number
  slotsMs?: number
  tariffMs?: number
  mixMs?: number
  houseFromMs?: number
  computeMs?: number
  writeBackMs?: number
}
```

Add, after `bucketStartMs`:

```ts
/** One session's priced totals per Stockholm month (key: year * 100 + month). */
export type PricedSessionCost = {
  sessionId: string
  estimated: boolean
  months: Map<number, CostTotals>
}

/**
 * Prices counted sessions by id (uncounted or unknown ids are absent): each
 * piece in its owning stretch's Stockholm month (`bucketStartMs`), so cost
 * months match kWh months. Callers read the sessions' generations first.
 */
export async function priceSessions(
  sessionIds: readonly string[],
  timings?: CostTimings,
): Promise<PricedSessionCost[]> {
  if (sessionIds.length === 0) return []
  const [sessions, tariffsAsc] = await Promise.all([
    timed(timings, 'energyMs', () => listSessionEnergy({ sessionIds })),
    timed(timings, 'tariffMs', loadTariffs),
  ])
  if (sessions.length === 0) return []
  const [index, mixes] = await Promise.all([
    loadSlots(sessions, timings),
    loadMix(sessions, timings),
  ])
  const started = performance.now()
  const priced = sessions.map((s) => {
    const buckets = new Map<number, EnergyInterval[]>()
    for (const iv of toIntervals(s, mixes.get(s.sessionId))) {
      const { year, month } = stockholmYearMonth(bucketStartMs(iv.startMs, s.stretches))
      const key = year * 100 + month
      const list = buckets.get(key)
      if (list) list.push(iv)
      else buckets.set(key, [iv])
    }
    const months = new Map<number, CostTotals>()
    for (const [key, ivs] of buckets) months.set(key, priceIntervals(ivs, index, tariffsAsc))
    return { sessionId: s.sessionId, estimated: s.estimated, months }
  })
  if (timings) timings.computeMs = Math.round(performance.now() - started)
  return priced
}

/** Stores priced sessions under the generations read before pricing them (see `writePriced`). */
export async function storePriced(
  stale: readonly SessionGeneration[],
  priced: readonly PricedSessionCost[],
): Promise<{ written: number }> {
  const generation = new Map(stale.map((s) => [s.sessionId, s.generation]))
  return sessionCostService.writePriced({
    pricingVersion: PRICING_VERSION,
    sessions: priced
      .filter((p) => generation.has(p.sessionId))
      .map((p) => ({
        sessionId: p.sessionId,
        generation: generation.get(p.sessionId) ?? null,
        estimated: p.estimated,
        months: [...p.months].map(([key, totals]) => ({
          year: Math.floor(key / 100),
          month: key % 100,
          totals,
        })),
      })),
  })
}

// A read's write-back: best effort, the figures are already priced.
async function writeBack(
  stale: readonly SessionGeneration[],
  priced: readonly PricedSessionCost[],
  timings?: CostTimings,
): Promise<void> {
  try {
    await timed(timings, 'writeBackMs', () => storePriced(stale, priced))
  } catch (error) {
    logger.warn('session costs: write-back failed; figures priced on read', {
      sessions: priced.length,
      error,
    })
  }
}

function addTo(map: Map<number, CostTotals>, key: number, totals: CostTotals): void {
  const prev = map.get(key)
  map.set(key, prev ? mergeTotals(prev, totals) : totals)
}
```

Replace the body of `getCostOverview` from `const [sessions, tariffsAsc, houseDataFrom] = …` through the
`priced` map's filling with:

```ts
  const [stored, houseDataFrom] = await Promise.all([
    timed(input.timings, 'storedMs', () =>
      sessionCostService.readMonthSums({
        vehicle: input.vehicle,
        pricingVersion: PRICING_VERSION,
      }),
    ),
    timed(input.timings, 'houseFromMs', () => firstReadingAt()),
  ])
  if (input.timings) input.timings.staleSessions = stored.stale.length

  // year*100+month → that month's totals: the stored sums plus the stale
  // sessions priced now (and written back).
  const priced = new Map<number, CostTotals>()
  for (const m of stored.months) addTo(priced, m.year * 100 + m.month, m.totals)
  if (stored.stale.length > 0) {
    const fresh = await priceSessions(
      stored.stale.map((s) => s.sessionId),
      input.timings,
    )
    for (const p of fresh) for (const [key, totals] of p.months) addTo(priced, key, totals)
    await writeBack(stored.stale, fresh, input.timings)
  }
```

Keep `monthTotals`, `yearTotals`, `allTime` and the `overview` object as they are; delete the
`const costStart = performance.now()` line and the trailing `computeMs` assignment (pricing records it now).

Replace `getSessionCosts` with:

```ts
/** Cost of specific sessions (the session list's current page). */
export async function getSessionCosts(input: {
  sessionIds: readonly string[]
  timings?: CostTimings
}): Promise<SessionCost[]> {
  if (input.sessionIds.length === 0) return []
  const stored = await timed(input.timings, 'storedMs', () =>
    sessionCostService.readSessionSums({
      sessionIds: input.sessionIds,
      pricingVersion: PRICING_VERSION,
    }),
  )
  if (input.timings) input.timings.staleSessions = stored.stale.length
  const costs: SessionCost[] = stored.current.map((s) => ({
    sessionId: s.sessionId,
    estimated: s.estimated,
    ...summarize(s.totals),
  }))
  if (stored.stale.length > 0) {
    const fresh = await priceSessions(
      stored.stale.map((s) => s.sessionId),
      input.timings,
    )
    for (const p of fresh) {
      costs.push({
        sessionId: p.sessionId,
        estimated: p.estimated,
        ...summarize([...p.months.values()].reduce(mergeTotals, emptyTotals())),
      })
    }
    await writeBack(stored.stale, fresh, input.timings)
  }
  return costs
}
```

Remove the now-unused `SessionEnergy` import only if `loadSlots` no longer needs it (it does: keep it).

- [ ] **Step 6: Run the costing tests**

Run: `bunx vitest run src/lib/evCharging/costing.test.ts`
Expected: all PASS. A `pricedTwice` mismatch means stored ≠ on-read: debug it (systematic-debugging), never loosen
the tolerance.

- [ ] **Step 7: Procedure test for the stored `sessions` path**

In `src/lib/orpc/procedures/evCharging.test.ts`, in `session returns one counted session …`, after the existing
`listTimings` assertions, add:

```ts
  const warmTimings: Record<string, number> = {}
  const again = await call(
    evChargingRouter.sessions,
    { page: 1, pageSize: 10 },
    { context: { ...baseContext(), timings: warmTimings } },
  )
  expect(again.costs?.find((c) => c.sessionId === row.id)?.totalSek).toBeCloseTo(
    result.cost.totalSek,
    9,
  )
  expect(warmTimings.costStaleSessions).toBe(0)
  expect(warmTimings.costMixMs).toBeUndefined()
```

Run: `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts src/lib/evCharging`
Expected: all PASS (the economy tests share `costInputs.ts` and must be untouched).

- [ ] **Step 8: Typecheck, lint, commit**

Run: `bun run typecheck && bun run check`

```bash
git add src/lib/evCharging/cost/priceIntervals.ts src/lib/evCharging/cost/index.ts \
  src/lib/evCharging/costing.ts src/lib/evCharging/costing.test.ts \
  src/lib/orpc/procedures/evCharging.test.ts
git commit -m "perf(charging): read session costs from the store"
```

---

### Task 5: Eager reprice after syncs and tariff edits

**Files:**
- Create: `src/lib/evCharging/repriceStale.ts`
- Test: `src/lib/evCharging/repriceStale.test.ts`
- Modify: `src/lib/evCharging/sync.ts`, `src/lib/spotPrice/sync.ts`, `src/lib/houseEnergy/sync.ts`
- Modify: `src/lib/orpc/procedures/tariff.ts`
- Test: `src/lib/orpc/procedures/tariff.test.ts`, `src/lib/evCharging/sync.test.ts`

**Interfaces:**
- Consumes: `listStale` (Task 2), `priceSessions`, `storePriced` (Task 4), `withDeadline` from
  `~/lib/integrations/runPulledSync`.
- Produces:
  ```ts
  export const REPRICE_BUDGET_MS = 10_000
  export function repriceStale(a: {
    trigger: string // the sync source or 'tariff'
    log: Logger
    signal?: AbortSignal
    budgetMs?: number
    reprice?: () => Promise<{ stale: number; written: number }> // tests
  }): Promise<number> // ms spent; never throws
  ```

- [ ] **Step 1: Failing tests**

`src/lib/evCharging/repriceStale.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import type { Logger } from '~/lib/logger'
import { listStale } from '~/lib/services/sessionCost'
import { insertSession as insertFixtureSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { PRICING_VERSION } from './cost'
import { repriceStale } from './repriceStale'

setupDatabase()

function fakeLog() {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  }
  return log
}

const insertSession = (startIso: string, endIso: string) =>
  insertFixtureSession({ startAt: new Date(startIso), endAt: new Date(endIso) })

test('prices every stale session and logs the run', async () => {
  await insertSession('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await insertSession('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')
  const log = fakeLog()
  const ms = await repriceStale({ trigger: 'zaptec', log })
  expect(Number.isInteger(ms)).toBe(true)
  expect(await listStale({ pricingVersion: PRICING_VERSION })).toEqual([])
  expect(log.info).toHaveBeenCalledWith('session costs repriced', {
    trigger: 'zaptec',
    stale: 2,
    written: 2,
    repriceMs: expect.any(Number),
  })
})

test('nothing stale: no log line', async () => {
  const log = fakeLog()
  await repriceStale({ trigger: 'elpris', log })
  expect(log.info).not.toHaveBeenCalled()
})

test('a failing reprice is a warning, never a throw', async () => {
  const log = fakeLog()
  await expect(
    repriceStale({
      trigger: 'tariff',
      log,
      reprice: async () => {
        throw new Error('pricing bug')
      },
    }),
  ).resolves.toBeTypeOf('number')
  expect(log.warn).toHaveBeenCalledWith('session cost reprice failed', {
    trigger: 'tariff',
    error: expect.any(Error),
  })
})

test('a reprice past its budget is given up on with a warning', async () => {
  const log = fakeLog()
  await repriceStale({ trigger: 'emaldo', log, budgetMs: 10, reprice: () => new Promise(() => {}) })
  expect(log.warn).toHaveBeenCalledWith('session cost reprice failed', {
    trigger: 'emaldo',
    error: expect.objectContaining({
      message: 'session cost reprice did not finish within its budget',
    }),
  })
})

test("skipped once the run's deadline has fired", async () => {
  await insertSession('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const log = fakeLog()
  const reprice = vi.fn(async () => ({ stale: 0, written: 0 }))
  await repriceStale({ trigger: 'zaptec', log, signal: AbortSignal.abort(), reprice })
  expect(reprice).not.toHaveBeenCalled()
  expect(log.warn).toHaveBeenCalledWith('session cost reprice skipped: run deadline reached', {
    trigger: 'zaptec',
  })
})
```

In `src/lib/orpc/procedures/tariff.test.ts`, add (the file's `call`, `baseContext`, `signIn` and `AUG`; import
`insertSession` from `~test/fixtures/evCharging`, `listStale` from `~/lib/services/sessionCost` and
`PRICING_VERSION` from `~/lib/evCharging/cost`):

```ts
test('a tariff edit leaves every session repriced', async () => {
  await signIn('admin')
  await insertSession()
  await call(tariffRouter.create, AUG, { context: baseContext() })
  expect(await listStale({ pricingVersion: PRICING_VERSION })).toEqual([])
})
```

In `src/lib/evCharging/sync.test.ts` (its `fakeZaptec`, `session(id, endAt)`, `capturingLogger` and `T1`; import
`listStale` from `~/lib/services/sessionCost` and `PRICING_VERSION` from `./cost`):

```ts
test('a sync run leaves the sessions it imported repriced', async () => {
  const { client } = fakeZaptec([session('s1', new Date('2026-09-18T12:00:00Z'))])
  const { log } = capturingLogger()
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })
  expect(await listStale({ pricingVersion: PRICING_VERSION })).toEqual([])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run src/lib/evCharging/repriceStale.test.ts src/lib/orpc/procedures/tariff.test.ts src/lib/evCharging/sync.test.ts`
Expected: FAIL (module missing; sessions stale after the edit and the sync).

- [ ] **Step 3: `repriceStale`**

`src/lib/evCharging/repriceStale.ts`:

```ts
// Server-only. The eager reprice of stale session costs (ADR-0020, amended
// 2026-10-11): after each Zaptec, elpris and Emaldo sync (after the energy-mix
// derive) and after a tariff edit, so the next costOverview reads only stored
// sums. Best effort with its own budget: a failure or a timeout is a warning,
// and the read path prices whatever is still stale.
import { withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import * as sessionCostService from '~/lib/services/sessionCost'
import { PRICING_VERSION } from './cost'
import { priceSessions, storePriced } from './costing'

/**
 * How long a sync waits for the reprice. A run's 240 s deadline, the 10 s
 * month refresh, the 30 s derive and this 10 s add up to 290 s, under Vercel's
 * 300 s function limit. A reprice given up on may still finish; the write-back
 * guard keeps it correct either way.
 */
export const REPRICE_BUDGET_MS = 10_000

async function repriceAll(): Promise<{ stale: number; written: number }> {
  // Generations first, then the inputs (priceSessions): see writePriced.
  const stale = await sessionCostService.listStale({ pricingVersion: PRICING_VERSION })
  if (stale.length === 0) return { stale: 0, written: 0 }
  const priced = await priceSessions(stale.map((s) => s.sessionId))
  const { written } = await storePriced(stale, priced)
  return { stale: stale.length, written }
}

/** Reprices every stale counted session. Returns the milliseconds spent. Never throws. */
export async function repriceStale(a: {
  trigger: string
  log: Logger
  /** The run's deadline signal: once fired, the reprice is skipped (the read path covers it). */
  signal?: AbortSignal
  budgetMs?: number
  /** The reprice (tests). */
  reprice?: () => Promise<{ stale: number; written: number }>
}): Promise<number> {
  if (a.signal?.aborted) {
    a.log.warn('session cost reprice skipped: run deadline reached', { trigger: a.trigger })
    return 0
  }
  const started = performance.now()
  try {
    const result = await withDeadline(
      (a.reprice ?? repriceAll)(),
      AbortSignal.timeout(a.budgetMs ?? REPRICE_BUDGET_MS),
      () => new Error('session cost reprice did not finish within its budget'),
    )
    if (result.stale > 0) {
      a.log.info('session costs repriced', {
        trigger: a.trigger,
        ...result,
        repriceMs: Math.round(performance.now() - started),
      })
    }
  } catch (error) {
    a.log.warn('session cost reprice failed', { trigger: a.trigger, error })
  }
  return Math.round(performance.now() - started)
}
```

- [ ] **Step 4: Call it after each sync's derive**

In `src/lib/evCharging/sync.ts`, inside `execute`'s `finally`, after the `run.deriveMs = await deriveAfterSync({…})`
statement:

```ts
        // ADR-0020 (amended 2026-10-11): reprice what this run made stale, so
        // the next cost read is stored sums only. Best effort, own budget.
        await repriceStale({ trigger: SOURCE, log, signal })
```

with `import { repriceStale } from './repriceStale'`. In `src/lib/spotPrice/sync.ts` the same after its
`deriveAfterSync`, with `trigger: 'elpris'` and `import { repriceStale } from '~/lib/evCharging/repriceStale'`. In
`src/lib/houseEnergy/sync.ts` the same after its `deriveAfterSync` (line ~58 of `execute`'s `finally`), with
`trigger: 'emaldo'` and the same import. Don't add a field to the run stats: the reprice logs its own line.

- [ ] **Step 5: Call it after a tariff edit**

In `src/lib/orpc/procedures/tariff.ts`, add `import { repriceStale } from '~/lib/evCharging/repriceStale'`, and in
each of `create`, `update` and `remove`, after the service call and its `context.log.info(…)`:

```ts
        // After success (ADR-0001): the edit made every stored cost stale.
        await repriceStale({ trigger: 'tariff', log: context.log })
```

It never throws, so it stays inside the `try` without changing the error mapping.

- [ ] **Step 6: Run the tests, then every sync suite**

Run: `bunx vitest run src/lib/evCharging src/lib/spotPrice src/lib/houseEnergy src/lib/orpc/procedures/tariff.test.ts`
Expected: all PASS. A sync test that pins its logger calls exactly may now see `session costs repriced`: assert the
line it cares about with `toHaveBeenCalledWith`, never delete an assertion.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `bun run typecheck && bun run check`

```bash
git add src/lib/evCharging/repriceStale.ts src/lib/evCharging/repriceStale.test.ts \
  src/lib/evCharging/sync.ts src/lib/evCharging/sync.test.ts src/lib/spotPrice/sync.ts \
  src/lib/houseEnergy/sync.ts src/lib/orpc/procedures/tariff.ts src/lib/orpc/procedures/tariff.test.ts
git commit -m "feat(charging): reprice stale session costs after syncs and edits"
```

---

### Task 6: Checkpoint script and docs

**Files:**
- Create: `scripts/checkSessionCosts.ts`
- Modify: `docs/adr/0020-spot-prices-and-charging-cost.md` (the file named `0020*`), `CLAUDE.md`,
  `docs/superpowers/roadmaps/2026-10-07-server-latency.md`
- Delete: `.bench-cost.ts` (untracked)

**Interfaces:**
- Consumes: `priceSessions` (Task 4), `PRICING_VERSION`, `db` + schema tables (a script may read directly: it is not
  app code, like `deriveEnergyMix.ts`).

- [ ] **Step 1: The read-only comparison script**

`scripts/checkSessionCosts.ts`:

```ts
// Checkpoint 3 of the server-latency roadmap (ADR-0020, amended 2026-10-11):
// prices every counted session on read and compares it with its stored month
// rows. Read-only: it never writes back.
//
//   read -rs DATABASE_URL && DATABASE_URL="$DATABASE_URL" \
//     bun --no-env-file scripts/checkSessionCosts.ts
//
// The target is always given explicitly, never read from env files
// (CLAUDE.md → Gotchas). Exits 1 when a current session differs by more than
// 1e-9 (relative) in any field.
const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL on the command line (see the header comment).')
  process.exit(1)
}
let target: URL
try {
  target = new URL(url)
} catch {
  console.error('DATABASE_URL is not a valid URL.')
  process.exit(1)
}
console.log(
  `Target database: ${decodeURIComponent(target.username)}@${target.hostname}:${target.port || '5432'}${target.pathname}`,
)

// Imported only now: ~/lib/db reads DATABASE_URL when it loads.
const { db } = await import('~/lib/db')
const { evSessionCostMonth } = await import('~/lib/db/schema')
const { PRICING_VERSION } = await import('~/lib/evCharging/cost')
const { priceSessions } = await import('~/lib/evCharging/costing')
const sessionCost = await import('~/lib/services/sessionCost')

const stale = await sessionCost.listStale({ pricingVersion: PRICING_VERSION })
const rows = await db.select().from(evSessionCostMonth)
const staleIds = new Set(stale.map((s) => s.sessionId))
const storedBySession = Map.groupBy(
  rows.filter((r) => !staleIds.has(r.sessionId)),
  (r) => r.sessionId,
)
const priced = await priceSessions([...storedBySession.keys()])

let worst = 0
const offenders: string[] = []
for (const p of priced) {
  const stored = new Map(
    (storedBySession.get(p.sessionId) ?? []).map((r) => [r.year * 100 + r.month, r]),
  )
  const keys = new Set([...stored.keys(), ...p.months.keys()])
  for (const key of keys) {
    const s = stored.get(key)
    const t = p.months.get(key)
    if (!s || !t) {
      offenders.push(`${p.sessionId} ${key}: month only ${s ? 'stored' : 'priced'}`)
      continue
    }
    for (const [field, value] of Object.entries(t)) {
      const diff = Math.abs((s as Record<string, number>)[field] - value)
      const rel = diff / Math.max(1, Math.abs(value))
      worst = Math.max(worst, rel)
      if (rel > 1e-9) offenders.push(`${p.sessionId} ${key} ${field}: ${s[field as keyof typeof s]} vs ${value}`)
    }
  }
}
console.log(
  `Current sessions compared: ${priced.length}; stale (not compared): ${stale.length}; ` +
    `largest relative difference: ${worst}`,
)
for (const o of offenders.slice(0, 50)) console.log(`  ${o}`)
process.exit(offenders.length > 0 ? 1 : 0)
```

A session repriced between the `listStale` read and the month-row read can show as an offender: re-run
before believing one.

- [ ] **Step 2: Run it locally**

First warm the store: `bun .bench-cost.ts` (prices and writes back), then
`DATABASE_URL=postgres://videbacken:videbacken@localhost:14620/videbacken bun --no-env-file scripts/checkSessionCosts.ts`
Expected: `stale (not compared): 0`, largest relative difference ≤ 1e-9, exit 0.

- [ ] **Step 3: Re-measure locally**

Run: `bun .bench-cost.ts` (twice; the second run is the warm store)
Expected: `costOverview` and `sessionCosts` well under the Task 0 numbers. Record both, then `rm .bench-cost.ts`.

- [ ] **Step 4: Commit the script**

Run: `bun run check`

```bash
git add scripts/checkSessionCosts.ts
git commit -m "chore(scripts): compare stored session costs with on-read pricing"
```

- [ ] **Step 5: ADR-0020 amendment**

In `docs/adr/0020-*.md`:
- **Decision in one line:** replace "computed **on read** … never materialized" with "computed by a pure TypeScript
  function … and **stored per session and Stockholm month** (amended 2026-10-11): each write to a cost input bumps
  the session's generation, the stored totals are read only while current, and stale sessions are priced on read
  and written back".
- Add under **Reading it** a paragraph "**Stored totals (amended 2026-10-11, server latency step 3)**" covering: the
  two tables and the current/stale rule (`PRICING_VERSION`); the four writers and what each bumps; the generation
  guard (generations read before inputs; `WHERE generation = g`); `repriceStale` after each sync and tariff edit
  (10 s budget); the reads (one statement for sums + stale ids); what stays on read (the session page's hero and the
  economy); the spec link; **operating notes:** after rolling prod back past this change and forward again, bump
  `PRICING_VERSION` (code written before it doesn't bump, so rows priced before the rollback would still read as
  current); a new total column must be `NOT NULL DEFAULT 0` (the migration runs while the old deployment still
  writes back) and comes with a `PRICING_VERSION` bump. Keep the "missing ≠ 0 kr" rules unchanged: a stored total carries `noPriceKwh` /
  `noTariffKwh` exactly as before.
- **Alternatives considered:** add B (writers recompute, reads trust rows) and C (in-memory cache) with the spec's
  one-line reasons.

- [ ] **Step 6: CLAUDE.md**

- Code map, `lib/db/`: add `sessionCost` to the schema list
  (`schema/{…,spotPrice,electricityTariff,sessionCost}.ts`).
- Code map, `services/`: add `sessionCost` to the list, and after `dbPool …`: "; `sessionCost/invalidate.ts` is the
  bump leaf every cost-input writer calls in its transaction (ADR-0020 amendment)".
- Gotchas, new bullet after the `spot_price_day` one:

  ```md
  - **`ev_session_cost` holds each session's priced cost per month** (ADR-0020, amended 2026-10-11): a stored total
    is read only while its `generation` matches. Anything that writes intervals, the energy mix, spot slots or
    tariffs must bump the affected sessions in the same transaction (`~/lib/services/sessionCost/invalidate`);
    a change to `priceIntervals`/`toIntervals` must bump `PRICING_VERSION`. Otherwise the pages show stale costs.
  ```

- [ ] **Step 7: Roadmap row 3 and checkpoint 3**

In `docs/superpowers/roadmaps/2026-10-07-server-latency.md`:
- Row 3: Plan = `[spec](../specs/2026-10-11-session-cost-store-design.md), [plan](../plans/2026-10-11-server-latency-3-session-cost-store.md)`,
  PR = the PR link once opened, Status `PR open`.
- The order line: "Order (owner, 2026-10-08): … then 6 (checkpoint passed), then 3 (2026-10-11). Row 4 follows
  unless reordered."
- Checkpoint 3 (replace "Defined when the step is shaped."):

  ```md
  3. **After step 3 (prod).** Warm `costOverview` `totalMs` ≤ 40 ms (117–125 at checkpoint 2) with
     `costStaleSessions` 0 and no `costSlots`/`costMix`/`costCompute` on the line; `sessionCostsMs` on `sessions`
     drops by a similar amount. Navigate, don't reload (a reload renders `costOverview` during SSR). The read-only
     `scripts/checkSessionCosts.ts` against prod finds no current session off by more than 1e-9, and a
     `session costs repriced` line follows the first syncs after the deploy. The `/charging` figures are unchanged
     (owner). Baseline before the deploy: <Task 0 numbers>. Details in the
     [spec](../specs/2026-10-11-session-cost-store-design.md#checkpoint-3-prod).
  ```

- [ ] **Step 8: Commit the docs**

Run: `bun run check:ci`

```bash
git add docs/adr/0020-*.md CLAUDE.md docs/superpowers/roadmaps/2026-10-07-server-latency.md
git commit -m "docs(perf): record stored session costs in ADR-0020 and the roadmap"
```

---

## After the tasks (feature-workflow Phases 5–7)

- **Step review (Phase 5)**, one message, all in parallel, each told to assume the step is wrong and given
  `git diff origin/main...HEAD`, this plan, the spec and the Review Focus:
  - Core: `code-reviewer`, a correctness reviewer, a spec reviewer (`general-purpose`).
  - Specialists: `migration-guard` and the schema-design reviewer (`supabase-postgres-best-practices`) for the
    schema; `test-completeness` for the new service and the writers; a reviewer loading
    `better-auth-security-best-practices` for the tariff procedures (admin-only mutations now do extra work after
    success).
  - Verify every finding against the code, fix confirmed ones one commit per concern, rule out the rest with a
    reason.
- **Pre-PR gate (Phase 6):** `bun run check`, `bun run check:ci`, `bun run build`, `bun run test`, the sv/en key
  check (no UI strings change). No UI changes, so no responsive check.
- **Ship (Phase 7):** PR `perf(charging): store priced session costs per month`, body from the PR template with the
  baseline and local numbers; update the roadmap row's PR link. Merge outside 12:25–12:45 and 15:25–15:45 UTC (an
  elpris sync between the migration and the cutover is harmless here, the reads fall back, but keep the deploy
  quiet for the checkpoint). After merge: roadmap row `merged`, then checkpoint 3 in a later session.

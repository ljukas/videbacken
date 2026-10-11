# Server latency step 6: stored daily spot averages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `evCharging/economy` reads each day's average spot price from a stored `spot_price_day` row instead of
grouping every slot of the year, so `economyDailySpotMs` drops from 56–247 ms (prod) to a PK read.

**Architecture:** A new `spot_price_day` table (PK `(zone, day)`), upserted by `spotPrice.replaceDay` in the same
transaction as the day's slots (its only writer), backfilled by a custom migration with the same SQL aggregate.
`dailyAverageSpot` keeps its signature and reads the table. Nothing above the service changes.

**Tech Stack:** Drizzle ORM (node-postgres), drizzle-kit migrations, Postgres 17 (local) / Supabase (prod), Vitest
node project with `setupDatabase()`.

**Spec:** [`docs/superpowers/specs/2026-10-11-spot-price-day-design.md`](../specs/2026-10-11-spot-price-day-design.md).
Roadmap: [server latency](../roadmaps/2026-10-07-server-latency.md), row 6. One session, one PR.

**Hat:** feature (a new table and write path; behavior-preserving for the page). Follow `docs/feature-workflow.md`
from Phase 3 (Isolate). Branch `perf/spot-price-day` (already created from `origin/main`, holds the spec commit). PR
title: `perf(spot-price): store daily spot averages on write`.

## Global Constraints

- Every `pgTable(...)` ends with `.enableRLS()` (`test/rls.test.ts` enforces it); re-export from `src/lib/db/schema/index.ts` (already `export * from './spotPrice'`).
- Migrations: `bun run db:generate --name=<desc>`; custom SQL via `bun run db:generate --custom --name=<desc>`. Never hand-edit `drizzle/meta/`.
- Schema changes get **`migration-guard` and the schema-design review** (subagent loading `supabase-postgres-best-practices`) before code builds on them (Non-negotiable).
- All DB access through `src/lib/services/` (ADR-0002). No `console.*`; logging via `~/lib/logger`.
- `DailySpot` stays `{ day: string; avgSekPerKwh: number; coveredMs: number }` (`src/lib/spotPrice/slots.ts`).
- `covered_seconds` CHECK: `> 0 AND <= 90000` (a 25 h DST day).
- Merge outside **12:25–12:45 and 15:25–15:45 UTC** (the elpris sync's cron times, 12:30 and 15:30 UTC).
- Commits: Conventional Commits, ≤72 chars, imperative; end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never run vitest while a reviewer does (shared local DB; per-worker schema names collide).

## Review Focus

1. **Deploy race:** an old-code elpris sync between the migration's backfill and the cutover stores a day with no
   `spot_price_day` row; the page silently drops that day from the average. Not testable; covered by the merge
   window above and checkpoint 6's day-count query (Task 3 writes it into the roadmap).
2. **Backfill ≠ runtime write:** the custom migration and `replaceDay` are two copies of one aggregate. A difference
   (day grouping across the UTC boundary, rounding of `covered_seconds`, float summation order) would show as
   different figures after a day is re-synced. Task 1 Step 6 compares the backfill to the old query on the local DB
   (239 days); both aggregates sum `ORDER BY slot_start` so the float order is fixed.
3. **Summation order vs today's numbers:** the old query summed in scan order (PK range scan, i.e. `slot_start`
   order). Task 1 Step 6 requires exact equality and reports the max difference if not.
4. **A day stored at local midnight in UTC terms** (2026-09-28 starts 2026-09-27T22:00Z): the row's `day` must be the
   Stockholm day, not the UTC one. Task 2's first test stores 2026-09-28 and asserts `day: '2026-09-28'`.
5. **Rejected or failed write leaves a stale or orphan average:** Task 2 tests that a rejected day keeps the old
   average and that a never-stored day gets no row.

---

### Task 0: Verify main and re-measure the baseline

**Files:** none committed (a throwaway script, deleted).

- [ ] **Step 1: Confirm the code still matches the spec**

Run: `git fetch -q origin && git log --oneline -3 origin/main && grep -n "export async function dailyAverageSpot\|export async function replaceDay" src/lib/services/spotPrice/spotPrice.ts && ls drizzle/*.sql | tail -2`
Expected: both functions present; the last migration is `0021_house_energy_month_view.sql`. If `origin/main` has a
newer migration (a parallel session), rebase first so ours gets the next number.

- [ ] **Step 2: Prod baseline (read-only, allowed)**

Through the Supabase MCP `execute_sql`:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT to_char(slot_start AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD') AS day,
       sum(sek_per_kwh * extract(epoch FROM slot_end - slot_start)) / sum(extract(epoch FROM slot_end - slot_start)) AS avg,
       sum(extract(epoch FROM slot_end - slot_start)) AS covered_s
FROM spot_price
WHERE zone = 'SE3' AND slot_start >= '2025-12-31T23:00:00Z' AND slot_start < '2026-12-31T23:00:00Z'
GROUP BY 1 ORDER BY 1;
```

Record the execution time and the plan's scan node.

- [ ] **Step 3: Local baseline**

Create `.bench-daily-spot.ts` in the worktree root (path aliases resolve there; `.env` supplies the local
`DATABASE_URL`):

```ts
// .bench-daily-spot.ts — throwaway, never commit
import { dailyAverageSpot } from '~/lib/services/spotPrice'

const times: number[] = []
for (let i = 0; i < 10; i++) {
  const t = performance.now()
  const days = await dailyAverageSpot('SE3', '2026-01-01', '2026-12-31')
  times.push(Math.round((performance.now() - t) * 10) / 10)
  if (i === 0) console.log('days', days.length)
}
console.log('ms', times.join(' '))
process.exit(0)
```

Run: `bun .bench-daily-spot.ts`
Expected: `days 239` (local data) and ten timings. Keep the file until Task 3 (re-run after the change), then delete it.

---

### Task 1: `spot_price_day` table and backfill migration

**Reviewers:** `migration-guard` (agent) + schema-design reviewer (`general-purpose` agent loading
`supabase-postgres-best-practices`, judging against: the PK range read `zone = $1 AND day BETWEEN $2 AND $3`, the
per-day upsert inside `replaceDay`'s transaction, and the one-off backfill over all of `spot_price`).

**Files:**
- Modify: `src/lib/db/schema/spotPrice.ts`
- Create (generated): `drizzle/0023_spot_price_day.sql`, `drizzle/meta/0023_snapshot.json`, journal entry
- Create (generated, then filled in): `drizzle/0024_backfill_spot_price_day.sql`

**Interfaces:**
- Produces: `spotPriceDay` (Drizzle table, exported from `~/lib/db/schema`) with columns `zone: string`,
  `day: string` (`'YYYY-MM-DD'`), `avgSekPerKwh: number`, `coveredSeconds: number`.

- [ ] **Step 1: Add the table**

In `src/lib/db/schema/spotPrice.ts`, extend the `drizzle-orm/pg-core` import with `date` and `integer`, and append:

```ts
// One row per stored Stockholm day of `spot_price`: its time-weighted average
// SEK/kWh (ex VAT) and how long the day is (23/24/25 h). Written only by
// `spotPrice.replaceDay`, in the same transaction as the day's slots, so it is
// never staler than they are; the economy page reads ~255 of these a year
// instead of grouping ~35 000 slots.
export const spotPriceDay = pgTable(
  'spot_price_day',
  {
    zone: text('zone').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    avgSekPerKwh: doublePrecision('avg_sek_per_kwh').notNull(),
    coveredSeconds: integer('covered_seconds').notNull(),
  },
  (table) => [
    // Serves the economy read (`zone = $1 AND day BETWEEN $2 AND $3`) and the
    // upsert's conflict target.
    primaryKey({ name: 'spot_price_day_pk', columns: [table.zone, table.day] }),
    check('spot_price_day_zone_check', sql`${table.zone} IN (${sqlList(PRICE_ZONES)})`),
    // A stored day is whole: 23, 24 or 25 hours.
    check(
      'spot_price_day_covered_seconds_check',
      sql`${table.coveredSeconds} > 0 AND ${table.coveredSeconds} <= 90000`,
    ),
  ],
).enableRLS()
```

- [ ] **Step 2: Generate the table migration**

Run: `bun run db:generate --name=spot_price_day`
Expected: `drizzle/0023_spot_price_day.sql` with `CREATE TABLE "spot_price_day"`, the PK, both CHECKs and
`ENABLE ROW LEVEL SECURITY`. Read it; nothing else may change.

- [ ] **Step 3: Generate and fill the backfill migration**

Run: `bun run db:generate --custom --name=backfill_spot_price_day`, then write into `drizzle/0024_backfill_spot_price_day.sql`:

```sql
-- Server latency step 6: every stored day's average, from the slots already in
-- spot_price. The same aggregate as spotPrice.replaceDay's upsert (keep the two
-- in step), summed in slot order so the float result is deterministic.
-- Idempotent: re-running it rewrites the rows with the same values.
INSERT INTO "spot_price_day" ("zone", "day", "avg_sek_per_kwh", "covered_seconds")
SELECT "zone",
       ("slot_start" AT TIME ZONE 'Europe/Stockholm')::date,
       sum("sek_per_kwh" * extract(epoch FROM "slot_end" - "slot_start") ORDER BY "slot_start")
         / sum(extract(epoch FROM "slot_end" - "slot_start")),
       sum(extract(epoch FROM "slot_end" - "slot_start"))::integer
FROM "spot_price"
GROUP BY 1, 2
ON CONFLICT ("zone", "day") DO UPDATE
  SET "avg_sek_per_kwh" = excluded."avg_sek_per_kwh",
      "covered_seconds" = excluded."covered_seconds";
```

- [ ] **Step 4: Apply locally**

Run: `bun run db:up && bun run db:migrate`
Expected: the pending migrations apply with no error. (The local DB is shared with other worktrees; the change is additive.)

- [ ] **Step 5: RLS test still passes**

Run: `bunx vitest run test/rls.test.ts`
Expected: PASS (the new table has RLS enabled).

- [ ] **Step 6: Equivalence against the old aggregate (local, 239 days)**

```bash
psql postgres://videbacken:videbacken@localhost:14620/videbacken -c "
WITH old AS (
  SELECT zone, to_char(slot_start AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD') AS day,
         sum(sek_per_kwh * extract(epoch FROM slot_end - slot_start)) / sum(extract(epoch FROM slot_end - slot_start)) AS avg,
         sum(extract(epoch FROM slot_end - slot_start)) AS covered_s
  FROM spot_price GROUP BY 1, 2)
SELECT (SELECT count(*) FROM old) AS old_days,
       (SELECT count(*) FROM spot_price_day) AS stored_days,
       count(*) FILTER (WHERE d.day IS NULL) AS missing,
       count(*) FILTER (WHERE d.avg_sek_per_kwh <> o.avg OR d.covered_seconds <> o.covered_s) AS differ,
       max(abs(d.avg_sek_per_kwh - o.avg)) AS max_avg_diff
FROM old o LEFT JOIN spot_price_day d ON d.zone = o.zone AND d.day::text = o.day;"
```

Expected: `old_days = stored_days = 239`, `missing 0`, `differ 0`. If `differ > 0` with `max_avg_diff` below
1e-12, report it (summation order) and keep going; anything larger is a bug — stop and debug.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema/spotPrice.ts drizzle/
git commit -m "feat(spot-price): add spot_price_day with a backfill"
```

Then dispatch both reviewers in parallel, told to assume the task is wrong; fix or rule on every finding.

---

### Task 2: `replaceDay` writes the day's average; `dailyAverageSpot` reads it

**Reviewers:** `code-reviewer` + `test-completeness` (agents).

**Files:**
- Modify: `src/lib/services/spotPrice/spotPrice.ts` (`replaceDay`, `dailyAverageSpot`)
- Modify: `src/lib/services/spotPrice/spotPrice.test.ts`
- Modify: `docs/adr/0020-spot-prices-and-cost-model.md` (amendment)

**Interfaces:**
- Consumes: `spotPriceDay` from Task 1.
- Produces: unchanged signatures — `replaceDay(zone, day, slots): Promise<{ written: number }>`,
  `dailyAverageSpot(zone, fromDay, toDay): Promise<DailySpot[]>`.

- [ ] **Step 1: Write the failing tests**

In `spotPrice.test.ts`, import `spotPriceDay` beside `spotPrice` from `~/lib/db/schema`, add a helper under
`storedCount`:

```ts
async function storedDays() {
  return db.select().from(spotPriceDay).orderBy(spotPriceDay.day)
}
```

Add these tests after `'stores DST days of 92 and 100 slots'`:

```ts
test("replaceDay stores the day's average beside its slots, on the Stockholm day", async () => {
  // 2026-09-28 starts at 2026-09-27T22:00Z: the row is the Stockholm day.
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, (i) => i / 100),
  )
  const rows = await storedDays()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ zone: 'SE3', day: '2026-09-28', coveredSeconds: 86_400 })
  expect(rows[0].avgSekPerKwh).toBeCloseTo(0.475) // mean of 0.00 … 0.95
})

test("re-storing a day replaces its average", async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15, () => 1))
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 60, () => 2))
  const rows = await storedDays()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ day: '2026-09-28', avgSekPerKwh: 2, coveredSeconds: 86_400 })
})

test("replacing a day leaves the neighbouring days' averages alone", async () => {
  await replaceDay('SE3', '2026-09-27', daySlots('2026-09-27', 15, () => 1))
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15, () => 2))
  await replaceDay('SE3', '2026-09-29', daySlots('2026-09-29', 15, () => 3))
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 60, () => 4))
  expect((await storedDays()).map((r) => [r.day, r.avgSekPerKwh])).toEqual([
    ['2026-09-27', 1],
    ['2026-09-28', 4],
    ['2026-09-29', 3],
  ])
})

test('a rejected day keeps its stored average, and a never-stored day gets none', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15, () => 1))
  const holey = daySlots('2026-09-28', 15, () => 5).filter((_, i) => i !== 40)
  await expect(replaceDay('SE3', '2026-09-28', holey)).rejects.toThrow(SpotPriceDomainError)
  const holeyNew = daySlots('2026-09-29', 15, () => 5).filter((_, i) => i !== 40)
  await expect(replaceDay('SE3', '2026-09-29', holeyNew)).rejects.toThrow(SpotPriceDomainError)
  expect((await storedDays()).map((r) => [r.day, r.avgSekPerKwh])).toEqual([['2026-09-28', 1]])
})

test('DST days store 23 and 25 hours', async () => {
  await replaceDay('SE3', '2026-03-29', daySlots('2026-03-29', 60))
  await replaceDay('SE3', '2026-10-25', daySlots('2026-10-25', 15))
  expect((await storedDays()).map((r) => [r.day, r.coveredSeconds])).toEqual([
    ['2026-03-29', 82_800],
    ['2026-10-25', 90_000],
  ])
})

test('dailyAverageSpot reads the stored day averages, not raw slots', async () => {
  // Slots written past replaceDay (no writer does this) have no day row.
  await db.insert(spotPrice).values(
    daySlots('2026-09-28', 60).map((s) => ({
      zone: 'SE3',
      slotStart: new Date(s.startMs),
      slotEnd: new Date(s.endMs),
      sekPerKwh: s.sekPerKwh,
    })),
  )
  expect(await dailyAverageSpot('SE3', '2026-09-28', '2026-09-28')).toEqual([])
})
```

Replace the test `'dailyAverageSpot weights unequal slot lengths by duration, not by count'` (it inserts mixed slot
lengths within one day, which `validateDaySlots` forbids, so it can't reach the only writer) with:

```ts
test("dailyAverageSpot carries each day's covered time, whatever its slot length", async () => {
  // A 23-hour hourly day beside a 24-hour quarter-hour day: the covered time is
  // what weights days against each other (averageSpotOre).
  await replaceDay('SE3', '2026-03-29', daySlots('2026-03-29', 60, () => 1))
  await replaceDay('SE3', '2026-03-30', daySlots('2026-03-30', 15, () => 3))
  expect(await dailyAverageSpot('SE3', '2026-03-29', '2026-03-30')).toEqual([
    { day: '2026-03-29', avgSekPerKwh: 1, coveredMs: 23 * 3_600_000 },
    { day: '2026-03-30', avgSekPerKwh: 3, coveredMs: 24 * 3_600_000 },
  ])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run src/lib/services/spotPrice/spotPrice.test.ts`
Expected: the five new `storedDays` tests FAIL (no rows), and `'dailyAverageSpot reads the stored day averages, not
raw slots'` FAILS (returns the raw day). The rest pass.

- [ ] **Step 3: Implement the write**

In `src/lib/services/spotPrice/spotPrice.ts`: import `spotPriceDay` beside `spotPrice`, add `lte` to the
`drizzle-orm` import, and add at module level (after the imports):

```ts
/** A slot's length in seconds (numeric in Postgres). */
const slotSeconds = sql`extract(epoch FROM ${spotPrice.slotEnd} - ${spotPrice.slotStart})`
```

In `replaceDay`, between the slot insert and `requestDerive`:

```ts
    // The day's average, from the slots just written (spot_price_day). The
    // same aggregate as the 0024 backfill migration; summed in slot order so
    // the float result is deterministic.
    await tx.execute(sql`
      INSERT INTO ${spotPriceDay} (zone, day, avg_sek_per_kwh, covered_seconds)
      SELECT ${spotPrice.zone}, ${day}::date,
             sum(${spotPrice.sekPerKwh} * ${slotSeconds} ORDER BY ${spotPrice.slotStart})
               / sum(${slotSeconds}),
             sum(${slotSeconds})::integer
      FROM ${spotPrice}
      WHERE ${spotPrice.zone} = ${zone}
        AND ${spotPrice.slotStart} >= ${new Date(startMs).toISOString()}::timestamptz
        AND ${spotPrice.slotStart} < ${new Date(endMs).toISOString()}::timestamptz
      GROUP BY ${spotPrice.zone}
      ON CONFLICT (zone, day) DO UPDATE
        SET avg_sek_per_kwh = excluded.avg_sek_per_kwh,
            covered_seconds = excluded.covered_seconds
    `)
```

Update `replaceDay`'s doc comment: append "It also rewrites the day's `spot_price_day` average in the same
transaction (the table's only writer)."

- [ ] **Step 4: Implement the read**

Replace `dailyAverageSpot`'s body and comment:

```ts
/**
 * Per Stockholm day in `[fromDay, toDay]` (inclusive) with stored slots: the
 * time-weighted average SEK/kWh (ex VAT) and how long the day has prices. Read
 * from `spot_price_day` (written by `replaceDay`), a PK range: ~255 rows a year
 * instead of grouping ~35 000 slots.
 */
export async function dailyAverageSpot(
  zone: PriceZone,
  fromDay: string,
  toDay: string,
): Promise<DailySpot[]> {
  const rows = await db
    .select({
      day: spotPriceDay.day,
      avgSekPerKwh: spotPriceDay.avgSekPerKwh,
      coveredSeconds: spotPriceDay.coveredSeconds,
    })
    .from(spotPriceDay)
    .where(
      and(
        eq(spotPriceDay.zone, zone),
        gte(spotPriceDay.day, fromDay),
        lte(spotPriceDay.day, toDay),
      ),
    )
    .orderBy(spotPriceDay.day)
  return rows.map((r) => ({
    day: r.day,
    avgSekPerKwh: r.avgSekPerKwh,
    coveredMs: r.coveredSeconds * 1000,
  }))
}
```

- [ ] **Step 5: Run the service and economy tests**

Run: `bunx vitest run src/lib/services/spotPrice src/lib/evCharging/chargingEconomy.test.ts src/lib/spotPrice/sync.test.ts`
Expected: all PASS.

- [ ] **Step 6: Amend ADR-0020**

In `docs/adr/0020-spot-prices-and-cost-model.md`:
- Under `### Data`, after the `spot_price` bullet, add:
  ```md
  - **`spot_price_day`** (amended 2026-10-11, server-latency step 6) — per stored Stockholm day, the time-weighted
    average SEK/kWh and the covered seconds, PK `(zone, day)`. `replaceDay` rewrites the day's row in the same
    transaction as its slots (the only writer), so it is never staler than they are. Stored because the economy
    page's on-read grouping of a year's slots cost 56–247 ms on prod. The cost math itself stays on read.
  ```
- In `### Counterfactuals`, change "Month average spot comes from `dailyAverageSpot` (per-day time-weighted average,
  aggregated in Postgres)." to "Month average spot comes from `dailyAverageSpot` (per-day time-weighted average,
  stored in `spot_price_day`)."

- [ ] **Step 7: Lint and commit**

```bash
bun run check
git add src/lib/services/spotPrice/ docs/adr/0020-spot-prices-and-cost-model.md
git commit -m "perf(spot-price): store each day's average when the day is written"
```

Then dispatch both reviewers in parallel, told to assume the task is wrong; fix or rule on every finding.

---

### Task 3: Measure, verify, roadmap, PR

**Reviewers:** the Phase 5 branch review (`code-reviewer`, `migration-guard`, schema-design reviewer,
`test-completeness`), not a per-task pair.

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-07-server-latency.md`
- Delete: `.bench-daily-spot.ts` (never committed)

- [ ] **Step 1: Local after-measurement**

Run: `bun .bench-daily-spot.ts`
Expected: `days 239`; timings well below Task 0's. Record both. Then `rm .bench-daily-spot.ts`.

- [ ] **Step 2: Prod read plan of the new query**

Not possible before the deploy (no table on prod). Skip; checkpoint 6 measures prod.

- [ ] **Step 3: Update the roadmap**

In `docs/superpowers/roadmaps/2026-10-07-server-latency.md`:
- Row 6: Step text → "`economyDailySpotMs` (56–247 ms on prod): store each day's average spot in `spot_price_day`,
  written by `replaceDay` in the same transaction as the slots (its only writer), backfilled by migration; `dailyAverageSpot`
  reads ~255 rows by PK"; Plan → `[spec](../specs/2026-10-11-spot-price-day-design.md), [plan](../plans/2026-10-11-server-latency-6-spot-price-day.md)`;
  PR → the PR link once opened; Status → `PR open`.
- Under `## Checkpoints (real-world gates)`, after item 5, add:
  ```md
  6. **After step 6 (prod).** `economyDailySpotMs` on `evCharging/economy` is ≤ 10 ms warm (56–247 before; 205 of 245
     at checkpoint 5), and `economy`'s `totalMs` drops by about as much (navigate, don't reload). The
     `/charging/economy` figures are unchanged (owner). A read-only SELECT shows a `spot_price_day` row for every
     Stockholm day in `spot_price`, each equal to the old aggregate (the query in the
     [plan](../plans/2026-10-11-server-latency-6-spot-price-day.md), Task 1 Step 6). Details in the
     [spec](../specs/2026-10-11-spot-price-day-design.md#checkpoint-6-prod).
  ```

- [ ] **Step 4: Pre-PR gate** (`docs/feature-workflow.md#pre-pr-gate`)

```bash
bun run check && bun run check:ci && bun run build && bun run db:up && bun run db:migrate && bun run test
```

Plus the sv/en key check (no message changes expected). Expected: all green. No UI changed, so no browser check.

- [ ] **Step 5: Re-check `origin/main` for a colliding migration number**

Run: `git fetch -q origin && git diff --name-only HEAD...origin/main -- drizzle/`
Expected: empty. If another branch merged a `0022_*`, rebase and regenerate both migrations (delete ours, re-run
Task 1 Steps 2–3) before the PR.

- [ ] **Step 6: Commit, push, open the PR**

```bash
git add docs/superpowers/roadmaps/2026-10-07-server-latency.md
git commit -m "docs(perf): mark server-latency step 6 PR open"
git push -u origin perf/spot-price-day
```

Open the PR with `.github/PULL_REQUEST_TEMPLATE.md`, title `perf(spot-price): store daily spot averages on write`.
The body states the merge window (outside 12:25–12:45 and 15:25–15:45 UTC) and pastes the Task 0/Task 3 timings,
the equivalence result and the pre-PR gate output. Then add the PR link to the roadmap row in a follow-up commit.

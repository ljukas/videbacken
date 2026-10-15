# Heat pumps step 2b — `heat_pump_day` view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `heatPump.monthSums` (the Översikt heat pump read, `heatPumpMs`) reads per-unit Stockholm day sums from a
materialized view, `heat_pump_day`, instead of scanning `heat_pump_reading`; a range's partial first and last day come
from the readings by primary key; the Comfort Cloud sync refreshes the view once per run that stored hours.

**Architecture:** A custom Drizzle migration creates `heat_pump_day` (one row per unit × Stockholm day: sums, a sum and
an hour count per temperature, hours, first/last hour) and its unique `(heat_pump_id, day)` index; the schema declares
it `pgMaterializedView(…).existing()`. `monthSums({ from, to })` keeps its signature and `HeatPumpMonthRow[]` output: a
pure `splitRange` cuts [from, to) into whole Stockholm days (read from the view) and up to two partial days (read from
the readings with `heat_pump_id = ANY(…)`, the primary key), unioned and grouped per unit and month in one statement.
`refreshDaySums()` runs `REFRESH … CONCURRENTLY`; the shared `refreshAfterSync` (moved from `houseEnergy/` to
`integrations/`, first task) calls it at the end of each Comfort Cloud run that stored hours.

**Tech Stack:** Postgres 17 materialized views, drizzle-orm 0.45 (`pgMaterializedView`, `refreshMaterializedView`,
`db.execute(sql…)`), drizzle-kit 0.31 (`generate --custom`), Vitest node project (per-test schema).

**Spec:** [heat pumps design](../specs/2026-10-08-heat-pumps-design.md): Schema (`heat_pump_day`), Service (the
"Both read `heat_pump_day`" and `refreshDaySums` bullets), Sync ("Refreshing `heat_pump_day`"), Testing (the step 2b
lines). ADR: [ADR-0027](../../adr/0027-heat-pump-energy-data.md) decision 6 (amended 2026-10-15). Roadmap:
[heat pumps](../roadmaps/2026-10-08-heat-pumps.md), step 2b, checkpoint 3b. Precedent:
[the house month view plan](./2026-10-07-energy-month-sums-view.md) and `drizzle/0021_house_energy_month_view.sql`.

## Global Constraints

- One PR, one concern: `perf(heat-pumps): read heat pump sums from a day view` (≤ 72 chars, Conventional Commits).
  The first task is a `refactor:` commit inside it (owner-approved, 2026-10-15).
- View `heat_pump_day`; unique index `heat_pump_day_heat_pump_id_day_idx` on `("heat_pump_id", "day")`; migration
  `drizzle/0027_heat_pump_day_view.sql` (the next free number on `origin/main` at 5c09b85; re-check before the PR,
  parallel sessions collide).
- The migration SQL never writes `"public".` (the test setup runs every migration in a per-test schema). Created
  `WITH DATA` (the default): prod is populated by the deploy's migration. Ends with the role-guarded `REVOKE` from
  `anon` / `authenticated`, copied from migration 0021.
- `day` is `("hour_start" AT TIME ZONE 'Europe/Stockholm')::date`; the time zone name stays inside SQL
  (`stockholm.ts` is the only TypeScript module that names it).
- Heating / cooling kWh: Σ `energy_kwh × coalesce(share, 0)` (a null share counts 0), as today's `monthSums`.
- Temperatures: a month's mean = Σ `*_c_sum` ÷ Σ `*_c_hours`, null when no hour has a value (= today's `avg()`).
- `monthSums`' signature, its `HeatPumpMonthRow` type and its ordering (name, id, month) stay exactly as today;
  `getEnergyOverview` doesn't change; `heatPumpMs` keeps its name.
- Partial-day reads filter `heat_pump_id = ANY(ARRAY(SELECT id FROM heat_pump))` and a `hour_start` range: the
  primary key, never a sequential scan of `heat_pump_reading`.
- Refresh: `REFRESH MATERIALIZED VIEW CONCURRENTLY` in a transaction with `SET LOCAL lock_timeout = '5s'` and
  `statement_timeout = '8s'`; best effort, **10 s** budget (`REFRESH_BUDGET_MS`); a failure or timeout =
  `log.warn('heat pump day refresh failed', { error })`, never a failed run; only when `run.hoursStored > 0`; also
  when the run then fails or its deadline fired. The house sync's messages stay `house energy month …`.
- `run.refreshMs` goes into the Comfort Cloud run type, `toRunStats().timings` and `logFields`.
- No reading value or hour ever reaches a log line or leaves the service (ADR-0027 decision 6).
- All DB access through services (ADR-0002); logging via `~/lib/logger` (ADR-0003).
- Never run two vitest processes at once on the local DB (they collide on per-worker schema names).

## Review Focus

1. **A range whose `from` and `to` fall on the same Stockholm day, or on consecutive days without a whole day between**
   (step 3's `lastYearSoFar` on the 1st at 08:00): only raw hours, no view part, nothing counted twice. Pinned in
   Task 3 (`splitRange` + a DB test).
2. **A partial day on a DST day** (2026-03-29 has 23 h, 2025-10-26 has 25 h) and the month edge at UTC 22:00/23:00:
   the split uses `stockholmDayBounds`, no hour lost or doubled. Pinned in Task 3 (reference-equality test).
3. **Hours stored after the last refresh**: in a partial day they count at once; in a whole day they don't until the
   next refresh (stale, never doubled). Pinned in Task 3.
4. **A re-stored day that shrinks, and a deleted unit**: after a refresh the day's sums go down (recomputed, not
   added); a unit deleted before the refresh never shows (the read inner-joins `heat_pump`). Pinned in Tasks 2 and 3.
5. **A Comfort Cloud run whose refresh throws or hangs, or that stored nothing**: the run's outcome is unchanged, one
   warning without values, no refresh when nothing was stored, a refresh after the deadline fired. Pinned in Task 4.

## Step reviewers (Phase 5)

Core three (`code-reviewer`, correctness, spec) plus: `migration-guard` and the schema-design reviewer (loading
`supabase-postgres-best-practices`, judging the view against `monthSums`' two query shapes and the refresh) for the
migration; `test-completeness` for the service and sync. No UI, procedure or auth change.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/lib/integrations/refreshAfterSync.ts` (+ `.test.ts`) | move from `src/lib/houseEnergy/`, add `label`, `refresh` required | shared best-effort view refresh after a sync |
| `src/lib/houseEnergy/sync.ts` | modify | import the moved helper, pass `label` + `refresh` |
| `drizzle/0027_heat_pump_day_view.sql` (+ `drizzle/meta/*`) | create (`--custom`, then filled) | the view, the unique index, the guarded REVOKE |
| `src/lib/db/schema/heatPump.ts` | modify | `heatPumpDay` (`pgMaterializedView(…).existing()`) |
| `src/lib/services/heatPump/monthSums.ts` (+ `.test.ts`) | modify | `splitRange`, `refreshDaySums`, `monthSums` over the view + partial days |
| `test/fixtures/heatPumpHours.ts` | modify | `storeHours` refreshes the view after storing |
| `src/lib/heatPump/sync.ts` (+ `sync.test.ts`) | modify | refresh in a `finally`, `refreshMs`, `deps.refreshDaySums` |
| `CLAUDE.md`, roadmap, step 3 + 4b plans | modify | gotcha, code map, row 2b, checkpoint 3b, carry-forwards |

---

### Task 1: Move `refreshAfterSync` to `integrations/` (refactor, behaviour-preserving)

**Files:**
- Move: `src/lib/houseEnergy/refreshAfterSync.ts` → `src/lib/integrations/refreshAfterSync.ts`
- Move: `src/lib/houseEnergy/refreshAfterSync.test.ts` → `src/lib/integrations/refreshAfterSync.test.ts`
- Modify: `src/lib/houseEnergy/sync.ts` (import line 19; the call at ≈ line 171)

**Interfaces:**
- Produces: `refreshAfterSync(a: { stored: boolean; label: string; refresh: () => Promise<void>; log: Logger; budgetMs?: number }): Promise<number>`
  and `REFRESH_BUDGET_MS = 10_000`, from `~/lib/integrations/refreshAfterSync`. Warnings:
  `` `${label} refresh failed` `` and the timeout error `` `${label} refresh did not finish within its budget` ``.

- [ ] **Step 0: Check `main` still matches this plan.** In the worktree:

```bash
git fetch -q origin && git log --oneline -1 origin/main
grep -n "export async function monthSums\|export type HeatPumpMonthRow" src/lib/services/heatPump/monthSums.ts
grep -rn "refreshAfterSync" src --include='*.ts'          # houseEnergy/sync.ts + its own files only
ls drizzle/*.sql | tail -1                                 # 0026_session_cost.sql → this step takes 0027
grep -n "hoursStored\|logFields\|execute:" src/lib/heatPump/sync.ts | head
```

If a migration ≥ 0027 exists, take the next number everywhere below. If `monthSums`' signature changed, stop and
update this plan.

- [ ] **Step 1: Move the files** with `git mv` (keeps history).

```bash
git mv src/lib/houseEnergy/refreshAfterSync.ts src/lib/integrations/refreshAfterSync.ts
git mv src/lib/houseEnergy/refreshAfterSync.test.ts src/lib/integrations/refreshAfterSync.test.ts
```

- [ ] **Step 2: Update the tests first** (`src/lib/integrations/refreshAfterSync.test.ts`): every call passes
  `label: 'house energy month'`; add a test that a different label names its own warning.

```ts
test('the label names the warning', async () => {
  const { log, warn } = fakeLog()
  await refreshAfterSync({
    stored: true,
    label: 'heat pump day',
    log,
    refresh: async () => Promise.reject(new Error('x')),
  })
  expect(warn).toHaveBeenCalledWith('heat pump day refresh failed', { error: expect.any(Error) })
})
```

Run: `bunx vitest run src/lib/integrations/refreshAfterSync.test.ts` → FAIL (type error / wrong message).

- [ ] **Step 3: Rewrite the helper** (`src/lib/integrations/refreshAfterSync.ts`):

```ts
// Server-only. A sync's best-effort refresh of a materialized view over the readings it writes
// (`house_energy_month`, ADR-0024; `heat_pump_day`, ADR-0027): once per run that stored something, also
// when the run then failed or hit its deadline (it is short, and skipping it leaves the pages a run
// behind). Health tracks the source: a failure is a warning, never a failed run. The next run that
// stores repairs a missed refresh.
import { withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'

/** How long a run waits for the refresh (≈ 50 ms on prod for either view). */
export const REFRESH_BUDGET_MS = 10_000

/** Refreshes when the run stored something; returns the milliseconds spent (0 when not). Never throws. */
export async function refreshAfterSync(a: {
  stored: boolean
  /** Names the view in the warning, e.g. 'house energy month'. */
  label: string
  refresh: () => Promise<void>
  log: Logger
  budgetMs?: number
}): Promise<number> {
  if (!a.stored) return 0
  const started = performance.now()
  try {
    await withDeadline(
      a.refresh(),
      AbortSignal.timeout(a.budgetMs ?? REFRESH_BUDGET_MS),
      () => new Error(`${a.label} refresh did not finish within its budget`),
    )
  } catch (error) {
    a.log.warn(`${a.label} refresh failed`, { error })
  }
  return Math.round(performance.now() - started)
}
```

- [ ] **Step 4: Update the house sync** (`src/lib/houseEnergy/sync.ts`): import from
  `'~/lib/integrations/refreshAfterSync'`, add `import { refreshMonthSums } from '~/lib/services/houseEnergy'`
  (extend the existing import from that module), and call:

```ts
        run.refreshMs = await refreshAfterSync({
          stored: run.earliestReplacedDay !== null,
          label: 'house energy month',
          refresh: opts.deps?.refreshMonthSums ?? refreshMonthSums,
          log,
        })
```

- [ ] **Step 5: Run** `bunx vitest run src/lib/integrations/refreshAfterSync.test.ts src/lib/houseEnergy/` → PASS
  (the house sync tests still match `'house energy month refresh failed'`). `bun run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/integrations/refreshAfterSync.ts src/lib/integrations/refreshAfterSync.test.ts src/lib/houseEnergy/refreshAfterSync.ts src/lib/houseEnergy/refreshAfterSync.test.ts src/lib/houseEnergy/sync.ts
git commit -m "refactor(integrations): share refreshAfterSync between syncs"
```

---

### Task 2: The `heat_pump_day` view, its schema declaration and `refreshDaySums`

**Files:**
- Create: `drizzle/0027_heat_pump_day_view.sql` (+ `drizzle/meta/_journal.json`, `drizzle/meta/0027_snapshot.json`, generated)
- Modify: `src/lib/db/schema/heatPump.ts` (add `heatPumpDay`), `src/lib/services/heatPump/monthSums.ts` (add `refreshDaySums`)
- Test: `src/lib/services/heatPump/monthSums.test.ts`

**Interfaces:**
- Produces: `heatPumpDay` (schema, columns `heatPumpId`, `day` (string), `kwh`, `heatKwh`, `coolKwh`, `insideCSum`,
  `insideCHours`, `outsideCSum`, `outsideCHours`, `setpointCSum`, `setpointCHours`, `hours`, `firstHour`,
  `lastHour`); `refreshDaySums(): Promise<void>` exported from `~/lib/services/heatPump`.

- [ ] **Step 1: Generate the empty custom migration**

```bash
bun run db:generate --custom --name=heat_pump_day_view
```

Expected: `drizzle/0027_heat_pump_day_view.sql` (empty) and a journal entry.

- [ ] **Step 2: Fill the migration**

```sql
-- Per-unit Stockholm day sums of heat_pump_reading (ADR-0027 decision 6, amended 2026-10-15; heat pumps step 2b).
-- The heat pump sum reads take whole days from here and a range's partial first and last day from the readings
-- (by primary key), so a request never scans the readings. Refreshed once per Comfort Cloud run that stored hours
-- (heatPump.refreshDaySums). A reading is one whole UTC hour and Stockholm's offsets are whole hours, so every hour
-- lies in one Stockholm day (DST days have 23 or 25). Temperatures keep a sum and an hour count, so any range of
-- days gets the exact hour-weighted mean.
CREATE MATERIALIZED VIEW "heat_pump_day" AS
SELECT
  "heat_pump_id",
  ("hour_start" AT TIME ZONE 'Europe/Stockholm')::date AS "day",
  sum("energy_kwh") AS "kwh",
  sum("energy_kwh" * coalesce("heat_share", 0)) AS "heat_kwh",
  sum("energy_kwh" * coalesce("cool_share", 0)) AS "cool_kwh",
  sum("inside_c") AS "inside_c_sum",
  count("inside_c")::int AS "inside_c_hours",
  sum("outside_c") AS "outside_c_sum",
  count("outside_c")::int AS "outside_c_hours",
  sum("setpoint_c") AS "setpoint_c_sum",
  count("setpoint_c")::int AS "setpoint_c_hours",
  count(*)::int AS "hours",
  min("hour_start") AS "first_hour",
  max("hour_start") AS "last_hour"
FROM "heat_pump_reading"
GROUP BY 1, 2;
--> statement-breakpoint
-- REFRESH … CONCURRENTLY needs a unique index over every row.
CREATE UNIQUE INDEX "heat_pump_day_heat_pump_id_day_idx" ON "heat_pump_day" ("heat_pump_id", "day");
--> statement-breakpoint
-- No RLS on a materialized view: keep Supabase's API roles off it (no-op where they don't exist, e.g. local and CI).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "heat_pump_day" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "heat_pump_day" FROM authenticated; END IF;
END $$;
```

- [ ] **Step 3: Declare the view** in `src/lib/db/schema/heatPump.ts` (add `integer`, `pgMaterializedView` to the
  `drizzle-orm/pg-core` import), after `heatPumpReading`:

```ts
// Per-unit Stockholm day sums of heat_pump_reading (ADR-0027 decision 6, amended 2026-10-15): what the
// heat pump sum reads take whole days from, so a request never scans the readings. A materialized view,
// defined in the custom migration 0027 (Drizzle can't declare its unique index, which REFRESH …
// CONCURRENTLY needs), hence `.existing()`: drizzle-kit never generates or drops it. Changing it = a new
// custom migration (drop, create, index + the guarded REVOKE). It is only as fresh as its last refresh:
// every writer of heat_pump_reading must call `heatPump.refreshDaySums()` after it writes (today: the
// Comfort Cloud sync, once per run that stored hours).
export const heatPumpDay = pgMaterializedView('heat_pump_day', {
  heatPumpId: uuid('heat_pump_id').notNull(),
  /** Stockholm calendar day. */
  day: date('day', { mode: 'string' }).notNull(),
  kwh: doublePrecision('kwh').notNull(),
  heatKwh: doublePrecision('heat_kwh').notNull(),
  coolKwh: doublePrecision('cool_kwh').notNull(),
  /** Σ over the hours with a value (null when none has); `…Hours` counts those hours. */
  insideCSum: doublePrecision('inside_c_sum'),
  insideCHours: integer('inside_c_hours').notNull(),
  outsideCSum: doublePrecision('outside_c_sum'),
  outsideCHours: integer('outside_c_hours').notNull(),
  setpointCSum: doublePrecision('setpoint_c_sum'),
  setpointCHours: integer('setpoint_c_hours').notNull(),
  hours: integer('hours').notNull(),
  firstHour: timestamp('first_hour', { withTimezone: true }).notNull(),
  lastHour: timestamp('last_hour', { withTimezone: true }).notNull(),
}).existing()
```

Run `bun run db:generate --name=check_no_diff` → expected "No schema changes" (nothing to generate). If drizzle-kit
writes a migration, delete it and its journal/snapshot entries and fix the declaration (`.existing()` missing).

- [ ] **Step 4: Write the failing tests** (append to `src/lib/services/heatPump/monthSums.test.ts`; import
  `heatPumpDay` from `~/lib/db/schema`, `db` from `~/lib/db`, `replaceDay` from `./heatPump`, `refreshDaySums` from
  `./monthSums`):

```ts
const viewRows = async () =>
  (await db.select().from(heatPumpDay)).sort(
    (a, b) => a.heatPumpId.localeCompare(b.heatPumpId) || a.day.localeCompare(b.day),
  )

test('refreshDaySums over no readings leaves the view empty', async () => {
  await refreshDaySums()
  expect(await viewRows()).toEqual([])
})

test('the view sums each unit per Stockholm day: DST days have 25 and 23 hours, 22:00Z/23:00Z start a day', async () => {
  const id = await seedUnits('Matsal')
  // 2025-10-26 (CET from 03:00 local): 2025-10-25T22:00Z → 2025-10-26T23:00Z, 25 hours.
  // 2026-03-29 (CEST from 02:00 local): 2026-03-28T23:00Z → 2026-03-29T22:00Z, 23 hours.
  await storeHours(id.Matsal, '2025-10-25T21:00:00Z', '2025-10-27T00:00:00Z', undefined, { refresh: false })
  await storeHours(id.Matsal, '2026-03-28T22:00:00Z', '2026-03-29T23:00:00Z', undefined, { refresh: false })
  expect(await viewRows()).toEqual([]) // not refreshed yet
  await refreshDaySums()
  expect((await viewRows()).map((r) => [r.day, r.hours])).toEqual([
    ['2025-10-25', 1],
    ['2025-10-26', 25],
    ['2025-10-27', 1],
    ['2026-03-28', 1],
    ['2026-03-29', 23],
    ['2026-03-30', 1],
  ])
})

test('the view keeps temperature sums and hour counts, and a null share counts 0', async () => {
  const id = await seedUnits('Matsal')
  const hours = [
    { energyKwh: 0.2, heatShare: 1, coolShare: 0, insideC: 20, outsideC: -2, setpointC: null },
    { energyKwh: 0.4, heatShare: null, coolShare: null, insideC: null, outsideC: 4, setpointC: null },
  ]
  await storeHours(id.Matsal, '2026-01-15T10:00:00Z', '2026-01-15T12:00:00Z', (_t, i) => hours[i])
  const [row] = await viewRows()
  expect(row).toMatchObject({
    day: '2026-01-15',
    hours: 2,
    insideCHours: 1,
    outsideCHours: 2,
    setpointCHours: 0,
    setpointCSum: null,
    firstHour: new Date('2026-01-15T10:00:00Z'),
    lastHour: new Date('2026-01-15T11:00:00Z'),
  })
  expect(row.kwh).toBeCloseTo(0.6, 9)
  expect(row.heatKwh).toBeCloseTo(0.2, 9)
  expect(row.insideCSum).toBeCloseTo(20, 9)
  expect(row.outsideCSum).toBeCloseTo(2, 9)
})

test('a re-stored day that shrinks goes down after the refresh (recomputed, not added)', async () => {
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T10:00:00Z')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T04:00:00Z') // replaces the UTC day
  const [row] = await viewRows()
  expect(row.hours).toBe(4)
  expect(row.kwh).toBeCloseTo(0.4, 9)
})
```

(The `{ refresh: false }` fifth argument is added to `storeHours` in this task's Step 5.)

Run: `bunx vitest run src/lib/services/heatPump/monthSums.test.ts` → FAIL (no `refreshDaySums`, no view).

- [ ] **Step 5: Implement** `refreshDaySums` in `src/lib/services/heatPump/monthSums.ts` (add `heatPumpDay` to the
  schema import):

```ts
/**
 * Recomputes the day sums view (`heat_pump_day`, ADR-0027 decision 6) from the readings. CONCURRENTLY: readers keep
 * the previous rows until it commits; a second refresh waits for the first. Every writer of readings calls it after
 * writing (the Comfort Cloud sync, once per run that stored hours). Bounded on the server like
 * `houseEnergy.refreshMonthSums`: the sync's budget only stops waiting, so a lock wait (5 s) and the refresh (8 s)
 * time out here and release the lock.
 */
export async function refreshDaySums(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`)
    await tx.execute(sql`SET LOCAL statement_timeout = '8s'`)
    await tx.refreshMaterializedView(heatPumpDay).concurrently()
  })
}
```

And in `test/fixtures/heatPumpHours.ts`, make `storeHours` refresh after storing (most tests read sums right after),
with an opt-out for the staleness tests:

```ts
import {
  type HeatPumpHourInput,
  refreshDaySums,
  replaceDay,
  upsertUnits,
} from '~/lib/services/heatPump'
…
/**
 * … (keep the existing doc) Then refreshes `heat_pump_day` (as the sync does after a run), unless
 * `opts.refresh` is false.
 */
export async function storeHours(
  heatPumpId: string,
  fromIso: string,
  toIso: string,
  at: (hourStartMs: number, i: number) => HourValues | null = () => ({}),
  opts: { refresh?: boolean } = {},
): Promise<void> {
  … (unchanged body)
  for (const [day, hours] of days) await replaceDay(heatPumpId, day, hours)
  if (opts.refresh ?? true) await refreshDaySums()
}
```

- [ ] **Step 6: Migrate and run**

```bash
bun run db:up && bun run db:migrate
bunx vitest run src/lib/services/heatPump/ test/rls.test.ts
```

Expected: PASS (`rls.test.ts` lists only `relkind IN ('r','p')`, so the view isn't asked for RLS).

- [ ] **Step 7: Commit**

```bash
git add drizzle/0027_heat_pump_day_view.sql drizzle/meta/_journal.json drizzle/meta/0027_snapshot.json src/lib/db/schema/heatPump.ts src/lib/services/heatPump/monthSums.ts src/lib/services/heatPump/monthSums.test.ts test/fixtures/heatPumpHours.ts
git commit -m "feat(heat-pumps): add the heat_pump_day materialized view"
```

- [ ] **Step 8: SCHEMA GATE (mandatory, before Task 3).** Dispatch in parallel: `migration-guard` (agent) on
  `drizzle/0027_heat_pump_day_view.sql` + `schema/heatPump.ts`, and a `general-purpose` schema-design reviewer that
  loads `supabase-postgres-best-practices` and judges the view against the two queries that will run (Task 3's
  `monthSums` statement: a `day` range over every unit, then `heat_pump_id = ANY(…) AND hour_start` ranges on the
  readings; and the refresh), told to assume it is wrong. Fix or explicitly rule on every finding before Task 3.

---

### Task 3: `monthSums` over the view plus partial days

**Files:**
- Modify: `src/lib/services/heatPump/monthSums.ts`, `src/lib/services/heatPump/monthSums.test.ts`

**Interfaces:**
- Consumes: `heatPumpDay` / `refreshDaySums` (Task 2); `stockholmDayOf(ms): string`, `stockholmDayBounds(day): { startMs; endMs }`,
  `addDays(day, n): string` from `~/lib/time/stockholm`.
- Produces: `splitRange(from: Date, to: Date): { wholeDays: { from: string; to: string } | null; partials: { from: Date; to: Date }[] }`
  (`wholeDays.to` exclusive); `monthSums` unchanged in signature and output.

- [ ] **Step 1: Write the failing `splitRange` tests** (pure, no DB; same file):

```ts
describe('splitRange', () => {
  const d = (iso: string) => new Date(iso)
  test('midnight to midnight: whole days only', () => {
    // Stockholm 2026-01-20 00:00 = 2026-01-19T23:00Z; 2026-02-01 00:00 = 2026-01-31T23:00Z.
    expect(splitRange(d('2026-01-19T23:00:00Z'), d('2026-01-31T23:00:00Z'))).toEqual({
      wholeDays: { from: '2026-01-20', to: '2026-02-01' },
      partials: [],
    })
  })
  test('midnight to mid-day (Översikt): whole days, then the last day up to `to`', () => {
    expect(splitRange(d('2026-01-19T23:00:00Z'), d('2026-10-15T06:00:00Z'))).toEqual({
      wholeDays: { from: '2026-01-20', to: '2026-10-15' },
      partials: [{ from: d('2026-10-14T22:00:00Z'), to: d('2026-10-15T06:00:00Z') }],
    })
  })
  test('mid-day to mid-day: a partial first day, whole days, a partial last day', () => {
    expect(splitRange(d('2026-01-15T05:00:00Z'), d('2026-01-18T05:00:00Z'))).toEqual({
      wholeDays: { from: '2026-01-16', to: '2026-01-18' },
      partials: [
        { from: d('2026-01-15T05:00:00Z'), to: d('2026-01-15T23:00:00Z') },
        { from: d('2026-01-17T23:00:00Z'), to: d('2026-01-18T05:00:00Z') },
      ],
    })
  })
  test('within one day, or across one midnight with no whole day: one partial', () => {
    expect(splitRange(d('2026-03-01T00:00:00Z'), d('2026-03-01T07:00:00Z'))).toEqual({
      wholeDays: null,
      partials: [{ from: d('2026-03-01T00:00:00Z'), to: d('2026-03-01T07:00:00Z') }],
    })
    expect(splitRange(d('2026-03-01T10:00:00Z'), d('2026-03-02T07:00:00Z'))).toEqual({
      wholeDays: null,
      partials: [{ from: d('2026-03-01T10:00:00Z'), to: d('2026-03-02T07:00:00Z') }],
    })
  })
  test('DST: the 23-hour and 25-hour days are split at local midnight', () => {
    // 2026-03-29 local midnight = 2026-03-28T23:00Z, next = 2026-03-29T22:00Z.
    expect(splitRange(d('2026-03-29T10:00:00Z'), d('2026-03-30T22:00:00Z'))).toEqual({
      wholeDays: null,
      partials: [{ from: d('2026-03-29T10:00:00Z'), to: d('2026-03-30T22:00:00Z') }],
    })
    expect(splitRange(d('2025-10-25T22:00:00Z'), d('2025-10-26T23:00:00Z'))).toEqual({
      wholeDays: { from: '2025-10-26', to: '2025-10-27' },
      partials: [],
    })
  })
  test('an empty or inverted range: nothing', () => {
    expect(splitRange(d('2026-03-01T00:00:00Z'), d('2026-03-01T00:00:00Z'))).toEqual({
      wholeDays: null,
      partials: [],
    })
  })
})
```

Run: `bunx vitest run src/lib/services/heatPump/monthSums.test.ts -t splitRange` → FAIL (`splitRange` missing).

- [ ] **Step 2: Implement `splitRange`** in `monthSums.ts`:

```ts
/**
 * Pure: [from, to) as whole Stockholm days [wholeDays.from, wholeDays.to) (calendar days, `to` exclusive), read from
 * `heat_pump_day`, and the partial days around them, read from the readings. A range with no whole day inside is one
 * partial (at most two days of hours, by primary key). DST days follow `stockholmDayBounds`.
 */
export function splitRange(
  from: Date,
  to: Date,
): { wholeDays: { from: string; to: string } | null; partials: { from: Date; to: Date }[] } {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  if (toMs <= fromMs) return { wholeDays: null, partials: [] }
  const fromDay = stockholmDayOf(fromMs)
  const fromBounds = stockholmDayBounds(fromDay)
  const atMidnight = fromBounds.startMs === fromMs
  const wholeFromDay = atMidnight ? fromDay : addDays(fromDay, 1)
  const wholeFromMs = atMidnight ? fromMs : fromBounds.endMs
  const toDay = stockholmDayOf(toMs)
  const toDayStartMs = stockholmDayBounds(toDay).startMs
  if (toDayStartMs <= wholeFromMs) return { wholeDays: null, partials: [{ from, to }] }
  const partials: { from: Date; to: Date }[] = []
  if (wholeFromMs > fromMs) partials.push({ from, to: new Date(wholeFromMs) })
  if (toMs > toDayStartMs) partials.push({ from: new Date(toDayStartMs), to })
  return { wholeDays: { from: wholeFromDay, to: toDay }, partials }
}
```

Run the `splitRange` tests → PASS, also with `TZ=UTC`.

- [ ] **Step 3: Write the failing DB tests** for the new read (same file). A raw reference sum (test-only SQL, the
  pre-2b query) pins equality:

```ts
/** The pre-step-2b read, straight over the readings: the reference `monthSums` must equal. */
async function reference(from: Date, to: Date) {
  const { rows } = await db.execute<{ heat_pump_id: string; y: number; m: number; kwh: number; heat: number; inside: number | null; hours: number }>(sql`
    SELECT heat_pump_id,
      extract(year from date_trunc('month', hour_start AT TIME ZONE 'Europe/Stockholm'))::int AS y,
      extract(month from date_trunc('month', hour_start AT TIME ZONE 'Europe/Stockholm'))::int AS m,
      sum(energy_kwh)::float8 AS kwh, sum(energy_kwh * coalesce(heat_share, 0))::float8 AS heat,
      avg(inside_c)::float8 AS inside, count(*)::int AS hours
    FROM heat_pump_reading WHERE hour_start >= ${from.toISOString()}::timestamptz AND hour_start < ${to.toISOString()}::timestamptz
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)
  return rows.map((r) => ({ id: r.heat_pump_id, y: r.y, m: r.m, kwh: r.kwh, heat: r.heat, inside: r.inside, hours: r.hours }))
}

test.each([
  ['midnight → mid-day (Översikt)', '2025-10-19T22:00:00Z', '2026-04-02T07:00:00Z'],
  ['mid-day → mid-day across both DST days', '2025-10-25T10:00:00Z', '2026-03-29T10:00:00Z'],
  ['a partial last day on the 23-hour day', '2026-03-01T00:00:00Z', '2026-03-29T05:00:00Z'],
  ['same day (lastYearSoFar on the 1st)', '2026-03-31T22:00:00Z', '2026-04-01T06:00:00Z'],
  ['across a month edge without a whole day', '2026-03-31T20:00:00Z', '2026-04-01T03:00:00Z'],
])('equals the raw read: %s', async (_name, fromIso, toIso) => {
  const id = await seedUnits('Matsal', 'Övervåning')
  // Varying values (synthetic) so a lost or doubled hour shows; Övervåning has a gap.
  const vary = (_t: number, i: number) => ({ energyKwh: 0.01 + (i % 7) * 0.01, insideC: 18 + (i % 5), heatShare: (i % 3) / 2 })
  await storeHours(id.Matsal, '2025-10-01T00:00:00Z', '2026-04-03T00:00:00Z', vary)
  await storeHours(id.Övervåning, '2025-10-01T00:00:00Z', '2026-04-03T00:00:00Z', (t, i) =>
    i % 50 === 0 ? null : vary(t, i),
  )
  const from = new Date(fromIso)
  const to = new Date(toIso)
  const got = (await monthSums({ from, to })).map((r) => ({
    id: r.heatPumpId, y: r.year, m: r.month, kwh: r.kwh, heat: r.heatKwh, inside: r.insideC, hours: r.hours,
  }))
  const want = await reference(from, to)
  expect(got.map((g) => [g.id, g.y, g.m, g.hours]).sort()).toEqual(want.map((w) => [w.id, w.y, w.m, w.hours]).sort())
  for (const w of want) {
    const g = got.find((x) => x.id === w.id && x.y === w.y && x.m === w.m)
    expect(g?.kwh).toBeCloseTo(w.kwh, 9)
    expect(g?.heat).toBeCloseTo(w.heat, 9)
    expect(g?.inside).toBeCloseTo(w.inside as number, 9) // every stored hour has an inside value
  }
})

test('hours stored after the refresh: a partial day counts them at once, a whole day only after the next refresh', async () => {
  const id = await seedUnits('Matsal')
  // Stockholm 2026-01-15 whole (24 h: 2026-01-14T23:00Z … 2026-01-15T22:00Z), refreshed.
  await storeHours(id.Matsal, '2026-01-14T23:00:00Z', '2026-01-15T23:00:00Z')
  // Without a refresh, re-store the UTC day 2026-01-15 as 00:00Z–09:00Z (10 h) plus 23:00Z, which is the
  // first hour of Stockholm 2026-01-16. Raw now: the 15th has 1 + 10 = 11 h, the 16th 1 h.
  const keep = (t: number) => {
    const h = new Date(t).getUTCHours()
    return h <= 9 || h === 23 ? {} : null
  }
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-16T00:00:00Z', keep, { refresh: false })
  // Whole day: the 15th (from the view); partial: [2026-01-15T23:00Z, 2026-01-16T05:00Z) (live).
  const range = { from: new Date('2026-01-14T23:00:00Z'), to: new Date('2026-01-16T05:00:00Z') }
  expect((await monthSums(range))[0].hours).toBe(24 + 1) // the stale 15th, the new 16th hour
  await refreshDaySums()
  expect((await monthSums(range))[0].hours).toBe(11 + 1)
})

test('a unit deleted before the refresh never shows', async () => {
  const id = await seedUnits('Matsal', 'Övervåning')
  await storeHours(id.Matsal, '2026-01-14T23:00:00Z', '2026-01-15T23:00:00Z')
  await storeHours(id.Övervåning, '2026-01-14T23:00:00Z', '2026-01-15T23:00:00Z')
  await db.delete(heatPump).where(eq(heatPump.id, id.Övervåning)) // cascades its readings; the view is stale
  const rows = await monthSums({ from: new Date('2026-01-14T23:00:00Z'), to: new Date('2026-01-15T23:00:00Z') })
  expect(rows.map((r) => r.name)).toEqual(['Matsal'])
})
```

Notes for the implementer:
- Import `describe` (vitest), `eq`, `sql` (drizzle-orm), `heatPump` (`~/lib/db/schema`) as needed.
- The equality cases store ≈ 4,400 hours per unit each (≈ 370 `replaceDay` calls); if the file gets slow (> 30 s),
  narrow each case's stored span to its range ± 2 days instead of sharing one span.
- Keep every existing `monthSums` test; they now go through the view because `storeHours` refreshes.

Run: `bunx vitest run src/lib/services/heatPump/monthSums.test.ts` → the new DB tests FAIL against the old
`monthSums` only where the view matters (the stale-view and deleted-unit tests); the equality tests may already pass.
That's expected: they pin the rewrite.

- [ ] **Step 4: Rewrite `monthSums`** over the view + partial days (one statement, `db.execute`):

```ts
type MonthSumRow = {
  heat_pump_id: string
  name: string
  year: number
  month: number
  kwh: number
  heat_kwh: number
  cool_kwh: number
  inside_c: number | null
  outside_c: number | null
  setpoint_c: number | null
  hours: number
  first_hour: Date
  last_hour: Date
  last_seen_at: Date
}

/**
 * Per unit and Stockholm month, the sums over the unit's readings in [from, to), ordered by name, unit, year and month
 * (ADR-0027 decision 6, amended in step 2b). Whole Stockholm days come from `heat_pump_day`; a partial first and last
 * day (`splitRange`) come from the readings, filtered by unit so they run on the primary key, never a scan. Both are
 * the same per-hour sums (a null share counts 0; a temperature keeps its sum and hour count, so the month's mean is
 * hour-weighted), so the union groups into months exactly as the readings would. Whole days are as fresh as the last
 * `refreshDaySums`; partial days see an hour as soon as it is stored. Sums only: `firstHour`, `lastHour` and
 * `lastSeenAt` are for `getEnergyOverview`'s expected hours, and an hour never leaves the service. The name is the
 * unit's current one; a unit deleted since the last refresh drops out with the join.
 */
export async function monthSums({ from, to }: { from: Date; to: Date }): Promise<HeatPumpMonthRow[]> {
  const { wholeDays, partials } = splitRange(from, to)
  const parts: SQL[] = []
  if (wholeDays) {
    parts.push(sql`
      SELECT heat_pump_id, date_trunc('month', day) AS m, kwh, heat_kwh, cool_kwh,
        inside_c_sum, inside_c_hours, outside_c_sum, outside_c_hours, setpoint_c_sum, setpoint_c_hours,
        hours, first_hour, last_hour
      FROM heat_pump_day
      WHERE day >= ${wholeDays.from}::date AND day < ${wholeDays.to}::date`)
  }
  for (const p of partials) {
    parts.push(sql`
      SELECT heat_pump_id, date_trunc('month', hour_start AT TIME ZONE 'Europe/Stockholm') AS m,
        energy_kwh, energy_kwh * coalesce(heat_share, 0), energy_kwh * coalesce(cool_share, 0),
        inside_c, (inside_c IS NOT NULL)::int, outside_c, (outside_c IS NOT NULL)::int,
        setpoint_c, (setpoint_c IS NOT NULL)::int,
        1, hour_start, hour_start
      FROM heat_pump_reading
      WHERE heat_pump_id = ANY(ARRAY(SELECT id FROM heat_pump))
        AND hour_start >= ${p.from.toISOString()}::timestamptz
        AND hour_start < ${p.to.toISOString()}::timestamptz`)
  }
  if (parts.length === 0) return []
  const { rows } = await db.execute<MonthSumRow>(sql`
    SELECT s.heat_pump_id, h.name,
      extract(year from s.m)::int AS year, extract(month from s.m)::int AS month,
      s.kwh, s.heat_kwh, s.cool_kwh,
      s.inside_c_sum / nullif(s.inside_c_hours, 0) AS inside_c,
      s.outside_c_sum / nullif(s.outside_c_hours, 0) AS outside_c,
      s.setpoint_c_sum / nullif(s.setpoint_c_hours, 0) AS setpoint_c,
      s.hours, s.first_hour, s.last_hour, h.last_seen_at
    FROM (
      SELECT heat_pump_id, m,
        sum(kwh) AS kwh, sum(heat_kwh) AS heat_kwh, sum(cool_kwh) AS cool_kwh,
        sum(inside_c_sum) AS inside_c_sum, sum(inside_c_hours)::int AS inside_c_hours,
        sum(outside_c_sum) AS outside_c_sum, sum(outside_c_hours)::int AS outside_c_hours,
        sum(setpoint_c_sum) AS setpoint_c_sum, sum(setpoint_c_hours)::int AS setpoint_c_hours,
        sum(hours)::int AS hours, min(first_hour) AS first_hour, max(last_hour) AS last_hour
      FROM (${sql.join(parts, sql` UNION ALL `)}) AS p (
        heat_pump_id, m, kwh, heat_kwh, cool_kwh, inside_c_sum, inside_c_hours, outside_c_sum, outside_c_hours,
        setpoint_c_sum, setpoint_c_hours, hours, first_hour, last_hour
      )
      GROUP BY heat_pump_id, m
    ) s
    JOIN heat_pump h ON h.id = s.heat_pump_id
    ORDER BY h.name, s.heat_pump_id, s.m`)
  return rows.map((r) => ({
    heatPumpId: r.heat_pump_id,
    name: r.name,
    year: Number(r.year),
    month: Number(r.month),
    kwh: Number(r.kwh),
    heatKwh: Number(r.heat_kwh),
    coolKwh: Number(r.cool_kwh),
    insideC: r.inside_c === null ? null : Number(r.inside_c),
    outsideC: r.outside_c === null ? null : Number(r.outside_c),
    setpointC: r.setpoint_c === null ? null : Number(r.setpoint_c),
    hours: Number(r.hours),
    firstHour: new Date(r.first_hour),
    lastHour: new Date(r.last_hour),
    lastSeenAt: new Date(r.last_seen_at),
  }))
}
```

Imports: `type SQL, sql` from `drizzle-orm` (drop `and`, `eq`, `gte`, `lt` if unused), `heatPumpDay` only for
`refreshDaySums`, `addDays, stockholmDayBounds, stockholmDayOf` from `~/lib/time/stockholm`. Notes:
- `ORDER BY h.name` must sort exactly like today's `orderBy(heatPump.name, …)` (the same column and DB collation).
- The `date_trunc('month', day)` on a `date` casts to `timestamp` without a zone: independent of the session
  `TimeZone`. Verify `TZ=UTC` and default runs both pass.
- If `db.execute` returns `first_hour` as a string, the `new Date(…)` mapping covers it; `Number(...)` covers
  `numeric`/`bigint` strings. Keep the mapping even if node-postgres already parses.

- [ ] **Step 5: Run** `bunx vitest run src/lib/services/heatPump/ && TZ=UTC bunx vitest run src/lib/services/heatPump/monthSums.test.ts`
  → PASS. Then the readers: `bunx vitest run src/lib/services/houseEnergy/energyOverview.test.ts src/lib/orpc/procedures/energy.test.ts`
  → PASS unchanged. If a test there writes heat pump readings with `replaceDay` directly (not `storeHours`), add
  `await refreshDaySums()` after it: `grep -n "heatPump.*replaceDay\|from '~/lib/services/heatPump'" src/lib/services/houseEnergy/energyOverview.test.ts src/lib/orpc/procedures/energy.test.ts`.

- [ ] **Step 6: Confirm the plan** locally (the partial day must use the primary key). With the dev DB migrated and
  some readings (`bun run db:studio` not needed; a psql one-off is fine):

```bash
docker compose exec -T db psql -U videbacken -d videbacken -c "EXPLAIN SELECT heat_pump_id FROM heat_pump_reading WHERE heat_pump_id = ANY(ARRAY(SELECT id FROM heat_pump)) AND hour_start >= now() - interval '8 hours' AND hour_start < now()"
```

Expected: `Index Scan using heat_pump_reading_pkey` (or `Index Only Scan`), no `Seq Scan on heat_pump_reading`. (On
prod, 2026-10-15: Index Scan, 0.22 ms.) Paste the plan line into the commit body.

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/heatPump/monthSums.ts src/lib/services/heatPump/monthSums.test.ts
git commit -m "perf(heat-pumps): read month sums from the day view plus partial days"
```

---

### Task 4: Refresh the view after each Comfort Cloud run that stored hours

**Files:**
- Modify: `src/lib/heatPump/sync.ts`, `src/lib/heatPump/sync.test.ts`

**Interfaces:**
- Consumes: `refreshAfterSync` (Task 1), `refreshDaySums` (Task 2).
- Produces: `ComfortCloudSyncRun.refreshMs: number`; `runComfortCloudSync({ deps: { refreshDaySums?: () => Promise<void> } })`.

- [ ] **Step 1: Write the failing tests** (`src/lib/heatPump/sync.test.ts`). Extend `RunExtra` and `run()` with
  `refreshDaySums?: () => Promise<void>` passed through `deps`. Import `heatPumpDay` from `~/lib/db/schema`.

```ts
test('a run that stored hours leaves the day view fresh and logs refreshMs', async () => {
  const captured = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-03-25')])

  const result = await run(client, { log: captured.log })

  expect(result).toMatchObject({ outcome: 'ok', refreshMs: expect.any(Number) })
  const days = await db.select().from(heatPumpDay)
  expect(days.length).toBeGreaterThan(0)
  expect(days.reduce((n, d) => n + d.hours, 0)).toBe(await hoursStored('Matsal'))
  const line = captured.entries().find((e) => e.msg === 'integration sync run')
  expect(line).toMatchObject({ refreshMs: expect.any(Number) })
})

test('a run that stored nothing does not refresh', async () => {
  const refresh = vi.fn(async () => {})
  // As "a unit that never stored an hour only warns": every day answers empty.
  const { client } = fakeComfortCloud([matsal('2026-03-25', { hasData: () => false })])

  const result = await run(client, { refreshDaySums: refresh })

  expect(result).toMatchObject({ outcome: 'ok', hoursStored: 0, refreshMs: 0 })
  expect(refresh).not.toHaveBeenCalled()
})

test('a run that fails part-way still refreshes for the hours that landed', async () => {
  const refresh = vi.fn(async () => {})
  const quiet = () => ({ registeredOn: '2026-03-28', rows: [] })
  const { client } = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')], {
    days: { [`${OVERVANING}:2026-04-02`]: quiet, [`${OVERVANING}:${TODAY}`]: quiet },
  })

  const result = await run(client, { refreshDaySums: refresh })

  expect(result.outcome).toBe('failed')
  expect(result.hoursStored).toBeGreaterThan(0)
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('a failed refresh only warns, without values: the run is still ok', async () => {
  const captured = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-03-25')])

  const result = await run(client, {
    log: captured.log,
    refreshDaySums: async () => Promise.reject(new Error('refresh boom')),
  })

  expect(result.outcome).toBe('ok')
  expect(captured.entries().filter((e) => e.msg === 'heat pump day refresh failed')).toHaveLength(1)
})

test('a run whose deadline fired before the finally still refreshes the hours that landed', async () => {
  const refresh = vi.fn(async () => {})
  // The first recent day (2026-04-01) lands, then the next day call hangs past the run deadline
  // (runPulledSync's real `setTimeout`, as in the house sync's deadline test).
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: { [`${MATSAL}:2026-04-02`]: () => new Promise<never>(() => {}) },
  })

  const result = await runComfortCloudSync({
    trigger: 'cron',
    now: () => NOW,
    deadlineMs: 1_000,
    deps: {
      comfortCloud: client,
      log: capturingLogger().log,
      sleep: async () => {},
      refreshDaySums: refresh,
    },
  })

  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable', hoursStored: 24 })
  expect(refresh).toHaveBeenCalledTimes(1)
})
```

Note: if the hanging call surfaces with another code than `unreachable`, assert the code the existing
`'a call that outlives the deadline …'` behaviour gives (see `src/lib/integrations/runPulledSync.test.ts`), not a new
one; what must hold is that hours landed, the deadline fired, and `refresh` ran once.

Run: `bunx vitest run src/lib/heatPump/sync.test.ts` → FAIL (`refreshMs` missing, no refresh).

- [ ] **Step 2: Implement** in `src/lib/heatPump/sync.ts`:

```ts
import { refreshAfterSync } from '~/lib/integrations/refreshAfterSync'
import { …, refreshDaySums, … } from '~/lib/services/heatPump'

export type ComfortCloudSyncRun = RunBase & {
  …
  logins: number
  /** Time spent refreshing `heat_pump_day` (0 when the run stored nothing), ms. */
  refreshMs: number
}

// runComfortCloudSync opts.deps:
    refreshDaySums?: () => Promise<void>

// init: add
      refreshMs: 0,

// execute:
    execute: async ({ run, signal, now, log, reportProgress }) => {
      try {
        await syncUnits(client, run, { signal, stats, now, sleep, log, reportProgress })
      } finally {
        // ADR-0027 decision 6: the sum reads take whole days from the day view; refresh it whenever
        // hours landed (also when the run then fails part-way or hit its deadline).
        run.refreshMs = await refreshAfterSync({
          stored: run.hoursStored > 0,
          label: 'heat pump day',
          refresh: opts.deps?.refreshDaySums ?? refreshDaySums,
          log,
        })
      }
    },

// toRunStats().timings: add
        refreshMs: run.refreshMs,

// logFields: add
      refreshMs: run.refreshMs,
```

- [ ] **Step 3: Run** `bunx vitest run src/lib/heatPump/` → PASS (every existing test too; a run line
  shape test that lists keys exactly must gain `refreshMs`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/heatPump/sync.ts src/lib/heatPump/sync.test.ts
git commit -m "feat(heat-pumps): refresh the day view after each Comfort Cloud run"
```

---

### Task 5: Docs — CLAUDE.md, roadmap, step 3 and 4b carry-forwards

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`,
  `docs/superpowers/plans/2026-10-08-heat-pumps-3-page.md`, `docs/superpowers/plans/2026-10-08-heat-pumps-4b-signature.md`

- [ ] **Step 1: CLAUDE.md.** In the code map's `db/` line, after the `house_energy_month` note, add "; heatPump.ts
  declares the `heat_pump_day` materialized view (custom migration, `.existing()`)". In the code map's `integrations/`
  line, add `refreshAfterSync` (the shared best-effort view refresh). Add a Gotcha after the `house_energy_month` one:

```markdown
- **`heat_pump_day` is a materialized view of `heat_pump_reading`** (ADR-0027 decision 6): the heat pump sums read
  whole Stockholm days from it and a range's partial first and last day from the readings (by primary key). Anything
  that writes readings must call `heatPump.refreshDaySums()` afterwards (today only the Comfort Cloud sync, once per
  run that stored hours). The `storeHours` test fixture refreshes; a test that writes with `replaceDay` directly
  refreshes before reading sums. Changing its definition = a new `db:generate --custom` migration (drop + create +
  the unique index + the guarded REVOKE).
```

- [ ] **Step 2: Roadmap.** Row 2b: "`heat_pump_day` materialized view (ADR-0027 decision 6's trigger, met at
  checkpoint 3): the heat pump sums read whole days from the view and partial days by primary key, refreshed after
  each Comfort Cloud run that stored hours; schema review", plan link `../plans/2026-10-15-heat-pumps-2b-day-view.md`,
  status `PR open` with the PR link once opened. Checkpoint 3b's last bullet: "The Comfort Cloud run line logs
  `refreshMs`, and a run that stored no hours logs `refreshMs` 0." Add a Log entry:

```markdown
- 2026-10-15: step 2b shaped and planned. Per-day view (`heat_pump_day`), not per month: Översikt's range ends
  mid-day, step 3's `lastYearSoFar` is a part month and its day chart and step 4b read days. Prod `EXPLAIN ANALYZE`
  (33.5k readings): the month read's scan 11.3 ms warm, building the day sums 28 ms (1,403 rows), a partial day by
  primary key 0.22 ms. `refreshAfterSync` moved to `integrations/` (owner). Carried forward: **step 3**: `daySums`
  reads whole days from `heat_pump_day` (sums ÷ hour counts for the means) and `lastYearSoFar` is a `monthSums` call
  with a mid-day `to`; **step 4b**: the signature's day reads go through step 3's `daySums`, so they read the view.
```

- [ ] **Step 3: Step 3 and 4b plans.** At the top of each (below the header), add an "Amended by step 2b
  (2026-10-15)" note: step 3's Task 2 builds `daySums` as a select from `heat_pump_day` (`heatPumpDay` in
  `schema/heatPump.ts`; means = `*_c_sum / nullif(*_c_hours, 0)`), not a GROUP BY over `heat_pump_reading`; its
  tests store through the `storeHours` fixture (which refreshes) or call `refreshDaySums()`; `lastYearSoFar` calls
  `monthSums({ from, to })` with the mid-day cut, which handles the partial day. Step 4b: nothing changes in its tasks;
  its day reads come from the view through step 3's `daySums`. Don't rewrite the tasks' code blocks; the plans' Task 1
  "check main" step catches the rest.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/roadmaps/2026-10-08-heat-pumps.md docs/superpowers/plans/2026-10-08-heat-pumps-3-page.md docs/superpowers/plans/2026-10-08-heat-pumps-4b-signature.md docs/superpowers/plans/2026-10-15-heat-pumps-2b-day-view.md
git commit -m "docs(heat-pumps): record the day view in CLAUDE.md, roadmap and plans"
```

---

## After the tasks

Phase 5 (step review: core three + `migration-guard`, schema-design, `test-completeness`, all in parallel, told to
assume the step is wrong), Phase 6 (pre-PR gate from `docs/feature-workflow.md`, plus a re-check that no newer
migration number landed on `origin/main`), Phase 7 (PR with this plan and checkpoint 3b linked; the roadmap row
updated to `PR open`). Then stop: checkpoint 3b runs on prod after the deploy, in a later session.

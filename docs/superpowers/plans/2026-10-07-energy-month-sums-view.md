# Energy month sums view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `energy.overview` reads monthly house-energy sums from a Postgres materialized view (`house_energy_month`)
instead of scanning every `house_energy_reading` row, and the Emaldo sync refreshes the view once per run.

**Architecture:** A custom Drizzle migration creates the materialized view (today's `monthRows()` query moved into SQL,
the first/last SoC probes included) plus a unique `(year, month)` index; the schema declares it with
`pgMaterializedView(…).existing()`. `houseEnergy.refreshMonthSums()` runs `REFRESH … CONCURRENTLY`; a best-effort
`refreshAfterSync` helper (shaped like `deriveAfterSync`) calls it at the end of each Emaldo run that stored a day.
`monthRows()` becomes a plain select from the view; nothing downstream changes.

**Tech Stack:** Postgres 17 materialized views, drizzle-orm 0.45 (`pgMaterializedView`, `db.refreshMaterializedView`),
drizzle-kit 0.31 (`generate --custom`), Vitest node project (per-test schema).

**Spec:** [`docs/superpowers/specs/2026-10-07-energy-month-sums-view-design.md`](../specs/2026-10-07-energy-month-sums-view-design.md)
(read it first). ADR: [ADR-0024](../../adr/0024-house-energy-pages.md) (Consequences amended 2026-10-07).

## Global Constraints

- One PR, one concern: `perf(energy): read the month sums from a materialized view` (≤ 72 chars, Conventional Commits).
- View name `house_energy_month`; unique index `house_energy_month_year_month_idx` on `("year", "month")`.
- The migration SQL never writes `"public".` (the test setup runs every migration in a per-test schema).
- The view is created `WITH DATA` (the default): prod is populated by the deploy's migration.
- Refresh: `REFRESH MATERIALIZED VIEW CONCURRENTLY`, best effort, **10 s** budget (`REFRESH_BUDGET_MS = 10_000`),
  failure or timeout = `log.warn('house energy month refresh failed', …)`, never a failed run.
- The refresh runs **before** `deriveAfterSync` in the Emaldo sync's `finally`, only when
  `run.earliestReplacedDay !== null`, and also after the run's deadline has fired.
- `run.refreshMs` goes into the Emaldo run's `timings`, `logFields` and the run type.
- `houseScanMs` keeps its name in `getEnergyOverview`'s timings.
- `EnergyOverview`'s shape and every figure stay exactly as today.
- No reading value ever reaches a log line (ADR-0023): the refresh warning logs the error only.
- All DB access through services (ADR-0002); logging via `~/lib/logger` (ADR-0003).
- Never run two vitest processes at once on the local DB (they collide on per-worker schema names).

## Review Focus

1. **A re-fetched day that shrinks** (Emaldo returns fewer buckets the second time): after the refresh the month's sums
   go *down*. The view is recomputed, not added to. Pinned in Task 1.
2. **A month whose every bucket lacks a SoC**: `first_soc_pct` / `last_soc_pct` are null, so the pages show "—" for
   Lager, as today. Pinned in Task 1.
3. **Stockholm month edges across DST**: the first local hour of 1 April (2026-03-31T22:00Z, CEST) and of 1 November
   (2026-10-31T23:00Z, CET) land in the new month. Pinned in Task 1.
4. **A refresh over an empty table** (a fresh local DB, a new Preview DB): works, the view stays empty, and the overview
   reads "no data". Pinned in Task 1.
5. **A sync whose refresh throws or hangs**: the run is still `ok`, the derive still runs, one warning is logged
   without readings. Pinned in Task 3.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `drizzle/0021_house_energy_month_view.sql` (+ `drizzle/meta/*`) | create (generated `--custom`, then filled) | the view + unique index |
| `src/lib/db/schema/houseEnergy.ts` | modify | `houseEnergyMonth` declaration (`.existing()`) |
| `src/lib/services/houseEnergy/houseEnergy.ts` | modify | `refreshMonthSums()` beside `replaceDay` (the only reading writer) |
| `src/lib/services/houseEnergy/monthSums.test.ts` | create | the view's content: sums, shrink, SoC edges, DST, empty |
| `src/lib/services/houseEnergy/energyOverview.ts` | modify | `monthRows()` selects from the view |
| `src/lib/services/houseEnergy/energyOverview.test.ts` | modify | refresh before reading |
| `src/lib/orpc/procedures/energy.test.ts` | modify | refresh before reading |
| `src/lib/houseEnergy/refreshAfterSync.ts` | create | best-effort refresh with budget + warning |
| `src/lib/houseEnergy/refreshAfterSync.test.ts` | create | its unit tests (no DB) |
| `src/lib/houseEnergy/sync.ts` | modify | call it in `finally`, `refreshMs` stats |
| `src/lib/houseEnergy/sync.test.ts` | modify | wiring: view fresh after a run, before the derive; failure warns |
| `CLAUDE.md` | modify | code map + a gotcha: a new reading writer must refresh the view |

---

### Task 0: Check `main` still matches this plan

**Files:** none changed unless a mismatch is found (then fix this plan first, in the same branch).

- [ ] **Step 1: Check the assumptions**

```bash
ls drizzle/*.sql | tail -1          # expect 0020_sensor_shelly_name.sql → this plan's migration is 0021
grep -n "async function monthRows" src/lib/services/houseEnergy/energyOverview.ts
grep -n "deriveAfterSync({" src/lib/houseEnergy/sync.ts
grep -rn "replaceDay(" src --include=*.ts | grep -v test | grep -v spotPrice   # only sync.ts calls the house one
grep -n "relkind IN ('r', 'p')" test/rls.test.ts
```

Expected: each line found. If the newest migration number moved, use the next free number everywhere below. If
another reading writer appeared, it must call `refreshMonthSums()` too (add a task).

---

### Task 1: The materialized view, its declaration and `refreshMonthSums()`

Reviewers: `migration-guard` + schema-design reviewer (loads `supabase-postgres-best-practices`; judge against the
refresh and the read below).

**Files:**
- Create: `drizzle/0021_house_energy_month_view.sql` (+ the `drizzle/meta` snapshot/journal drizzle-kit writes)
- Modify: `src/lib/db/schema/houseEnergy.ts`
- Modify: `src/lib/services/houseEnergy/houseEnergy.ts`
- Test: `src/lib/services/houseEnergy/monthSums.test.ts`

**Interfaces:**
- Produces: `houseEnergyMonth` (from `~/lib/db/schema`), columns `year, month, gridImportKwh, gridExportKwh, solarKwh,
  loadKwh, batteryDischargeKwh, batteryChargeSolarKwh, batteryChargeGridKwh, buckets, firstBucket, lastBucket,
  firstSocPct, lastSocPct`.
- Produces: `refreshMonthSums(): Promise<void>` (from `~/lib/services/houseEnergy`).

- [ ] **Step 1: Write the failing tests** (`src/lib/services/houseEnergy/monthSums.test.ts`)

```ts
// src/lib/services/houseEnergy/monthSums.test.ts
import { asc } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { houseEnergyMonth } from '~/lib/db/schema'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { reading, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { refreshMonthSums, replaceDay } from './houseEnergy'

setupDatabase()

const dayOf = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return { dayStart: new Date(startMs), dayEnd: new Date(endMs) }
}
const months = () => db.select().from(houseEnergyMonth).orderBy(asc(houseEnergyMonth.year), asc(houseEnergyMonth.month))

test('an empty table refreshes to an empty view', async () => {
  await refreshMonthSums()
  expect(await months()).toEqual([])
})

test('a stored day is invisible until the refresh, then summed per month', async () => {
  await replaceDay(dayOf('2026-02-10'), syntheticDay('2026-02-10', () => ({
    gridImportKwh: 0.1, gridExportKwh: 0.02, solarKwh: 0.05, loadKwh: 0.2,
    batteryDischargeKwh: 0.03, batteryChargeSolarKwh: 0.01, batteryChargeGridKwh: 0.04, batteryChargeAcKwh: 0.01,
  })))
  expect(await months()).toEqual([])
  await refreshMonthSums()
  const [feb] = await months()
  expect(feb).toMatchObject({ year: 2026, month: 2, buckets: 288 })
  expect(feb.gridImportKwh).toBeCloseTo(28.8, 9)
  expect(feb.gridExportKwh).toBeCloseTo(5.76, 9)
  expect(feb.solarKwh).toBeCloseTo(14.4, 9)
  expect(feb.loadKwh).toBeCloseTo(57.6, 9)
  expect(feb.batteryDischargeKwh).toBeCloseTo(8.64, 9)
  expect(feb.batteryChargeSolarKwh).toBeCloseTo(2.88, 9)
  // charge_grid + charge_ac (ADR-0023: ac counts as grid)
  expect(feb.batteryChargeGridKwh).toBeCloseTo(14.4, 9)
  expect(feb.firstBucket).toEqual(dayOf('2026-02-10').dayStart)
  expect(feb.lastBucket).toEqual(new Date(dayOf('2026-02-10').dayEnd.getTime() - 5 * 60_000))
})

test('a re-fetched day that shrinks lowers the month: the view is recomputed, not added to', async () => {
  const day = syntheticDay('2026-05-03', () => ({ loadKwh: 0.1 }))
  await replaceDay(dayOf('2026-05-03'), day)
  await refreshMonthSums()
  await replaceDay(dayOf('2026-05-03'), day.slice(0, 100))
  await refreshMonthSums()
  const [may] = await months()
  expect(may.buckets).toBe(100)
  expect(may.loadKwh).toBeCloseTo(10, 9)
})

test("first and last SoC skip the month's edge buckets without one", async () => {
  await replaceDay(dayOf('2026-09-01'), syntheticDay('2026-09-01', (_t, i) => ({
    batterySocPct: i < 3 || i > 284 ? null : 10 + (i % 50),
  })))
  await refreshMonthSums()
  const [sep] = await months()
  expect(sep.firstSocPct).toBe(13) // bucket 3
  expect(sep.lastSocPct).toBe(10 + (284 % 50)) // bucket 284
})

test('a month without any SoC has null first and last SoC', async () => {
  await replaceDay(dayOf('2026-07-04'), syntheticDay('2026-07-04'))
  await refreshMonthSums()
  const [jul] = await months()
  expect(jul.firstSocPct).toBeNull()
  expect(jul.lastSocPct).toBeNull()
})

test('the first local hour of a month lands in that month across both DST offsets', async () => {
  // 2026-04-01 00:00 CEST = 2026-03-31T22:00Z; 2026-11-01 00:00 CET = 2026-10-31T23:00Z
  await replaceDay(dayOf('2026-03-31'), syntheticDay('2026-03-31', () => ({ loadKwh: 1 })))
  await replaceDay(dayOf('2026-04-01'), [reading(Date.parse('2026-03-31T22:00:00Z'), { loadKwh: 2 })])
  await replaceDay(dayOf('2026-10-31'), syntheticDay('2026-10-31', () => ({ loadKwh: 1 })))
  await replaceDay(dayOf('2026-11-01'), [reading(Date.parse('2026-10-31T23:00:00Z'), { loadKwh: 2 })])
  await refreshMonthSums()
  const rows = await months()
  expect(rows.map((r) => [r.month, r.buckets, r.loadKwh])).toEqual([
    [3, 288, 288],
    [4, 1, 2],
    [10, 288, 288],
    [11, 1, 2],
  ])
})

test('a second refresh with nothing new changes nothing', async () => {
  await replaceDay(dayOf('2026-02-10'), syntheticDay('2026-02-10', () => ({ loadKwh: 0.1 })))
  await refreshMonthSums()
  const before = await months()
  await refreshMonthSums()
  expect(await months()).toEqual(before)
})
```

Note on the DST test: `syntheticDay` already fills a whole Stockholm day (288 buckets on a 24 h day). 31 March and
31 October 2026 are both 24 h days (the switches are 29 March and 25 October).

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/lib/services/houseEnergy/monthSums.test.ts`
Expected: FAIL to compile/import: `houseEnergyMonth` and `refreshMonthSums` don't exist.

- [ ] **Step 3: Declare the view** (append to `src/lib/db/schema/houseEnergy.ts`; add `integer` and
  `pgMaterializedView` to its `drizzle-orm/pg-core` import)

```ts
// Monthly sums of house_energy_reading, one row per Stockholm month with
// readings (ADR-0024, amended 2026-10-07): what the Energi pages read, so a
// request never scans the readings. A materialized view, defined in the custom
// migration 0021 (Drizzle can't declare its unique index, which REFRESH …
// CONCURRENTLY needs), hence `.existing()`: drizzle-kit never generates or drops
// it. Changing it = a new custom migration (drop, create, index).
// It is only as fresh as its last refresh: every writer of house_energy_reading
// must call `houseEnergy.refreshMonthSums()` after it writes (today: the Emaldo
// sync, once per run).
export const houseEnergyMonth = pgMaterializedView('house_energy_month', {
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  gridImportKwh: doublePrecision('grid_import_kwh').notNull(),
  gridExportKwh: doublePrecision('grid_export_kwh').notNull(),
  solarKwh: doublePrecision('solar_kwh').notNull(),
  loadKwh: doublePrecision('load_kwh').notNull(),
  batteryDischargeKwh: doublePrecision('battery_discharge_kwh').notNull(),
  batteryChargeSolarKwh: doublePrecision('battery_charge_solar_kwh').notNull(),
  /** charge_grid + charge_ac (ADR-0023: ac counts as grid). */
  batteryChargeGridKwh: doublePrecision('battery_charge_grid_kwh').notNull(),
  buckets: integer('buckets').notNull(),
  firstBucket: timestamp('first_bucket', { withTimezone: true }).notNull(),
  lastBucket: timestamp('last_bucket', { withTimezone: true }).notNull(),
  /** SoC of the month's first / last bucket that has one. */
  firstSocPct: doublePrecision('first_soc_pct'),
  lastSocPct: doublePrecision('last_soc_pct'),
}).existing()
```

`schema/index.ts` already re-exports `./houseEnergy`.

- [ ] **Step 4: Generate the custom migration and confirm drizzle-kit ignores the view**

```bash
bun run db:generate --custom --name=house_energy_month_view
bun run db:generate --name=check_no_diff   # expect "No schema changes, nothing to migrate"
```

If the second command writes a migration, the `.existing()` declaration isn't being honoured: delete that file and its
journal entry and stop to investigate (don't hand-craft around it).

- [ ] **Step 5: Fill the migration** (`drizzle/0021_house_energy_month_view.sql`)

```sql
-- Monthly house-energy sums (ADR-0024, amended 2026-10-07). The query the
-- Energi pages ran on every request, now refreshed once per Emaldo sync run
-- (houseEnergy.refreshMonthSums). Sums per UTC hour first: Stockholm's offsets
-- are whole hours, so every hour lies in one Stockholm month and only the
-- hours are converted. The SoC values are primary-key probes per month.
CREATE MATERIALIZED VIEW "house_energy_month" AS
WITH "hourly" AS (
  SELECT
    date_bin('1 hour', "bucket_start", timestamptz '2000-01-01 00:00:00+00') AS "hour",
    sum("grid_import_kwh") AS "grid_import_kwh",
    sum("grid_export_kwh") AS "grid_export_kwh",
    sum("solar_kwh") AS "solar_kwh",
    sum("load_kwh") AS "load_kwh",
    sum("battery_discharge_kwh") AS "battery_discharge_kwh",
    sum("battery_charge_solar_kwh") AS "battery_charge_solar_kwh",
    sum("battery_charge_grid_kwh" + "battery_charge_ac_kwh") AS "battery_charge_grid_kwh",
    count(*) AS "buckets",
    min("bucket_start") AS "first_bucket",
    max("bucket_start") AS "last_bucket"
  FROM "house_energy_reading"
  GROUP BY 1
), "monthly" AS (
  SELECT
    extract(year FROM "hour" AT TIME ZONE 'Europe/Stockholm')::int AS "year",
    extract(month FROM "hour" AT TIME ZONE 'Europe/Stockholm')::int AS "month",
    sum("grid_import_kwh") AS "grid_import_kwh",
    sum("grid_export_kwh") AS "grid_export_kwh",
    sum("solar_kwh") AS "solar_kwh",
    sum("load_kwh") AS "load_kwh",
    sum("battery_discharge_kwh") AS "battery_discharge_kwh",
    sum("battery_charge_solar_kwh") AS "battery_charge_solar_kwh",
    sum("battery_charge_grid_kwh") AS "battery_charge_grid_kwh",
    sum("buckets")::int AS "buckets",
    min("first_bucket") AS "first_bucket",
    max("last_bucket") AS "last_bucket"
  FROM "hourly"
  GROUP BY 1, 2
)
SELECT
  "m"."year", "m"."month",
  "m"."grid_import_kwh", "m"."grid_export_kwh", "m"."solar_kwh", "m"."load_kwh",
  "m"."battery_discharge_kwh", "m"."battery_charge_solar_kwh", "m"."battery_charge_grid_kwh",
  "m"."buckets", "m"."first_bucket", "m"."last_bucket",
  (SELECT "p"."battery_soc_pct" FROM "house_energy_reading" "p"
    WHERE "p"."bucket_start" BETWEEN "m"."first_bucket" AND "m"."last_bucket"
      AND "p"."battery_soc_pct" IS NOT NULL
    ORDER BY "p"."bucket_start" ASC LIMIT 1) AS "first_soc_pct",
  (SELECT "p"."battery_soc_pct" FROM "house_energy_reading" "p"
    WHERE "p"."bucket_start" BETWEEN "m"."first_bucket" AND "m"."last_bucket"
      AND "p"."battery_soc_pct" IS NOT NULL
    ORDER BY "p"."bucket_start" DESC LIMIT 1) AS "last_soc_pct"
FROM "monthly" "m";
--> statement-breakpoint
-- REFRESH … CONCURRENTLY needs a unique index over every row.
CREATE UNIQUE INDEX "house_energy_month_year_month_idx" ON "house_energy_month" ("year", "month");
```

Then `bun run db:migrate` (local only; check `.env.local` has no `DATABASE_URL*` line first, CLAUDE.md gotcha).

- [ ] **Step 6: Add `refreshMonthSums()`** (in `src/lib/services/houseEnergy/houseEnergy.ts`, after `replaceDay`; import
  `houseEnergyMonth` from `~/lib/db/schema`)

```ts
/**
 * Recomputes the monthly sums view (`house_energy_month`, ADR-0024) from the
 * readings. CONCURRENTLY: readers keep the previous rows until it commits; a
 * second refresh waits for the first. Every writer of readings calls it after
 * writing (the Emaldo sync, once per run).
 */
export async function refreshMonthSums(): Promise<void> {
  await db.refreshMaterializedView(houseEnergyMonth).concurrently()
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/services/houseEnergy/monthSums.test.ts test/rls.test.ts src/lib/db/houseEnergySchema.test.ts`
Expected: PASS (the RLS test ignores the view: `relkind` `m`).

- [ ] **Step 8: Commit**

```bash
git add drizzle src/lib/db/schema/houseEnergy.ts src/lib/services/houseEnergy/houseEnergy.ts src/lib/services/houseEnergy/monthSums.test.ts
git commit -m "feat(energy): add the house energy month sums view"
```

---

### Task 2: `energy.overview` reads the view

Reviewers: `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/services/houseEnergy/energyOverview.ts` (the `hourly`, `monthly`, `col`, `probeSoc`, `probeStart`,
  `edgeSoc` declarations and `monthRows()`)
- Modify: `src/lib/services/houseEnergy/energyOverview.test.ts`
- Modify: `src/lib/orpc/procedures/energy.test.ts`

**Interfaces:**
- Consumes: `houseEnergyMonth`, `refreshMonthSums` (Task 1).
- Produces: `getEnergyOverview` unchanged (signature, `EnergyOverview`, `timings.houseScanMs`).

- [ ] **Step 1: Make the existing tests refresh before reading** (they are the safety net: same expectations, now
  through the view)

In `energyOverview.test.ts`, import `refreshMonthSums` from `./houseEnergy` and add, under `dayOf`:

```ts
/** The pages read the view: refresh it first, as the sync does after storing. */
async function overview(input: Parameters<typeof getEnergyOverview>[0]) {
  await refreshMonthSums()
  return getEnergyOverview(input)
}
```

Replace every `getEnergyOverview(` call in the file's tests with `overview(` (keep the import; `overview` uses it).

In `src/lib/orpc/procedures/energy.test.ts`, import `refreshMonthSums` beside `replaceDay` and add
`await refreshMonthSums()` right after both `await replaceDay(…)` lines (the timings test and the privacy test).

- [ ] **Step 2: Add the staleness test** (in `energyOverview.test.ts`)

```ts
test('reads the view: a day stored after the last refresh is not seen until the next one', async () => {
  await storeDay('2026-05-10', { loadKwh: 0.1 })
  await refreshMonthSums()
  await storeDay('2026-05-11', { loadKwh: 0.1 })
  const now = new Date('2026-05-12T12:00:00Z')
  const stale = await getEnergyOverview({ year: 2026, now })
  expect(stale.months[4]?.buckets).toBe(288)
  const fresh = await overview({ year: 2026, now })
  expect(fresh.months[4]?.buckets).toBe(576)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bunx vitest run src/lib/services/houseEnergy/energyOverview.test.ts`
Expected: the staleness test FAILS (`stale` sees 576: the service still scans the readings); the others PASS.

- [ ] **Step 4: Replace the scan with a select from the view**

Delete the `hourly`, `local`, `monthly`, `col`, `probeSoc`, `probeStart` and `edgeSoc` declarations, drop the now
unused `count, max, min, sql` and `houseEnergyReading` imports, import `asc` from `drizzle-orm` and `houseEnergyMonth`
from `~/lib/db/schema`, and make `monthRows()`:

```ts
// Every month with readings, oldest first, from the monthly sums view
// (ADR-0024, amended 2026-10-07): the Emaldo sync refreshes it once per run,
// so a request reads one row per month instead of scanning the readings.
// Returns sums only, never a bucket.
async function monthRows(): Promise<MonthRow[]> {
  const rows = await db
    .select()
    .from(houseEnergyMonth)
    .orderBy(asc(houseEnergyMonth.year), asc(houseEnergyMonth.month))
  return rows.map((row) => ({
    year: row.year,
    month: row.month,
    sums: {
      gridImportKwh: row.gridImportKwh,
      gridExportKwh: row.gridExportKwh,
      solarKwh: row.solarKwh,
      loadKwh: row.loadKwh,
      batteryDischargeKwh: row.batteryDischargeKwh,
      batteryChargeSolarKwh: row.batteryChargeSolarKwh,
      batteryChargeGridKwh: row.batteryChargeGridKwh,
      firstSocPct: row.firstSocPct,
      lastSocPct: row.lastSocPct,
      buckets: row.buckets,
    },
    firstBucket: row.firstBucket,
    lastBucket: row.lastBucket,
  }))
}
```

Remove `num` / `numOrNull` if nothing else uses them. In `getEnergyOverview`, `houseScanMs` keeps timing
`monthRows()` (same name; it now times the view read).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/services/houseEnergy/energyOverview.test.ts src/lib/orpc/procedures/energy.test.ts`
Expected: PASS, every pre-existing expectation unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/houseEnergy/energyOverview.ts src/lib/services/houseEnergy/energyOverview.test.ts src/lib/orpc/procedures/energy.test.ts
git commit -m "perf(energy): read the overview's months from the sums view"
```

---

### Task 3: The Emaldo sync refreshes the view

Reviewers: `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/houseEnergy/refreshAfterSync.ts`
- Create: `src/lib/houseEnergy/refreshAfterSync.test.ts`
- Modify: `src/lib/houseEnergy/sync.ts` (`EmaldoSyncRun`, `runEmaldoSync`'s `deps`, `init`, `execute`'s `finally`,
  `toRunStats`, `logFields`)
- Modify: `src/lib/houseEnergy/sync.test.ts`

**Interfaces:**
- Consumes: `refreshMonthSums` (Task 1), `withDeadline` (`~/lib/integrations/runPulledSync`).
- Produces: `refreshAfterSync(a: { stored: boolean; log: Logger; refresh?: () => Promise<void>; budgetMs?: number }): Promise<number>`,
  `REFRESH_BUDGET_MS = 10_000`; `runEmaldoSync` `deps.refreshMonthSums?: () => Promise<void>`; `EmaldoSyncRun.refreshMs: number`.

- [ ] **Step 1: Write the helper's failing tests** (`src/lib/houseEnergy/refreshAfterSync.test.ts`)

```ts
import { expect, test, vi } from 'vitest'
import type { Logger } from '~/lib/logger'
import { refreshAfterSync } from './refreshAfterSync'

function fakeLog() {
  const warn = vi.fn()
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => log }
  return { log, warn }
}

test('nothing stored: no refresh, 0 ms', async () => {
  const refresh = vi.fn(async () => {})
  const { log } = fakeLog()
  expect(await refreshAfterSync({ stored: false, log, refresh })).toBe(0)
  expect(refresh).not.toHaveBeenCalled()
})

test('refreshes once and returns the whole milliseconds spent', async () => {
  const refresh = vi.fn(async () => {})
  const { log, warn } = fakeLog()
  const ms = await refreshAfterSync({ stored: true, log, refresh })
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(Number.isInteger(ms)).toBe(true)
  expect(warn).not.toHaveBeenCalled()
})

test('a failed refresh warns and never throws', async () => {
  const error = new Error('could not refresh')
  const { log, warn } = fakeLog()
  await expect(
    refreshAfterSync({ stored: true, log, refresh: async () => Promise.reject(error) }),
  ).resolves.toEqual(expect.any(Number))
  expect(warn).toHaveBeenCalledWith('house energy month refresh failed', { error })
})

test('a refresh past its budget warns and returns', async () => {
  const { log, warn } = fakeLog()
  const never = () => new Promise<void>(() => {})
  await refreshAfterSync({ stored: true, log, refresh: never, budgetMs: 10 })
  expect(warn).toHaveBeenCalledWith('house energy month refresh failed', {
    error: expect.objectContaining({ message: 'house energy month refresh did not finish within its budget' }),
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/lib/houseEnergy/refreshAfterSync.test.ts`
Expected: FAIL: module `./refreshAfterSync` not found.

- [ ] **Step 3: Write the helper** (`src/lib/houseEnergy/refreshAfterSync.ts`)

```ts
// Server-only. The Emaldo sync's best-effort refresh of the monthly sums view
// (ADR-0024, amended 2026-10-07), at the end of `execute`, before the derive:
// once per run that stored a day, also when the run then failed or hit its
// deadline (it is short, and skipping it leaves the pages an hour behind).
// Health tracks the source: a failure is a warning, never a failed run. Every
// run stores yesterday and today, so the next run repairs a missed refresh.
import { withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { refreshMonthSums } from '~/lib/services/houseEnergy'

/** How long a run waits for the refresh (≈ 50 ms on prod at 75k readings). */
export const REFRESH_BUDGET_MS = 10_000

/** Refreshes when the run stored a day; returns the milliseconds spent (0 when not). Never throws. */
export async function refreshAfterSync(a: {
  stored: boolean
  log: Logger
  /** The refresh (tests). */
  refresh?: () => Promise<void>
  budgetMs?: number
}): Promise<number> {
  if (!a.stored) return 0
  const started = performance.now()
  try {
    await withDeadline(
      (a.refresh ?? refreshMonthSums)(),
      AbortSignal.timeout(a.budgetMs ?? REFRESH_BUDGET_MS),
      () => new Error('house energy month refresh did not finish within its budget'),
    )
  } catch (error) {
    a.log.warn('house energy month refresh failed', { error })
  }
  return Math.round(performance.now() - started)
}
```

- [ ] **Step 4: Run the helper's tests to verify they pass**

Run: `bunx vitest run src/lib/houseEnergy/refreshAfterSync.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the sync's failing tests** (in `src/lib/houseEnergy/sync.test.ts`)

Extend `RunExtra` and `run` so tests can inject the refresh and the derive:

```ts
type RunExtra = {
  log?: ReturnType<typeof capturingLogger>['log']
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  refreshMonthSums?: () => Promise<void>
  deriveFrom?: typeof deriveFrom
}
const run = (client: EmaldoClient, extra: RunExtra = {}) =>
  runEmaldoSync({
    trigger: 'cron',
    now: extra.now ?? (() => NOW),
    deps: {
      emaldo: client,
      log: extra.log ?? capturingLogger().log,
      sleep: extra.sleep ?? (async () => {}),
      refreshMonthSums: extra.refreshMonthSums,
      deriveFrom: extra.deriveFrom,
    },
  })
```

(Import `type deriveFrom` from `./derive`, `houseEnergyMonth` from `~/lib/db/schema` and `db` from `~/lib/db` if
not already imported.) The file's own `fakeEmaldo()` answers every day with three synthetic buckets (its local
`syntheticDay(day, n)`), and a run's result carries `outcome`. Add:

```ts
test('a run that stored days leaves the month sums view fresh, before the derive runs', async () => {
  const seen: number[] = []
  const deriveSpy: typeof deriveFrom = async (fromDay) => {
    seen.push((await db.select().from(houseEnergyMonth)).length)
    return { fromDay, days: 0, sessions: 0, deriveMs: 0 }
  }
  const { client } = fakeEmaldo()

  const result = await run(client, { deriveFrom: deriveSpy })

  expect(result).toMatchObject({ outcome: 'ok', refreshMs: expect.any(Number) })
  // Yesterday (31 March) and today (1 April) are two Stockholm months.
  expect((await db.select().from(houseEnergyMonth)).map((m) => m.month).sort()).toEqual([3, 4])
  expect(seen).toEqual([2]) // the derive saw the refreshed view
})

test('a failed refresh only warns: the run is ok and the derive still runs', async () => {
  const captured = capturingLogger()
  const derive = vi.fn<typeof deriveFrom>(async (fromDay) => ({ fromDay, days: 0, sessions: 0, deriveMs: 0 }))
  const { client } = fakeEmaldo()

  const result = await run(client, {
    log: captured.log,
    deriveFrom: derive,
    refreshMonthSums: async () => Promise.reject(new Error('refresh boom')),
  })

  expect(result.outcome).toBe('ok')
  expect(derive).toHaveBeenCalledWith(YESTERDAY, expect.anything())
  expect(captured.entries().filter((e) => e.msg === 'house energy month refresh failed')).toHaveLength(1)
})

test('a run that stored nothing does not refresh', async () => {
  const refresh = vi.fn(async () => {})
  const { client } = fakeEmaldo({
    [YESTERDAY]: (d) => syntheticDay(d, 0),
    [TODAY]: (d) => syntheticDay(d, 0),
  })

  const result = await run(client, { refreshMonthSums: refresh })

  expect(result).toMatchObject({ outcome: 'failed', earliestReplacedDay: null, refreshMs: 0 })
  expect(refresh).not.toHaveBeenCalled()
})

test('a run that fails part-way still refreshes for the days that landed', async () => {
  const refresh = vi.fn(async () => {})
  // Today lands, then the empty yesterday fails the run (see "an empty yesterday fails the run…").
  const { client } = fakeEmaldo({ [YESTERDAY]: (d) => syntheticDay(d, 0) })

  const result = await run(client, { refreshMonthSums: refresh })

  expect(result.outcome).toBe('failed')
  expect(refresh).toHaveBeenCalledTimes(1)
})
```

Also extend the existing test 'the run row records since and every counter' (its `timings` expectation) with
`refreshMs: expect.any(Number)` next to `deriveMs: expect.any(Number)`.

- [ ] **Step 6: Run them to verify they fail**

Run: `bunx vitest run src/lib/houseEnergy/sync.test.ts`
Expected: the new tests and the counter test FAIL (no refresh, no `refreshMs`, `deps.refreshMonthSums` ignored).

- [ ] **Step 7: Wire the refresh into the sync** (`src/lib/houseEnergy/sync.ts`)

- `EmaldoSyncRun`: add, after `deriveMs`:

```ts
  /** Time spent refreshing the monthly sums view (ADR-0024). */
  refreshMs: number
```

- `runEmaldoSync`'s `deps`: add `refreshMonthSums?: () => Promise<void>`.
- `init`: add `refreshMs: 0,`.
- `execute`'s `finally`, before the derive:

```ts
      } finally {
        // ADR-0024: the pages read the monthly sums view; refresh it first,
        // whenever a day landed (also when the run then fails part-way).
        run.refreshMs = await refreshAfterSync({
          stored: run.earliestReplacedDay !== null,
          log,
          refresh: opts.deps?.refreshMonthSums,
        })
        // ADR-0023: new readings change the house mix and the pool from the
        // earliest replaced day on — also when the run then fails part-way.
        run.deriveMs = await deriveAfterSync({
```

- `toRunStats().timings` and `logFields`: add `refreshMs: run.refreshMs,` after `deriveMs`.
- Import `refreshAfterSync` from `./refreshAfterSync`.

- [ ] **Step 8: Run the sync and derive tests to verify they pass**

Run: `bunx vitest run src/lib/houseEnergy/sync.test.ts src/lib/houseEnergy/syncDerive.test.ts src/lib/houseEnergy/refreshAfterSync.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/houseEnergy/refreshAfterSync.ts src/lib/houseEnergy/refreshAfterSync.test.ts src/lib/houseEnergy/sync.ts src/lib/houseEnergy/sync.test.ts
git commit -m "feat(energy): refresh the month sums view after each Emaldo run"
```

---

### Task 4: CLAUDE.md, branch review, gate, PR

Reviewers (branch, Phase 5): `migration-guard` + schema-design reviewer (Non-negotiable), `test-completeness`,
`code-reviewer`.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

In the Code map's `db/` line, after `…spotPrice,electricityTariff}.ts`, add: `; houseEnergy.ts also declares the
`house_energy_month` materialized view (custom migration, `.existing()`)`. In **Gotchas**, add:

```md
- **`house_energy_month` is a materialized view of `house_energy_reading`** (ADR-0024): the Energi pages read it,
  and it is only as fresh as its last refresh. Anything that writes readings must call
  `houseEnergy.refreshMonthSums()` afterwards (today only the Emaldo sync, once per run). Tests that write readings and
  read the overview refresh first. Changing its definition = a new `db:generate --custom` migration (drop + create +
  the unique index).
```

- [ ] **Step 2: Branch review** — dispatch the four reviewers above on `git diff origin/main...HEAD`; fix or rule on
  every finding in this PR.

- [ ] **Step 3: Pre-PR gate** (`docs/feature-workflow.md#pre-pr-gate`)

```bash
bun run check && bun run check:ci
bun run build
bun run db:up && bun run db:migrate
bun run test
```

Expected: all green (no UI changed: no browser check needed beyond the suite).

- [ ] **Step 4: Local sanity against the full local history**

```bash
# After `bun run db:migrate` on the local full-history DB, compare the view with a plain sum (psql on :14620):
#   SELECT sum(load_kwh) FROM house_energy_month;  vs  SELECT sum(load_kwh) FROM house_energy_reading;
# and one month's first/last SoC against the old probes.
```

Record the numbers in the PR.

- [ ] **Step 5: Commit, push, open the PR** — title `perf(energy): read the month sums from a materialized view`;
  body: *Why* (prod mean 160 ms, spill at ≈ 10k hours, links to the spec and ADR-0024), *Verification* (gate output,
  local sanity numbers), *Checkpoint after deploy* (the spec's four checks).

### After merge: the checkpoint (on prod, read-only)

Record in a small `docs(energy): …` PR (or the spec's status line):

1. Same figures: the view's 2026-02, 2026-08 rows and the all-time sum equal plain SQL sums over
   `house_energy_reading`; `/energy` and `/energy/battery` show the same values as before.
2. Grants: `SELECT grantee, privilege_type FROM information_schema.table_privileges WHERE table_name =
   'house_energy_month'` lists no `anon` / `authenticated` (the migration revoked them; a grant here means the DO block didn't run).
3. Refresh: the next Emaldo run's log line carries `refreshMs` and no refresh warning; the view's newest `last_bucket`
   moved.
4. Speed: `pg_stat_statements` for the view read, and `rpc timing` `houseScanMs` / `totalMs` for `energy.overview`,
   against the 160 ms mean measured on 2026-10-07.

# Solar-aware cost, step 3: energy-mix derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-10-04 (Task 0, after step 2b).** The battery pool has no round-trip efficiency any more. Inflows
> enter at full kWh, and after each bucket the pool is capped at its end-of-bucket SoC × `C`, keeping the spot sums
> (spec "Derivation" 3, decision 7; ADR-0023 amendment). Measured on the local copy of the full history
> (2026-01-20 → 2026-10-04, 73,945 buckets, SoC on all of them; prod's data matched it exactly at checkpoint 2b):
> - **A row's SoC is the battery's state at the bucket's middle**, neither start nor end. Regressing
>   `soc[i+1] − soc[i]` on bucket i's and bucket i+1's net battery flow gives weights of 0.45–0.54 each, in every
>   month. The charge-onset and charge-stop buckets agree: the SoC moves about half a bucket's worth in each of them.
>   So the state at bucket i's **end** is the mean of `soc[i]` and `soc[i+1]`. The cap uses that mean when both are
>   known and the next row is exactly 5 minutes later; otherwise the bucket isn't capped.
> - **`C` = 7.58 kWh per 100 %**: Σ discharge ÷ Σ SoC drop / 100 over 35,385 adjacent pairs of discharge-only
>   buckets, each pair counting the mean of its two discharges (the SoC change spans half of each). By month:
>   ≈ 6.2 in Jan–Feb, 7.5–8.1 from March. One constant, as the spec says. Too large in winter keeps a little old energy
>   longer, but the pool stays bounded. Prototyped over the whole history, only 3.0 kWh in all ever discharged
>   beyond the pool (the drift rule).
> - **Losses raise the cost of what's left, as agreed.** In the prototype (flat spot), the pool's average cost was
>   1.8× its inflow spot in Jan–Feb (median; p95 2.5×, max 5.4×) and 1.01–1.14× from March. Real winter economics:
>   only ≈ 55 % comes back out. So a battery spot average isn't a market price, and the mix table's battery-spot CHECK
>   is a wide sanity bound (±1000 SEK/kWh, Task 1). The ±100 of `spot_price` could fail a whole derive.
> - The checkpoint stores `capacity_kwh` in place of `eta`. A checkpoint computed with another `C` is never resumed
>   from, so changing `C` rebuilds history at the next derive.
> - The **first** derive in prod rebuilds all history on its own: there is no checkpoint yet and earlier readings
>   exist (Task 7). The script (Task 9) is a fallback, so the owner's pooler-URI prerequisite is no longer needed for
>   checkpoint 3.

**Goal:** For every counted charging session, derive and store (money-free) how each 15-minute slot was supplied:
grid, solar, battery-from-grid (with the average spot it was bought at), battery-from-solar (with the average spot it
would have sold for), battery-unpriced, and no-house-data. Re-derive automatically after the Emaldo, Zaptec and elpris
syncs. Nothing is shown yet (step 4 prices it).

**Architecture:** Pure, client-safe modules in `src/lib/houseEnergy/mix/` do all the math (house supply split per
5-min bucket, session shaping by the load jump, an average-cost battery pool, per-slot car mix). The orchestrator
`src/lib/houseEnergy/derive.ts` runs one derive inside a single transaction that holds a transaction-scoped advisory
lock (reads and writes alike, so concurrent derives never overwrite newer results with older data): load readings,
spot slots and counted sessions through services, run the pool forward from the previous day's checkpoint, rewrite
the mix rows of every session overlapping the window and the daily pool checkpoints. `deriveAfterSync` makes it a
best-effort trigger at the end of each sync's `execute`.

**Tech Stack:** Drizzle 0.45 (node-postgres), Postgres 17 (local) / Supabase (prod), Vitest (node + browser), Bun.

**Spec:** `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md` ("Data model", "Derivation") ·
**ADR:** `docs/adr/0023-solar-aware-charging-cost.md` · **Roadmap:** step 3 of
`docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`

**Branch:** `feat/charging-energy-mix` · **PR title:** `feat(charging): derive each session's grid, solar and battery mix`

## Contract deviations

All additive; only step 3 calls the changed functions unless noted.

1. **Optional trailing `dbOrTx` parameters** so one derive runs in one locked transaction: step 2's
   `listReadings(range, dbOrTx?)` and `firstReadingAt(dbOrTx?)`; `listSlotsOverlapping(zone, ranges, dbOrTx?)`;
   `listSessionEnergy(filter, dbOrTx?)` (which also gains a `{ endsAfter: Date }` filter);
   `replaceForSessions(sessionIds, rows, dbOrTx?)`. Existing callers are unchanged. `src/lib/db/index.ts` exports
   `DbTransaction` / `DbOrTx` types.
2. **Pool checkpoints carry their capacity.** `battery_pool_day` gains `capacity_kwh` and `derived_at`;
   `getPoolDay(day, dbOrTx?)` returns `{ state: PoolState; capacityKwh: number } | null` (not bare `PoolState`), and
   `replacePoolDaysFrom(day, rows, capacityKwh, dbOrTx?)` takes the `C` the rows were computed with. A derive never
   resumes from a checkpoint with another `C`; it rebuilds from the first reading. So a change of
   `BATTERY_CAPACITY_KWH` re-derives history at the next trigger on its own.
3. **Run types gain fields:** Zaptec `SyncRun` and `ElprisSyncRun` gain `deriveFromDay: string | null` and
   `deriveMs: number`; `EmaldoSyncRun` gains `deriveMs: number`. `ImportSessionsResult` gains
   `earliestChangedStartAt: Date | null`. Each sync's `deps` gains `deriveFrom?: typeof deriveFrom` (tests).
4. **Triggers fire on whatever a sync stored, even when the run then fails** (the spec said "after its sync
   succeeds"): a stored change is never detected as new again, so skipping it would lose it for good. Recorded as a
   spec amendment in Task 10.
5. **A fifth pure module** `mix/houseTimeline.ts` (`runHouseTimeline`) runs the pool forward day by day, works out
   each bucket's SoC cap from its own and the next reading's SoC, and records each bucket's supply and battery
   outflow; `deriveSessionMix(buckets, house)` consumes its map.
6. Step 4 note: Σ mix `kwh` of a session equals Σ of its **stretches** (`SessionEnergy.stretches`, i.e. its Zaptec
   intervals, or `energyKwh` for an `estimated` session), not necessarily `energyKwh`. Step 4's guard should compare
   against the stretches.

## Global Constraints

- All DB access through `src/lib/services/**` (ADR-0002). Biome blocks `~/lib/db` / `~/lib/db/schema` imports
  elsewhere (tests and `scripts/` excepted). `derive.ts` and the syncs call services only; the transaction handle
  reaches them as the service-exported type `DeriveTx`.
- Every new table ends with `.enableRLS()`; timestamps `timestamp(..., { withTimezone: true })`; kWh and SEK columns
  `doublePrecision` (float8, like `energy_kwh` and `sek_per_kwh`).
- `src/lib/houseEnergy/mix/*` is pure and client-safe: no I/O, only `import type` from services, value imports only
  from client-safe modules (`~/lib/time/stockholm`, siblings). Guarded by `clientSafe.browser.test.tsx`.
- **Never log readings or mix values.** The derive's log line carries the requested and actual start day, counts and
  timings only.
- **Synthetic fixtures only.** Never copy anything from `data/private/` into a test, fixture or this repo (it's public).
- Logging via `~/lib/logger` (`log` passed in, or `logger` from `~/lib/logger/server`). Never `console.*` outside
  `scripts/`.
- Constants: `BUCKET_MS` = 5 min; `SLOT_MS` = 15 min (UTC quarter-hours); `BASELINE_BUCKETS` = 6 (the 30 min before
  the session start, median); `MIN_BASELINE_BUCKETS` = 3; `BATTERY_CAPACITY_KWH` = **7.58** (kWh per 100 % SoC,
  measured 2026-10-04; see the header note; checkpoint 3 re-measures it on prod); `EMPTY_KWH` = 1e-9; parts-sum tolerance `1e-9 × kwh + 1e-9`; `MIX_INSERT_BATCH` = 2 000;
  `MAX_WIDEN_STEPS` = 10; `DERIVE_BUDGET_MS` = 30 000; derive transaction: `lock_timeout` 20 s, `statement_timeout`
  25 s, `idle_in_transaction_session_timeout` 60 s (a frozen Vercel instance can't hold the lock).
- `battery_charge_ac` counts as **grid origin** (spec, "Sync"). Step 2's checkpoint records its real meaning in the
  spec; Task 0 checks that the recorded meaning still allows this, or the plan is amended first.
- A derive is **best effort**: it logs a warning and never fails, slows past its budget, or changes the outcome of a
  sync run. It runs even when the sync run failed part-way (deviation 4).
- **Migrations are frozen once pushed.** Get `migration-guard` and the schema-design review on Task 1 before the
  first push; a later fix is a new migration, never an edited or regenerated one.
- Conventional Commits, subject ≤ 72 chars, one hat per commit; every commit message ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests need the local DB: `bun run db:up && bun run db:migrate`. Note: the test pool pins **one** connection, so a
  service call inside the derive that forgets its `tx` and uses `db` blocks forever (test timeout). That is the
  symptom to look for if a derive test hangs.

## Review Focus

1. **Energy conservation per session.** Σ mix `kwh` must equal Σ stretch kWh exactly. The clamp and its
   redistribution, an earlier interval sharing a bucket, a zero-length stretch, and gaps are the places where it
   breaks. Tests: Task 2 ("capped at the house load", "an earlier interval's energy … counts against its load",
   "zero-length", "every interval's kWh stays exact"), Task 3 ("parts always sum"), Task 7 (Σ assertions).
2. **The re-derive window.** A session spanning midnight widens the start day. Resuming from a checkpoint must equal
   a full derive. A missing checkpoint, or one with another `C`, rebuilds from the first reading. Sessions ending
   before the window keep their rows, and voided sessions lose theirs. Task 7.
3. **Triggers never lose a change, and never invent one.** Pages imported before a Zaptec failure are still derived;
   an unchanged re-import doesn't derive; a moved start derives from the earlier of the old and new start; elpris and
   Emaldo days stored before a failure are still derived; a derive failure never fails the run. Tasks 6, 7 and 8.
4. **Battery pool edge cases**: empty pool, discharge beyond the pool (drift), inflow without a spot price, a
   grid-charged battery, charge and discharge in the same bucket, float dust. The SoC cap: trims every part by one
   factor and keeps the spot sums; never raises a pool below it; a cap of 0 empties the pool; no cap without both
   SoC values or across a gap; uses the mean of this and the next reading (mid-bucket SoC). Task 3 and Task 7
   ("grid", "without a spot price", "measured SoC").
5. **DST and gaps.** Days have 276 or 300 buckets. Days without readings carry the pool state forward through today.
   A gap inside a session means a uniform spread and no house data. Task 2 ("spring-forward"), Task 3
   ("276 buckets", "300 buckets", "carry"), Task 7 ("after the last reading").

---

### Task 0: Verify main matches this plan

**Files:** none (read-only), except fixing this plan if anything differs.

- [ ] **Step 1: Worktree from up-to-date main**

```bash
cd /Users/lukas/prog/videbacken && git fetch origin
git worktree add ../videbacken-energy-mix -b feat/charging-energy-mix origin/main
cd ../videbacken-energy-mix && cp ../videbacken/.env .env && bun install
bun run db:up && bun run db:migrate
```

Copy `.env` only. Never copy `.env.local`: after a `vercel env pull` it holds production's `DATABASE_URL`.

- [ ] **Step 2: Previous steps merged and checkpoints passed.** In
  `docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`, rows 1, 2 and 2b must read `checkpoint passed` and
  row 2's result must record the settled meaning of `battery_charge_ac`. Read the spec's "Sync (roadmap step 2)"
  bullet on `battery_charge_ac`: if it is no longer "grid-origin" (e.g. it is AC-coupled solar), stop and amend
  `supply.ts` / `pool.ts` in this plan first.

- [ ] **Step 3: Every consumed seam exists as described.** Each grep must print a match:

```bash
grep -n "export type HouseBucket" src/lib/effects/emaldo/emaldo.ts
grep -n "export class EmaldoError\|export interface EmaldoClient" src/lib/effects/emaldo/*.ts
grep -n "export type HouseReading\|export async function replaceDay\|export async function listReadings\|export async function firstReadingAt" src/lib/services/houseEnergy/houseEnergy.ts
grep -n "houseEnergyReading = pgTable" src/lib/db/schema/houseEnergy.ts
grep -n "houseEnergy" src/lib/db/schema/index.ts
grep -n "earliestReplacedDay\|export async function runEmaldoSync\|execute:" src/lib/houseEnergy/sync.ts
grep -n "'emaldo'" src/lib/integrationHealth.ts
grep -n "runEmaldoSync" src/lib/orpc/procedures/evCharging.ts
grep -n "export async function listSessionEnergy\|estimated: boolean" src/lib/services/evCharging/sessionEnergy.ts
grep -n "export type ImportSessionsResult\|export async function importSessions" src/lib/services/evCharging/evCharging.ts
grep -n "export async function listSlotsOverlapping\|export async function replaceDay" src/lib/services/spotPrice/spotPrice.ts
grep -n "export class SlotIndex" src/lib/evCharging/cost/slotIndex.ts
grep -n "export function stockholmDayBounds\|export function addDays\|export function isStockholmDay\|export function stockholmDayOf" src/lib/time/stockholm.ts
grep -n "export function withDeadline" src/lib/integrations/runPulledSync.ts
grep -n "execute:\|reattributeSessions" src/lib/evCharging/sync.ts
grep -n "execute:\|await replaceDay" src/lib/spotPrice/sync.ts
grep -n "export async function insertSession\|export async function insertInterval" test/fixtures/evCharging.ts
```

And these must print **nothing**:

```bash
grep -rn "ev_charge_energy_mix\|battery_pool_day\|energyMix" src drizzle
ls src/lib/houseEnergy/mix 2>/dev/null
```

- [ ] **Step 4: Read the step-2 orchestrator** `src/lib/houseEnergy/sync.ts` in full and confirm:
  - `execute` fetches and stores days **one at a time** and sets `run.earliestReplacedDay` as each day lands (not only
    at the end). If it only sets it at the end, Task 9 also moves that assignment next to the store.
  - `HouseReading` field names equal the contract's (`bucketStart: Date`, `gridImportKwh`, `gridExportKwh`,
    `solarKwh`, `loadKwh`, `batteryDischargeKwh`, `batteryChargeSolarKwh`, `batteryChargeGridKwh`,
    `batteryChargeAcKwh`), and `replaceDay({ dayStart, dayEnd }, buckets)` accepts a whole synthetic day.
  - Whether `test/fixtures/houseEnergy.ts` exists (step 2 may have added one). If it does, Task 2 adds the two
    helpers below to it instead of creating the file, keeping its existing exports.
- [ ] **Step 5: Next migration number**: `ls drizzle/*.sql | tail -2`. Task 1's file will be the next number.
- [ ] **Step 6:** If anything above differs, fix this plan (names, signatures, the Task 9 Emaldo edit) and commit the
  fix as `docs(charging): align the energy mix plan with main` before Task 1.

---

### Task 1: `ev_charge_energy_mix` + `battery_pool_day` schema and migration

**Files:**
- Modify: `src/lib/db/schema/houseEnergy.ts` (append; merge imports into the file's existing ones)
- Create (generated): `drizzle/00NN_energy_mix_and_battery_pool.sql`, `drizzle/meta/*`

**Interfaces:**
- Consumes: `evChargeSession` (`./evCharging`).
- Produces: `evChargeEnergyMix`, `batteryPoolDay`.

**Reviewers:** A = `migration-guard`; B = schema-design reviewer (`general-purpose` agent that loads
`supabase-postgres-best-practices`), told to assume the schema is wrong and to judge it against **the queries that
actually run**:
- `listForSessions`: `SELECT * FROM ev_charge_energy_mix WHERE session_id IN (…≤ ~1 000 ids) ORDER BY session_id, slot_start`
  (step 4 reads it on every cost request).
- `replaceForSessions`: `DELETE … WHERE session_id IN (…)` then batched `INSERT`s (≤ 2 000 rows each), inside the
  derive transaction.
- `pruneUncounted`: `DELETE FROM ev_charge_energy_mix WHERE session_id IN (SELECT id FROM ev_charge_session WHERE end_at > $1 AND NOT counted)`.
- FK cascade when an `ev_charge_session` row is deleted.
- `getPoolDay`: `SELECT … FROM battery_pool_day WHERE day = $1`; `replacePoolDaysFrom`: `DELETE … WHERE day >= $1`
  plus an `INSERT` of ≤ ~1 000 rows.
- Volumes: ≈ 300 sessions/yr × ≈ 30 slots ≈ 10 k mix rows/yr; 365 pool rows/yr. Rows are replaced, never updated.

The reviewer should confirm that the two PKs serve all of the above, with no secondary index needed. It should also
check that every valid derive output satisfies the CHECKs: parts within float tolerance, the spot present exactly
when its kWh > 0, negative spots allowed, battery spots above `spot_price`'s range allowed (losses raise them; see
the header note), slot alignment.

- [ ] **Step 1: Append the tables** to `src/lib/db/schema/houseEnergy.ts`. Ensure the file imports `sql` from
  `drizzle-orm`; `check, date, doublePrecision, pgTable, primaryKey, timestamp, uuid` from `drizzle-orm/pg-core`; and
  `evChargeSession` from `./evCharging`.

```ts
// ── Energy mix (ADR-0023, roadmap step 3) ───────────────────────────────

// One row per counted charging session × 15-minute UTC slot: how that slot's
// charging energy was supplied — straight from the grid, straight from solar,
// from the battery (split by what had charged it: grid energy at the average
// spot it was bought at, solar at the average spot it would have sold for, or
// energy stored in a slot without a price), or with no house data (priced as
// grid). Money-free: kronor are priced on read (ADR-0020). Written only by the
// derive (delete + insert per session, one transaction), never updated.
export const evChargeEnergyMix = pgTable(
  'ev_charge_energy_mix',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => evChargeSession.id, { onDelete: 'cascade' }),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    /** The session's energy in this slot; the six parts below sum to it. */
    kwh: doublePrecision('kwh').notNull(),
    gridKwh: doublePrecision('grid_kwh').notNull(),
    solarKwh: doublePrecision('solar_kwh').notNull(),
    batteryGridKwh: doublePrecision('battery_grid_kwh').notNull(),
    /** Average spot (SEK/kWh ex VAT) the battery's grid energy was bought at; null when its kWh is 0. */
    batteryGridSpotSek: doublePrecision('battery_grid_spot_sek'),
    batterySolarKwh: doublePrecision('battery_solar_kwh').notNull(),
    /** Average spot (SEK/kWh ex VAT) of the slots the battery's solar energy was stored in; null when its kWh is 0. */
    batterySolarSpotSek: doublePrecision('battery_solar_spot_sek'),
    batteryUnpricedKwh: doublePrecision('battery_unpriced_kwh').notNull(),
    noHouseDataKwh: doublePrecision('no_house_data_kwh').notNull(),
  },
  (table) => [
    // Serves every query: the cost read's `session_id IN (…) ORDER BY
    // session_id, slot_start`, the derive's delete by session ids, and the FK
    // cascade from ev_charge_session. No other index.
    primaryKey({ name: 'ev_charge_energy_mix_pk', columns: [table.sessionId, table.slotStart] }),
    // UTC quarter-hours: the cost math joins these to 15-min spot slots.
    check(
      'ev_charge_energy_mix_slot_start_check',
      sql`extract(epoch FROM ${table.slotStart}) % 900 = 0`,
    ),
    check(
      'ev_charge_energy_mix_kwh_nonneg_check',
      sql`${table.kwh} >= 0 AND ${table.gridKwh} >= 0 AND ${table.solarKwh} >= 0
        AND ${table.batteryGridKwh} >= 0 AND ${table.batterySolarKwh} >= 0
        AND ${table.batteryUnpricedKwh} >= 0 AND ${table.noHouseDataKwh} >= 0`,
    ),
    // The parts are kWh × fractions, so they sum to `kwh` up to float rounding.
    check(
      'ev_charge_energy_mix_parts_sum_check',
      sql`abs(${table.kwh} - (${table.gridKwh} + ${table.solarKwh} + ${table.batteryGridKwh}
        + ${table.batterySolarKwh} + ${table.batteryUnpricedKwh} + ${table.noHouseDataKwh}))
        <= 1e-9 * ${table.kwh} + 1e-9`,
    ),
    // A spot exactly when there is energy to price. Only a sanity bound on its
    // value, far wider than spot_price's ±100: battery losses raise the
    // average cost of what is left in the pool (spec decision 7; the history
    // shows ≈ 1.8× in winter, up to ≈ 5×), so this is no market price. Negative
    // spots are real.
    check(
      'ev_charge_energy_mix_battery_grid_spot_check',
      sql`(${table.batteryGridKwh} > 0) = (${table.batteryGridSpotSek} IS NOT NULL)
        AND (${table.batteryGridSpotSek} IS NULL
          OR (${table.batteryGridSpotSek} > -1000 AND ${table.batteryGridSpotSek} < 1000))`,
    ),
    check(
      'ev_charge_energy_mix_battery_solar_spot_check',
      sql`(${table.batterySolarKwh} > 0) = (${table.batterySolarSpotSek} IS NOT NULL)
        AND (${table.batterySolarSpotSek} IS NULL
          OR (${table.batterySolarSpotSek} > -1000 AND ${table.batterySolarSpotSek} < 1000))`,
    ),
  ],
).enableRLS()

// The battery cost pool's state at the end of each Stockholm day: the derive's
// checkpoint (ADR-0023). A re-derive from day D resumes from D−1's row.
// `capacity_kwh` is the C (kWh per 100 % SoC) the state was computed with: a
// checkpoint with another C is never resumed from (the derive rebuilds from
// the first reading), so changing C re-derives history by itself. Spot sums
// may be negative.
export const batteryPoolDay = pgTable(
  'battery_pool_day',
  {
    // The PK serves both queries: the point lookup of D−1 and `day >= D`.
    day: date('day', { mode: 'string' }).primaryKey(),
    storedKwh: doublePrecision('stored_kwh').notNull(),
    gridKwh: doublePrecision('grid_kwh').notNull(),
    gridSpotSekSum: doublePrecision('grid_spot_sek_sum').notNull(),
    solarKwh: doublePrecision('solar_kwh').notNull(),
    solarSpotSekSum: doublePrecision('solar_spot_sek_sum').notNull(),
    unpricedKwh: doublePrecision('unpriced_kwh').notNull(),
    capacityKwh: doublePrecision('capacity_kwh').notNull(),
    /** When the derive wrote this checkpoint (shows whether a re-derive reached it). */
    derivedAt: timestamp('derived_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'battery_pool_day_kwh_nonneg_check',
      sql`${table.storedKwh} >= 0 AND ${table.gridKwh} >= 0 AND ${table.solarKwh} >= 0
        AND ${table.unpricedKwh} >= 0`,
    ),
    check(
      'battery_pool_day_stored_sum_check',
      sql`abs(${table.storedKwh} - (${table.gridKwh} + ${table.solarKwh} + ${table.unpricedKwh}))
        <= 1e-9 * ${table.storedKwh} + 1e-9`,
    ),
    check(
      'battery_pool_day_capacity_kwh_check',
      sql`${table.capacityKwh} > 0 AND ${table.capacityKwh} < 100`,
    ),
  ],
).enableRLS()
```

`schema/index.ts` already re-exports `./houseEnergy` (step 2), so nothing else changes there.

- [ ] **Step 2: Generate and apply**

Run: `bun run db:generate --name=energy_mix_and_battery_pool && bun run db:migrate`

Expected: `drizzle/00NN_energy_mix_and_battery_pool.sql` contains two `CREATE TABLE`s, the FK with
`ON DELETE cascade`, both PKs, eight CHECKs, and two `ENABLE ROW LEVEL SECURITY`. It touches no other table.

- [ ] **Step 3:** `bunx vitest run test/rls.test.ts` → PASS.
- [ ] **Step 4:** Dispatch both reviewers. Fix or explicitly rule on every finding **before** pushing anything.
- [ ] **Step 5: Commit** `feat(charging): add the energy mix and battery pool tables`

---

### Task 2: House supply split and session shaping (pure, test-first)

**Files:**
- Create: `test/fixtures/houseEnergy.ts` (or extend step 2's; see Task 0 step 4)
- Create: `src/lib/houseEnergy/mix/supply.ts`, `src/lib/houseEnergy/mix/supply.test.ts`
- Create: `src/lib/houseEnergy/mix/shape.ts`, `src/lib/houseEnergy/mix/shape.test.ts`

**Interfaces:**
- Consumes: `type HouseReading` from `~/lib/services/houseEnergy`.
- Produces:
  ```ts
  export type SupplyFractions = { grid: number; solar: number; battery: number }
  export function houseSupply(r: HouseReading): SupplyFractions | null
  export const BUCKET_MS: number; export const BASELINE_BUCKETS: number; export const MIN_BASELINE_BUCKETS: number
  export type CarBucket = { bucketStart: number; kwh: number }
  export function shapeSession(input: { startMs: number;
    stretches: readonly { startMs: number; endMs: number; kwh: number }[];
    readings: readonly HouseReading[] }): CarBucket[]
  ```

**Reviewers:** A = `code-reviewer`; B = `test-completeness` (the service/pure-logic row: tests first, every branch).

- [ ] **Step 1: Test fixture** `test/fixtures/houseEnergy.ts`:

```ts
import type { HouseReading } from '~/lib/services/houseEnergy'
import { stockholmDayBounds } from '~/lib/time/stockholm'

// SYNTHETIC house readings for tests. Never put real readings in the repo
// (it's public); the probe's real data stays in data/private/.

const BUCKET_MS = 5 * 60_000

export type Flows = Partial<Omit<HouseReading, 'bucketStart'>>

/** One reading; every flow not given is 0, the SoC null (so the pool isn't capped). */
export function reading(bucketStart: Date | number, flows: Flows = {}): HouseReading {
  return {
    bucketStart: new Date(bucketStart),
    gridImportKwh: 0,
    gridExportKwh: 0,
    solarKwh: 0,
    loadKwh: 0,
    batteryDischargeKwh: 0,
    batteryChargeSolarKwh: 0,
    batteryChargeGridKwh: 0,
    batteryChargeAcKwh: 0,
    batterySocPct: null,
    ...flows,
  }
}

/** Every 5-min bucket of Stockholm `day` (276, 288 or 300 of them); `flows` per bucket. */
export function syntheticDay(
  day: string,
  flows: (bucketStartMs: number, i: number) => Flows = () => ({}),
): HouseReading[] {
  const { startMs, endMs } = stockholmDayBounds(day)
  const out: HouseReading[] = []
  for (let t = startMs, i = 0; t < endMs; t += BUCKET_MS, i++) out.push(reading(t, flows(t, i)))
  return out
}
```

- [ ] **Step 2: Failing tests for `supply.ts`**

```ts
// src/lib/houseEnergy/mix/supply.test.ts
import { expect, test } from 'vitest'
import { reading } from '~test/fixtures/houseEnergy'
import { type SupplyFractions, houseSupply } from './supply'

const T = Date.UTC(2026, 5, 10, 10)

function expectFractions(actual: SupplyFractions | null, expected: SupplyFractions) {
  expect(actual).not.toBeNull()
  expect(actual?.grid).toBeCloseTo(expected.grid, 12)
  expect(actual?.solar).toBeCloseTo(expected.solar, 12)
  expect(actual?.battery).toBeCloseTo(expected.battery, 12)
}

test('a bucket on grid alone is all grid', () => {
  expectFractions(houseSupply(reading(T, { gridImportKwh: 0.4, loadKwh: 0.4 })), {
    grid: 1,
    solar: 0,
    battery: 0,
  })
})

test('solar that is exported or stored is not house supply', () => {
  // 1.2 produced: 0.5 exported, 0.3 into the battery → 0.4 reaches the house.
  const r = reading(T, {
    solarKwh: 1.2,
    gridExportKwh: 0.5,
    batteryChargeSolarKwh: 0.3,
    gridImportKwh: 0.4,
    loadKwh: 0.8,
  })
  expectFractions(houseSupply(r), { grid: 0.5, solar: 0.5, battery: 0 })
})

test('grid energy charging the battery is not house supply (charge_grid and charge_ac alike)', () => {
  // 1.5 imported: 0.6 + 0.3 into the battery → 0.6 reaches the house.
  const r = reading(T, {
    gridImportKwh: 1.5,
    batteryChargeGridKwh: 0.6,
    batteryChargeAcKwh: 0.3,
    loadKwh: 0.6,
  })
  expectFractions(houseSupply(r), { grid: 1, solar: 0, battery: 0 })
})

test('battery discharge feeding the house is battery supply', () => {
  const r = reading(T, { gridImportKwh: 0.2, batteryDischargeKwh: 0.6, loadKwh: 0.8 })
  expectFractions(houseSupply(r), { grid: 0.25, solar: 0, battery: 0.75 })
})

test('battery energy that was exported is not house supply', () => {
  // 0.5 exported with only 0.1 solar → 0.4 of the 1.0 discharged left via the grid.
  const r = reading(T, {
    solarKwh: 0.1,
    gridExportKwh: 0.5,
    batteryDischargeKwh: 1.0,
    loadKwh: 0.6,
  })
  expectFractions(houseSupply(r), { grid: 0, solar: 0, battery: 1 })
})

test('grid, solar and battery together split in proportion', () => {
  const r = reading(T, {
    gridImportKwh: 0.3,
    solarKwh: 0.5,
    batteryDischargeKwh: 0.2,
    loadKwh: 1,
  })
  expectFractions(houseSupply(r), { grid: 0.3, solar: 0.5, battery: 0.2 })
})

test('a flow inconsistency never makes a part negative', () => {
  // More battery charging than import: grid → house clamps to 0.
  const r = reading(T, { gridImportKwh: 0.1, batteryChargeGridKwh: 0.3, solarKwh: 0.5, loadKwh: 0.5 })
  expectFractions(houseSupply(r), { grid: 0, solar: 1, battery: 0 })
})

test('zero load, or nothing supplying the house, is no house data', () => {
  expect(houseSupply(reading(T, { gridImportKwh: 0.1 }))).toBeNull()
  expect(houseSupply(reading(T, { loadKwh: 0.5 }))).toBeNull()
})
```

- [ ] **Step 3: Failing tests for `shape.ts`**

```ts
// src/lib/houseEnergy/mix/shape.test.ts
import { expect, test } from 'vitest'
import type { HouseReading } from '~/lib/services/houseEnergy'
import { reading } from '~test/fixtures/houseEnergy'
import { BUCKET_MS, type CarBucket, shapeSession } from './shape'

const at = (iso: string) => Date.parse(iso)
const total = (b: CarBucket[]) => b.reduce((s, x) => s + x.kwh, 0)
const kwhAt = (b: CarBucket[], iso: string) => b.find((x) => x.bucketStart === at(iso))?.kwh ?? 0

/** One reading per bucket over [fromIso, toIso) with `load(ms)` (all from the grid). */
function loads(fromIso: string, toIso: string, load: (ms: number) => number): HouseReading[] {
  const out: HouseReading[] = []
  for (let t = at(fromIso); t < at(toIso); t += BUCKET_MS) {
    out.push(reading(t, { loadKwh: load(t), gridImportKwh: load(t) }))
  }
  return out
}

const LONG = { startMs: at('2026-06-10T07:00:00Z'), endMs: at('2026-06-10T10:00:00Z'), kwh: 24 }

test('without readings an interval spreads uniformly over its buckets', () => {
  const out = shapeSession({
    startMs: at('2026-06-10T10:00:00Z'),
    stretches: [{ startMs: at('2026-06-10T10:00:00Z'), endMs: at('2026-06-10T11:00:00Z'), kwh: 6 }],
    readings: [],
  })
  expect(out).toHaveLength(12)
  expect(out[0].bucketStart).toBe(at('2026-06-10T10:00:00Z'))
  for (const b of out) expect(b.kwh).toBeCloseTo(0.5, 12)
})

test('an unaligned interval splits its edge buckets by overlap', () => {
  const out = shapeSession({
    startMs: at('2026-06-10T10:02:00Z'),
    stretches: [{ startMs: at('2026-06-10T10:02:00Z'), endMs: at('2026-06-10T10:12:00Z'), kwh: 1 }],
    readings: [],
  })
  expect(kwhAt(out, '2026-06-10T10:00:00Z')).toBeCloseTo(0.3, 12)
  expect(kwhAt(out, '2026-06-10T10:05:00Z')).toBeCloseTo(0.5, 12)
  expect(kwhAt(out, '2026-06-10T10:10:00Z')).toBeCloseTo(0.2, 12)
})

test('the load rise above the pre-session baseline shapes a long interval', () => {
  // Zaptec's interval starts 07:00 but the car draws from 08:00: the load
  // jumps from 0.1 to 1.1 kWh per bucket there.
  const readings = loads('2026-06-10T06:30:00Z', '2026-06-10T10:00:00Z', (t) =>
    t < at('2026-06-10T08:00:00Z') ? 0.1 : 1.1,
  )
  const out = shapeSession({ startMs: LONG.startMs, stretches: [LONG], readings })
  expect(out).toHaveLength(24)
  expect(out[0].bucketStart).toBe(at('2026-06-10T08:00:00Z'))
  for (const b of out) expect(b.kwh).toBeCloseTo(1, 12)
  expect(kwhAt(out, '2026-06-10T07:30:00Z')).toBe(0)
})

test('a gap inside the interval falls back to a uniform spread', () => {
  const readings = loads('2026-06-10T06:30:00Z', '2026-06-10T10:00:00Z', (t) =>
    t < at('2026-06-10T08:00:00Z') ? 0.1 : 1.1,
  ).filter((r) => r.bucketStart.getTime() !== at('2026-06-10T09:00:00Z'))
  const out = shapeSession({ startMs: LONG.startMs, stretches: [LONG], readings })
  expect(out).toHaveLength(36)
  for (const b of out) expect(b.kwh).toBeCloseTo(24 / 36, 12)
})

test('fewer than three pre-session buckets means no baseline: uniform spread', () => {
  const readings = loads('2026-06-10T06:50:00Z', '2026-06-10T10:00:00Z', () => 1.1)
  const out = shapeSession({ startMs: LONG.startMs, stretches: [LONG], readings })
  expect(out).toHaveLength(36)
  for (const b of out) expect(b.kwh).toBeCloseTo(24 / 36, 12)
})

test('a load that never rises above the baseline spreads uniformly', () => {
  const readings = loads('2026-06-10T06:30:00Z', '2026-06-10T10:00:00Z', () => 1)
  const out = shapeSession({ startMs: LONG.startMs, stretches: [LONG], readings })
  expect(out).toHaveLength(36)
  for (const b of out) expect(b.kwh).toBeCloseTo(24 / 36, 12)
})

test('a bucket is capped at the house load and the excess moves to buckets with headroom', () => {
  // No pre-session readings → uniform 1 kWh each; the first two buckets only
  // had 0.5 kWh of load in total.
  const readings = [0.5, 0.5, 2, 2].map((load, i) =>
    reading(at('2026-06-10T10:00:00Z') + i * BUCKET_MS, { loadKwh: load, gridImportKwh: load }),
  )
  const out = shapeSession({
    startMs: at('2026-06-10T10:00:00Z'),
    stretches: [{ startMs: at('2026-06-10T10:00:00Z'), endMs: at('2026-06-10T10:20:00Z'), kwh: 4 }],
    readings,
  })
  expect(out.map((b) => b.kwh)).toEqual([0.5, 0.5, 1.5, 1.5].map((x) => expect.closeTo(x, 12)))
})

test('with no headroom anywhere the excess spreads by overlap (load is exceeded, kWh kept)', () => {
  const readings = [0, 1, 2, 3].map((i) =>
    reading(at('2026-06-10T10:00:00Z') + i * BUCKET_MS, { loadKwh: 0.5, gridImportKwh: 0.5 }),
  )
  const out = shapeSession({
    startMs: at('2026-06-10T10:00:00Z'),
    stretches: [{ startMs: at('2026-06-10T10:00:00Z'), endMs: at('2026-06-10T10:20:00Z'), kwh: 4 }],
    readings,
  })
  expect(out.map((b) => b.kwh)).toEqual([1, 1, 1, 1].map((x) => expect.closeTo(x, 12)))
})

test("an earlier interval's energy in a shared bucket counts against its load", () => {
  const readings = [1.0, 0.6, 2.0].map((load, i) =>
    reading(at('2026-06-10T10:00:00Z') + i * BUCKET_MS, { loadKwh: load, gridImportKwh: load }),
  )
  const out = shapeSession({
    startMs: at('2026-06-10T10:00:00Z'),
    stretches: [
      { startMs: at('2026-06-10T10:00:00Z'), endMs: at('2026-06-10T10:07:30Z'), kwh: 1.5 },
      { startMs: at('2026-06-10T10:07:30Z'), endMs: at('2026-06-10T10:15:00Z'), kwh: 1 },
    ],
    readings,
  })
  // A: 1.0 + 0.5. B: 1/3 into 10:05 capped at 0.6 − 0.5 = 0.1, the rest to 10:10.
  expect(kwhAt(out, '2026-06-10T10:00:00Z')).toBeCloseTo(1, 12)
  expect(kwhAt(out, '2026-06-10T10:05:00Z')).toBeCloseTo(0.6, 12)
  expect(kwhAt(out, '2026-06-10T10:10:00Z')).toBeCloseTo(0.9, 12)
})

test("every interval's kWh stays exact through shaping and clamping", () => {
  let seed = 7
  const rand = () => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  const readings = loads('2026-06-10T06:00:00Z', '2026-06-10T14:00:00Z', () => rand() * 1.5)
  const stretches = [
    { startMs: at('2026-06-10T07:03:00Z'), endMs: at('2026-06-10T08:41:00Z'), kwh: 9.7 },
    { startMs: at('2026-06-10T08:41:00Z'), endMs: at('2026-06-10T11:17:00Z'), kwh: 13.1 },
    { startMs: at('2026-06-10T11:17:00Z'), endMs: at('2026-06-10T13:59:00Z'), kwh: 2.25 },
  ]
  const out = shapeSession({ startMs: stretches[0].startMs, stretches, readings })
  expect(total(out)).toBeCloseTo(9.7 + 13.1 + 2.25, 9)
  for (const b of out) expect(b.kwh).toBeGreaterThanOrEqual(0)
})

test('a zero-length (estimated) stretch lands in its start bucket', () => {
  const t = at('2026-06-10T10:02:00Z')
  expect(shapeSession({ startMs: t, stretches: [{ startMs: t, endMs: t, kwh: 3 }], readings: [] })).toEqual([
    { bucketStart: at('2026-06-10T10:00:00Z'), kwh: 3 },
  ])
})

test('zero-kWh intervals produce no buckets', () => {
  expect(shapeSession({ startMs: LONG.startMs, stretches: [{ ...LONG, kwh: 0 }], readings: [] })).toEqual([])
})

test('an hour across the spring-forward switch is twelve buckets (UTC, never local)', () => {
  // 2026-03-29 00:30Z–01:30Z = 01:30 CET → 03:30 CEST.
  const out = shapeSession({
    startMs: at('2026-03-29T00:30:00Z'),
    stretches: [{ startMs: at('2026-03-29T00:30:00Z'), endMs: at('2026-03-29T01:30:00Z'), kwh: 6 }],
    readings: [],
  })
  expect(out).toHaveLength(12)
  expect(total(out)).toBeCloseTo(6, 12)
})
```

- [ ] **Step 4: Run, expect FAIL**: `bunx vitest run src/lib/houseEnergy/mix` (modules don't exist).

- [ ] **Step 5: Implement `supply.ts`**

```ts
// Client-safe, pure (ADR-0023, spec "Derivation" 2). Where the house's own
// consumption came from in one 5-minute bucket. Energy that went into the
// battery or out to the grid is not house supply. The car gets the same mix
// as the house (proportional split, ADR-0023 decision 4).
import type { HouseReading } from '~/lib/services/houseEnergy'

/** Fractions of the house's supply in one bucket; they sum to 1. */
export type SupplyFractions = { grid: number; solar: number; battery: number }

/**
 * grid → house = import − battery charging from the grid (charge_grid and
 * charge_ac, both grid-origin); solar → house = solar − export − battery
 * charging from solar; battery → house = discharge minus whatever of it was
 * exported (export beyond solar). Each clamps at 0. Null = no house data:
 * zero load, or nothing supplied the house.
 */
export function houseSupply(r: HouseReading): SupplyFractions | null {
  const grid = Math.max(0, r.gridImportKwh - r.batteryChargeGridKwh - r.batteryChargeAcKwh)
  const solar = Math.max(0, r.solarKwh - r.gridExportKwh - r.batteryChargeSolarKwh)
  const battery = Math.max(0, r.batteryDischargeKwh - Math.max(0, r.gridExportKwh - r.solarKwh))
  const sum = grid + solar + battery
  if (!(r.loadKwh > 0) || !(sum > 0)) return null
  return { grid: grid / sum, solar: solar / sum, battery: battery / sum }
}
```

- [ ] **Step 6: Implement `shape.ts`**

```ts
// Client-safe, pure (ADR-0023, spec "Derivation" 1). Spreads a session's
// Zaptec intervals over the house's 5-minute buckets, shaped by how far the
// house load rose above its level just before the session: Zaptec's first
// interval can span hours before the car drew anything, and the load shows the
// real start as a clean jump. Every interval's kWh stays exact.
import type { HouseReading } from '~/lib/services/houseEnergy'

/** Emaldo's bucket length; buckets start on 5-minute UTC boundaries. */
export const BUCKET_MS = 5 * 60_000
/** Pre-session buckets whose median load is the baseline (30 min). */
export const BASELINE_BUCKETS = 6
/** Fewer pre-session buckets with data than this → no baseline → uniform spread. */
export const MIN_BASELINE_BUCKETS = 3

/** The car's energy in one 5-minute bucket. */
export type CarBucket = { bucketStart: number; kwh: number }

type Stretch = { startMs: number; endMs: number; kwh: number }
type Covered = { start: number; share: number; load: number | undefined }

const floorToBucket = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS
const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0)

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The car's kWh per 5-minute bucket, ascending, zero buckets left out.
 * `readings` should cover [startMs − 30 min, the last stretch's end).
 *
 * Per stretch: weight = max(0, load − baseline) × overlap share; uniform (by
 * overlap) when there's no baseline, a covered bucket has no reading, or the
 * weights sum to 0. Then, when every covered bucket has a reading, each bucket
 * is capped at its load minus what earlier stretches already put there, and
 * the excess moves to buckets with headroom in proportion to it; whatever no
 * headroom can take is spread by overlap (the load is exceeded, the kWh kept).
 */
export function shapeSession(input: {
  startMs: number
  stretches: readonly Stretch[]
  readings: readonly HouseReading[]
}): CarBucket[] {
  const loadAt = new Map<number, number>()
  for (const r of input.readings) loadAt.set(r.bucketStart.getTime(), r.loadKwh)

  const first = floorToBucket(input.startMs)
  const before: number[] = []
  for (let i = 1; i <= BASELINE_BUCKETS; i++) {
    const load = loadAt.get(first - i * BUCKET_MS)
    if (load !== undefined) before.push(load)
  }
  const baseline = before.length >= MIN_BASELINE_BUCKETS ? median(before) : null

  const car = new Map<number, number>()
  for (const stretch of input.stretches) {
    if (!(stretch.kwh > 0)) continue
    for (const [start, kwh] of spreadStretch(stretch, loadAt, baseline, car)) {
      car.set(start, (car.get(start) ?? 0) + kwh)
    }
  }
  return [...car]
    .filter(([, kwh]) => kwh > 0)
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, kwh]) => ({ bucketStart, kwh }))
}

function spreadStretch(
  s: Stretch,
  loadAt: ReadonlyMap<number, number>,
  baseline: number | null,
  placed: ReadonlyMap<number, number>,
): [number, number][] {
  // A zero-length stretch (an `estimated` session with start = end): all of
  // it in its start bucket, so the session's total still matches.
  if (s.endMs <= s.startMs) return [[floorToBucket(s.startMs), s.kwh]]
  const duration = s.endMs - s.startMs
  const covered: Covered[] = []
  for (let b = floorToBucket(s.startMs); b < s.endMs; b += BUCKET_MS) {
    const overlap = Math.min(b + BUCKET_MS, s.endMs) - Math.max(b, s.startMs)
    covered.push({ start: b, share: overlap / duration, load: loadAt.get(b) })
  }
  const complete = covered.every((c) => c.load !== undefined)
  let weights = covered.map((c) => c.share)
  if (complete && baseline !== null) {
    const shaped = covered.map((c) => Math.max(0, (c.load ?? 0) - baseline) * c.share)
    if (sum(shaped) > 0) weights = shaped
  }
  const weightSum = sum(weights)
  const kwh = weights.map((w) => (s.kwh * w) / weightSum)
  if (complete) {
    const cap = covered.map((c) => Math.max(0, (c.load ?? 0) - (placed.get(c.start) ?? 0)))
    clampToLoad(
      kwh,
      cap,
      covered.map((c) => c.share),
    )
  }
  return covered.map((c, i) => [c.start, kwh[i]])
}

/** Caps each bucket at `cap`, moving the excess as described above. Mutates `kwh`; keeps its sum. */
function clampToLoad(kwh: number[], cap: readonly number[], share: readonly number[]): void {
  let excess = 0
  for (let i = 0; i < kwh.length; i++) {
    if (kwh[i] > cap[i]) {
      excess += kwh[i] - cap[i]
      kwh[i] = cap[i]
    }
  }
  if (!(excess > 0)) return
  const headroom = kwh.map((k, i) => cap[i] - k)
  const room = sum(headroom)
  const moved = Math.min(excess, room)
  if (moved > 0) {
    for (let i = 0; i < kwh.length; i++) kwh[i] += (moved * headroom[i]) / room
  }
  const rest = excess - moved
  if (rest > 0) {
    const shareSum = sum(share)
    for (let i = 0; i < kwh.length; i++) kwh[i] += (rest * share[i]) / shareSum
  }
}
```

- [ ] **Step 7: Run, expect PASS**: `bunx vitest run src/lib/houseEnergy/mix`
- [ ] **Step 8: Commit** `feat(charging): split house supply and shape sessions by load`

---

### Task 3: Battery pool, house timeline and per-slot car mix (pure, test-first)

**Files:**
- Create: `src/lib/houseEnergy/mix/pool.ts` + `pool.test.ts`
- Create: `src/lib/houseEnergy/mix/carMix.ts` + `carMix.test.ts`
- Create: `src/lib/houseEnergy/mix/houseTimeline.ts` + `houseTimeline.test.ts`
- Modify: `src/lib/evCharging/clientSafe.browser.test.tsx` (one test)

**Interfaces:**
- Consumes: Task 2's `SupplyFractions`, `houseSupply`, `CarBucket`; `addDays`, `stockholmDayBounds`,
  `stockholmDayOf` from `~/lib/time/stockholm`.
- Produces (contract names exactly):
  ```ts
  export const BATTERY_CAPACITY_KWH: number
  export type PoolState = { storedKwh; gridKwh; gridSpotSekSum; solarKwh; solarSpotSekSum; unpricedKwh: number }
  export type BatteryOut = { gridKwh; gridSpotSekSum; solarKwh; solarSpotSekSum; unpricedKwh: number }
  export const emptyPool: () => PoolState
  export function stepPool(s: PoolState, r: HouseReading, spotSekPerKwh: number | null, capKwh: number | null): { next: PoolState; out: BatteryOut }
  export function endOfBucketSocPct(r: HouseReading, next: HouseReading | undefined): number | null
  export const SLOT_MS: number
  export type MixSlot = { slotStart: Date; kwh; gridKwh; solarKwh; batteryGridKwh: number; batteryGridSpotSek: number | null;
    batterySolarKwh: number; batterySolarSpotSek: number | null; batteryUnpricedKwh; noHouseDataKwh: number }
  export type BucketHouse = { supply: SupplyFractions | null; batteryOut: BatteryOut }
  export function deriveSessionMix(buckets: readonly CarBucket[], house: ReadonlyMap<number, BucketHouse>): MixSlot[]
  export type PoolDay = { day: string; state: PoolState }
  export function runHouseTimeline(input: { readings: readonly HouseReading[]; fromDay: string; throughDay: string;
    start: PoolState; spotAt: (bucketStartMs: number) => number | null; capacityKwh: number }):
    { days: PoolDay[]; house: Map<number, BucketHouse> }
  ```

**Reviewers:** A = `code-reviewer`; B = `test-completeness`.

- [ ] **Step 1: Failing tests for `pool.ts`**

```ts
// src/lib/houseEnergy/mix/pool.test.ts
import { expect, test } from 'vitest'
import { reading } from '~test/fixtures/houseEnergy'
import {
  BATTERY_CAPACITY_KWH,
  type BatteryOut,
  emptyPool,
  endOfBucketSocPct,
  type PoolState,
  stepPool,
} from './pool'

const T = Date.UTC(2026, 1, 15, 1)

/** A pool from its parts (storedKwh is always their sum). */
function pool(parts: Partial<PoolState>): PoolState {
  const s = { ...emptyPool(), ...parts }
  return { ...s, storedKwh: s.gridKwh + s.solarKwh + s.unpricedKwh }
}
function expectOut(actual: BatteryOut, expected: Partial<BatteryOut>) {
  const full: BatteryOut = {
    gridKwh: 0,
    gridSpotSekSum: 0,
    solarKwh: 0,
    solarSpotSekSum: 0,
    unpricedKwh: 0,
    ...expected,
  }
  for (const key of Object.keys(full) as (keyof BatteryOut)[]) {
    expect(actual[key], key).toBeCloseTo(full[key], 12)
  }
}
function expectPool(actual: PoolState, expected: Partial<PoolState>) {
  const full = pool(expected)
  for (const key of Object.keys(full) as (keyof PoolState)[]) {
    expect(actual[key], key).toBeCloseTo(full[key], 12)
  }
}

test('BATTERY_CAPACITY_KWH is a plausible kWh per 100 % SoC', () => {
  expect(BATTERY_CAPACITY_KWH).toBeGreaterThan(5)
  expect(BATTERY_CAPACITY_KWH).toBeLessThan(12)
})

test('grid charging (charge_grid and charge_ac) enters at its full kWh at the slot spot', () => {
  const r = reading(T, { batteryChargeGridKwh: 1, batteryChargeAcKwh: 0.5 })
  const { next, out } = stepPool(emptyPool(), r, 0.2, null)
  expectPool(next, { gridKwh: 1.5, gridSpotSekSum: 0.3 })
  expectOut(out, {})
})

test('solar charging carries its slot spot as value', () => {
  const { next } = stepPool(emptyPool(), reading(T, { batteryChargeSolarKwh: 1 }), 0.6, null)
  expectPool(next, { solarKwh: 1, solarSpotSekSum: 0.6 })
})

test('charging in a slot without a spot price is unpriced', () => {
  const r = reading(T, { batteryChargeGridKwh: 1, batteryChargeSolarKwh: 1 })
  expectPool(stepPool(emptyPool(), r, null, null).next, { unpricedKwh: 2 })
})

test('a discharge takes every part in proportion and keeps each average spot', () => {
  const s = pool({ gridKwh: 2, gridSpotSekSum: 2, solarKwh: 2, solarSpotSekSum: 1 })
  const { next, out } = stepPool(s, reading(T, { batteryDischargeKwh: 1 }), 5, null)
  expectOut(out, { gridKwh: 0.5, gridSpotSekSum: 0.5, solarKwh: 0.5, solarSpotSekSum: 0.25 })
  expectPool(next, { gridKwh: 1.5, gridSpotSekSum: 1.5, solarKwh: 1.5, solarSpotSekSum: 0.75 })
})

test('a discharge beyond the pool empties it; the excess is grid at the current spot (drift)', () => {
  const s = pool({ solarKwh: 1, solarSpotSekSum: 0.4 })
  const { next, out } = stepPool(s, reading(T, { batteryDischargeKwh: 1.5 }), 2, null)
  expectOut(out, { solarKwh: 1, solarSpotSekSum: 0.4, gridKwh: 0.5, gridSpotSekSum: 1 })
  expect(next).toEqual(emptyPool())
})

test("an empty pool's discharge without a spot price is unpriced", () => {
  const { next, out } = stepPool(emptyPool(), reading(T, { batteryDischargeKwh: 0.3 }), null, null)
  expectOut(out, { unpricedKwh: 0.3 })
  expect(next).toEqual(emptyPool())
})

test('charge and discharge in one bucket: the inflow joins before the outflow leaves', () => {
  const r = reading(T, { batteryChargeGridKwh: 1, batteryDischargeKwh: 0.45 })
  const { next, out } = stepPool(emptyPool(), r, 1, null)
  expectOut(out, { gridKwh: 0.45, gridSpotSekSum: 0.45 })
  expectPool(next, { gridKwh: 0.55, gridSpotSekSum: 0.55 })
})

test('float dust left after a discharge resets the pool to empty', () => {
  const s = pool({ gridKwh: 1, gridSpotSekSum: 1 })
  const { next } = stepPool(s, reading(T, { batteryDischargeKwh: 1 - 1e-13 }), 1, null)
  expect(next).toEqual(emptyPool())
})

test('above the cap every part shrinks by one factor and keeps its spot sum (losses raise the cost)', () => {
  const s = pool({ gridKwh: 3, gridSpotSekSum: 1.5, solarKwh: 1, solarSpotSekSum: 0.8, unpricedKwh: 1 })
  const { next, out } = stepPool(s, reading(T), 1, 2.5)
  expectOut(out, {})
  expectPool(next, {
    gridKwh: 1.5,
    gridSpotSekSum: 1.5,
    solarKwh: 0.5,
    solarSpotSekSum: 0.8,
    unpricedKwh: 0.5,
  })
})

test("the cap applies after the bucket's inflow and outflow", () => {
  // 2 in, 0.5 out → 1.5 stored, capped at 1.2; the 2 SEK paid stay, less the 0.5 that left.
  const r = reading(T, { batteryChargeGridKwh: 2, batteryDischargeKwh: 0.5 })
  const { next, out } = stepPool(emptyPool(), r, 1, 1.2)
  expectOut(out, { gridKwh: 0.5, gridSpotSekSum: 0.5 })
  expectPool(next, { gridKwh: 1.2, gridSpotSekSum: 1.5 })
})

test('below the cap nothing changes: the pool never invents energy', () => {
  const s = pool({ gridKwh: 1, gridSpotSekSum: 0.5 })
  expect(stepPool(s, reading(T), 1, 5).next).toEqual(s)
})

test('a cap of 0 empties the pool', () => {
  const s = pool({ gridKwh: 1, gridSpotSekSum: 0.5 })
  expect(stepPool(s, reading(T), 1, 0).next).toEqual(emptyPool())
})

test("the end-of-bucket SoC is the mean of this and the next reading's (Emaldo's SoC is mid-bucket)", () => {
  const r = reading(T, { batterySocPct: 40 })
  expect(endOfBucketSocPct(r, reading(T + 300_000, { batterySocPct: 45 }))).toBe(42.5)
})

test('no end-of-bucket SoC without both values or across a gap', () => {
  const r = reading(T, { batterySocPct: 40 })
  expect(endOfBucketSocPct(r, undefined)).toBeNull()
  expect(endOfBucketSocPct(r, reading(T + 300_000))).toBeNull()
  expect(endOfBucketSocPct(reading(T), reading(T + 300_000, { batterySocPct: 45 }))).toBeNull()
  expect(endOfBucketSocPct(r, reading(T + 600_000, { batterySocPct: 45 }))).toBeNull()
})

test('stepPool never mutates its input', () => {
  const s = pool({ gridKwh: 2, gridSpotSekSum: 2 })
  const copy = structuredClone(s)
  stepPool(s, reading(T, { batteryDischargeKwh: 1, batteryChargeSolarKwh: 1 }), 1, 0.5)
  expect(s).toEqual(copy)
})

test('a long random run keeps every part non-negative, stored equal to their sum and under the cap', () => {
  let seed = 11
  const rand = () => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  let s = emptyPool()
  for (let i = 0; i < 10_000; i++) {
    const r = reading(T + i * 300_000, {
      batteryChargeGridKwh: rand() < 0.3 ? rand() * 0.4 : 0,
      batteryChargeSolarKwh: rand() < 0.3 ? rand() * 0.4 : 0,
      batteryDischargeKwh: rand() < 0.4 ? rand() * 0.5 : 0,
    })
    const cap = rand() < 0.2 ? null : rand() * 8
    const { next, out } = stepPool(s, r, rand() < 0.1 ? null : rand() * 3 - 0.5, cap)
    for (const v of [next.gridKwh, next.solarKwh, next.unpricedKwh, out.gridKwh, out.solarKwh, out.unpricedKwh]) {
      expect(v).toBeGreaterThanOrEqual(0)
    }
    expect(next.storedKwh).toBeCloseTo(next.gridKwh + next.solarKwh + next.unpricedKwh, 9)
    if (cap !== null) expect(next.storedKwh).toBeLessThanOrEqual(cap + 1e-12)
    expect(out.gridKwh + out.solarKwh + out.unpricedKwh).toBeCloseTo(r.batteryDischargeKwh, 9)
    s = next
  }
})
```

- [ ] **Step 2: Failing tests for `carMix.ts`**

```ts
// src/lib/houseEnergy/mix/carMix.test.ts
import { expect, test } from 'vitest'
import { type BucketHouse, deriveSessionMix, type MixSlot } from './carMix'
import type { BatteryOut } from './pool'
import { BUCKET_MS } from './shape'

const T0 = Date.UTC(2026, 5, 10, 10) // 10:00Z, a quarter-hour
const out = (o: Partial<BatteryOut> = {}): BatteryOut => ({
  gridKwh: 0,
  gridSpotSekSum: 0,
  solarKwh: 0,
  solarSpotSekSum: 0,
  unpricedKwh: 0,
  ...o,
})
const parts = (s: MixSlot) =>
  s.gridKwh + s.solarKwh + s.batteryGridKwh + s.batterySolarKwh + s.batteryUnpricedKwh + s.noHouseDataKwh

test('without house data every kWh is no-house-data', () => {
  const mix = deriveSessionMix(
    [0, 1, 2].map((i) => ({ bucketStart: T0 + i * BUCKET_MS, kwh: 1 })),
    new Map(),
  )
  expect(mix).toEqual([
    {
      slotStart: new Date(T0),
      kwh: 3,
      gridKwh: 0,
      solarKwh: 0,
      batteryGridKwh: 0,
      batteryGridSpotSek: null,
      batterySolarKwh: 0,
      batterySolarSpotSek: null,
      batteryUnpricedKwh: 0,
      noHouseDataKwh: 3,
    },
  ])
})

test('a bucket whose house supply is unknown (zero load) is no-house-data', () => {
  const house = new Map<number, BucketHouse>([[T0, { supply: null, batteryOut: out() }]])
  expect(deriveSessionMix([{ bucketStart: T0, kwh: 2 }], house)[0].noHouseDataKwh).toBe(2)
})

test("the car gets the house's proportional mix", () => {
  const house = new Map<number, BucketHouse>([
    [T0, { supply: { grid: 0.5, solar: 0.3, battery: 0.2 }, batteryOut: out({ gridKwh: 1, gridSpotSekSum: 1.2 }) }],
  ])
  const [slot] = deriveSessionMix([{ bucketStart: T0, kwh: 2 }], house)
  expect(slot.gridKwh).toBeCloseTo(1, 12)
  expect(slot.solarKwh).toBeCloseTo(0.6, 12)
  expect(slot.batteryGridKwh).toBeCloseTo(0.4, 12)
  expect(slot.batteryGridSpotSek).toBeCloseTo(1.2, 12)
  expect(slot.batterySolarKwh).toBe(0)
  expect(slot.batterySolarSpotSek).toBeNull()
})

test('the battery part splits by what left the battery, each with its average spot', () => {
  const house = new Map<number, BucketHouse>([
    [
      T0,
      {
        supply: { grid: 0, solar: 0, battery: 1 },
        batteryOut: out({ gridKwh: 1, gridSpotSekSum: 1, solarKwh: 3, solarSpotSekSum: 1.5 }),
      },
    ],
  ])
  const [slot] = deriveSessionMix([{ bucketStart: T0, kwh: 0.4 }], house)
  expect(slot.batteryGridKwh).toBeCloseTo(0.1, 12)
  expect(slot.batteryGridSpotSek).toBeCloseTo(1, 12)
  expect(slot.batterySolarKwh).toBeCloseTo(0.3, 12)
  expect(slot.batterySolarSpotSek).toBeCloseTo(0.5, 12)
})

test('battery energy of unpriced origin stays unpriced', () => {
  const house = new Map<number, BucketHouse>([
    [T0, { supply: { grid: 0, solar: 0, battery: 1 }, batteryOut: out({ unpricedKwh: 0.5 }) }],
  ])
  const [slot] = deriveSessionMix([{ bucketStart: T0, kwh: 0.5 }], house)
  expect(slot.batteryUnpricedKwh).toBeCloseTo(0.5, 12)
  expect(slot.batteryGridSpotSek).toBeNull()
})

test('buckets aggregate into 15-min slots with kWh-weighted battery spots', () => {
  const battery = (spot: number): BucketHouse => ({
    supply: { grid: 0, solar: 0, battery: 1 },
    batteryOut: out({ gridKwh: 1, gridSpotSekSum: spot }),
  })
  const house = new Map<number, BucketHouse>([
    [T0, battery(1)],
    [T0 + BUCKET_MS, battery(2)],
    [T0 + 3 * BUCKET_MS, battery(3)],
  ])
  const mix = deriveSessionMix(
    [
      { bucketStart: T0, kwh: 1 },
      { bucketStart: T0 + BUCKET_MS, kwh: 3 },
      { bucketStart: T0 + 3 * BUCKET_MS, kwh: 2 },
    ],
    house,
  )
  expect(mix.map((s) => s.slotStart.getTime())).toEqual([T0, T0 + 3 * BUCKET_MS])
  expect(mix[0].kwh).toBeCloseTo(4, 12)
  expect(mix[0].batteryGridSpotSek).toBeCloseTo((1 * 1 + 3 * 2) / 4, 12)
  expect(mix[1].batteryGridSpotSek).toBeCloseTo(3, 12)
})

test('a session across midnight yields slots on both days, at UTC quarter-hours', () => {
  // 21:55Z = 23:55 local (CEST); 22:00Z = 00:00 local the next day.
  const mix = deriveSessionMix(
    [
      { bucketStart: Date.UTC(2026, 5, 10, 21, 55), kwh: 1 },
      { bucketStart: Date.UTC(2026, 5, 10, 22, 0), kwh: 1 },
    ],
    new Map(),
  )
  expect(mix.map((s) => s.slotStart.toISOString())).toEqual([
    '2026-06-10T21:45:00.000Z',
    '2026-06-10T22:00:00.000Z',
  ])
})

test('zero-kWh buckets add no slot', () => {
  expect(deriveSessionMix([{ bucketStart: T0, kwh: 0 }], new Map())).toEqual([])
})

test("the parts always sum to the slot's kWh", () => {
  let seed = 3
  const rand = () => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  const buckets = Array.from({ length: 48 }, (_, i) => ({ bucketStart: T0 + i * BUCKET_MS, kwh: rand() * 2 }))
  const house = new Map<number, BucketHouse>()
  for (const b of buckets) {
    if (rand() < 0.15) continue
    const g = rand()
    const s = rand()
    const bat = rand()
    const sum = g + s + bat
    house.set(b.bucketStart, {
      supply: rand() < 0.1 ? null : { grid: g / sum, solar: s / sum, battery: bat / sum },
      batteryOut: out({
        gridKwh: rand(),
        gridSpotSekSum: rand(),
        solarKwh: rand(),
        solarSpotSekSum: rand(),
        unpricedKwh: rand() < 0.5 ? rand() : 0,
      }),
    })
  }
  for (const slot of deriveSessionMix(buckets, house)) {
    expect(parts(slot)).toBeCloseTo(slot.kwh, 9)
    expect(slot.batteryGridSpotSek === null).toBe(!(slot.batteryGridKwh > 0))
    expect(slot.batterySolarSpotSek === null).toBe(!(slot.batterySolarKwh > 0))
  }
})
```

- [ ] **Step 3: Failing tests for `houseTimeline.ts`**

```ts
// src/lib/houseEnergy/mix/houseTimeline.test.ts
import { expect, test } from 'vitest'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { reading, syntheticDay } from '~test/fixtures/houseEnergy'
import { runHouseTimeline } from './houseTimeline'
import { BATTERY_CAPACITY_KWH, emptyPool } from './pool'

// No SoC in these readings unless a test sets one, so the pool isn't capped.
const charging = () => ({ batteryChargeGridKwh: 0.01, gridImportKwh: 0.01 })
const C = BATTERY_CAPACITY_KWH

test('a spring-forward day steps 276 buckets into one checkpoint', () => {
  const readings = syntheticDay('2026-03-29', charging)
  expect(readings).toHaveLength(276)
  const { days, house } = runHouseTimeline({
    readings,
    fromDay: '2026-03-29',
    throughDay: '2026-03-29',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days.map((d) => d.day)).toEqual(['2026-03-29'])
  expect(days[0].state.gridKwh).toBeCloseTo(276 * 0.01, 9)
  expect(house.size).toBe(276)
})

test('a fall-back day steps 300 buckets into one checkpoint', () => {
  const readings = syntheticDay('2026-10-25', charging)
  expect(readings).toHaveLength(300)
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-10-25',
    throughDay: '2026-10-25',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days).toHaveLength(1)
  expect(days[0].state.gridKwh).toBeCloseTo(300 * 0.01, 9)
})

test('days without readings carry the state forward, through throughDay', () => {
  const readings = [...syntheticDay('2026-06-08', charging), ...syntheticDay('2026-06-10', charging)]
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-08',
    throughDay: '2026-06-12',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days.map((d) => d.day)).toEqual([
    '2026-06-08',
    '2026-06-09',
    '2026-06-10',
    '2026-06-11',
    '2026-06-12',
  ])
  expect(days[1].state).toEqual(days[0].state)
  expect(days[4].state).toEqual(days[2].state)
  expect(days[2].state.gridKwh).toBeCloseTo(2 * 288 * 0.01, 9)
})

test('readings before fromDay are not stepped (they only feed the shaping baseline)', () => {
  const readings = [...syntheticDay('2026-06-09', charging), ...syntheticDay('2026-06-10')]
  const { days, house } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days[0].state).toEqual(emptyPool())
  expect(house.has(stockholmDayBounds('2026-06-09').startMs)).toBe(false)
})

test("each bucket's inflow carries its own slot's spot", () => {
  const t0 = Date.UTC(2026, 5, 10, 10)
  const t1 = t0 + 300_000
  const readings = [
    reading(t0, { batteryChargeGridKwh: 1, gridImportKwh: 1 }),
    reading(t1, { batteryChargeGridKwh: 1, gridImportKwh: 1 }),
  ]
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: (ms) => (ms === t0 ? 1 : 3),
    capacityKwh: C,
  })
  expect(days[0].state.gridKwh).toBeCloseTo(2, 12)
  expect(days[0].state.gridSpotSekSum).toBeCloseTo(4, 12)
})

test("after each bucket the pool is capped at its end-of-bucket SoC × capacity, keeping its cost", () => {
  // Capacity 10 kWh; SoC 10 → 12 → 14 %: the end-of-bucket caps are 1.1 and
  // 1.3 kWh; the last bucket has no next reading, so it isn't capped.
  const t0 = Date.UTC(2026, 5, 10, 10)
  const readings = [10, 12, 14].map((soc, i) =>
    reading(t0 + i * 300_000, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: soc }),
  )
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: 10,
  })
  // 1 (under 1.1) → 2 capped to 1.3 → 2.3 uncapped; all 3 SEK paid stay.
  expect(days[0].state.gridKwh).toBeCloseTo(2.3, 12)
  expect(days[0].state.gridSpotSekSum).toBeCloseTo(3, 12)
})

test('the bucket before a gap is not capped', () => {
  const t0 = Date.UTC(2026, 5, 10, 10)
  const readings = [
    reading(t0, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: 10 }),
    reading(t0 + 600_000, { batterySocPct: 10 }),
  ]
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: 1,
  })
  expect(days[0].state.gridKwh).toBeCloseTo(1, 12)
})

test('the cap of a day\'s last bucket uses the next day\'s first reading', () => {
  const day = '2026-06-10'
  const next = stockholmDayBounds(day).endMs
  const readings = [
    reading(next - 300_000, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: 4 }),
    reading(next, { batterySocPct: 6 }),
  ]
  const { days } = runHouseTimeline({
    readings,
    fromDay: day,
    throughDay: '2026-06-11',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: 10,
  })
  expect(days[0].state.gridKwh).toBeCloseTo(0.5, 12)
})

test("records each bucket's house supply and what left the battery", () => {
  const t = Date.UTC(2026, 5, 10, 19)
  const { house } = runHouseTimeline({
    readings: [reading(t, { gridImportKwh: 0.3, batteryDischargeKwh: 0.3, loadKwh: 0.6 })],
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 2,
    capacityKwh: C,
  })
  const bucket = house.get(t)
  expect(bucket?.supply?.grid).toBeCloseTo(0.5, 12)
  expect(bucket?.supply?.battery).toBeCloseTo(0.5, 12)
  // Empty pool: the whole discharge is drift, grid-origin at the current spot.
  expect(bucket?.batteryOut.gridKwh).toBeCloseTo(0.3, 12)
  expect(bucket?.batteryOut.gridSpotSekSum).toBeCloseTo(0.6, 12)
})

test('fromDay after throughDay and no readings: no checkpoints', () => {
  const r = runHouseTimeline({
    readings: [],
    fromDay: '2026-06-11',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(r.days).toEqual([])
  expect(r.house.size).toBe(0)
})
```

- [ ] **Step 4: Run, expect FAIL**: `bunx vitest run src/lib/houseEnergy/mix`

- [ ] **Step 5: Implement `pool.ts`**

```ts
// Client-safe, pure (ADR-0023 decision 5 and its 2026-10-04 amendment, spec
// "Derivation" 3). The battery as an average-cost pool, run forward bucket by
// bucket: inflows enter at their full kWh carrying their slot's spot (grid:
// what was paid; solar: what export would have paid), an outflow takes every
// part in proportion, and after the bucket the pool is capped at what the
// battery's measured state of charge says it holds.
import type { HouseReading } from '~/lib/services/houseEnergy'
import { BUCKET_MS } from './shape'

/**
 * C: the kWh the battery delivers per 100 % SoC (spec "Derivation" 3).
 * Measured 2026-10-04 over 2026-01-20 → 2026-10-04: Σ discharge ÷ Σ SoC drop
 * / 100 over adjacent pairs of discharge-only buckets (≈ 6.2 in Jan–Feb,
 * 7.5–8.1 from March). Every checkpoint stores the C it was computed with, so
 * changing this re-derives history at the next derive.
 */
export const BATTERY_CAPACITY_KWH = 7.58

/** Below this the pool counts as empty (float dust after many proportional removals). */
const EMPTY_KWH = 1e-9

/**
 * What's in the battery: grid energy with Σ kWh × the spot it was bought at,
 * solar energy with Σ kWh × the spot it would have sold for, and energy stored
 * in a slot without a price. `storedKwh` is always their sum.
 */
export type PoolState = {
  storedKwh: number
  gridKwh: number
  gridSpotSekSum: number
  solarKwh: number
  solarSpotSekSum: number
  unpricedKwh: number
}

/** The composition of what left the battery in one bucket (its parts sum to the discharge). */
export type BatteryOut = {
  gridKwh: number
  gridSpotSekSum: number
  solarKwh: number
  solarSpotSekSum: number
  unpricedKwh: number
}

export const emptyPool = (): PoolState => ({
  storedKwh: 0,
  gridKwh: 0,
  gridSpotSekSum: 0,
  solarKwh: 0,
  solarSpotSekSum: 0,
  unpricedKwh: 0,
})

/**
 * The battery's SoC (%) at the end of bucket `r`. Emaldo's SoC describes the
 * middle of its bucket (measured 2026-10-04: the change from one row to the
 * next splits evenly between the two buckets' flows), so the end is the mean
 * of this row's and the next one's. Null, so no cap, without both values or
 * when `next` isn't the very next bucket (a gap).
 */
export function endOfBucketSocPct(r: HouseReading, next: HouseReading | undefined): number | null {
  if (!next || next.bucketStart.getTime() - r.bucketStart.getTime() !== BUCKET_MS) return null
  if (r.batterySocPct === null || next.batterySocPct === null) return null
  return (r.batterySocPct + next.batterySocPct) / 2
}

/**
 * One 5-minute bucket. The inflow joins before the outflow leaves (a bucket
 * that both charges and discharges sends some of its own inflow on). An
 * outflow beyond the pool empties it and counts the excess as grid energy at
 * this bucket's spot: conservative, and it absorbs measurement drift. Then,
 * with a `capKwh` (end-of-bucket SoC × C), a pool above it shrinks every part
 * by one factor and keeps its spot sums: charging, standby and heating losses
 * raise the average cost (and solar value) of what is left. Below the cap
 * nothing changes. `charge_ac` is grid-origin (spec "Sync").
 */
export function stepPool(
  s: PoolState,
  r: HouseReading,
  spotSekPerKwh: number | null,
  capKwh: number | null,
): { next: PoolState; out: BatteryOut } {
  const gridIn = r.batteryChargeGridKwh + r.batteryChargeAcKwh
  const solarIn = r.batteryChargeSolarKwh
  let { gridKwh, gridSpotSekSum, solarKwh, solarSpotSekSum, unpricedKwh } = s
  if (spotSekPerKwh === null) {
    unpricedKwh += gridIn + solarIn
  } else {
    gridKwh += gridIn
    gridSpotSekSum += gridIn * spotSekPerKwh
    solarKwh += solarIn
    solarSpotSekSum += solarIn * spotSekPerKwh
  }

  const out: BatteryOut = { gridKwh: 0, gridSpotSekSum: 0, solarKwh: 0, solarSpotSekSum: 0, unpricedKwh: 0 }
  const discharge = r.batteryDischargeKwh
  if (discharge > 0) {
    const stored = gridKwh + solarKwh + unpricedKwh
    const f = stored > 0 ? Math.min(1, discharge / stored) : 0
    out.gridKwh = gridKwh * f
    out.gridSpotSekSum = gridSpotSekSum * f
    out.solarKwh = solarKwh * f
    out.solarSpotSekSum = solarSpotSekSum * f
    out.unpricedKwh = unpricedKwh * f
    gridKwh *= 1 - f
    gridSpotSekSum *= 1 - f
    solarKwh *= 1 - f
    solarSpotSekSum *= 1 - f
    unpricedKwh *= 1 - f
    const excess = discharge - stored
    if (excess > 0) {
      if (spotSekPerKwh === null) out.unpricedKwh += excess
      else {
        out.gridKwh += excess
        out.gridSpotSekSum += excess * spotSekPerKwh
      }
    }
  }

  const stored = gridKwh + solarKwh + unpricedKwh
  if (capKwh !== null && stored > capKwh) {
    const k = Math.max(0, capKwh) / stored
    gridKwh *= k
    solarKwh *= k
    unpricedKwh *= k
  }
  const storedKwh = gridKwh + solarKwh + unpricedKwh
  if (storedKwh < EMPTY_KWH) return { next: emptyPool(), out }
  return {
    next: { storedKwh, gridKwh, gridSpotSekSum, solarKwh, solarSpotSekSum, unpricedKwh },
    out,
  }
}
```

- [ ] **Step 6: Implement `carMix.ts`**

```ts
// Client-safe, pure (ADR-0023, spec "Derivation" 4). The car's energy per
// 15-minute slot, split like the house's supply in each 5-minute bucket; the
// battery part splits further by what left the battery in that bucket.
import type { BatteryOut } from './pool'
import type { CarBucket } from './shape'
import type { SupplyFractions } from './supply'

/** Mix rows are per UTC quarter-hour (the spot slot length since 2025-10-01). */
export const SLOT_MS = 15 * 60_000

export type MixSlot = {
  slotStart: Date
  kwh: number
  gridKwh: number
  solarKwh: number
  batteryGridKwh: number
  /** kWh-weighted average spot (SEK/kWh ex VAT); null when batteryGridKwh is 0. */
  batteryGridSpotSek: number | null
  batterySolarKwh: number
  /** kWh-weighted average spot (SEK/kWh ex VAT); null when batterySolarKwh is 0. */
  batterySolarSpotSek: number | null
  batteryUnpricedKwh: number
  noHouseDataKwh: number
}

/** What the house data says about one 5-minute bucket. */
export type BucketHouse = { supply: SupplyFractions | null; batteryOut: BatteryOut }

type Acc = {
  kwh: number
  gridKwh: number
  solarKwh: number
  batteryGridKwh: number
  batteryGridSpotSum: number
  batterySolarKwh: number
  batterySolarSpotSum: number
  batteryUnpricedKwh: number
  noHouseDataKwh: number
}

const emptyAcc = (): Acc => ({
  kwh: 0,
  gridKwh: 0,
  solarKwh: 0,
  batteryGridKwh: 0,
  batteryGridSpotSum: 0,
  batterySolarKwh: 0,
  batterySolarSpotSum: 0,
  batteryUnpricedKwh: 0,
  noHouseDataKwh: 0,
})

/**
 * Per bucket: car kWh × the house fractions; a bucket missing from `house`, or
 * with unknown supply, is no-house-data. Slots ascending; a slot's parts sum
 * to its `kwh`, and a battery spot is set exactly when its kWh is > 0.
 */
export function deriveSessionMix(
  buckets: readonly CarBucket[],
  house: ReadonlyMap<number, BucketHouse>,
): MixSlot[] {
  const slots = new Map<number, Acc>()
  for (const b of buckets) {
    if (!(b.kwh > 0)) continue
    const slotStart = Math.floor(b.bucketStart / SLOT_MS) * SLOT_MS
    let acc = slots.get(slotStart)
    if (!acc) {
      acc = emptyAcc()
      slots.set(slotStart, acc)
    }
    acc.kwh += b.kwh
    const h = house.get(b.bucketStart)
    if (!h?.supply) {
      acc.noHouseDataKwh += b.kwh
      continue
    }
    acc.gridKwh += b.kwh * h.supply.grid
    acc.solarKwh += b.kwh * h.supply.solar
    const battery = b.kwh * h.supply.battery
    if (!(battery > 0)) continue
    const o = h.batteryOut
    const left = o.gridKwh + o.solarKwh + o.unpricedKwh
    if (!(left > 0)) {
      acc.batteryUnpricedKwh += battery
      continue
    }
    const fromGrid = battery * (o.gridKwh / left)
    const fromSolar = battery * (o.solarKwh / left)
    acc.batteryGridKwh += fromGrid
    acc.batterySolarKwh += fromSolar
    acc.batteryUnpricedKwh += battery * (o.unpricedKwh / left)
    if (o.gridKwh > 0) acc.batteryGridSpotSum += fromGrid * (o.gridSpotSekSum / o.gridKwh)
    if (o.solarKwh > 0) acc.batterySolarSpotSum += fromSolar * (o.solarSpotSekSum / o.solarKwh)
  }
  return [...slots]
    .sort(([a], [b]) => a - b)
    .map(([start, a]) => ({
      slotStart: new Date(start),
      kwh: a.kwh,
      gridKwh: a.gridKwh,
      solarKwh: a.solarKwh,
      batteryGridKwh: a.batteryGridKwh,
      batteryGridSpotSek: a.batteryGridKwh > 0 ? a.batteryGridSpotSum / a.batteryGridKwh : null,
      batterySolarKwh: a.batterySolarKwh,
      batterySolarSpotSek: a.batterySolarKwh > 0 ? a.batterySolarSpotSum / a.batterySolarKwh : null,
      batteryUnpricedKwh: a.batteryUnpricedKwh,
      noHouseDataKwh: a.noHouseDataKwh,
    }))
}
```

- [ ] **Step 7: Implement `houseTimeline.ts`**

```ts
// Client-safe, pure (ADR-0023). Runs the battery pool forward over the house
// readings from `fromDay`, one Stockholm day at a time (23, 24 or 25 h), and
// records what the car mix needs per bucket. Each bucket is capped at its
// end-of-bucket SoC × `capacityKwh` (the next reading's SoC is needed for it,
// so the readings are stepped as one ascending list across days). A
// checkpoint is written for every day through `throughDay` (normally today)
// even without readings: the state carries over, so a later derive from any
// day up to today finds D−1's row.
import type { HouseReading } from '~/lib/services/houseEnergy'
import { addDays, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'
import type { BucketHouse } from './carMix'
import { endOfBucketSocPct, type PoolState, stepPool } from './pool'
import { houseSupply } from './supply'

export type PoolDay = { day: string; state: PoolState }

export function runHouseTimeline(input: {
  readings: readonly HouseReading[]
  fromDay: string
  throughDay: string
  start: PoolState
  /** The spot (SEK/kWh ex VAT) of the slot containing the bucket, or null. */
  spotAt: (bucketStartMs: number) => number | null
  /** C: kWh the battery delivers per 100 % SoC. */
  capacityKwh: number
}): { days: PoolDay[]; house: Map<number, BucketHouse> } {
  const fromMs = stockholmDayBounds(input.fromDay).startMs
  const stepped = input.readings
    .filter((r) => r.bucketStart.getTime() >= fromMs)
    .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
  const house = new Map<number, BucketHouse>()
  const days: PoolDay[] = []
  const last = stepped.at(-1)
  const lastReadingDay = last ? stockholmDayOf(last.bucketStart.getTime()) : null
  const lastDay =
    lastReadingDay !== null && lastReadingDay > input.throughDay ? lastReadingDay : input.throughDay

  let state = input.start
  let i = 0
  for (let day = input.fromDay; day <= lastDay; day = addDays(day, 1)) {
    const endMs = stockholmDayBounds(day).endMs
    for (; i < stepped.length && stepped[i].bucketStart.getTime() < endMs; i++) {
      const r = stepped[i]
      const t = r.bucketStart.getTime()
      const soc = endOfBucketSocPct(r, stepped[i + 1])
      const capKwh = soc === null ? null : (soc / 100) * input.capacityKwh
      const { next, out } = stepPool(state, r, input.spotAt(t), capKwh)
      state = next
      house.set(t, { supply: houseSupply(r), batteryOut: out })
    }
    days.push({ day, state })
  }
  return { days, house }
}
```

- [ ] **Step 8: Client-safe guard.** Append to `src/lib/evCharging/clientSafe.browser.test.tsx`:

```tsx
test('the energy-mix derivation math is importable client-side', async () => {
  const supply = await import('~/lib/houseEnergy/mix/supply')
  const shape = await import('~/lib/houseEnergy/mix/shape')
  const pool = await import('~/lib/houseEnergy/mix/pool')
  const carMix = await import('~/lib/houseEnergy/mix/carMix')
  const timeline = await import('~/lib/houseEnergy/mix/houseTimeline')
  expect(typeof supply.houseSupply).toBe('function')
  expect(typeof shape.shapeSession).toBe('function')
  expect(pool.emptyPool().storedKwh).toBe(0)
  expect(typeof carMix.deriveSessionMix).toBe('function')
  expect(typeof timeline.runHouseTimeline).toBe('function')
})
```

- [ ] **Step 9: Run, expect PASS**:
  `bunx vitest run src/lib/houseEnergy/mix && bunx vitest run --project browser src/lib/evCharging/clientSafe.browser.test.tsx`
- [ ] **Step 10: Commit** `feat(charging): add the battery cost pool and per-slot car mix`

---

### Task 4: Pool checkpoints in the houseEnergy service (+ `DbOrTx`)

**Files:**
- Modify: `src/lib/db/index.ts` (export two types)
- Modify: `src/lib/services/houseEnergy/houseEnergy.ts` (`listReadings`, `firstReadingAt`: optional `dbOrTx`)
- Create: `src/lib/services/houseEnergy/batteryPool.ts`, `src/lib/services/houseEnergy/batteryPool.test.ts`
- Modify: `src/lib/services/houseEnergy/index.ts` (`export * from './batteryPool'`)

**Interfaces:**
- Produces:
  ```ts
  // ~/lib/db
  export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
  export type DbOrTx = typeof db | DbTransaction
  // ~/lib/services/houseEnergy
  export async function listReadings(range: { from: Date; to: Date }, dbOrTx?: DbOrTx): Promise<HouseReading[]>
  export async function firstReadingAt(dbOrTx?: DbOrTx): Promise<Date | null>
  export type PoolCheckpoint = { state: PoolState; capacityKwh: number }
  export async function getPoolDay(day: string, dbOrTx?: DbOrTx): Promise<PoolCheckpoint | null>
  export async function replacePoolDaysFrom(day: string, rows: readonly { day: string; state: PoolState }[], capacityKwh: number, dbOrTx?: DbOrTx): Promise<void>
  export type BatteryCapacity = { capacityKwh: number; dischargedKwh: number; socDropPct: number; pairs: number; from: Date; to: Date }
  export async function measureBatteryCapacity(dbOrTx?: DbOrTx): Promise<BatteryCapacity | null>
  ```

**Reviewers:** A = `code-reviewer`; B = `test-completeness`.

- [ ] **Step 1: Failing tests**

```ts
// src/lib/services/houseEnergy/batteryPool.test.ts
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { batteryPoolDay, houseEnergyReading } from '~/lib/db/schema'
import type { PoolState } from '~/lib/houseEnergy/mix/pool'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { reading, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { getPoolDay, measureBatteryCapacity, replacePoolDaysFrom } from './batteryPool'
import { firstReadingAt, listReadings, replaceDay } from './houseEnergy'

setupDatabase()

const C = 7.5
const state = (gridKwh: number, solarKwh = 0): PoolState => ({
  storedKwh: gridKwh + solarKwh,
  gridKwh,
  gridSpotSekSum: gridKwh * 0.5,
  solarKwh,
  solarSpotSekSum: solarKwh * 0.25,
  unpricedKwh: 0,
})
const storedDays = async () =>
  (await db.select({ day: batteryPoolDay.day }).from(batteryPoolDay).orderBy(batteryPoolDay.day)).map(
    (r) => r.day,
  )
async function storeDay(day: string, flows: Parameters<typeof syntheticDay>[1]) {
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, syntheticDay(day, flows))
}

test('getPoolDay is null without a checkpoint and round-trips one with its capacity', async () => {
  expect(await getPoolDay('2026-06-10')).toBeNull()
  await replacePoolDaysFrom('2026-06-10', [{ day: '2026-06-10', state: state(2, 1) }], C)
  expect(await getPoolDay('2026-06-10')).toEqual({ state: state(2, 1), capacityKwh: C })
})

test('replacePoolDaysFrom rewrites the days from `day` on and keeps earlier ones', async () => {
  await replacePoolDaysFrom(
    '2026-06-08',
    ['2026-06-08', '2026-06-09', '2026-06-10'].map((day) => ({ day, state: state(1) })),
    C,
  )
  await replacePoolDaysFrom('2026-06-09', [{ day: '2026-06-09', state: state(5) }], C)
  expect(await storedDays()).toEqual(['2026-06-08', '2026-06-09'])
  expect((await getPoolDay('2026-06-09'))?.state).toEqual(state(5))
  expect((await getPoolDay('2026-06-08'))?.state).toEqual(state(1))
})

test('an empty list clears every checkpoint from `day` on', async () => {
  await replacePoolDaysFrom(
    '2026-06-08',
    ['2026-06-08', '2026-06-09'].map((day) => ({ day, state: state(1) })),
    C,
  )
  await replacePoolDaysFrom('2026-06-09', [], C)
  expect(await storedDays()).toEqual(['2026-06-08'])
})

test('a row before `day` or a malformed day is refused before anything changes', async () => {
  await replacePoolDaysFrom('2026-06-08', [{ day: '2026-06-08', state: state(1) }], C)
  await expect(
    replacePoolDaysFrom('2026-06-09', [{ day: '2026-06-08', state: state(2) }], C),
  ).rejects.toThrow(RangeError)
  await expect(replacePoolDaysFrom('2026-6-9', [], C)).rejects.toThrow(RangeError)
  await expect(getPoolDay('yesterday')).rejects.toThrow(RangeError)
  expect(await storedDays()).toEqual(['2026-06-08'])
})

test("the table refuses a stored total that isn't the parts' sum, and a capacity outside (0, 100)", async () => {
  await expectConstraintViolation(
    db.insert(batteryPoolDay).values({ day: '2026-06-10', ...state(1), storedKwh: 2, capacityKwh: C }),
    'battery_pool_day_stored_sum_check',
  )
  await expectConstraintViolation(
    db.insert(batteryPoolDay).values({ day: '2026-06-11', ...state(1), capacityKwh: 0 }),
    'battery_pool_day_capacity_kwh_check',
  )
})

test('measureBatteryCapacity: kWh delivered per 100 % SoC over discharge-only pairs', async () => {
  expect(await measureBatteryCapacity()).toBeNull()
  // 2026-06-10: 100 buckets charging (not measured), then 0.04 kWh out per
  // bucket while the SoC falls 0.5 % per bucket → 8 kWh per 100 %. Bucket 150
  // also charges, so the two pairs touching it are left out.
  await storeDay('2026-06-10', (_, i) => {
    if (i < 100) return { batteryChargeSolarKwh: 0.1, solarKwh: 0.1, batterySocPct: i * 0.9 }
    const discharging = { batteryDischargeKwh: 0.04, loadKwh: 0.04, batterySocPct: 100 - (i - 100) * 0.5 }
    return i === 150 ? { ...discharging, batteryChargeGridKwh: 0.5, gridImportKwh: 0.5 } : discharging
  })
  const measured = await measureBatteryCapacity()
  expect(measured?.capacityKwh).toBeCloseTo(8, 9)
  // Buckets 100–287: 187 adjacent pairs, minus the two touching bucket 150.
  expect(measured?.pairs).toBe(185)
  const { startMs } = stockholmDayBounds('2026-06-10')
  expect(measured?.from).toEqual(new Date(startMs + 100 * 300_000))
  expect(measured?.to).toEqual(new Date(startMs + 287 * 300_000))
})

test('measureBatteryCapacity ignores pairs across a gap or without a SoC', async () => {
  const discharging = (soc: number | null) => (_: number, i: number) => ({
    batteryDischargeKwh: 0.04,
    loadKwh: 0.04,
    batterySocPct: soc === null ? null : soc - i * 0.25,
  })
  // Every other bucket missing: no two adjacent readings.
  const { startMs, endMs } = stockholmDayBounds('2026-06-10')
  await replaceDay(
    { dayStart: new Date(startMs), dayEnd: new Date(endMs) },
    syntheticDay('2026-06-10', discharging(100)).filter((_, i) => i % 2 === 0),
  )
  await storeDay('2026-06-11', discharging(null))
  expect(await measureBatteryCapacity()).toBeNull()
})

test("listReadings and firstReadingAt read inside a caller's transaction", async () => {
  // The test pool has one connection: using `db` instead of `tx` here would hang.
  await db.transaction(async (tx) => {
    await tx
      .insert(houseEnergyReading)
      .values(reading(Date.parse('2026-06-10T10:00:00Z'), { loadKwh: 0.1, gridImportKwh: 0.1 }))
    expect(await firstReadingAt(tx)).toEqual(new Date('2026-06-10T10:00:00Z'))
    const rows = await listReadings(
      { from: new Date('2026-06-10T00:00:00Z'), to: new Date('2026-06-11T00:00:00Z') },
      tx,
    )
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**: `bunx vitest run src/lib/services/houseEnergy/batteryPool.test.ts`

- [ ] **Step 3: Implement**

In `src/lib/db/index.ts`, after `export const db = …`:

```ts
/** A transaction handle, as `db.transaction`'s callback receives it. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** `db` or an open transaction: lets a caller compose service calls into one transaction. */
export type DbOrTx = typeof db | DbTransaction
```

In `src/lib/services/houseEnergy/houseEnergy.ts`: import `type DbOrTx` from `~/lib/db`, give `listReadings` and
`firstReadingAt` a trailing `dbOrTx: DbOrTx = db` parameter, and replace `db.` with `dbOrTx.` in those two bodies
only. Nothing else in the file changes.

```ts
// src/lib/services/houseEnergy/batteryPool.ts
import { eq, gte, sql } from 'drizzle-orm'
import { type DbOrTx, db } from '~/lib/db'
import { batteryPoolDay } from '~/lib/db/schema'
import type { PoolState } from '~/lib/houseEnergy/mix/pool'
import { isStockholmDay } from '~/lib/time/stockholm'

/** A day-end pool state and the capacity C (kWh per 100 % SoC) it was computed with. */
export type PoolCheckpoint = { state: PoolState; capacityKwh: number }

/** 9 bound parameters per row: far under Postgres's 65 535 per statement. */
const POOL_INSERT_BATCH = 5_000

function assertDay(day: string): void {
  if (!isStockholmDay(day)) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
}

/** The battery pool at the end of Stockholm `day`, or null without a checkpoint (ADR-0023). */
export async function getPoolDay(day: string, dbOrTx: DbOrTx = db): Promise<PoolCheckpoint | null> {
  assertDay(day)
  const [row] = await dbOrTx
    .select({
      storedKwh: batteryPoolDay.storedKwh,
      gridKwh: batteryPoolDay.gridKwh,
      gridSpotSekSum: batteryPoolDay.gridSpotSekSum,
      solarKwh: batteryPoolDay.solarKwh,
      solarSpotSekSum: batteryPoolDay.solarSpotSekSum,
      unpricedKwh: batteryPoolDay.unpricedKwh,
      capacityKwh: batteryPoolDay.capacityKwh,
    })
    .from(batteryPoolDay)
    .where(eq(batteryPoolDay.day, day))
  if (!row) return null
  const { capacityKwh, ...state } = row
  return { state, capacityKwh }
}

/**
 * Replaces every checkpoint from `day` on with `rows` (all on or after `day`),
 * computed with capacity `capacityKwh`: delete + insert, atomically (its own
 * transaction, or the caller's). A row before `day` or a malformed day is a
 * programming error: RangeError, nothing written.
 */
export async function replacePoolDaysFrom(
  day: string,
  rows: readonly { day: string; state: PoolState }[],
  capacityKwh: number,
  dbOrTx: DbOrTx = db,
): Promise<void> {
  assertDay(day)
  for (const row of rows) {
    assertDay(row.day)
    if (row.day < day) throw new RangeError(`Pool day ${row.day} is before ${day}`)
  }
  const values = rows.map((r) => ({
    day: r.day,
    storedKwh: r.state.storedKwh,
    gridKwh: r.state.gridKwh,
    gridSpotSekSum: r.state.gridSpotSekSum,
    solarKwh: r.state.solarKwh,
    solarSpotSekSum: r.state.solarSpotSekSum,
    unpricedKwh: r.state.unpricedKwh,
    capacityKwh,
  }))
  const write = async (tx: DbOrTx) => {
    await tx.delete(batteryPoolDay).where(gte(batteryPoolDay.day, day))
    for (let i = 0; i < values.length; i += POOL_INSERT_BATCH) {
      await tx.insert(batteryPoolDay).values(values.slice(i, i + POOL_INSERT_BATCH))
    }
  }
  if (dbOrTx === db) await db.transaction(write)
  else await write(dbOrTx)
}

export type BatteryCapacity = {
  /** kWh delivered per 100 % SoC. */
  capacityKwh: number
  dischargedKwh: number
  socDropPct: number
  pairs: number
  from: Date
  to: Date
}

/**
 * C, measured from every stored reading (spec "Derivation" 3): Σ discharge ÷
 * Σ SoC drop / 100 over adjacent pairs of buckets (5 min apart, both with a
 * SoC) that only discharge. A row's SoC is its bucket's mid-point, so the SoC
 * change between two rows spans half of each bucket: a pair counts the mean
 * of its two discharges. Null without such pairs or without a net drop.
 * `from`/`to`: the first pair's first bucket and the last pair's second.
 */
export async function measureBatteryCapacity(dbOrTx: DbOrTx = db): Promise<BatteryCapacity | null> {
  const result = await dbOrTx.execute<{
    discharged: number | null
    soc_drop: number | null
    pairs: number
    first: Date | string | null
    last: Date | string | null
  }>(sql`
    WITH x AS (
      SELECT bucket_start,
        battery_charge_solar_kwh + battery_charge_grid_kwh + battery_charge_ac_kwh AS charged,
        battery_discharge_kwh AS discharged,
        battery_soc_pct AS soc,
        lead(bucket_start) OVER w AS next_start,
        lead(battery_charge_solar_kwh + battery_charge_grid_kwh + battery_charge_ac_kwh) OVER w AS next_charged,
        lead(battery_discharge_kwh) OVER w AS next_discharged,
        lead(battery_soc_pct) OVER w AS next_soc
      FROM house_energy_reading
      WINDOW w AS (ORDER BY bucket_start)
    )
    SELECT sum((discharged + next_discharged) / 2)::float8 AS discharged,
           sum(soc - next_soc)::float8 AS soc_drop,
           count(*)::int AS pairs,
           min(bucket_start) AS first,
           max(next_start) AS last
    FROM x
    WHERE next_start = bucket_start + interval '5 minutes'
      AND charged = 0 AND next_charged = 0
      AND discharged > 0 AND next_discharged > 0
      AND soc IS NOT NULL AND next_soc IS NOT NULL
  `)
  const row = result.rows[0]
  if (!row || row.pairs === 0 || row.discharged === null || row.soc_drop === null) return null
  if (!(row.soc_drop > 0) || row.first === null || row.last === null) return null
  return {
    capacityKwh: row.discharged / (row.soc_drop / 100),
    dischargedKwh: row.discharged,
    socDropPct: row.soc_drop,
    pairs: row.pairs,
    from: new Date(row.first),
    to: new Date(row.last),
  }
}
```

Add `export * from './batteryPool'` to `src/lib/services/houseEnergy/index.ts`.

- [ ] **Step 4: Run, expect PASS**: `bunx vitest run src/lib/services/houseEnergy && bun run typecheck`
- [ ] **Step 5: Commit** `feat(charging): store battery pool checkpoints`

---

### Task 5: The energyMix service

**Files:**
- Create: `src/lib/services/energyMix/energyMix.ts`, `energyMix.test.ts`, `index.ts`

**Interfaces:**
- Consumes: `DbOrTx`, `DbTransaction` (Task 4); `evChargeEnergyMix`, `evChargeSession`; `countedSessionFilter` from
  `~/lib/services/evCharging/counted`; `type MixSlot` (Task 3).
- Produces:
  ```ts
  export type DeriveTx = DbTransaction
  export type MixRow = MixSlot & { sessionId: string }
  export const MIX_INSERT_BATCH: number
  export async function withDeriveLock<T>(fn: (tx: DeriveTx) => Promise<T>): Promise<T>
  export async function replaceForSessions(sessionIds: readonly string[], rows: readonly MixRow[], dbOrTx?: DbOrTx): Promise<void>
  export async function listForSessions(sessionIds: readonly string[]): Promise<Map<string, MixSlot[]>>
  export async function pruneUncounted(after: Date, dbOrTx?: DbOrTx): Promise<number>
  ```

**Reviewers:** A = `code-reviewer`; B = `test-completeness`.

- [ ] **Step 1: Failing tests**

```ts
// src/lib/services/energyMix/energyMix.test.ts
import { eq, inArray } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeEnergyMix, evChargeSession } from '~/lib/db/schema'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import {
  listForSessions,
  MIX_INSERT_BATCH,
  pruneUncounted,
  replaceForSessions,
  withDeriveLock,
} from './energyMix'

setupDatabase()

const QUARTER = 15 * 60_000

function slot(iso: string, over: Partial<MixSlot> = {}): MixSlot {
  return {
    slotStart: new Date(iso),
    kwh: 1,
    gridKwh: 1,
    solarKwh: 0,
    batteryGridKwh: 0,
    batteryGridSpotSek: null,
    batterySolarKwh: 0,
    batterySolarSpotSek: null,
    batteryUnpricedKwh: 0,
    noHouseDataKwh: 0,
    ...over,
  }
}
const rowsOf = (sessionId: string, slots: MixSlot[]) => slots.map((s) => ({ ...s, sessionId }))
const batteryHeavy = { kwh: 2, gridKwh: 0.5, solarKwh: 0.5, batteryGridKwh: 1, batteryGridSpotSek: 0.3 }

test('replaceForSessions stores rows that listForSessions returns per session, in slot order', async () => {
  const a = await insertSession()
  const b = await insertSession({
    startAt: new Date('2026-01-02T10:00:00Z'),
    endAt: new Date('2026-01-02T11:00:00Z'),
  })
  await replaceForSessions(
    [a, b],
    [
      ...rowsOf(a, [slot('2026-01-01T10:15:00Z'), slot('2026-01-01T10:00:00Z', batteryHeavy)]),
      ...rowsOf(b, [slot('2026-01-02T10:00:00Z', { kwh: 3, gridKwh: 0, noHouseDataKwh: 3 })]),
    ],
  )
  const mix = await listForSessions([a, b])
  expect(mix.get(a)).toEqual([slot('2026-01-01T10:00:00Z', batteryHeavy), slot('2026-01-01T10:15:00Z')])
  expect(mix.get(b)).toEqual([slot('2026-01-02T10:00:00Z', { kwh: 3, gridKwh: 0, noHouseDataKwh: 3 })])
})

test('replacing a session rewrites only its rows and leaves none stale', async () => {
  const a = await insertSession()
  const b = await insertSession()
  await replaceForSessions(
    [a, b],
    [
      ...rowsOf(a, [slot('2026-01-01T10:00:00Z'), slot('2026-01-01T10:15:00Z')]),
      ...rowsOf(b, [slot('2026-01-01T10:00:00Z')]),
    ],
  )
  await replaceForSessions([a], rowsOf(a, [slot('2026-01-01T10:30:00Z')]))
  const mix = await listForSessions([a, b])
  expect(mix.get(a)?.map((s) => s.slotStart.toISOString())).toEqual(['2026-01-01T10:30:00.000Z'])
  expect(mix.get(b)).toHaveLength(1)
})

test('a row for a session not being replaced is refused before anything is written', async () => {
  const a = await insertSession()
  const b = await insertSession()
  await expect(replaceForSessions([a], rowsOf(b, [slot('2026-01-01T10:00:00Z')]))).rejects.toThrow(
    RangeError,
  )
  expect((await listForSessions([a, b])).size).toBe(0)
})

test('more rows than one insert batch are all stored', async () => {
  const a = await insertSession()
  const start = Date.parse('2026-01-01T00:00:00Z')
  const slots = Array.from({ length: MIX_INSERT_BATCH + 1 }, (_, i) =>
    slot(new Date(start + i * QUARTER).toISOString()),
  )
  await replaceForSessions([a], rowsOf(a, slots))
  expect((await listForSessions([a])).get(a)).toHaveLength(MIX_INSERT_BATCH + 1)
})

test('listForSessions: no ids → empty map; sessions without rows are absent', async () => {
  expect(await listForSessions([])).toEqual(new Map())
  const a = await insertSession()
  expect((await listForSessions([a])).has(a)).toBe(false)
})

test('rows go with their session (FK cascade)', async () => {
  const a = await insertSession()
  await replaceForSessions([a], rowsOf(a, [slot('2026-01-01T10:00:00Z')]))
  await db.delete(evChargeSession).where(eq(evChargeSession.id, a))
  expect(await db.select().from(evChargeEnergyMix)).toEqual([])
})

test('the table refuses parts that do not add up, a spot without kWh, an unaligned slot and negative kWh', async () => {
  const a = await insertSession()
  const insert = (over: Partial<MixSlot>) =>
    db.insert(evChargeEnergyMix).values({ ...slot('2026-01-01T10:00:00Z', over), sessionId: a })
  await expectConstraintViolation(insert({ gridKwh: 0.5 }), 'ev_charge_energy_mix_parts_sum_check')
  await expectConstraintViolation(
    insert({ batteryGridSpotSek: 0.3 }),
    'ev_charge_energy_mix_battery_grid_spot_check',
  )
  await expectConstraintViolation(
    insert({ gridKwh: 0, batteryGridKwh: 1 }),
    'ev_charge_energy_mix_battery_grid_spot_check',
  )
  await expectConstraintViolation(
    insert({ gridKwh: 0, batterySolarKwh: 1 }),
    'ev_charge_energy_mix_battery_solar_spot_check',
  )
  await expectConstraintViolation(
    insert({ slotStart: new Date('2026-01-01T10:05:00Z') }),
    'ev_charge_energy_mix_slot_start_check',
  )
  await expectConstraintViolation(
    insert({ kwh: 0, gridKwh: -1, solarKwh: 1 }),
    'ev_charge_energy_mix_kwh_nonneg_check',
  )
})

test('pruneUncounted drops the rows of no-longer-counted sessions that end after the instant', async () => {
  const counted = await insertSession({
    startAt: new Date('2026-01-05T10:00:00Z'),
    endAt: new Date('2026-01-05T11:00:00Z'),
  })
  const voided = await insertSession({
    startAt: new Date('2026-01-05T12:00:00Z'),
    endAt: new Date('2026-01-05T13:00:00Z'),
  })
  const earlierVoided = await insertSession({
    startAt: new Date('2026-01-01T10:00:00Z'),
    endAt: new Date('2026-01-01T11:00:00Z'),
  })
  await replaceForSessions(
    [counted, voided, earlierVoided],
    [
      ...rowsOf(counted, [slot('2026-01-05T10:00:00Z')]),
      ...rowsOf(voided, [slot('2026-01-05T12:00:00Z')]),
      ...rowsOf(earlierVoided, [slot('2026-01-01T10:00:00Z')]),
    ],
  )
  await db
    .update(evChargeSession)
    .set({ voided: true })
    .where(inArray(evChargeSession.id, [voided, earlierVoided]))
  expect(await pruneUncounted(new Date('2026-01-05T00:00:00Z'))).toBe(1)
  const left = await listForSessions([counted, voided, earlierVoided])
  expect([...left.keys()].sort()).toEqual([counted, earlierVoided].sort())
})

test('withDeriveLock runs its writes in one transaction that a throw rolls back', async () => {
  const a = await insertSession()
  await expect(
    withDeriveLock(async (tx) => {
      await replaceForSessions([a], rowsOf(a, [slot('2026-01-01T10:00:00Z')]), tx)
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect((await listForSessions([a])).size).toBe(0)
  await withDeriveLock((tx) => replaceForSessions([a], rowsOf(a, [slot('2026-01-01T10:00:00Z')]), tx))
  expect((await listForSessions([a])).get(a)).toHaveLength(1)
})
```

- [ ] **Step 2: Run, expect FAIL**: `bunx vitest run src/lib/services/energyMix`

- [ ] **Step 3: Implement**

```ts
// src/lib/services/energyMix/energyMix.ts
import { and, asc, gt, inArray, not, sql } from 'drizzle-orm'
import { type DbOrTx, type DbTransaction, db } from '~/lib/db'
import { evChargeEnergyMix, evChargeSession } from '~/lib/db/schema'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import { countedSessionFilter } from '~/lib/services/evCharging/counted'

// The stored energy mix of charging sessions (ADR-0023): per session × 15-min
// slot, kWh by origin. Written only by the derive; read by the cost model.

/** The transaction a derive runs in (see `withDeriveLock`). */
export type DeriveTx = DbTransaction
export type MixRow = MixSlot & { sessionId: string }

/** 12 bound parameters per row: keeps one INSERT far under Postgres's 65 535. */
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
 * Deletes the mix of sessions ending after `after` that are no longer counted
 * (voided, replaced, under the noise threshold): a derive rewrites counted
 * sessions only, so their old rows would otherwise linger. Returns how many
 * rows went.
 */
export async function pruneUncounted(after: Date, dbOrTx: DbOrTx = db): Promise<number> {
  const uncounted = dbOrTx
    .select({ id: evChargeSession.id })
    .from(evChargeSession)
    .where(and(gt(evChargeSession.endAt, after), not(countedSessionFilter())))
  const deleted = await dbOrTx
    .delete(evChargeEnergyMix)
    .where(inArray(evChargeEnergyMix.sessionId, uncounted))
    .returning({ sessionId: evChargeEnergyMix.sessionId })
  return deleted.length
}
```

```ts
// src/lib/services/energyMix/index.ts
export * from './energyMix'
```

- [ ] **Step 4: Run, expect PASS**: `bunx vitest run src/lib/services/energyMix && bun run typecheck`
- [ ] **Step 5: Commit** `feat(charging): add the energy mix service`

---

### Task 6: What the derive needs from sessions and spot prices

**Files:**
- Modify: `src/lib/services/evCharging/sessionEnergy.ts` (+ `sessionEnergy.test.ts`)
- Modify: `src/lib/services/evCharging/evCharging.ts` (`importSessions` change detection; + `evCharging.test.ts`)
- Modify: `src/lib/services/spotPrice/spotPrice.ts` (+ `spotPrice.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export async function listSessionEnergy(filter: { all: true; vehicle?: VehicleScope } | { sessionIds: readonly string[] } | { endsAfter: Date }, dbOrTx?: DbOrTx): Promise<SessionEnergy[]>
  export async function earliestCountedStartEndingAfter(after: Date, dbOrTx?: DbOrTx): Promise<Date | null>
  export type ImportSessionsResult = { upserted: number; voided: number; skipped: number; earliestChangedStartAt: Date | null }
  export async function listSlotsOverlapping(zone: PriceZone, ranges: readonly { startMs: number; endMs: number }[], dbOrTx?: DbOrTx): Promise<PriceSlot[]>
  ```

**Reviewers:** A = `code-reviewer`; B = `test-completeness`.

- [ ] **Step 1: Failing tests**

Append to `src/lib/services/evCharging/sessionEnergy.test.ts` (import `earliestCountedStartEndingAfter` alongside the
existing imports; it uses the file's `insertSession`, which makes 2-hour, 10 kWh sessions):

```ts
test('endsAfter lists the counted sessions ending after an instant', async () => {
  await insertSession({ startAt: new Date('2026-09-01T20:00:00Z') }) // ends 22:00
  await insertSession({ startAt: new Date('2026-09-01T22:00:00Z') }) // ends exactly at midnight
  const spanning = await insertSession({ startAt: new Date('2026-09-01T23:00:00Z') })
  const after = await insertSession({ startAt: new Date('2026-09-02T10:00:00Z') })
  await insertSession({ startAt: new Date('2026-09-02T12:00:00Z'), voided: true })
  const list = await listSessionEnergy({ endsAfter: new Date('2026-09-02T00:00:00Z') })
  expect(list.map((s) => s.sessionId)).toEqual([spanning, after])
  expect(list[0]).toMatchObject({
    estimated: true,
    stretches: [
      { startMs: Date.parse('2026-09-01T23:00:00Z'), endMs: Date.parse('2026-09-02T01:00:00Z'), kwh: 10 },
    ],
  })
})

test('earliestCountedStartEndingAfter: the earliest counted start among sessions ending after an instant', async () => {
  const midnight = new Date('2026-09-02T00:00:00Z')
  expect(await earliestCountedStartEndingAfter(midnight)).toBeNull()
  await insertSession({ startAt: new Date('2026-09-01T20:00:00Z') }) // ends before
  await insertSession({ startAt: new Date('2026-09-01T22:30:00Z'), voided: true }) // spans, voided
  await insertSession({ startAt: new Date('2026-09-01T23:00:00Z') }) // spans
  await insertSession({ startAt: new Date('2026-09-02T08:00:00Z') })
  expect(await earliestCountedStartEndingAfter(midnight)).toEqual(new Date('2026-09-01T23:00:00Z'))
})
```

In `src/lib/services/evCharging/evCharging.test.ts`, first make the nine existing result assertions tolerant of the
new field: `sed -i '' 's/)\.toEqual({ upserted:/).toMatchObject({ upserted:/' src/lib/services/evCharging/evCharging.test.ts`
(then `grep -n "toEqual({ upserted" src/lib/services/evCharging/evCharging.test.ts` prints nothing). Then append:

```ts
describe('importSessions reports the earliest change for the energy-mix derive', () => {
  const ctx = { installationId: 'install-1' }
  const iv = (from: string, to: string, kwh: number) => ({
    startAt: new Date(from),
    endAt: new Date(to),
    energyKwh: kwh,
  })
  const withIntervals = (over: Partial<ZaptecSession> = {}) =>
    session({
      intervals: [
        iv('2026-01-10T10:00:00Z', '2026-01-10T11:00:00Z', 2),
        iv('2026-01-10T11:00:00Z', '2026-01-10T12:00:00Z', 3),
      ],
      ...over,
    })

  test('a new session is a change from its start', async () => {
    const result = await importSessions([withIntervals()], ctx)
    expect(result.earliestChangedStartAt).toEqual(new Date('2026-01-10T10:00:00Z'))
  })

  test('re-importing an identical page changes nothing', async () => {
    await importSessions([withIntervals()], ctx)
    const again = await importSessions([withIntervals()], ctx)
    expect(again.earliestChangedStartAt).toBeNull()
  })

  test.each<[string, Partial<ZaptecSession>]>([
    ['energy', { energyKwh: 6 }],
    ['end', { endAt: new Date('2026-01-10T12:30:00Z') }],
    ['void flag', { voided: true }],
    ['replacement', { replacedBySessionId: 'zap-2' }],
    ['intervals', { intervals: [iv('2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', 5)] }],
  ])('a changed %s is a change from the start', async (_, over) => {
    await importSessions([withIntervals()], ctx)
    const result = await importSessions([withIntervals(over)], ctx)
    expect(result.earliestChangedStartAt).toEqual(new Date('2026-01-10T10:00:00Z'))
  })

  test('a moved start counts from the earlier of the old and new start', async () => {
    await importSessions([withIntervals()], ctx)
    const later = await importSessions([withIntervals({ startAt: new Date('2026-01-10T10:30:00Z') })], ctx)
    expect(later.earliestChangedStartAt).toEqual(new Date('2026-01-10T10:00:00Z'))
    const earlier = await importSessions([withIntervals({ startAt: new Date('2026-01-10T09:00:00Z') })], ctx)
    expect(earlier.earliestChangedStartAt).toEqual(new Date('2026-01-10T09:00:00Z'))
  })

  test('the earliest change on the page wins; skipped sessions are not changes', async () => {
    const result = await importSessions(
      [
        session({ id: 'zap-a', startAt: new Date('2026-01-12T10:00:00Z'), endAt: new Date('2026-01-12T11:00:00Z') }),
        session({ id: 'zap-b', startAt: new Date('2026-01-11T10:00:00Z'), endAt: new Date('2026-01-11T11:00:00Z') }),
        session({ id: 'zap-bad', startAt: new Date('2026-01-01T10:00:00Z'), energyKwh: -1 }),
      ],
      ctx,
    )
    expect(result.earliestChangedStartAt).toEqual(new Date('2026-01-11T10:00:00Z'))
  })
})
```

(Add `describe` to the file's vitest import.)

Append to `src/lib/services/spotPrice/spotPrice.test.ts`:

```ts
test("listSlotsOverlapping reads inside a caller's transaction", async () => {
  // The test pool has one connection: using `db` instead of `tx` here would hang.
  await db.transaction(async (tx) => {
    await tx.insert(spotPrice).values({
      zone: 'SE3',
      slotStart: new Date('2026-09-28T08:00:00Z'),
      slotEnd: new Date('2026-09-28T08:15:00Z'),
      sekPerKwh: 1.5,
    })
    const slots = await listSlotsOverlapping(
      'SE3',
      [{ startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T08:15Z') }],
      tx,
    )
    expect(slots).toEqual([
      { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T08:15Z'), sekPerKwh: 1.5 },
    ])
  })
})
```

- [ ] **Step 2: Run, expect FAIL**:
  `bunx vitest run src/lib/services/evCharging src/lib/services/spotPrice`

- [ ] **Step 3: Implement**

`sessionEnergy.ts`: import `gt` from `drizzle-orm` and `type DbOrTx` from `~/lib/db`; replace the filter building and
the `db.` calls:

```ts
type SessionEnergyFilter =
  | { all: true; vehicle?: VehicleScope }
  | { sessionIds: readonly string[] }
  /** Counted sessions ending after the instant (the energy-mix derive's window, ADR-0023). */
  | { endsAfter: Date }

function sessionFilterOf(filter: SessionEnergyFilter) {
  if ('sessionIds' in filter) {
    return and(countedSessionFilter(), inArray(evChargeSession.id, [...filter.sessionIds]))
  }
  if ('endsAfter' in filter) {
    return and(countedSessionFilter(), gt(evChargeSession.endAt, filter.endsAfter))
  }
  return countedSessionFilter({ vehicle: filter.vehicle })
}

export async function listSessionEnergy(
  filter: SessionEnergyFilter,
  dbOrTx: DbOrTx = db,
): Promise<SessionEnergy[]> {
  if ('sessionIds' in filter && filter.sessionIds.length === 0) return []
  const sessionFilter = sessionFilterOf(filter)
  // … body unchanged, except `db.select` → `dbOrTx.select` (all three: the
  // sessions query, the intervals query and its subselect).
}

/**
 * Start of the earliest counted session ending after `after`, or null. The
 * energy-mix derive widens its start day back with it, so a session spanning
 * midnight is always derived whole (ADR-0023).
 */
export async function earliestCountedStartEndingAfter(
  after: Date,
  dbOrTx: DbOrTx = db,
): Promise<Date | null> {
  const [row] = await dbOrTx
    .select({ first: min(evChargeSession.startAt) })
    .from(evChargeSession)
    .where(and(countedSessionFilter(), gt(evChargeSession.endAt, after)))
  return row?.first ?? null
}
```

`evCharging.ts`: extend the result type and detect changes inside the existing transaction, **before** the upsert:

```ts
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
```

In `importSessions`: the early return becomes `return { upserted: 0, voided: 0, skipped, earliestChangedStartAt: null }`;
declare `let earliestChangedStartAt: Date | null = null` before `db.transaction`; inside the transaction, right after
the charger stub insert and before the session upsert:

```ts
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
      .where(inArray(evChargeSession.zaptecSessionId, validSessions.map((s) => s.id)))
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
            .where(inArray(evChargeInterval.sessionId, stored.map((s) => s.id)))
    earliestChangedStartAt = earliestChangedStart(validSessions, stored, storedIntervals)
```

and the final return becomes `return { upserted: validSessions.length, voided, skipped, earliestChangedStartAt }`.

`spotPrice.ts`: import `type DbOrTx`; `listSlotsOverlapping(zone, ranges, dbOrTx: DbOrTx = db)` and
`await dbOrTx.execute<…>(…)`. Nothing else changes.

- [ ] **Step 4: Run, expect PASS**:
  `bunx vitest run src/lib/services/evCharging src/lib/services/spotPrice src/lib/evCharging && bun run typecheck`
  (the last folder proves the Zaptec sync and cost read models are unaffected).
- [ ] **Step 5: Commit** `feat(charging): expose session changes and windows for the mix derive`

---

### Task 7: `deriveFrom` + `deriveAfterSync`

**Files:**
- Create: `src/lib/houseEnergy/derive.ts`, `src/lib/houseEnergy/derive.test.ts`
- Create: `src/lib/houseEnergy/deriveAfterSync.ts`, `src/lib/houseEnergy/deriveAfterSync.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6; `SlotIndex` (`~/lib/evCharging/cost`); `SPOT_ZONE`; `withDeadline`.
- Produces:
  ```ts
  export type DeriveResult = { days: number; sessions: number; deriveMs: number }
  export async function deriveFrom(day: string, opts: { log: Logger; now?: () => Date }): Promise<DeriveResult>
  export const DERIVE_BUDGET_MS = 30_000
  export async function deriveAfterSync(a: { source: IntegrationSource; fromDay: string | null; log: Logger;
    derive?: typeof deriveFrom; budgetMs?: number }): Promise<number>   // ms spent; never throws
  ```

**Reviewers:** A = `code-reviewer`; B = `test-completeness`.

- [ ] **Step 1: Failing tests for `derive.ts`**

```ts
// src/lib/houseEnergy/derive.test.ts
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeSession } from '~/lib/db/schema'
import { createServerLogger } from '~/lib/logger/server'
import * as energyMixService from '~/lib/services/energyMix'
import * as houseEnergyService from '~/lib/services/houseEnergy'
import * as spotPriceService from '~/lib/services/spotPrice'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { insertInterval, insertSession } from '~test/fixtures/evCharging'
import { type Flows, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { deriveFrom } from './derive'
import type { MixSlot } from './mix/carMix'
import { BATTERY_CAPACITY_KWH } from './mix/pool'

setupDatabase()

const log = createServerLogger({ write: () => true })
const derive = (day: string, nowIso = '2026-06-12T12:00:00Z') =>
  deriveFrom(day, { log, now: () => new Date(nowIso) })

const at = (iso: string) => Date.parse(iso)
const inRange = (ms: number, fromIso: string, toIso: string) => ms >= at(fromIso) && ms < at(toIso)
const BASE: Flows = { loadKwh: 0.1, gridImportKwh: 0.1 }
type KwhKey = 'kwh' | 'gridKwh' | 'solarKwh' | 'batteryGridKwh' | 'batterySolarKwh' | 'batteryUnpricedKwh' | 'noHouseDataKwh'
const total = (slots: MixSlot[], key: KwhKey) => slots.reduce((s, x) => s + x[key], 0)

async function storeDay(day: string, flows: (ms: number) => Flows) {
  const { startMs, endMs } = stockholmDayBounds(day)
  await houseEnergyService.replaceDay(
    { dayStart: new Date(startMs), dayEnd: new Date(endMs) },
    syntheticDay(day, flows),
  )
}
async function storePrices(day: string, price: (ms: number) => number = () => 1) {
  await spotPriceService.replaceDay(
    'SE3',
    day,
    daySlots(day, 15).map((s) => ({ ...s, sekPerKwh: price(s.startMs) })),
  )
}
async function mixOf(sessionId: string): Promise<MixSlot[]> {
  return (await energyMixService.listForSessions([sessionId])).get(sessionId) ?? []
}
async function session(fromIso: string, toIso: string, kwh: number, opts: { intervals?: boolean } = {}) {
  const id = await insertSession({ startAt: new Date(fromIso), endAt: new Date(toIso), energyKwh: kwh })
  if (opts.intervals !== false) await insertInterval(id, new Date(fromIso), new Date(toIso), kwh)
  return id
}

// 2026-06-10: the car draws 1 kWh per bucket 08:00–10:00Z, half of the house's
// 1.1 kWh load from solar, half from the grid; Zaptec's interval starts at 07:00.
const sunny = (ms: number): Flows =>
  inRange(ms, '2026-06-10T08:00:00Z', '2026-06-10T10:00:00Z')
    ? { loadKwh: 1.1, solarKwh: 0.55, gridImportKwh: 0.55 }
    : BASE

test('with no house readings nothing is derived', async () => {
  const id = await session('2026-06-10T08:00:00Z', '2026-06-10T10:00:00Z', 10)
  const result = await derive('2026-06-10')
  expect(result).toMatchObject({ days: 0, sessions: 0 })
  expect(typeof result.deriveMs).toBe('number')
  expect(await mixOf(id)).toEqual([])
  expect(await houseEnergyService.getPoolDay('2026-06-10')).toBeNull()
})

test.each<[string, boolean]>([
  ['with Zaptec intervals', true],
  ['estimated (no intervals)', false],
])('a sunny midday session (%s) is half solar, shaped to the load jump', async (_, intervals) => {
  await storeDay('2026-06-10', sunny)
  await storePrices('2026-06-10')
  const id = await session('2026-06-10T07:00:00Z', '2026-06-10T10:00:00Z', 24, { intervals })
  const result = await derive('2026-06-10')
  expect(result).toMatchObject({ sessions: 1, days: 3 }) // 06-10 … 06-12 (today)
  const slots = await mixOf(id)
  expect(slots).toHaveLength(8)
  expect(slots[0].slotStart).toEqual(new Date('2026-06-10T08:00:00Z'))
  expect(total(slots, 'kwh')).toBeCloseTo(24, 9)
  expect(total(slots, 'gridKwh')).toBeCloseTo(12, 9)
  expect(total(slots, 'solarKwh')).toBeCloseTo(12, 9)
  expect(total(slots, 'noHouseDataKwh')).toBe(0)
})

// 2026-02-15: the battery charges from the grid 00:00–01:00 local at 0.2 SEK,
// then covers half of a 19:00–20:00Z session (the other half from the grid).
const NIGHT_CHARGE_END = stockholmDayBounds('2026-02-15').startMs + 3_600_000
const NIGHT_CHARGE: Flows = { loadKwh: 0.1, gridImportKwh: 0.6, batteryChargeGridKwh: 0.5 }
const BATTERY_HALF: Flows = { loadKwh: 0.6, gridImportKwh: 0.3, batteryDischargeKwh: 0.3 }
const nightThenSession =
  (sessionFrom: string, sessionTo: string) =>
  (ms: number): Flows => {
    if (ms < NIGHT_CHARGE_END) return NIGHT_CHARGE
    return inRange(ms, sessionFrom, sessionTo) ? BATTERY_HALF : BASE
  }

test('battery energy charged from the grid at night carries the night spot', async () => {
  await storeDay('2026-02-15', nightThenSession('2026-02-15T19:00:00Z', '2026-02-15T20:00:00Z'))
  await storePrices('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? 0.2 : 1))
  const id = await session('2026-02-15T19:00:00Z', '2026-02-15T20:00:00Z', 6)
  await derive('2026-02-15', '2026-02-15T22:00:00Z')
  const slots = await mixOf(id)
  expect(total(slots, 'kwh')).toBeCloseTo(6, 9)
  expect(total(slots, 'gridKwh')).toBeCloseTo(3, 9)
  expect(total(slots, 'batteryGridKwh')).toBeCloseTo(3, 9)
  for (const s of slots) expect(s.batteryGridSpotSek).toBeCloseTo(0.2, 9)
  // No SoC in these readings, so no cap: 6 kWh in, 3.6 out.
  const left = 6 - 3.6
  const checkpoint = await houseEnergyService.getPoolDay('2026-02-15')
  expect(checkpoint?.capacityKwh).toBe(BATTERY_CAPACITY_KWH)
  expect(checkpoint?.state.gridKwh).toBeCloseTo(left, 9)
  expect(checkpoint?.state.gridSpotSekSum).toBeCloseTo(left * 0.2, 9)
})

test('battery energy stored without a spot price is battery-unpriced', async () => {
  await storeDay('2026-02-15', nightThenSession('2026-02-15T19:00:00Z', '2026-02-15T20:00:00Z'))
  const id = await session('2026-02-15T19:00:00Z', '2026-02-15T20:00:00Z', 6)
  await derive('2026-02-15', '2026-02-15T22:00:00Z')
  const slots = await mixOf(id)
  expect(total(slots, 'batteryUnpricedKwh')).toBeCloseTo(3, 9)
  expect(total(slots, 'batteryGridKwh')).toBe(0)
  expect(total(slots, 'gridKwh')).toBeCloseTo(3, 9)
})

test('the pool follows the measured SoC: losses leave less energy at a higher cost', async () => {
  // The same night charge (6 kWh at 0.2 SEK), but the battery reports 10 %
  // all day: the pool is capped at 10 % of C and keeps the 1.2 SEK paid.
  await storeDay('2026-02-15', (ms) => ({
    ...(ms < NIGHT_CHARGE_END ? NIGHT_CHARGE : BASE),
    batterySocPct: 10,
  }))
  await storePrices('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? 0.2 : 1))
  await derive('2026-02-15', '2026-02-15T22:00:00Z')
  const checkpoint = await houseEnergyService.getPoolDay('2026-02-15')
  expect(checkpoint?.state.gridKwh).toBeCloseTo(0.1 * BATTERY_CAPACITY_KWH, 9)
  expect(checkpoint?.state.gridSpotSekSum).toBeCloseTo(1.2, 9)
})

test("resuming from the previous day's checkpoint gives the same mix as deriving both days", async () => {
  // Charged on the night of 02-15, used by a session on 02-16.
  await storeDay('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? NIGHT_CHARGE : BASE))
  await storeDay('2026-02-16', (ms) =>
    inRange(ms, '2026-02-16T19:00:00Z', '2026-02-16T20:00:00Z') ? BATTERY_HALF : BASE,
  )
  await storePrices('2026-02-15', (ms) => (ms < NIGHT_CHARGE_END ? 0.2 : 1))
  await storePrices('2026-02-16')
  const id = await session('2026-02-16T19:00:00Z', '2026-02-16T20:00:00Z', 6)
  await derive('2026-02-15', '2026-02-16T22:00:00Z')
  const full = await mixOf(id)
  await derive('2026-02-16', '2026-02-16T22:00:00Z')
  expect(await mixOf(id)).toEqual(full)
  expect(total(full, 'batteryGridKwh')).toBeCloseTo(3, 9)
})

test('a session spanning midnight widens the derive to its start day', async () => {
  const flows = (ms: number): Flows =>
    inRange(ms, '2026-06-10T21:00:00Z', '2026-06-10T23:00:00Z') ? { loadKwh: 0.3, gridImportKwh: 0.3 } : BASE
  await storeDay('2026-06-10', flows)
  await storeDay('2026-06-11', flows)
  // 23:00 local on 06-10 → 01:00 local on 06-11.
  const id = await session('2026-06-10T21:00:00Z', '2026-06-10T23:00:00Z', 4)
  const result = await derive('2026-06-11')
  expect(result.days).toBe(3) // 06-10 … 06-12
  const slots = await mixOf(id)
  expect(slots[0].slotStart).toEqual(new Date('2026-06-10T21:00:00Z'))
  expect(total(slots, 'kwh')).toBeCloseTo(4, 9)
  expect(total(slots, 'gridKwh')).toBeCloseTo(4, 9)
  expect(await houseEnergyService.getPoolDay('2026-06-10')).not.toBeNull()
})

test('without a checkpoint for the day before, it rebuilds from the first reading', async () => {
  for (const day of ['2026-06-08', '2026-06-09', '2026-06-10']) await storeDay(day, () => BASE)
  const result = await derive('2026-06-10')
  expect(result.days).toBe(5) // 06-08 … 06-12
  expect(await houseEnergyService.getPoolDay('2026-06-08')).not.toBeNull()
})

test('a checkpoint computed with another capacity is not resumed from', async () => {
  await storeDay('2026-06-09', () => BASE)
  await storeDay('2026-06-10', () => BASE)
  await houseEnergyService.replacePoolDaysFrom(
    '2026-06-09',
    [
      {
        day: '2026-06-09',
        state: { storedKwh: 5, gridKwh: 5, gridSpotSekSum: 5, solarKwh: 0, solarSpotSekSum: 0, unpricedKwh: 0 },
      },
    ],
    BATTERY_CAPACITY_KWH / 2,
  )
  await derive('2026-06-10')
  const rebuilt = await houseEnergyService.getPoolDay('2026-06-09')
  expect(rebuilt?.capacityKwh).toBe(BATTERY_CAPACITY_KWH)
  expect(rebuilt?.state.storedKwh).toBe(0)
})

test('a session after the last reading is all no-house-data', async () => {
  await storeDay('2026-06-10', () => BASE)
  await storePrices('2026-06-11')
  const id = await session('2026-06-11T10:00:00Z', '2026-06-11T11:00:00Z', 3)
  await derive('2026-06-10')
  const slots = await mixOf(id)
  expect(total(slots, 'noHouseDataKwh')).toBeCloseTo(3, 9)
  expect(total(slots, 'kwh')).toBeCloseTo(3, 9)
})

test('a voided session loses its mix on the next derive', async () => {
  await storeDay('2026-06-10', sunny)
  const id = await session('2026-06-10T07:00:00Z', '2026-06-10T10:00:00Z', 24)
  await derive('2026-06-10')
  expect(await mixOf(id)).not.toEqual([])
  await db.update(evChargeSession).set({ voided: true }).where(eq(evChargeSession.id, id))
  await derive('2026-06-10')
  expect(await mixOf(id)).toEqual([])
})

test('sessions ending before the derive window keep their rows', async () => {
  await storeDay('2026-06-09', () => BASE)
  await storeDay('2026-06-10', () => BASE)
  const early = await session('2026-06-09T10:00:00Z', '2026-06-09T11:00:00Z', 2)
  await derive('2026-06-09')
  const before = await mixOf(early)
  expect(before).not.toEqual([])
  await storeDay('2026-06-10', () => ({ loadKwh: 0.2, gridImportKwh: 0.2 }))
  await derive('2026-06-10')
  expect(await mixOf(early)).toEqual(before)
})

test('deriving twice gives the same rows', async () => {
  await storeDay('2026-06-10', sunny)
  await storePrices('2026-06-10')
  const id = await session('2026-06-10T07:00:00Z', '2026-06-10T10:00:00Z', 24)
  await derive('2026-06-10')
  const first = await mixOf(id)
  await derive('2026-06-10')
  expect(await mixOf(id)).toEqual(first)
})

test('a malformed day is refused', async () => {
  await expect(derive('2026-6-10')).rejects.toThrow(RangeError)
})
```

- [ ] **Step 2: Failing tests for `deriveAfterSync.ts`**

```ts
// src/lib/houseEnergy/deriveAfterSync.test.ts
import { expect, test, vi } from 'vitest'
import type { Logger } from '~/lib/logger'
import type { deriveFrom } from './derive'
import { deriveAfterSync } from './deriveAfterSync'

function fakeLog() {
  const warn = vi.fn()
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => log }
  return { log, warn }
}

test('no day: nothing derived, 0 ms', async () => {
  const derive = vi.fn<typeof deriveFrom>()
  const { log } = fakeLog()
  expect(await deriveAfterSync({ source: 'zaptec', fromDay: null, log, derive })).toBe(0)
  expect(derive).not.toHaveBeenCalled()
})

test("derives from the day with the run's logger and returns the time spent", async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => ({ days: 1, sessions: 1, deriveMs: 1 }))
  const { log } = fakeLog()
  const ms = await deriveAfterSync({ source: 'elpris', fromDay: '2026-09-28', log, derive })
  expect(derive).toHaveBeenCalledWith('2026-09-28', { log })
  expect(Number.isInteger(ms)).toBe(true)
})

test('a failing derive is a warning, never a throw', async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => {
    throw new Error('derive bug')
  })
  const { log, warn } = fakeLog()
  await expect(
    deriveAfterSync({ source: 'emaldo', fromDay: '2026-09-28', log, derive }),
  ).resolves.toBeTypeOf('number')
  expect(warn).toHaveBeenCalledWith('energy mix derive failed', {
    source: 'emaldo',
    fromDay: '2026-09-28',
    error: expect.any(Error),
  })
})

test('a derive past its budget is given up on with a warning', async () => {
  const derive = vi.fn<typeof deriveFrom>(() => new Promise(() => {}))
  const { log, warn } = fakeLog()
  const ms = await deriveAfterSync({ source: 'zaptec', fromDay: '2026-09-28', log, derive, budgetMs: 50 })
  expect(ms).toBeLessThan(5_000)
  expect(warn).toHaveBeenCalledWith('energy mix derive failed', expect.objectContaining({ source: 'zaptec' }))
})
```

- [ ] **Step 3: Run, expect FAIL**: `bunx vitest run src/lib/houseEnergy/derive.test.ts src/lib/houseEnergy/deriveAfterSync.test.ts`

- [ ] **Step 4: Implement `derive.ts`**

```ts
// Server-only. Derives the energy mix (ADR-0023, spec "Derivation" 5): from
// Stockholm `day` — widened back to the start day of any counted session
// overlapping it — runs the battery pool forward from the previous day's
// checkpoint to the last reading, then rewrites the mix rows of every counted
// session ending after the window's start and the pool checkpoints from it on.
// One transaction under the derive lock (energyMix.withDeriveLock): reads and
// writes alike, so a concurrent derive never writes older data over newer.
import { SlotIndex } from '~/lib/evCharging/cost'
import type { Logger } from '~/lib/logger'
import * as energyMixService from '~/lib/services/energyMix'
import type { DeriveTx, MixRow } from '~/lib/services/energyMix'
import * as evChargingService from '~/lib/services/evCharging'
import type { SessionEnergy } from '~/lib/services/evCharging'
import * as houseEnergyService from '~/lib/services/houseEnergy'
import type { HouseReading } from '~/lib/services/houseEnergy'
import * as spotPriceService from '~/lib/services/spotPrice'
import { SPOT_ZONE } from '~/lib/spotPrice/zones'
import { addDays, isStockholmDay, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'
import { type BucketHouse, deriveSessionMix } from './mix/carMix'
import { runHouseTimeline } from './mix/houseTimeline'
import { BATTERY_CAPACITY_KWH, emptyPool, type PoolState } from './mix/pool'
import { BASELINE_BUCKETS, BUCKET_MS, shapeSession } from './mix/shape'

/** Bound on widening the start back across chained sessions that span midnight. */
const MAX_WIDEN_STEPS = 10

export type DeriveResult = { days: number; sessions: number; deriveMs: number }

type DeriveStats = {
  fromDay: string | null
  days: number
  sessions: number
  rows: number
  readings: number
  readMs: number
  computeMs: number
  writeMs: number
}

/**
 * Re-derives the energy mix from Stockholm `day` (a RangeError for a malformed
 * one). With no house readings at all it does nothing. Logs one line with
 * counts and timings only — never readings or mix values.
 */
export async function deriveFrom(
  day: string,
  opts: { log: Logger; now?: () => Date },
): Promise<DeriveResult> {
  if (!isStockholmDay(day)) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  const started = performance.now()
  const now = (opts.now ?? (() => new Date()))()
  const stats = await energyMixService.withDeriveLock((tx) => deriveLocked(day, now, tx))
  const deriveMs = Math.round(performance.now() - started)
  if (stats.fromDay === null) {
    opts.log.debug('energy mix derive skipped: no house readings', { requestedDay: day })
  } else {
    opts.log.info('energy mix derived', { requestedDay: day, ...stats, deriveMs })
  }
  return { days: stats.days, sessions: stats.sessions, deriveMs }
}

async function deriveLocked(day: string, now: Date, tx: DeriveTx): Promise<DeriveStats> {
  const t0 = performance.now()
  const first = await houseEnergyService.firstReadingAt(tx)
  if (!first) {
    return { fromDay: null, days: 0, sessions: 0, rows: 0, readings: 0, readMs: 0, computeMs: 0, writeMs: 0 }
  }

  let fromDay = await widenToSessions(day, tx)
  let start: PoolState = emptyPool()
  const checkpoint = await houseEnergyService.getPoolDay(addDays(fromDay, -1), tx)
  if (checkpoint && checkpoint.capacityKwh === BATTERY_CAPACITY_KWH) {
    start = checkpoint.state
  } else if (first.getTime() < stockholmDayBounds(fromDay).startMs) {
    // History exists before `fromDay` but no usable checkpoint (none yet, or
    // computed with another C): rebuild from the first reading, empty pool.
    fromDay = await widenToSessions(stockholmDayOf(first.getTime()), tx)
  }

  const today = stockholmDayOf(now.getTime())
  const fromMs = stockholmDayBounds(fromDay).startMs
  const toMs = Math.max(fromMs, stockholmDayBounds(today).endMs)
  // From 30 min before the window: the shaping baseline of a session starting at its midnight.
  const readings = await houseEnergyService.listReadings(
    { from: new Date(fromMs - BASELINE_BUCKETS * BUCKET_MS), to: new Date(toMs) },
    tx,
  )
  const slots = new SlotIndex(
    await spotPriceService.listSlotsOverlapping(SPOT_ZONE, [{ startMs: fromMs, endMs: toMs }], tx),
  )
  const sessions = await evChargingService.listSessionEnergy({ endsAfter: new Date(fromMs) }, tx)
  const t1 = performance.now()

  const { days, house } = runHouseTimeline({
    readings,
    fromDay,
    throughDay: today,
    start,
    spotAt: (ms) => slots.between(ms, ms + 1)[0]?.sekPerKwh ?? null,
    capacityKwh: BATTERY_CAPACITY_KWH,
  })
  const rows = sessions.flatMap((s) => sessionRows(s, readings, house))
  const t2 = performance.now()

  await energyMixService.replaceForSessions(
    sessions.map((s) => s.sessionId),
    rows,
    tx,
  )
  await energyMixService.pruneUncounted(new Date(fromMs), tx)
  await houseEnergyService.replacePoolDaysFrom(fromDay, days, BATTERY_CAPACITY_KWH, tx)
  const t3 = performance.now()

  return {
    fromDay,
    days: days.length,
    sessions: sessions.length,
    rows: rows.length,
    readings: readings.length,
    readMs: Math.round(t1 - t0),
    computeMs: Math.round(t2 - t1),
    writeMs: Math.round(t3 - t2),
  }
}

/**
 * `day`, moved back to the start day of the earliest counted session that
 * ends after its midnight — repeatedly, since that session's own day may be
 * overlapped by an even earlier one. Every rewritten session then lies wholly
 * inside the window the pool runs over.
 */
async function widenToSessions(day: string, tx: DeriveTx): Promise<string> {
  let from = day
  for (let step = 0; step < MAX_WIDEN_STEPS; step++) {
    const fromMs = stockholmDayBounds(from).startMs
    const earliest = await evChargingService.earliestCountedStartEndingAfter(new Date(fromMs), tx)
    if (!earliest || earliest.getTime() >= fromMs) break
    from = stockholmDayOf(earliest.getTime())
  }
  return from
}

function sessionRows(
  s: SessionEnergy,
  readings: readonly HouseReading[],
  house: ReadonlyMap<number, BucketHouse>,
): MixRow[] {
  const startMs = s.startAt.getTime()
  const endMs = Math.max(startMs, ...s.stretches.map((x) => x.endMs))
  const window = between(readings, startMs - (BASELINE_BUCKETS + 1) * BUCKET_MS, endMs)
  const car = shapeSession({ startMs, stretches: s.stretches, readings: window })
  return deriveSessionMix(car, house).map((slot) => ({ ...slot, sessionId: s.sessionId }))
}

/** Readings with bucketStart in [fromMs, toMs); `readings` ascending (listReadings' order). */
function between(readings: readonly HouseReading[], fromMs: number, toMs: number): HouseReading[] {
  return readings.slice(lowerBound(readings, fromMs), lowerBound(readings, toMs))
}

function lowerBound(readings: readonly HouseReading[], ms: number): number {
  let lo = 0
  let hi = readings.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (readings[mid].bucketStart.getTime() < ms) lo = mid + 1
    else hi = mid
  }
  return lo
}
```

- [ ] **Step 5: Implement `deriveAfterSync.ts`**

```ts
// Server-only. The best-effort trigger the Emaldo, Zaptec and elpris syncs run
// at the end of `execute` (ADR-0023): re-derive from the earliest day the run
// stored or changed — even when the run then failed, since a stored change is
// never detected as new again. Health tracks the source, not the derive: a
// failure or a derive past its budget is a warning, never a failed run.
import type { IntegrationSource } from '~/lib/integrationHealth'
import { withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { deriveFrom } from './derive'

/**
 * How long a sync waits for its derive. Added to a run's 240 s deadline it
 * stays under Vercel's 300 s function limit. A derive given up on keeps
 * running; if the instance is frozen first, Postgres ends its idle transaction
 * after 60 s and the next trigger redoes the work.
 */
export const DERIVE_BUDGET_MS = 30_000

/** Returns the milliseconds spent (0 when `fromDay` is null). Never throws. */
export async function deriveAfterSync(a: {
  source: IntegrationSource
  fromDay: string | null
  log: Logger
  derive?: typeof deriveFrom
  budgetMs?: number
}): Promise<number> {
  if (a.fromDay === null) return 0
  const started = performance.now()
  try {
    await withDeadline(
      (a.derive ?? deriveFrom)(a.fromDay, { log: a.log }),
      AbortSignal.timeout(a.budgetMs ?? DERIVE_BUDGET_MS),
      () => new Error('energy mix derive did not finish within its budget'),
    )
  } catch (error) {
    a.log.warn('energy mix derive failed', { source: a.source, fromDay: a.fromDay, error })
  }
  return Math.round(performance.now() - started)
}
```

- [ ] **Step 6: Run, expect PASS**:
  `bunx vitest run src/lib/houseEnergy/derive.test.ts src/lib/houseEnergy/deriveAfterSync.test.ts && bun run typecheck`
  (a derive test that hangs means a service call inside the derive ignored its `tx`; see Global Constraints).
- [ ] **Step 7: Commit** `feat(charging): derive each session's energy mix from a day`

---

### Task 8: Re-derive after each sync (Zaptec, elpris, Emaldo) + `syncNow` timings

**Files:**
- Modify: `src/lib/evCharging/sync.ts` (+ `sync.test.ts`)
- Modify: `src/lib/spotPrice/sync.ts` (+ `sync.test.ts`)
- Modify: `src/lib/houseEnergy/sync.ts`; Create: `src/lib/houseEnergy/syncDerive.test.ts`
- Modify: `src/lib/orpc/procedures/evCharging.ts` (`syncNow` timings only)

**Interfaces:**
- Consumes: `deriveAfterSync`, `deriveFrom` (Task 7); `ImportSessionsResult.earliestChangedStartAt` (Task 6);
  `EmaldoSyncRun.earliestReplacedDay` (step 2).
- Produces: `SyncRun.deriveFromDay`, `SyncRun.deriveMs`, `ElprisSyncRun.deriveFromDay`, `ElprisSyncRun.deriveMs`,
  `EmaldoSyncRun.deriveMs`; run-history `timings.deriveMs` for all three; request timings `zaptecDeriveMs`,
  `elprisDeriveMs`, `emaldoDeriveMs`.

**Reviewers:** A = `code-reviewer`; B = `test-completeness`. (The procedure edit only adds timing keys; no permission
boundary changes, so no security reviewer.)

- [ ] **Step 1: Failing tests, Zaptec** (append to `src/lib/evCharging/sync.test.ts`; add
  `import type { deriveFrom } from '~/lib/houseEnergy/derive'`):

```ts
const deriveSpy = () => vi.fn<typeof deriveFrom>(async () => ({ days: 1, sessions: 1, deriveMs: 1 }))

test("new sessions re-derive the energy mix from the earliest one's start day", async () => {
  const derive = deriveSpy()
  const { client } = fakeZaptec([
    session('s1', new Date('2026-09-18T12:00:00Z')),
    // Starts 2026-09-14T23:00Z = 2026-09-15 01:00 local.
    session('s2', new Date('2026-09-15T01:00:00Z')),
  ])
  const { log, runLines } = capturingLogger()
  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deps: { zaptec: client, log, deriveFrom: derive },
  })
  expect(run.outcome).toBe('ok')
  expect(run.deriveFromDay).toBe('2026-09-15')
  expect(derive).toHaveBeenCalledTimes(1)
  expect(derive).toHaveBeenCalledWith('2026-09-15', { log })
  expect(runLines()[0]).toMatchObject({ deriveFromDay: '2026-09-15', deriveMs: expect.any(Number) })
})

test('an unchanged re-import does not re-derive', async () => {
  const derive = deriveSpy()
  const { client } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, deriveFrom: derive } })
  const second = await runZaptecSync({
    trigger: 'cron',
    now: () => new Date(T1.getTime() + HOUR),
    deps: { zaptec: client, deriveFrom: derive },
  })
  expect(second.deriveFromDay).toBeNull()
  expect(second.deriveMs).toBe(0)
  expect(derive).toHaveBeenCalledTimes(1)
})

test('a changed session re-derives from its start day', async () => {
  const derive = deriveSpy()
  const end = new Date(T1.getTime() - DAY)
  const { client, state } = fakeZaptec([session('s1', end)])
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, deriveFrom: derive } })
  state.sessions = [session('s1', end, { energyKwh: 5 })]
  const second = await runZaptecSync({
    trigger: 'cron',
    now: () => new Date(T1.getTime() + HOUR),
    deps: { zaptec: client, deriveFrom: derive },
  })
  expect(second.deriveFromDay).toBe('2026-09-19')
  expect(derive).toHaveBeenLastCalledWith('2026-09-19', expect.anything())
})

test('sessions imported before a failure are still derived, and the run still fails', async () => {
  const derive = deriveSpy()
  const { client, state } = fakeZaptec([
    session('s1', new Date('2026-09-10T12:00:00Z')),
    session('s2', new Date('2026-09-11T12:00:00Z')),
    session('s3', new Date('2026-09-12T12:00:00Z')),
  ])
  state.failOnPage = 2
  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deps: { zaptec: client, deriveFrom: derive },
  })
  expect(run.outcome).toBe('failed')
  expect(derive).toHaveBeenCalledWith('2026-09-10', expect.anything())
})

test('a failed derive is a warning and the run stays ok', async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => {
    throw new Error('derive bug')
  })
  const { client } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  const { log, entries } = capturingLogger()
  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deps: { zaptec: client, log, deriveFrom: derive },
  })
  expect(run.outcome).toBe('ok')
  expect(entries().find((e) => e.msg === 'energy mix derive failed')).toMatchObject({
    level: WARN,
    source: 'zaptec',
  })
})

test('the run row records an integer deriveMs timing', async () => {
  const { client } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, deriveFrom: deriveSpy() } })
  const [row] = await db.select({ timings: integrationSyncRun.timings }).from(integrationSyncRun)
  expect(Number.isInteger(row.timings.deriveMs)).toBe(true)
})
```

(`session('s1', end)` starts at `end − 2 h` = 2026-09-19T08:00Z, i.e. Stockholm day `2026-09-19`.)

- [ ] **Step 2: Failing tests, elpris** (append to `src/lib/spotPrice/sync.test.ts`; add
  `import type { deriveFrom } from '~/lib/houseEnergy/derive'`):

```ts
const deriveSpy = () => vi.fn<typeof deriveFrom>(async () => ({ days: 1, sessions: 0, deriveMs: 1 }))

test('newly filled days re-derive the energy mix from the earliest of them', async () => {
  const derive = deriveSpy()
  const { client } = fakeElpris({ publishedThrough: TOMORROW })
  const result = await run(client, { deriveFrom: derive })
  expect(result.deriveFromDay).toBe(TODAY)
  expect(derive).toHaveBeenCalledWith(TODAY, expect.anything())
})

test('a run that fills nothing does not re-derive', async () => {
  const { client } = fakeElpris({ publishedThrough: TOMORROW })
  await run(client, { deriveFrom: deriveSpy() })
  const derive = deriveSpy()
  const second = await run(client, { deriveFrom: derive })
  expect(second.deriveFromDay).toBeNull()
  expect(derive).not.toHaveBeenCalled()
})

test('days stored before the run fails are still derived', async () => {
  await insertSession(new Date('2026-09-25T10:00:00Z'))
  const derive = deriveSpy()
  const { client } = fakeElpris({ missing: ['2026-09-27'] }) // yesterday missing → the run fails
  const result = await run(client, { deriveFrom: derive })
  expect(result.outcome).toBe('failed')
  expect(derive).toHaveBeenCalledWith('2026-09-25', expect.anything())
})

test('a failed derive never fails the elpris run', async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => {
    throw new Error('derive bug')
  })
  const { client } = fakeElpris({ publishedThrough: TOMORROW })
  const result = await run(client, { deriveFrom: derive })
  expect(result.outcome).toBe('ok')
  expect(typeof result.deriveMs).toBe('number')
})
```

- [ ] **Step 3: Failing tests, Emaldo** (new file; the fake is local so it can't collide with step 2's helpers):

```ts
// src/lib/houseEnergy/syncDerive.test.ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { queue } from '~/lib/effects'
import { type EmaldoClient, EmaldoError } from '~/lib/effects/emaldo'
import { createServerLogger } from '~/lib/logger/server'
import { addDays, stockholmDayBounds } from '~/lib/time/stockholm'
import { syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import type { deriveFrom } from './derive'
import { runEmaldoSync } from './sync'

setupDatabase()

const NOW = new Date('2026-09-28T12:00:00Z')
const TODAY = '2026-09-28'
const log = createServerLogger({ write: () => true })

/** Synthetic Emaldo: whole days (today up to NOW); throws on call `failOnCall` (1-based) or later. */
function fakeEmaldo(opts: { failOnCall?: number } = {}): EmaldoClient {
  let calls = 0
  return {
    async fetchDay(offset) {
      calls++
      if (opts.failOnCall !== undefined && calls >= opts.failOnCall) {
        throw new EmaldoError('unreachable', 'stats', 503)
      }
      const day = addDays(TODAY, offset)
      const { startMs, endMs } = stockholmDayBounds(day)
      return {
        dayStart: new Date(startMs),
        dayEnd: new Date(endMs),
        buckets: syntheticDay(day, () => ({ loadKwh: 0.1, gridImportKwh: 0.1 })).filter(
          (b) => b.bucketStart.getTime() < NOW.getTime(),
        ),
        droppedBuckets: 0,
      }
    },
  }
}
const deriveSpy = () => vi.fn<typeof deriveFrom>(async () => ({ days: 1, sessions: 0, deriveMs: 1 }))
const run = (client: EmaldoClient, derive: typeof deriveFrom) =>
  runEmaldoSync({
    trigger: 'cron',
    now: () => NOW,
    deps: { emaldo: client, log, sleep: async () => {}, deriveFrom: derive },
  })

beforeEach(() => {
  vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

test('a successful run re-derives from its earliest replaced day', async () => {
  const derive = deriveSpy()
  const result = await run(fakeEmaldo(), derive)
  expect(result.outcome).toBe('ok')
  expect(result.earliestReplacedDay).not.toBeNull()
  expect(derive).toHaveBeenCalledTimes(1)
  expect(derive).toHaveBeenCalledWith(result.earliestReplacedDay, { log })
  expect(typeof result.deriveMs).toBe('number')
})

test('days stored before a failure are still derived', async () => {
  const derive = deriveSpy()
  const result = await run(fakeEmaldo({ failOnCall: 2 }), derive)
  expect(result.outcome).toBe('failed')
  expect(result.earliestReplacedDay).not.toBeNull()
  expect(derive).toHaveBeenCalledWith(result.earliestReplacedDay, { log })
})

test('a run that stored nothing does not re-derive', async () => {
  const derive = deriveSpy()
  const result = await run(fakeEmaldo({ failOnCall: 1 }), derive)
  expect(result.outcome).toBe('failed')
  expect(derive).not.toHaveBeenCalled()
  expect(result.deriveMs).toBe(0)
})

test('a failed derive never fails the Emaldo run', async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => {
    throw new Error('derive bug')
  })
  expect((await run(fakeEmaldo(), derive)).outcome).toBe('ok')
})
```

- [ ] **Step 4: Run, expect FAIL**:
  `bunx vitest run src/lib/evCharging/sync.test.ts src/lib/spotPrice/sync.test.ts src/lib/houseEnergy/syncDerive.test.ts`

- [ ] **Step 5: Implement, Zaptec** (`src/lib/evCharging/sync.ts`):

Imports: `import type { deriveFrom } from '~/lib/houseEnergy/derive'`,
`import { deriveAfterSync } from '~/lib/houseEnergy/deriveAfterSync'`,
`import { stockholmDayOf } from '~/lib/time/stockholm'`.

`SyncRun` gains:

```ts
  /**
   * Stockholm day of the earliest session start this run added or changed
   * (old or new start) — where the energy-mix re-derive starts; null if none.
   */
  deriveFromDay: string | null
  /** Time spent re-deriving the energy mix (ADR-0023); 0 when nothing changed. */
  deriveMs: number
```

`opts.deps` type becomes `{ zaptec?: ZaptecClient; log?: Logger; deriveFrom?: typeof deriveFrom }`; `init` adds
`deriveFromDay: null, deriveMs: 0`; `execute` becomes:

```ts
    execute: async ({ run, signal, now, log }) => {
      try {
        await fetchAndImport(client, run, stats, signal, now)
        // Attribution follows the import (ADR-0021). … (the existing re-match
        // block, unchanged, from `const started = performance.now()` through its
        // `finally { run.reattributeMs = … }`)
      } finally {
        // ADR-0023: re-derive the energy mix from the earliest session this run
        // added or changed — also when the import failed part-way: a stored
        // change is never detected as changed again. Best effort, own budget.
        run.deriveMs = await deriveAfterSync({
          source: SOURCE,
          fromDay: run.deriveFromDay,
          log,
          derive: opts.deps?.deriveFrom,
        })
      }
    },
```

In `importWindow`, after `run.skipped += result.skipped`:

```ts
      if (result.earliestChangedStartAt) {
        const day = stockholmDayOf(result.earliestChangedStartAt.getTime())
        if (run.deriveFromDay === null || day < run.deriveFromDay) run.deriveFromDay = day
      }
```

`logFields` adds `deriveFromDay: run.deriveFromDay, deriveMs: run.deriveMs`; `runStats`'s `timings` adds
`deriveMs: run.deriveMs`.

- [ ] **Step 6: Implement, elpris** (`src/lib/spotPrice/sync.ts`): same imports (minus `stockholmDayOf`, already
  imported). `ElprisSyncRun` gains:

```ts
  /** Earliest day this run stored (each was missing before) — where the energy-mix re-derive starts. */
  deriveFromDay: string | null
  /** Time spent re-deriving the energy mix (ADR-0023). */
  deriveMs: number
```

`deps` gains `deriveFrom?: typeof deriveFrom`; `init` adds `deriveFromDay: null, deriveMs: 0`; `execute` becomes:

```ts
    execute: async ({ run, signal, now, log }) => {
      try {
        await fetchMissingDays(client, run, stats, { signal, now, sleep, log })
      } finally {
        // ADR-0023: prices change the pool's value and the mix's battery spots
        // from the earliest newly filled day on — also when the run then fails:
        // a stored day is never "missing" again, so it would not re-trigger.
        run.deriveMs = await deriveAfterSync({
          source: 'elpris',
          fromDay: run.deriveFromDay,
          log,
          derive: opts.deps?.deriveFrom,
        })
      }
    },
```

In `fetchMissingDays`, after `run.upserted += written`:

```ts
    if (run.deriveFromDay === null || day < run.deriveFromDay) run.deriveFromDay = day
```

`toRunStats`'s `timings` adds `deriveMs: run.deriveMs`; `logFields` adds `deriveFromDay` and `deriveMs`.

- [ ] **Step 7: Implement, Emaldo** (`src/lib/houseEnergy/sync.ts`, step 2's file): import `type deriveFrom` from
  `./derive` and `deriveAfterSync` from `./deriveAfterSync`. Add `/** Time spent re-deriving the energy mix (ADR-0023). */
  deriveMs: number` to `EmaldoSyncRun`, `deriveMs: 0` to `init`, `deriveFrom?: typeof deriveFrom` to `deps`, and
  `deriveMs` to `logFields` and to `toRunStats`'s `timings`. Step 2's `execute` is a single
  `syncDays(client, run, stats, { signal, now, sleep, log })` call; wrap it like the others:

```ts
    execute: async ({ run, signal, now, log }) => {
      try {
        await syncDays(client, run, stats, { signal, now, sleep, log })
      } finally {
        // ADR-0023: new readings change the house mix and the pool from the
        // earliest replaced day on — also when the run then fails part-way.
        run.deriveMs = await deriveAfterSync({
          source: 'emaldo',
          fromDay: run.earliestReplacedDay,
          log,
          derive: opts.deps?.deriveFrom,
        })
      }
    },
```

If Task 0 step 4 found `earliestReplacedDay` set only at the end, move that assignment next to each day's store here
(same min-day rule as elpris).

- [ ] **Step 8: `syncNow` timings** (`src/lib/orpc/procedures/evCharging.ts`): in each branch's
  `if (context.timings)` block add `context.timings.zaptecDeriveMs = run.deriveMs`,
  `context.timings.elprisDeriveMs = run.deriveMs` and (in step 2's Emaldo branch)
  `context.timings.emaldoDeriveMs = run.deriveMs`.

- [ ] **Step 9: Run, expect PASS**:
  `bunx vitest run src/lib/evCharging src/lib/spotPrice src/lib/houseEnergy src/lib/integrations && bun run typecheck`
  (the full suites: existing sync tests now run the real derive at the end of each run; it finds no readings and
  returns quickly).
- [ ] **Step 10: Commit** `feat(charging): re-derive the energy mix after each sync`

---

### Task 9: One-off re-derive script

**Files:**
- Create: `scripts/deriveEnergyMix.ts`

**Interfaces:** Consumes `deriveFrom`, `BATTERY_CAPACITY_KWH`, `firstReadingAt`, `measureBatteryCapacity`.

**Reviewers:** A = `code-reviewer`; B = `migration-guard` (it audits the `vercel env pull` / prod-`DATABASE_URL`
hazard this script must not fall into).

- [ ] **Step 1: Write the script**

```ts
// One-off re-derive of the energy mix and battery pool (ADR-0023): after a
// derive fix, or at roadmap checkpoint 3. Runs deriveFrom(day) once, from
// --from or (default) the first house reading's Stockholm day, i.e. all of
// history. Idempotent: a derive rewrites everything it covers.
//
//   read -rs DATABASE_URL && DATABASE_URL="$DATABASE_URL" \
//     bun --no-env-file scripts/deriveEnergyMix.ts [--from YYYY-MM-DD] [--yes]
//
// The target is always given explicitly, never read from env files:
// --no-env-file stops Bun auto-loading .env/.env.local, and `vercel env pull`
// leaves production's DATABASE_URL in .env.local (CLAUDE.md → Gotchas).
// Without --yes it only prints the target, the first reading and the measured
// battery capacity C; it writes nothing.
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: { from: { type: 'string' }, yes: { type: 'boolean', default: false } },
})
const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL on the command line (see the header comment).')
  process.exit(1)
}
const target = new URL(url)
console.log(`Target database: ${target.hostname}:${target.port || '5432'}${target.pathname}`)

// Imported only now: ~/lib/db reads DATABASE_URL when it loads.
const { deriveFrom } = await import('~/lib/houseEnergy/derive')
const { BATTERY_CAPACITY_KWH } = await import('~/lib/houseEnergy/mix/pool')
const { logger } = await import('~/lib/logger/server')
const houseEnergyService = await import('~/lib/services/houseEnergy')
const { isStockholmDay, stockholmDayOf } = await import('~/lib/time/stockholm')

const first = await houseEnergyService.firstReadingAt()
if (!first) {
  console.log('No house readings stored: nothing to derive.')
  process.exit(0)
}
console.log(`First reading: ${first.toISOString()} (Stockholm day ${stockholmDayOf(first.getTime())})`)
const measured = await houseEnergyService.measureBatteryCapacity()
if (measured) {
  console.log(
    `Measured battery capacity: ${measured.capacityKwh.toFixed(2)} kWh per 100 % SoC over ${measured.pairs} pairs ` +
      `(${measured.from.toISOString()} → ${measured.to.toISOString()}); code uses ${BATTERY_CAPACITY_KWH}`,
  )
}

const from = values.from ?? stockholmDayOf(first.getTime())
if (!isStockholmDay(from)) {
  console.error(`--from must be a YYYY-MM-DD day, got ${from}`)
  process.exit(1)
}
if (!values.yes) {
  console.log(`Dry run. Re-run with --yes to derive from ${from}.`)
  process.exit(0)
}
const result = await deriveFrom(from, { log: logger })
console.log(
  `Derived from ${from}: ${result.days} pool days, ${result.sessions} sessions, ${result.deriveMs} ms.`,
)
process.exit(0)
```

- [ ] **Step 2: Smoke-test locally** (local DB only):

```bash
DATABASE_URL=postgres://videbacken:videbacken@localhost:14620/videbacken bun --no-env-file scripts/deriveEnergyMix.ts
bun --no-env-file scripts/deriveEnergyMix.ts; echo "exit $?"
```

Expected: the first prints `Target database: localhost:14620/videbacken` and then either "No house readings stored"
or the measured capacity and "Dry run…". The second prints the "Set DATABASE_URL" error and `exit 1`.

- [ ] **Step 2b: Local full rebuild, timed.** The local dev DB holds the whole real history (step 2b's live
  re-fetch), so this is the prod-sized first derive. Run it with `--yes` against the **local** URL above and note
  the printed `ms`, plus the `energy mix derived` log line's `readMs`/`computeMs`/`writeMs`. It must finish well
  inside `DERIVE_BUDGET_MS` (30 s) and the 25 s `statement_timeout`, because prod's first triggered derive rebuilds
  all history the same way. If it doesn't, stop and fix it before the PR. Then run the probe comparison from Task 14
  step 4 against the local DB (local spot prices start 2026-06-03, so earlier sessions show battery-unpriced energy)
  and put only the aggregate verdict in the PR, never the numbers per session.

- [ ] **Step 3:** `bun run typecheck && bun run check:ci` → PASS.
- [ ] **Step 4: Commit** `feat(charging): add a one-off energy mix re-derive script`

---

### Task 10: Docs: spec amendments, CLAUDE.md

**Files:** Modify: `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md`, `CLAUDE.md`,
`docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md` (Log only).

**Reviewers:** A = `code-reviewer` (ADR/spec consistency with the code); B = `test-completeness` (every amended
rule has a test that names it).

- [ ] **Step 1: Spec.** Under "Derivation (roadmap step 3)" append:

```markdown
**Amendments (step 3 build, 2026-10).**
- Shaping: the baseline needs at least 3 of the 6 pre-session buckets. A zero-length stretch lands in its start
  bucket. A bucket's cap is its load minus car energy an earlier interval already put there. Excess no headroom can
  take spreads by overlap (the load is exceeded, the kWh kept).
- Pool: within one bucket the inflow joins before the outflow leaves, then the SoC cap applies; below 1e-9 kWh the
  pool resets to empty.
- SoC alignment (settled from the full history, 2026-10-04): a row's SoC is the battery's state at its bucket's
  **middle**. The cap after bucket i uses the mean of row i's and row i+1's SoC, only when both exist and row i+1 is
  the very next bucket. `C` = 7.58 kWh per 100 % (all history; ≈ 6.2 in Jan–Feb, 7.5–8.1 from March).
- Losses raise the cost of what is left: on the history, battery energy's average cost is ≈ 1.8× its inflow spot in
  Jan–Feb (median) and ≈ 1.01–1.14× from March. So a mix row's battery spot isn't a market price, and its CHECK is
  a wide ±1000 SEK/kWh sanity bound.
- `battery_pool_day` stores the `C` each checkpoint was computed with (`capacity_kwh`, and `derived_at`). A derive
  never resumes from a checkpoint with another `C`, nor without a checkpoint while earlier readings exist: it
  rebuilds from the first reading. So the first derive in prod, and any change of `C`, rebuilds history at the next
  trigger. Checkpoints are written through today, carrying the state over days without readings.
- Each derive runs in one transaction holding a transaction-scoped advisory lock, reads included, so a concurrent
  derive never writes older data over newer.
- Triggers fire on whatever a sync stored, **even if the run then fails**: a stored change is never detected as new
  again. A derive is best effort, with its own 30 s budget, and never changes a run's outcome.
- With no house readings at all, nothing is derived (sessions keep no mix rows and stay all-grid).
- A session's Σ mix `kwh` equals Σ of its stretches (its Zaptec intervals, or `energyKwh` when estimated).
- A one-off full re-derive: `scripts/deriveEnergyMix.ts` (`bun --no-env-file`, explicit `DATABASE_URL`).
```

In "Data model" → `battery_pool_day`, replace "Each row stores the capacity constant…" with "`capacity_kwh` (the `C` the row was computed with) and `derived_at`"; in `house_energy_reading`, replace "Whether it is the bucket's start or end state is settled from data in step 3" with "It is the state at the bucket's middle (settled in step 3)"; in "Derivation" 3 (SoC anchor), replace "that bucket's own row or the next one: whether … settled from data in step 3" with "the mean of that bucket's row and the next one, as the SoC is mid-bucket" and give `C`'s measured value; in `ev_charge_energy_mix` add
"CHECK: `slot_start` on a UTC quarter-hour; each battery spot set exactly when its kWh > 0".

- [ ] **Step 2: CLAUDE.md** (code map):
  - `services/` line: add `energyMix` to the list.
  - The `houseEnergy/` line (from step 2): append `; energy-mix derivation (ADR-0023): pure client-safe mix/ (supply,
    shape, pool, carMix, houseTimeline), derive.ts (deriveFrom: one locked transaction) + deriveAfterSync.ts (best-effort
    trigger after the Emaldo, Zaptec and elpris syncs)`.
  - `scripts/` line: add `deriveEnergyMix.ts (one-off energy-mix re-derive; bun --no-env-file + explicit DATABASE_URL)`.
  - Gotchas, first bullet: append "One-off scripts against prod (`scripts/deriveEnergyMix.ts`) run with
    `bun --no-env-file` and an inline `DATABASE_URL`, never from env files."
  - If the ADR index has no 0023 row (step 1/2 may have added it), add
    `| Solar-aware charging cost (Emaldo readings, energy mix, battery pool) | **0023** |`.
- [ ] **Step 3: Roadmap Log**: `- 2026-10-xx: step 3 built; derivation amendments recorded in the spec (SoC is
  mid-bucket, C = 7.58 stored per checkpoint, triggers on partial runs, locked derive).` Under "Owner prerequisites",
  mark the pooler-URI item as optional: the first derive in prod rebuilds history on its own.
- [ ] **Step 4: Commit** `docs(charging): record the energy mix derivation details`

---

### Task 11: Branch review (feature-workflow Phase 5)

- [ ] **Step 1: Gates that apply.** Dispatch in parallel, each told to assume the branch is wrong:
  - `migration-guard` **and** the schema-design reviewer (`general-purpose` + `supabase-postgres-best-practices`)
    over `drizzle/` and `src/lib/db/schema/houseEnergy.ts`. This is a Non-negotiable: every finding fixed or
    explicitly ruled on. A fix to a pushed migration is a **new** migration.
  - `test-completeness` over `src/lib/services/{energyMix,houseEnergy,evCharging,spotPrice}` and
    `src/lib/houseEnergy/**`.
  - `code-reviewer` (ADR-0001/0002/0003/0019/0020/0023 adherence) over the whole diff.
  - A general correctness pass: `/code-review high` on the branch diff. Ask it specifically about Review Focus 1–5 and
    the lock and timeout settings in `withDeriveLock`.
  - No auth, session, file-access or permission-boundary change → no security pass (state this in the PR).
- [ ] **Step 2:** Fix every confirmed finding in this branch, one commit per concern
  (`fix(charging): …`). Rerun the affected tests.

---

### Task 12: Pre-PR gate (feature-workflow "Pre-PR gate")

- [ ] Run, paste the outputs into the PR's Verification section:

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```

- [ ] No UI changed in this step → no browser/responsive check (the client-safe browser test runs in `bun run test`).
- [ ] Local end-to-end smoke (optional, needs real Emaldo creds in `.env`; skip otherwise): `bun run dev`, then as
  admin "Synka nu" on `/charging`. The dev log shows `integration sync run` for emaldo with `deriveMs`, then one
  `energy mix derived` line (counts only).

---

### Task 13: Roadmap row + PR

- [ ] **Step 1:** In the roadmap Status table, row 3: PR `#NN` link, status `PR open`. Commit
  `docs(charging): mark the energy mix step as in review`.
- [ ] **Step 2:** Push and open the PR with `.github/PULL_REQUEST_TEMPLATE.md`, base `main`, title
  **`feat(charging): derive each session's grid, solar and battery mix`**. Body:
  - **Why:** ADR-0023 step 3: store each session's supply mix (money-free) so step 4 can price the real cash cost.
  - **What changed:** two tables (mix, pool checkpoints), pure mix modules, `deriveFrom` under an advisory xact lock,
    triggers after the three syncs, a one-off script. Nothing user-visible.
  - **Verification:** the gate outputs.
  - **Risks / follow-ups:** `C` (7.58) is measured on the local copy of the history; checkpoint 3 re-measures it
    on prod. Winter battery energy costs ≈ 1.8× its purchase spot (losses, decision 7): step 4 shows that in
    kronor. The first derive in prod rebuilds all history (no checkpoint yet) within the 30 s budget, timed locally
    in Task 9. Triggers now fire on partial runs. Step 4 must compare Σ mix with Σ stretches.
  - End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 3:** Wait for `CI Success` and the PR-title check; fix anything red. Squash-merge only when the owner
  says so; afterwards set the row to `merged`.

---

### Task 14: STOP: checkpoint 3 is the owner's, in a later session

Do **not** start step 4. Stop after the PR is open (or merged). The roadmap's checkpoint 3 (prod) runs once this is
merged and deployed. Record its result in the roadmap (a small `docs(charging): …` PR, or step 4's PR if the owner
says so). The checkpoint:

1. **The derive ran in prod and rebuilt history.** After the deploy and the next hourly Emaldo run (`:45`), the first
   derive finds no checkpoint and rebuilds from the first reading. Read-only SQL (Supabase MCP `execute_sql` or the
   SQL editor):

   ```sql
   SELECT count(*) AS pool_days, min(day) AS first_day, max(day) AS last_day,
          min(derived_at) AS oldest_write, array_agg(DISTINCT capacity_kwh) AS capacities
   FROM battery_pool_day;
   SELECT count(DISTINCT session_id) AS sessions_with_mix FROM ev_charge_energy_mix;
   ```

   Expected: pool days from the first reading's day through today, one capacity (7.58), and every counted session
   since the first reading has mix rows. Check the Vercel runtime log's `energy mix derived` line for its `deriveMs`
   (no `energy mix derive failed` warning).

2. **Fallback only: the script.** If the derive failed or `sessions_with_mix` falls short, re-run it once with
   `scripts/deriveEnergyMix.ts` using the Supabase **transaction pooler** URI (Supabase dashboard → Connect →
   Transaction pooler), pasted into the hidden prompt, never into a file, never via `vercel env pull`:

   ```bash
   read -rs DATABASE_URL && DATABASE_URL="$DATABASE_URL" bun --no-env-file scripts/deriveEnergyMix.ts
   read -rs DATABASE_URL && DATABASE_URL="$DATABASE_URL" bun --no-env-file scripts/deriveEnergyMix.ts --yes
   ```

   The first (dry) run prints the target host. Check that it's the prod pooler before running `--yes`.

3. **`C` and the cap on prod.** Re-measure `C` (the script's dry run prints the same number):

   ```sql
   WITH x AS (
     SELECT bucket_start,
       battery_charge_solar_kwh + battery_charge_grid_kwh + battery_charge_ac_kwh AS charged,
       battery_discharge_kwh AS discharged, battery_soc_pct AS soc,
       lead(bucket_start) OVER w AS next_start,
       lead(battery_charge_solar_kwh + battery_charge_grid_kwh + battery_charge_ac_kwh) OVER w AS next_charged,
       lead(battery_discharge_kwh) OVER w AS next_discharged,
       lead(battery_soc_pct) OVER w AS next_soc
     FROM house_energy_reading WINDOW w AS (ORDER BY bucket_start))
   SELECT round((sum((discharged + next_discharged) / 2) / (sum(soc - next_soc) / 100))::numeric, 2) AS c_kwh,
          count(*) AS pairs
   FROM x
   WHERE next_start = bucket_start + interval '5 minutes' AND charged = 0 AND next_charged = 0
     AND discharged > 0 AND next_discharged > 0 AND soc IS NOT NULL AND next_soc IS NOT NULL;
   ```

   Expected ≈ 7.58 (plausible 7–9). If it differs by more than ≈ 0.1, a small PR
   `fix(charging): set the battery capacity measured on prod` sets `BATTERY_CAPACITY_KWH` and its comment; after it
   deploys, the next derive rebuilds all history by itself (every checkpoint's `capacity_kwh` differs). Then the
   pool stays at or under the measured SoC at each day's end (half a bucket's tolerance, since the last bucket's
   cap uses the next day's first SoC):

   ```sql
   SELECT p.day, round(p.stored_kwh::numeric, 2) AS pool_kwh,
          round((p.capacity_kwh * r.battery_soc_pct / 100)::numeric, 2) AS soc_kwh
   FROM battery_pool_day p
   CROSS JOIN LATERAL (
     SELECT battery_soc_pct FROM house_energy_reading
     WHERE bucket_start < ((p.day + 1)::timestamp AT TIME ZONE 'Europe/Stockholm')
     ORDER BY bucket_start DESC LIMIT 1
   ) r
   WHERE p.stored_kwh > p.capacity_kwh * r.battery_soc_pct / 100 + 0.3
   ORDER BY p.day;
   ```

   Expected: no rows.

4. **Compare with the probe.** Fill the `VALUES` list with the start ("Session (local)") of each of the seven sessions
   in `/Users/lukas/prog/videbacken/data/private/emaldo/PROBE-NOTES.md` (local file, not in git; year 2026). Never
   paste the results into the repo:

   ```sql
   WITH probe(local_start) AS (
     VALUES ('2026-MM-DD HH:MI'::timestamp) -- one row per probe session, from PROBE-NOTES.md
   ),
   s AS (
     SELECT p.local_start, e.id
     FROM probe p
     JOIN ev_charge_session e
       ON (e.start_at AT TIME ZONE 'Europe/Stockholm')
          BETWEEN p.local_start - interval '2 minutes' AND p.local_start + interval '2 minutes'
     WHERE NOT e.voided AND e.replaced_by_zaptec_session_id IS NULL
   )
   SELECT s.local_start,
          round(sum(m.kwh)::numeric, 1) AS kwh,
          round(100 * sum(m.grid_kwh) / nullif(sum(m.kwh), 0)) AS grid_pct,
          round(100 * (sum(m.grid_kwh) + sum(m.battery_grid_kwh) + sum(m.battery_unpriced_kwh)
                + sum(m.no_house_data_kwh)) / nullif(sum(m.kwh), 0)) AS grid_origin_pct,
          round(sum(m.solar_kwh)::numeric, 1) AS solar_kwh,
          round(sum(m.battery_grid_kwh)::numeric, 1) AS battery_grid_kwh,
          round(sum(m.battery_solar_kwh)::numeric, 1) AS battery_solar_kwh,
          round(sum(m.battery_unpriced_kwh)::numeric, 1) AS battery_unpriced_kwh,
          round(sum(m.no_house_data_kwh)::numeric, 1) AS no_house_data_kwh,
          count(m.session_id) AS slots
   FROM s LEFT JOIN ev_charge_energy_mix m ON m.session_id = s.id
   GROUP BY s.local_start
   ORDER BY s.local_start;
   ```

   Expected: `grid_pct` lands near the probe's **P (proportional)** column. Shaped sessions may be a few points higher
   (the probe noted 06-12 and 09-06), and the nights with grid-charged battery show `battery_grid_kwh` > 0. Any
   `no_house_data_kwh` > 0, or a session with 0 slots, means the readings or the derive missed it: investigate before
   passing.

5. **The owner agrees the numbers match reality.** Record in the roadmap: the prod `C` + date, the cap check, the seven `grid_pct` values
   next to P, and status `checkpoint passed`.

# Design — server latency step 3: stored session costs

Roadmap: [server latency](../roadmaps/2026-10-07-server-latency.md), step 3. Amends ADR-0020 (cost on read →
priced on write, with an on-read fallback for stale sessions).

Amended during the build (schema and step reviews): "Schema", "Race safety" and the read side below describe what
shipped.

## Why

`evCharging/costOverview` is critical in the `/charging` loader and is still the slowest read on the page:
`totalMs` 117–125 warm on prod after step 2 (checkpoint 2). Most of that is the two query rounds before the math:
sessions, tariffs and the house-data start first, then the year's spot slots and energy mix (`costSlots` +
`costMix`, 29–60 ms each). On top of that comes `costCompute` (21–53 ms), synchronous CPU that blocks the
instance's event loop. The `sessions` list prices its page the same way (`sessionCostsMs`). All of it reprices
history that hardly ever changes: a session's price only changes when its energy, mix, spot slots or tariff do.

## Decision

Each counted session's priced `CostTotals` are stored per Stockholm month, written by the existing TypeScript
pricing (one implementation, no SQL copy). `costOverview` and the `sessions` list read sums. A stored total is used
only while it is **current**. A stale session is priced on read, as today, and written back. A race or a failed
reprice therefore costs latency, never a wrong figure.

Alternatives (owner chose A, 2026-10-11):

- **B. Writers recompute, reads trust the rows.** One table, no stamps. A reprice that races a concurrent sync, or one
  that fails, leaves a wrong figure until the next write, and nothing shows it. It also needs a backfill script.
- **C. A per-instance in-memory cache keyed on an input fingerprint.** No schema, but it doesn't reach the goal:
  checking the fingerprint is itself a query round, every hourly sync clears the whole cache, and cold instances
  (row 4) start empty.
- **A, lazy only** (no eager reprice). Simpler, but the first view after each hourly sync reprices the sessions that
  sync changed, which brings back the second query round. The owner chose eager reprice plus the read fallback.

### What a session's price depends on

| Input | Its one writer | Bumps |
|---|---|---|
| Session row + intervals | `evCharging.importSessions` (Zaptec sync) | every session the import upserts |
| Energy mix | `energyMix.replaceForSessions` (derive) | the sessions it replaces |
| Spot slots | `spotPrice.replaceDay` | every session (counted or not) whose energy may overlap the day (below) |
| Tariff periods | `tariff.create` / `update` / `remove` | every session |
| The pricing code | — | none: `PRICING_VERSION` (below) makes every total stale |

Not inputs: the vehicle (attribution is filtered at read), voided/replaced/noise (the counted filter is applied at
read), `pruneUncounted` (it only touches uncounted sessions), `firstReadingAt` (read separately, as today). Bumping
too many sessions only costs a reprice; bumping too few would show a stale total, so every writer errs wide.

`replaceDay` bumps the sessions with an interval overlapping the day, plus sessions whose `[start_at, end_at)`
overlaps it (an interval-less session is priced over its window). A mix slot always lies inside its session's
stretches' span, so this covers the mix pieces too.

### Schema (`src/lib/db/schema/sessionCost.ts`, re-exported from the barrel)

```ts
evSessionCost = pgTable('ev_session_cost', {
  sessionId: uuid().primaryKey().references(() => evChargeSession.id, { onDelete: 'cascade' }),
  generation: integer().notNull().default(0),       // bumped by every write to the session's inputs
  pricedGeneration: integer(),                      // the generation the month rows were priced at; null = never
  pricingVersion: integer(),                        // PRICING_VERSION the month rows were priced with
  estimated: boolean(),                             // the session has no intervals (priced over its window)
}).enableRLS()

evSessionCostMonth = pgTable('ev_session_cost_month', {
  sessionId: uuid().notNull().references(() => evSessionCost.sessionId, { onDelete: 'cascade' }), // cascades from the session too
  year: integer().notNull(),                        // Stockholm month, as house_energy_month
  month: integer().notNull(),                       // CHECK 1..12
  // the 14 CostTotals fields, double precision NOT NULL:
  // kwh, gridKwh, fullKwh, noPriceKwh, noTariffKwh, spotSek, feesSek, totalSek,
  // solarKwh, batteryKwh, noHouseDataKwh, solarValueSek, solarPricedKwh, solarUnpricedKwh
}, PK (session_id, year, month)).enableRLS()
```

- The state lives in its own table, not on `ev_charge_session`: the new `sessionCost` service owns both tables
  (ADR-0002), and the Zaptec upsert's update set stays untouched.
- `double precision` matches the mix and the session energy. The sums are floats summed in another order than
  today's whole-month pricing, so they agree within float rounding (≤ 1e-9), not bit for bit.
- The month rows reference `ev_session_cost` (not the session directly): deleting a session cascades through its
  state row to its months, and a month row can't exist without a state row.
- CHECKs: `generation >= 0`, and `priced_generation` null or between 0 and `generation`; the priced columns
  (`priced_generation`, `pricing_version`, `estimated`) are null together or set together; `month` 1–12; every
  total finite (`> '-Infinity' AND < 'Infinity'`, which also refuses NaN). No sign bound: spot money is negative on
  negative prices, and a float residue of −1e-17 kWh would fail a whole write-back.
- Indexes: the month table's PK `(session_id, year, month)` serves the reads' join, the write-back's delete by
  session and the FK cascade; the month sums scan every row (a few hundred).
- No backfill migration: after the deploy every session is stale, and the first reprice (the next sync, or the first
  read) fills the table.

### The rule: current or stale

A session's stored totals are **current** when its `ev_session_cost` row exists, `priced_generation = generation`
and `pricing_version = PRICING_VERSION`. Anything else, including a session with no row, is **stale**. Reads use only
current totals.

`PRICING_VERSION` is a constant beside `priceIntervals`, bumped with any change to what `priceIntervals` or
`toIntervals` compute (as `DERIVE_VERSION` is for the derive, ADR-0023).

### Race safety

- **Invalidation** is one statement inside the writer's own transaction: an upsert of `ev_session_cost` rows that
  sets `generation = generation + 1` (inserting `generation = 1` for a session without a row), locking rows in
  `session_id` order. The input change and the bump commit together. `bumpAll` (tariff edits) upserts a row for
  every session, so a repricer that read a session without a row loses too.
- **Set-wide bumps wait out imports.** `bumpAll` and `bumpOverlapping` choose sessions from the writer's READ
  COMMITTED snapshot, which can't see a session or interval a concurrent import hasn't committed. Each tariff
  transaction therefore starts with `LOCK TABLE ev_charge_session IN SHARE MODE`, and `replaceDay`'s with
  `LOCK TABLE ev_charge_session, ev_charge_interval IN SHARE MODE`: it waits for an in-flight import and holds new
  ones off for the few ms of the write, without blocking readers or the write-back's FK KEY SHARE locks. Sessions
  first, as the import takes them; tables before cost rows, so no lock cycle.
- **A repricer reads the generations before the inputs**, then prices, then writes back in one transaction with
  **one sorted upsert**: `INSERT INTO ev_session_cost … ON CONFLICT (session_id) DO UPDATE SET priced_generation,
  pricing_version, estimated … WHERE ev_session_cost.generation = EXCLUDED.generation`, the rows in `session_id`
  order (the bumps' order, so no deadlock), joined to `ev_charge_session` (a session deleted meanwhile is skipped).
  A session read without a row counts as generation 0, so its insert loses to a writer's row (generation ≥ 1). A row
  already current at that generation and version is skipped, not rewritten. Only the sessions the upsert returned
  get their month rows replaced. Duplicate ids are stored once.
- **Timeouts.** The write-back's transaction sets a lock wait of 1 s (200 ms for a read's write-back), 5 s per
  statement and 5 s idle in the transaction, so an abandoned write-back can't hold row locks; a timeout throws and
  the callers treat it as best effort.
- If a writer commits between the repricer's generation read and its input read, the repricer prices newer inputs
  under the old generation; the bump then makes it stale again. Harmless.
- If a writer commits before the write-back, the `WHERE generation = g` misses: nothing is written.
- If a writer commits after the write-back, its bump makes the session stale.
- So a current row always holds totals priced from inputs at least as new as its generation's. Two repricers racing
  on the same generation write the same totals.

### Pricing per session and month (`src/lib/evCharging/costing.ts`)

One shared function prices a set of sessions into `Map<sessionId, Map<yearMonth, CostTotals>>`: today's loaders
(energy, slots, mix, tariffs), `toIntervals`, and each piece bucketed by its owning stretch's Stockholm month
(`bucketStartMs`, unchanged). Both the eager reprice and the read fallback use it. `priceIntervals` sums piece by
piece with no state across pieces, so per-session month totals summed over sessions equal today's whole-month
pricing up to float summation order.

### Eager reprice (`repriceStale`, `src/lib/evCharging/`)

Finds every stale counted session, prices it and writes it back under the generation guard. It never throws: a
failure or a timeout is a `warn`, and the read fallback covers it. It runs:

- **After each sync:** in the post-sync step Zaptec, elpris and Emaldo already run, right after the energy-mix
  derive, and also when the derive was skipped. Budget 10 s: run deadline 240 + month refresh 10 + derive 30 +
  reprice 10 = 290 s, under Vercel's 300 s. It is skipped once the run's deadline signal has fired.
- **After a tariff edit:** in the `tariff` procedures, after the service call succeeds (ADR-0001's "after success"),
  awaited and best-effort. A rare admin save waits ~200 ms, and the next `/charging` view is warm.

No cron and no queue topic: the hourly syncs and the read fallback make a failed reprice heal by itself.

### Read side

**`costOverview`**, two queries in parallel:

1. `sessionCost.readMonthSums({ vehicle, pricingVersion })`, **one statement**: the `SUM` of every total column per `(year, month)`
   over the current sessions, and the stale sessions' ids with their generations, all over counted sessions in the
   scope. All months, all time (a few dozen rows). One statement because it is one snapshot: two separate queries
   could see a session repriced or bumped between them and count it twice or not at all.
2. `firstReadingAt()`, as today.

With nothing stale, that is the whole request: one round, no slots, no mix, no pricing. Otherwise the stale sessions
are priced on read by the shared function, merged into the sums, and written back under the guard (awaited,
best-effort: a failed write-back is a `warn`, and the figures are still returned). The tiles and the 12 months are
built from the merged sums as today.

**`sessions` list** (`getSessionCosts`): the page's ids, current per-session sums (summed over the session's months)
plus stale ones priced on read and written back. `estimated` comes from `ev_session_cost`, or from the pricing for a
stale session. The response shape and the `costs: null` on failure stay.

**Unchanged:** the session page's cash-cost hero and `/charging/economy` keep pricing on read.

**Timings:** `costStoredMs`, `costStaleSessions` (a count) and `costWriteBackMs`. The existing
`costEnergy`/`costSlots`/`costMix`/`costTariff`/`costCompute` appear only when something was stale. `repriceStale`
logs its own line per sync run (sessions, ms).

## Testing (test-first)

- **Service** (`services/sessionCost`): current vs stale (no row, generation moved, version differs); the guarded
  write-back losing a race (a bump between the generation read and the write-back leaves the session stale and its
  month rows untouched); `readMonthSums` and `readSessionSums` honor the counted filter and the vehicle scope, and read sums and stale ids from one snapshot; cascade on
  session delete.
- **Writers:** `importSessions`, `replaceForSessions`, `replaceDay` (an overlapping interval, an interval-less session
  over its window, a session outside the day left alone) and the three tariff mutations each bump the right sessions,
  in the writer's transaction (a rolled-back write bumps nothing).
- **Reprice:** prices every stale session, leaves current ones alone, never throws, stops at its budget and on the
  abort signal; a `PRICING_VERSION` mismatch makes a session stale.
- **Equivalence:** on the costing fixtures, the store-backed `getCostOverview` and `getSessionCosts` equal today's
  on-read pricing within 1e-9 per field, for every vehicle scope, with everything stale, everything current, and a
  mix.
- **Procedures:** a tariff mutation leaves the sessions current; the read path writes back.

## Checkpoint 3 (prod)

- **Latency:** warm `costOverview` `totalMs` ≤ 40 ms (117–125 at checkpoint 2), with no `costSlots`/`costMix`/
  `costCompute` on the line and `costStaleSessions` 0. `sessionCostsMs` on `sessions` drops by a similar amount.
  Navigate, don't reload: a reload renders `costOverview` during SSR and logs no `rpc timing` line (checkpoint 2's tip).
- **Correctness:** a read-only script (`bun --no-env-file`, an inline prod `DATABASE_URL`, like
  `scripts/deriveEnergyMix.ts`) prices every counted session on read and compares it with the stored month rows:
  none current-and-different by more than 1e-9 per field.
- **Figures:** the owner checks that `/charging` (tiles, months, the session list's costs) is unchanged.
- The plan's first task re-measures the baseline on current `main` (prod `rpc timing` lines for `costOverview` and
  `sessions`).

## Docs

- ADR-0020: amend the one-line decision and "Reading it" (priced on write per session and month, current/stale rule,
  on-read fallback); a dated amendment note.
- CLAUDE.md code map: the `sessionCost` service and schema.
- Roadmap row 3: the spec, the plan, the PR.

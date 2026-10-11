# ADR 0020 — Spot Prices and the Charging Cost Model

- **Status**: Accepted
- **Date**: 2026-09-29
- **Deciders**: Lukas
- **Decision in one line**: Charging cost is computed by a pure TypeScript function over each
  session's energy intervals, the SE3 day-ahead price slots they overlap, and admin-managed per-kWh tariff periods,
  and **stored per session and Stockholm month** (amended 2026-10-11): each write to a cost input bumps the
  session's generation, the stored totals are read only while current, and stale sessions are priced on read and
  written back. Missing prices or tariffs count as missing energy (never 0 kr), and a per-interval
  `gridShare` is the seam for solar/battery later.

**Spec**: [EV charging Phase 2 design](../superpowers/specs/2026-09-29-ev-charging-phase2-design.md).
**Plan**: [Phase 2 plan](../superpowers/plans/2026-09-29-ev-charging-phase2.md).
**Research**: [scope map](../superpowers/specs/2026-09-28-ev-charging-scope-map.md) ("Phase 2", "Phase 2b").
**Builds on**: [ADR-0019](./0019-external-data-integrations.md) (the elpris source is a pulled integration).
**Extended by**: [ADR-0023](./0023-solar-aware-charging-cost.md) — the `gridShare` seam becomes a per-slot energy mix
(grid / solar / battery) derived from Emaldo; the economy counterfactuals stay grid-only.

---

## Context

The owner wants to know what charging the car costs. The household's bills (Aug 2026) decompose the per-kWh price
exactly: Bixia *Kvartspris* bills the **15-min SE3 spot price** plus "rörliga kostnader" + "fast påslag"; Vattenfall
Eldistribution (Enkeltariff E4) bills a flat **elöverföring** and the statutory **energiskatt**; everything carries
25 % VAT. `(50,328 + 5,331) × 1,25 = 69,574 öre` reproduces the retailer's printed "elpris inkl. moms" exactly.

Zaptec reports each session's energy as roughly **hourly intervals**; prices come in **15-min slots** (hourly before
2025-10-01; 92/100 slots on DST days). Tariffs change: Bixia's variable costs monthly, grid fees and tax on 1 January.

## Decision

### Data

- **`spot_price`** — one row per slot, PK `(zone, slot_start)`, explicit `slot_end` (slots aren't a fixed length),
  SEK/kWh ex VAT (may be negative). Filled by the `elpris` integration (ADR-0019) from elprisetjustnu.se.
  A day is stored **whole**: `replaceDay` deletes the Stockholm day's range and inserts, in one transaction, so a day
  re-split at another granularity can never leave overlapping slots (which would double-count energy).
- **`spot_price_day`** (amended 2026-10-11, server-latency step 6) — per stored Stockholm day, the time-weighted
  average SEK/kWh and the covered seconds, PK `(zone, day)`. `replaceDay` rewrites the day's row in the same
  transaction as its slots (the only writer), so it is never staler than they are. It is also the record of which
  days are stored: the elpris sync plans the days without a row, so a day whose slots exist without one (e.g. after
  a rollback past this change) is re-fetched and healed. The flip side: deleting a day's slots no longer makes the
  sync re-fetch it (its row survives). Write `spot_price` only through `replaceDay`; to re-fetch a day, delete its
  `spot_price_day` row. Stored because the economy page's on-read grouping of a year's slots cost 56–247 ms on prod.
  The cost math itself is not stored with the prices: charging cost is stored per session and month (see "Stored
  totals" below), and the session page's hero and the economy page still price on read.
- **`electricity_tariff`** — admin-managed periods keyed by a unique Stockholm `valid_from` date: retail markup
  (may be negative), grid transfer, energy tax (öre/kWh ex VAT) and VAT %. A period applies until the next begins,
  so editing today's tariff never re-prices history. Fixed monthly fees are deliberately out of scope.

### The math (`src/lib/evCharging/cost/`, client-safe, no db)

`priceIntervals(intervals, SlotIndex, tariffsAsc)` splits each interval's **grid** kWh across the slots it overlaps
(`kWh × overlap / duration` — power assumed uniform within an interval) and prices each piece with the tariff in force
on its slot's Stockholm day: `total = (spot + markup + grid + tax) × (1 + VAT)`. It returns `CostTotals`
(`kwh, gridKwh, fullKwh, noPriceKwh, noTariffKwh, spotSek, feesSek, totalSek`); money covers only `fullKwh`.

- **Missing data is a state.** Energy without a price or a tariff is counted, not priced at 0; `isComplete` compares
  `fullKwh` to `gridKwh` (so an over-count from overlapping slots is incomplete too). The UI shows a partly priced
  total as "minst … kr" with the share of charging that lacks a price, marks unpriced chart months "Pris saknas", and
  explains a page with nothing priced once (no tariff yet / no price yet) — never 0 kr. Zero energy is a true 0 kr.
- **`gridShare`** (0…1, always 1 today) scales what's priced. A later solar/battery source (Emaldo) supplies the real
  share per interval without touching the math; Phase 4 counterfactuals price hypothetical intervals the same way.
  Since ADR-0023 a piece may instead carry a `mix` (grid / solar / battery parts); `gridShare` is then 1 and ignored.
  The economy keeps `gridShare` 1.
- Invalid input (non-finite, negative kWh, share outside 0…1) throws — stored data is CHECK-constrained, so it's a bug.

### Reading it

`src/lib/evCharging/costing.ts` (a domain orchestrator, ADR-0001) loads counted-session energy, **only the slots
those sessions overlap** (one `unnest` join over their windows), and all tariff periods — each through its own service
— and buckets by each interval's Stockholm start month, exactly as the kWh overview does (a test pins kWh parity).
It backs `costOverview`, a **separate procedure** from `overview`, and the costs `sessions` returns with each page
(`costs: null` when costing throws, ADR-0025 §5), so a price or tariff problem degrades the cost figures and never
the energy ones; the page prefetches `costOverview` best-effort, and a session page brings its own costs.

**Stored totals (amended 2026-10-11, server latency step 3).** Two tables hold the priced cost:
`ev_session_cost` (one row per session: `generation`, `pricing_version`) and `ev_session_cost_month` (one row per
session and Stockholm month: the totals plus `noPriceKwh` / `noTariffKwh`). A session's stored totals are
**current** when its `generation` matches the one the totals were priced at and its `pricing_version` equals
`PRICING_VERSION`; otherwise it is **stale**. `PRICING_VERSION` must be bumped with any change to anything
`priceSessions` computes or depends on the shape of: `priceIntervals`, `toIntervals`, `bucketStartMs` and the month
keying, and how `listSessionEnergy` builds stretches and `estimated`.

- **Writers bump.** Every writer of a cost input bumps the affected sessions' generation in its own transaction
  (`sessionCost/invalidate.ts`): `importSessions` and `replaceForSessions` (the session's intervals and mix) bump
  those sessions, `replaceDay` (spot slots) bumps the sessions overlapping the day, and tariff create/update/remove
  bumps **every session** (`bumpAll` upserts a row for each, so a session read without a row loses too).
  `pruneUncounted` and attribution are exempt by design: they don't change a counted session's priced cost.
- **Set-wide bumps wait out imports.** `bumpAll` and `bumpOverlapping` choose their sessions from the writer's READ
  COMMITTED snapshot, so a session or interval inserted by a concurrent, not yet committed `importSessions` would be
  missed and could then be stored as current with the old tariff or slots. Each tariff transaction therefore starts
  with `LOCK TABLE ev_charge_session IN SHARE MODE`, and `replaceDay`'s with `LOCK TABLE ev_charge_session,
  ev_charge_interval IN SHARE MODE` (sessions first, the order the import takes them; tables before cost rows, so no
  lock cycle). SHARE waits for an in-flight import's ROW EXCLUSIVE and holds new imports off for the few ms of the
  write; it doesn't conflict with readers or the write-back's FK KEY SHARE row locks.
- **Generation guard.** A pricer reads the generations first, then the inputs, and writes back with
  `WHERE generation = g` (one sorted upsert). If an input changed meanwhile, the write is skipped and the session
  stays stale. The write-back's transaction sets three local timeouts: a lock wait of 1 s (200 ms on the read path,
  whose reader already has its figures; a derive can hold bumped rows for seconds), 5 s per statement and 5 s idle
  in the transaction, so a write-back abandoned past its caller's budget on a frozen instance can't hold row locks.
  A session with a non-finite total is left out (and warned about) rather than failing the whole write-back.
- **Repricing.** `repriceStale` runs after the Zaptec, elpris and Emaldo syncs and after tariff edits, with a 10 s
  budget. Whatever it doesn't reach is priced on the next read.
- **Reads.** `costOverview` and the sessions list read the stored sums and the stale ids in one statement, and price
  only the stale sessions. A stored total carries `noPriceKwh` / `noTariffKwh` exactly as before, so "missing
  ≠ 0 kr" is unchanged. The session page's hero and the economy page still price on read.
- **A read's write-back is a cache fill, not a mutation.** Any signed-in user's read may store the stale sessions it
  priced. That is derived data computed from inputs the reader doesn't control, so ADR-0017's rule (users are
  read-only; mutations are admin-only) is about user-initiated mutations and doesn't apply.
- **A `PRICING_VERSION` deploy churns, correctly.** While the old and the new deployment both serve, each reads the
  other's rows as stale and rewrites them. Every figure stays right; it only costs extra writes until the old one
  is gone.
- **Self-check.** `scripts/checkSessionCosts.ts` (read-only; `bun --no-env-file` with an inline `DATABASE_URL`)
  prices every current counted session on read and compares it with its stored month rows (≤ 1e-9 relative per
  field). A session repriced between its two reads can show as an offender: re-run before believing one.
- **Spec**: [session cost store design](../superpowers/specs/2026-10-11-session-cost-store-design.md).
- **Operating notes.** After rolling prod back past this change and forward again, bump `PRICING_VERSION`: code
  written before it doesn't bump, so rows priced before the rollback would still read as current. A new total column
  must be `NOT NULL DEFAULT 0` (the migration runs while the old deployment still writes back) and comes with a
  `PRICING_VERSION` bump.

### Energy tax is built in

Energy tax is statutory and the same for the whole price area, so a small table (`ENERGY_TAX_ORE_BY_YEAR`) pre-fills
new periods and follows the chosen year; it stays editable (some northern municipalities get a deduction; laws change).
Grid fees will come from **Eltariff-API** once Vattenfall Eldistribution publishes (scope map "Phase 2b"); the retailer's
monthly variable cost stays manual (no API).

### Counterfactuals (Phase 4, 2026-09-30)

[Phase 4 design](../superpowers/specs/2026-09-30-ev-charging-phase4-design.md). `src/lib/evCharging/economy/`
(client-safe) re-delivers a session's energy inside its plug-in window — widened to cover every interval, so the
actual schedule is always one of the candidates — at most at its **rate cap** (the highest observed kW, or kWh ÷
window hours if higher), and prices the result with `priceIntervals`:

- **immediate** fills the window's price pieces in time order from plug-in; **optimal** cheapest first; **dearest**
  most expensive first. Pieces are ranked by the full price `(spot + fees) × (1 + VAT)` of the tariff at the slot's
  Stockholm day (`unitPrice`, shared with `priceIntervals`). Greedy is exactly optimal: cost is linear in kWh with
  independent per-slot capacity.
- **Score** = (dearest − actual) ÷ (dearest − optimal), clamped to 0…1, null below a gap of max(0,5 kr, 5 % of |actual|) (amended 2026-10-01: a ≈4 öre gap graded 18 %, owner feedback; month/year scores apply the same rule to the summed totals, a ratio of sums, so individually unscored sessions can still contribute to a scored month/year). Saved =
  immediate − actual (may be negative); left on the table = actual − optimal (never negative). Month/year scores
  come from the **summed** totals (not an average of per-session scores) and are null when nothing is included.
- A session without intervals (`no_hourly`) or with any part of its window lacking a price or tariff (`no_price`) is
  **excluded and counted** — never priced over what remains.
- Month/year sums bucket by the **session's start month** (counterfactuals only exist per session), so they can
  differ by öre from the cost overview, which buckets by interval.
- **Spot timing only**: everything is grid-bought (`gridShare` 1). Actual spreads each hour's energy over its
  quarters while optimal can pick single quarters, so "left on the table" is slightly overstated. The rate cap pulls
  the other way: it is built from **hourly averages**, so a car that drew 11 kW for 30 min of an hour gets a 5,5 kW
  cap and the optimum is more constrained than the real charger, which understates "left on the table". The two
  biases are unquantified and roughly offsetting; the page says "somewhat over- or understated".
- Month average spot comes from `dailyAverageSpot` (per-day time-weighted average, stored in `spot_price_day`). The same
  average feeds the year tile, and days without a tariff are skipped.
- A session's `actualComplete` flag (`isComplete(actual)`) tells consumers whether `actual` prices every kWh; an
  excluded `no_price` session can carry a partial actual, so kronor figures are shown only when it is set, and
  `paidSpotOre` is null otherwise. `EconomyTotals` kronor are 0 when nothing is included: gate them on `included > 0`.

## Alternatives considered

- **Materialize cost per session/interval.** Faster reads, but every tariff edit needs a recompute job and "which
  numbers are stale" bookkeeping. Data is tiny (~100 sessions/yr); on-read stays well under a ~300 ms budget for the
  whole read for years (estimated ~100–150 ms at 5 years). The `rpc timing` line records `costEnergyMs`, `costSlotsMs`,
  `costTariffMs` and `costComputeMs`; revisit with a monthly rollup if `costSlotsMs` grows. **Adopted 2026-10-11**
  once on-read pricing measured 117–460 ms on prod; see "Stored totals".
- **Writers recompute, reads trust the rows (amended 2026-10-11, rejected).** Every writer would have to price the
  affected sessions itself, so a spot-price sync or a tariff edit does the heaviest work inside its transaction, and
  a missed writer leaves wrong numbers with no way to notice. Generations make a miss show up as a stale session.
- **In-memory cache (amended 2026-10-11, rejected).** Per instance, so each cold instance pays the full price, and
  Vercel starts instances often. It also needs its own invalidation.
- **All in SQL.** An overlap join × lateral tariff lookup works, but DST/15-min edge cases are hard to test in SQL,
  and Phase 4 counterfactuals price intervals that don't exist in any table. The hybrid keeps SQL for the narrow fetch.
- **Price by the interval's start slot only.** Simpler, but an hour spans four 15-min prices; the overlap split is
  exact for uniform power and costs nothing extra.

## Consequences

- One small, pure, heavily tested module decides every kronor figure; DST days, the hourly→15-min switch and tariff
  changes at Stockholm midnight are unit tests, not SQL fixtures.
- Cost was an **upper bound** until ADR-0023 (2026-10): all charging counted as grid-bought. Since then the cash
  cost prices each session's stored solar/battery mix (stored per session and month since 2026-10-11, see "Stored
  totals"; the session page's hero and the economy page price on read); a session without house data is still priced as
  grid-bought, and the page says how much ("Husets energidata saknas för …"). Zaptec's hourly intervals still can't
  resolve cheaper quarters inside an hour, though the mix's load-shaped spread narrows it. The economy
  counterfactuals remain grid-only (spot timing), labelled so.
- Adding a zone or a tariff component is a migration each (CHECK list; column) — cheap, but not free.
- Time-of-use grid pricing (effektavgift) doesn't fit a flat per-kWh period; it would need a child table, most likely
  fed by Eltariff-API.

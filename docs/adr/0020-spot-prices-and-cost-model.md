# ADR 0020 — Spot Prices and the Charging Cost Model

- **Status**: Accepted
- **Date**: 2026-09-29
- **Deciders**: Lukas
- **Decision in one line**: Charging cost is computed **on read** by a pure TypeScript function over each
  session's energy intervals, the SE3 day-ahead price slots they overlap, and admin-managed per-kWh tariff periods —
  never materialized — with missing prices or tariffs counted as missing energy (never 0 kr), and a per-interval
  `gridShare` as the seam for solar/battery later.

**Spec**: [EV charging Phase 2 design](../superpowers/specs/2026-09-29-ev-charging-phase2-design.md).
**Plan**: [Phase 2 plan](../superpowers/plans/2026-09-29-ev-charging-phase2.md).
**Research**: [scope map](../superpowers/specs/2026-09-28-ev-charging-scope-map.md) ("Phase 2", "Phase 2b").
**Builds on**: [ADR-0019](./0019-external-data-integrations.md) (the elpris source is a pulled integration).

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
- Invalid input (non-finite, negative kWh, share outside 0…1) throws — stored data is CHECK-constrained, so it's a bug.

### Reading it

`src/lib/evCharging/costing.ts` (a domain orchestrator, ADR-0001) loads counted-session energy, **only the slots
those sessions overlap** (one `unnest` join over their windows), and all tariff periods — each through its own service
— and buckets by each interval's Stockholm start month, exactly as the kWh overview does (a test pins kWh parity).
It backs `costOverview` / `sessionCosts`, **separate procedures** from `overview` / `sessions`, so a price or tariff
problem degrades the cost figures and never the energy ones; the page prefetches cost best-effort.

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
- **Score** = (dearest − actual) ÷ (dearest − optimal), clamped to 0…1, null below a 0,01 kr gap. Saved =
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
- Month average spot comes from `dailyAverageSpot` (per-day time-weighted average, aggregated in Postgres). The same
  average feeds the year tile, and days without a tariff are skipped.
- A session's `actualComplete` flag (`isComplete(actual)`) tells consumers whether `actual` prices every kWh; an
  excluded `no_price` session can carry a partial actual, so kronor figures are shown only when it is set, and
  `paidSpotOre` is null otherwise. `EconomyTotals` kronor are 0 when nothing is included: gate them on `included > 0`.

## Alternatives considered

- **Materialize cost per session/interval.** Faster reads, but every tariff edit needs a recompute job and "which
  numbers are stale" bookkeeping. Data is tiny (~100 sessions/yr); on-read stays well under a ~300 ms budget for the
  whole read for years (estimated ~100–150 ms at 5 years). The `rpc timing` line records `costEnergyMs`, `costSlotsMs`,
  `costTariffMs` and `costComputeMs`; revisit with a monthly rollup if `costSlotsMs` grows.
- **All in SQL.** An overlap join × lateral tariff lookup works, but DST/15-min edge cases are hard to test in SQL,
  and Phase 4 counterfactuals price intervals that don't exist in any table. The hybrid keeps SQL for the narrow fetch.
- **Price by the interval's start slot only.** Simpler, but an hour spans four 15-min prices; the overlap split is
  exact for uniform power and costs nothing extra.

## Consequences

- One small, pure, heavily tested module decides every kronor figure; DST days, the hourly→15-min switch and tariff
  changes at Stockholm midnight are unit tests, not SQL fixtures.
- Cost is an **upper bound** today: all charging counts as grid-bought (stated on the page), and Zaptec's hourly
  intervals can't resolve cheaper quarters inside an hour.
- Adding a zone or a tariff component is a migration each (CHECK list; column) — cheap, but not free.
- Time-of-use grid pricing (effektavgift) doesn't fit a flat per-kWh period; it would need a child table, most likely
  fed by Eltariff-API.

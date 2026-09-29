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

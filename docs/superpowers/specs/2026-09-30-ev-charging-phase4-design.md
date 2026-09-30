# EV charging Phase 4 — how economically we charge — design

Status: agreed 2026-09-30. Scope + research: [scope map](./2026-09-28-ev-charging-scope-map.md) ("Phase 4").
Builds on: [Phase 2 design](./2026-09-29-ev-charging-phase2-design.md), [Phase 3 design](./2026-09-30-ev-charging-phase3-design.md),
ADR-0019, ADR-0020 (amended by this phase: "Counterfactuals").

## Intent

Answer: **how well do we time our charging against the spot price, and what would charging differently have
saved?** Concretely: "would scheduled / smart charging have paid off?" Read-only for everyone signed in, like the
rest of `/charging`.

**Spot timing only, clearly labelled** (owner decision). All charging is still priced as grid-bought
(`gridShare = 1`, ADR-0020). The house has solar + a battery and most charging is daytime, so a spot-only optimum
can recommend night charging for a session that actually ran on solar. The page says, next to every score, that it
measures price timing as if every kWh came from the grid. A solar-aware phase (Emaldo → a real `gridShare`) is out
of scope.

## Decisions (agreed with the owner)

| # | Decision |
|---|---|
| 1 | Counterfactuals are **computed on read** by a new pure module that builds hypothetical `EnergyInterval`s and prices them with the existing `priceIntervals` — no materialized results, no SQL scheduling (approach 1 of 3; the others were sync-time materialization and SQL). |
| 2 | Three schedules per session: **immediate** (from plug-in, in time order), **optimal** (cheapest slots in the window first), **dearest** (most expensive first), each capped at the session's **rate cap**. |
| 3 | **Rate cap** = max(highest observed kW over any interval, session kWh ÷ window hours). Using the highest observed rate makes the actual session a feasible schedule, so `optimal ≤ actual ≤ dearest`. |
| 4 | Slots are ranked by the **full price incl fees + VAT** under the tariff of the slot's Stockholm day (a tariff change inside a window re-ranks correctly). Greedy is exactly optimal: cost is linear in kWh with per-slot capacity (fractional knapsack). |
| 5 | **Score** ("Pristajming") = (dearest − actual) ÷ (dearest − optimal), clamped to 0…1; **null** when dearest − optimal < 0.01 kr (nothing to choose between). |
| 6 | Headline kronor: **"Sparat mot direktladdning"** = immediate − actual (may be negative); **"Kvar att hämta"** = actual − optimal. |
| 7 | Price comparison: **paid spot** öre/kWh (energy-weighted, incl VAT) vs the **plug-in window's** time-weighted average spot (per session) and the **month's** time-weighted average spot (per month). |
| 8 | Sessions are **excluded** from counterfactuals (and counted, with the reason) when they have **no hourly data** (`no_hourly`: energy is spread evenly, nothing to compare) or when any part of the window lacks a **price or tariff** (`no_price`). Never 0 kr (ADR-0020). |
| 9 | Month aggregates = sums over the included sessions, bucketed by the **Stockholm month the session started** (counterfactuals only exist per session). This can differ by a few öre from `/charging`'s monthly cost for a session crossing month end; the page says so. |
| 10 | Known bias, stated on the page: actual spreads each hour's energy uniformly over its 15-min prices, while optimal can pick single quarters → "Kvar att hämta" is slightly overstated. |
| 11 | UI: a new sub-route **`/charging/economy`** (third sidebar sub-item "Ekonomi") and a new **`/charging/sessions/$sessionId`** page with an energy + spot-price chart. |
| 12 | **No schema change.** Everything derives from `ev_charge_session`, `ev_charge_interval`, `spot_price` and `electricity_tariff` through existing services. |
| 13 | **No new ADR**: a "Counterfactuals (Phase 4)" amendment to ADR-0020 records decisions 2–5, 9 and 10. |

---

## The math — `src/lib/evCharging/economy/` (client-safe, no db)

Same shape and rules as `src/lib/evCharging/cost/`: pure functions, types shared with the client, invalid input
throws. Uses `d3-array` (`sum`, `max`, sorting helpers) and the existing `SlotIndex` / `priceIntervals` /
`tariffAt`. Nothing hand-rolled beyond the greedy fill itself (a few lines; no library does "fill slots by price up
to a capacity").

```ts
type Window = { startMs: number; endMs: number }
// The session's plug-in → plug-out, widened to cover its stretches (clock quirks can put an interval
// slightly outside the window) so the actual schedule is always inside it — the invariant needs that.

type EconomySession = {                                  // own input type; no import from services
  startMs: number; endMs: number; kwh: number
  stretches: { startMs: number; endMs: number; kwh: number }[]
  estimated: boolean                                     // no Zaptec intervals → `no_hourly`
}

rateCapKw(stretches: EnergyStretch[], window: Window, kwh: number): number
// max over stretches with duration > 0 of kwh/hours, and kwh / windowHours. Never 0 for kwh > 0.

type ScheduleKind = 'immediate' | 'optimal' | 'dearest'
schedule(kind, input: { kwh; rateKw; window; slots: SlotIndex; tariffsAsc }): EnergyInterval[]
// Candidate pieces = each slot's overlap with the window (capacity = rateKw × overlap hours).
// immediate: pieces in time order. optimal: ascending full price. dearest: descending full price.
// Fill until kwh is delivered; the last piece is partial and placed at the piece's start.
// A window stretch not covered by any slot is a piece with no price: it can't be ranked, so its
// presence marks the session `no_price` (decision 8) before any schedule is built.

type SessionEconomy = {
  actual: CostTotals; immediate: CostTotals; optimal: CostTotals; dearest: CostTotals
  score: number | null
  savedVsImmediateSek: number          // immediate.totalSek − actual.totalSek
  leftOnTableSek: number               // actual.totalSek − optimal.totalSek
  paidSpotOre: number | null           // actual.spotSek / actual.fullKwh × 100
  windowAvgSpotOre: number | null      // time-weighted, incl VAT of each slot's tariff
  schedules: Record<ScheduleKind, EnergyInterval[]>
  excluded: null | 'no_hourly' | 'no_price'
}
sessionEconomy(session: EconomySession, slots, tariffsAsc): SessionEconomy

type MonthEconomy = {
  month: number
  sessions: number; excluded: { noHourly: number; noPrice: number }
  actualSek: number; immediateSek: number; optimalSek: number; dearestSek: number
  score: number | null                 // decision 5 over the month's sums
  paidSpotOre: number | null           // over included sessions
  monthAvgSpotOre: number | null       // every slot of the month, time-weighted, incl VAT; null if none
}
```

- "Full price" of a slot = `(spot + markup + grid + tax) × (1 + VAT)` for the tariff at the slot's Stockholm day —
  the same formula as `priceIntervals` (extract a small `slotPriceOre(slot, tariffsAsc)` in `cost/` and use it in
  both, so the ranking and the pricing can never disagree).
- A slot with no tariff makes the window `no_price` too (it can't be priced, so it can't be ranked), and so does an
  actual cost that isn't `isComplete` — a partial actual can't be compared.
- Scheduled intervals carry `gridShare: 1` (same seam as the actual cost).
- Window average spot: slots weighted by their overlap with the window; incl VAT of each slot's tariff (so it is
  comparable with `paidSpotOre`, which `priceIntervals` computes incl VAT).

## Read model — `src/lib/evCharging/economy.ts` (server-only orchestrator, ADR-0001)

- **Shared helpers first:** `timed`, `loadTariffs` and `toIntervals` move from `costing.ts` into
  `src/lib/evCharging/costInputs.ts` (server-only); `costing.ts` imports them. Behavior-preserving; lands in PR A.
- `getEconomyOverview({ year?, now?, timings? })`:
  1. `listSessionEnergy({ all: true })` + `loadTariffs()` in parallel.
  2. **One** `listSlotsOverlapping(SPOT_ZONE, ranges)` call whose ranges are each session's **plug-in window**
     (not its stretches — optimal and dearest may use slots outside the charged hours) plus the selected year's
     twelve Stockholm month bounds (for `monthAvgSpotOre`).
  3. Pure `sessionEconomy` per session in the selected year (by start month), `monthEconomy` per month.
  - Returns `{ year, years, tiles: YearEconomy /* = MonthEconomy without `month`, over the year */, months: MonthEconomy[12], sessions: EconomySessionRow[] }`, with
    `EconomySessionRow` = id, startAt, endAt, kWh, and the `SessionEconomy` figures minus `schedules`
    (newest first; ~100/yr → no paging). `years` reuses `distinctCountedYears()`.
- `getSessionEconomy({ sessionId, timings? })`:
  - Loads the session through a new `getSessionEnergy(id)` in `services/evCharging/sessionEnergy.ts`, which throws
    `EvChargingDomainError('EV_SESSION_NOT_FOUND')` (new `services/evCharging/errors.ts`, ADR-0002 shape, like
    `TariffDomainError`) when the id doesn't exist or isn't counted.
  - Slots for the window ± 1 h (chart context).
  - Returns header facts (startAt, endAt, kWh, peak kW via the existing `sessionPeakKw`, `estimated`), the actual
    intervals, the chart slots (`{ startMs, endMs, oreInclVat | null }`), the `SessionEconomy` incl `schedules`.
- Timings sink `{ energyMs, slotsMs, tariffMs, computeMs }`, forwarded with `recordPrefixedTimings(…, 'economy')`.

## Procedures — `src/lib/orpc/procedures/evCharging.ts`

- `evCharging.economy` — `protectedProcedure`, input `{ year?: int in [OVERVIEW_MIN_YEAR, OVERVIEW_MAX_YEAR] }`.
- `evCharging.session` — `protectedProcedure`, input `{ sessionId: string (non-empty, bounded length) }`,
  `.errors({ NOT_FOUND })`; `EV_SESSION_NOT_FOUND` → `errors.NOT_FOUND()`.
- Both record `economyEnergyMs / economySlotsMs / economyTariffMs / economyComputeMs`.
- Freshness: no `refetchInterval`; focus refetch + `useSyncNow`'s `orpc.evCharging.key()` invalidation (ADR-0018).

---

## UI

### `/charging/economy` — `src/routes/_authenticated/charging/economy.tsx`

- Sidebar: third entry in `chargingSubItems` ("Ekonomi"); command palette: "Laddekonomi".
- Search: `year` (zod, `.catch(undefined)`), changes with `replace: true, resetScroll: false`; loader
  `ensureQueryData(economy(year))` + Zaptec/elpris `syncStatus`; `keepPreviousData` on year changes; failed read →
  `LoadErrorAlert`.
- Page order in `PageContainer`: `ChargingHeading` → `SyncHealthAlert` (Zaptec, elpris) → `YearSelector` →
  1. **Tiles** (`EconomyTiles`): "Sparat mot direktladdning" kr, "Kvar att hämta" kr, "Pristajming" %,
     "Betalt spotpris" vs "Snittspot" öre/kWh. Negative savings shown as negative. Same card style as `TotalsTiles`.
  2. **Kronor per month** (`EconomyMonthlyChart`, Recharts via shadcn `ChartContainer`, like `MonthlyChart`):
     grouped bars *direkt / faktiskt / optimalt*; months with only excluded sessions get the "Pris saknas" stub.
  3. **Spot per month** (`SpotComparisonChart`, Recharts `ComposedChart`): paid spot öre/kWh bars vs month average
     spot line.
  4. **Sessions** (`EconomySessionTable`): date + window, kWh, actual kr, vs direkt, vs optimalt, score; row links to
     `/charging/sessions/$sessionId`; excluded rows show "—" with the reason ("ingen timdata" / "pris saknas");
     < sm the vs-columns fold under the date (like `SessionList`).
  5. **Footnote** (`EconomyFootnote`): spot-timing-only caveat (solar not included), the 15-min bias, start-month
     bucketing, excluded-session counts; plus `PriceFootnote` (elpris attribution).
- Year with no counted sessions → one `Empty` in place of the cards.

### `/charging/sessions/$sessionId` — `src/routes/_authenticated/charging/sessions/$sessionId.tsx`

- Linked from `SessionList` rows on `/charging` and from the economy table. No sidebar item of its own (the
  "Laddning" group stays active).
- Loader `ensureQueryData(session(id))`; `NOT_FOUND` → the route's `notFoundComponent`; other failures →
  `LoadErrorAlert`.
- Header: back link, "fre 5 sep · 21:10–07:02", kWh, peak kW.
- Four figures: actual / direkt / optimalt kr + Pristajming; an excluded session shows one `Empty`-style note with
  the reason instead.
- **`SessionPriceChart` (visx)** — mixed resolution (hourly bars, 15-min price steps) needs a real time axis:
  `d3-scale` `scaleTime` over window ± 1 h, Stockholm-formatted ticks (date-fns + `@date-fns/tz`); actual kWh per
  interval as solid `rect`s at true times; optimal schedule as outlined ghost bars (toggle); spot öre/kWh as
  `LinePath` + `curveStepAfter` on a right axis; outside-window shading; `@visx/tooltip` on hover/focus
  ("02:00–03:00 · 10,8 kWh · 41,2 öre"); `@visx/responsive` `ParentSize` width, fixed height, thinner ticks on
  mobile; an sr-only `<table>` with the same data.
- Same caveat footnote as the economy page.

### i18n

All strings in `messages/sv.json` (source of truth) + `messages/en.json` (key-complete); prefixes
`charging_economy_*`, `charging_session_*`, plus `nav_charging_economy_short` and the command entry. Dates via
date-fns with `getDateFnsLocale()` + `tz(STOCKHOLM_TIME_ZONE)`.

---

## Delivery: three stacked PRs (two skeptical reviewers after each task)

| PR | Title | Scope |
|---|---|---|
| **A** | `feat(charging): add charging economy read models` | Spec + plan, `slotPriceOre` extraction, pure `economy/` (test-first), `costInputs.ts` extraction, `getSessionEnergy` + `EvChargingDomainError`, `economy.ts`, the two procedures + timings, ADR-0020 amendment. No UI caller. |
| **B** | `feat(charging): show charging economy on /charging/economy` | Route, sidebar + command entry, tiles, both charts, session table, footnotes, empty/error states, i18n. |
| **C** | `feat(charging): add a session page with a price overlay` | `/charging/sessions/$sessionId`, `SessionPriceChart` + table fallback, not-found, row links from `SessionList` and the economy table, i18n. |

## Testing

- **Pure module (test-first, node):** immediate fills chronologically and stops at kWh; optimal/dearest greedy by
  full price with per-slot capacity and partial edge slots; a tariff change at midnight inside the window
  re-ranks; negative prices first; rate-cap rules; **invariant `optimal ≤ actual ≤ dearest`** over seeded random
  fixtures (a loop over seeds, no new dependency); score null below 0.01 kr gap; a DST-straddling window; hourly
  slots before 2025-10-01; `no_hourly` / `no_price` (missing slot, missing tariff) exclusions; month sums skip
  excluded sessions; window/month average spot weighting.
- **`slotPriceOre` extraction:** existing `priceIntervals` tests stay green unchanged.
- **Service / orchestrator (`setupDatabase()`):** `countedSessionFilter()` honoured; window slots loaded (optimal
  uses a slot outside the charged hours); actual equals `getSessionCosts` for the same session (parity);
  `getSessionEnergy` throws `EV_SESSION_NOT_FOUND` for unknown and for voided ids (test-completeness: every code
  exercised).
- **Procedures:** year bounds; anonymous → unauthorized; `EV_SESSION_NOT_FOUND` → `NOT_FOUND`.
- **Components (browser):** negative saving rendered negative; excluded row "—" + reason; table reflows < sm;
  session chart draws bars, ghost bars and the step line and exposes the table fallback; not-found page;
  `clientSafe.browser.test.tsx` covers `economy/`.
- **Live (Phase 6):** desktop / tablet / mobile with `ZAPTEC_ADAPTER=fake` plus locally synced elpris prices.

## Accepted gaps / deferred

- Solar/battery (real `gridShare`) — a later phase; until then the score is spot timing only.
- Within-hour timing of actual charging is unknown (Zaptec hourly), hence the 15-min bias (decision 10).
- No per-vehicle split (Phase 5); the economy table will gain a vehicle column then.
- No "tonight's cheapest window" forecast (scope map "Later").

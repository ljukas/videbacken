# EV charging Phase 2 — spot prices + cost — design

Status: agreed 2026-09-29. Scope + research: [scope map](./2026-09-28-ev-charging-scope-map.md) ("Phase 2").
Builds on: [Phase 1 design](./2026-09-28-ev-charging-phase1-design.md), ADR-0019.
Produced from two architect blueprints (pragmatic / clean) reconciled into a hybrid.

## Decisions (agreed with the owner)

| # | Decision |
|---|---|
| 1 | Price source **elprisetjustnu.se**, zone **SE3** (constant, but stored per row). 15-min slots since 2025-10-01, hourly before. Attribution "Elpriser tillhandahålls av Elpriset just nu.se" on the page. |
| 2 | Tariff is **flat per kWh**, admin-managed, **versioned by `valid_from`** (Stockholm date). Fields ex VAT: retail markup öre/kWh, grid transfer öre/kWh, energy tax öre/kWh, VAT %. Fixed monthly fees excluded. |
| 3 | `elpris` is its **own integration source**: own lease/health/run history/alerts (ADR-0019), **own daily cron**. Admin "Synka nu" runs both syncs in parallel. |
| 4 | Cost is **computed on read** (no materialized cost). |
| 5 | **Hybrid cost architecture**: narrow SQL fetch (counted intervals + only the slots they overlap) → **pure TS cost function**. |
| 6 | UI: tiles (total kr incl VAT, avg öre/kWh, spot vs fees split), monthly chart kWh ↔ kr toggle, session cost column (spot + total). |
| 7 | All charging is priced as **bought from the grid** (solar/battery self-supply ignored → upper bound, stated on the page). The cost function takes a per-interval `gridShare` (always 1 in Phase 2) so a later Emaldo-based phase is additive. |

### Reconciled against the owner's bills (Aug 2026)

- Bixia **Kvartspris** (spot billed per 15-min slot — matches our allocation), rörliga kostnader 5,331 öre + fast påslag 0 → *retail markup*.
  `(50,328 + 5,331) × 1,25 = 69,574 öre` = the bill's "Ditt elpris inkl. moms" exactly.
- Vattenfall **Enkeltariff E4**: elöverföring 35,60 öre → *grid transfer*; energiskatt 36,00 öre → *energy tax*; moms 25 %.
- Excluded: abonnemang (kr/år), Bixia fast avgift + rabatt (kr/månad).
- Bixia's rörliga kostnader change monthly → admin adds a period per bill (valid from the 1st) for exact figures; otherwise the latest period applies as an estimate. Dialog offers "Ny period från nuvarande".
- Real tariff values are entered through the admin UI — never seeded or committed.

## Elpris API facts (probed 2026-09-29)

- `GET https://www.elprisetjustnu.se/api/v1/prices/YYYY/MM-DD_SE3.json` →
  `[{ SEK_per_kWh, EUR_per_kWh, EXR, time_start, time_end }]`, ISO with offset, SEK **ex VAT**, may be ≤ 0.
- 96 rows/day; **92 / 100 on DST days**; 24 (hourly) before 2025-10-01; data from 2022-11-01.
- Unpublished day (tomorrow before ~13:00 CET) → **404**.

## Delivery: four PRs, in order (two skeptical reviewers after each)

| PR | Title (conventional commit) | Scope |
|---|---|---|
| **A** | `refactor(sync): extract the pulled-integration run lifecycle` | `runPulledSync`, `withDeadline`, `IntegrationError` base, cron helper. Zaptec behavior identical. |
| **B** | `feat(charging): add spot price and tariff storage with cost math` | Schema + migration, `spotPrice` + `tariff` services, pure cost module, Stockholm time helpers. |
| **C** | `feat(charging): sync SE3 spot prices from elprisetjustnu` | Elpris effect, `runElprisSync`, cron, two-source health/`syncNow`. |
| **D** | `feat(charging): show charging cost and manage tariffs` | Cost composer + procedures, tariff CRUD UI, cost tiles/chart/column, ADR-0020. |

Prerequisite met: PR #22 (migration 0004) merged; Phase 2's migration is 0005.

---

## PR A — pulled-run lifecycle (refactor, no behavior change)

- `src/lib/effects/integrationError.ts`: `abstract class IntegrationError extends Error { code: IntegrationErrorCode }`; `ZaptecError` extends it.
- `src/lib/integrations/runPulledSync.ts`:
  ```ts
  type RunBase = { source: IntegrationSource; trigger: SyncTrigger;
    outcome: 'ok'|'failed'|'skipped'|'error'; code: IntegrationErrorCode|null;
    transition: HealthTransition; startedAt: Date; since: Date|null; durationMs: number }
  runPulledSync<R extends RunBase>(spec: {
    source; trigger; now?; deadlineMs?; log?
    init(base: RunBase): R
    execute(ctx: { run: R; signal: AbortSignal; now: () => Date }): Promise<void>
      // IntegrationError → 'failed'; anything else → 'error' (recorded best-effort, rethrown)
    toRunStats(run: R): RunStats
    logFields(run: R): Record<string, unknown>
    finalize?(run: R): void
  }): Promise<R>
  withDeadline<T>(p: Promise<T>, signal: AbortSignal, mkErr: () => IntegrationError): Promise<T>
  ```
  Moves verbatim from `sync.ts`: lease (`beginAttempt`), deadline timer, recording guard, `recordOutcome`,
  internal_error fallback, `alertAdmins(source, …)`, the one `integration sync run` log line and its grading.
- `src/lib/integrations/cron.ts`: `verifyCronSecret` + `cronHandler(run)` (secret gate → 200 for ok/failed/skipped, 500 on throw).
  `zaptecSyncCron.ts` becomes a thin caller and re-exports `verifyCronSecret`.
- Retry/timeout loop in `zaptec/client.ts`: extract to `src/lib/effects/policyFetch.ts` **only if** it separates
  cleanly from the token flow; otherwise elpris gets its own ~30-line loop and extraction waits for Škoda.
- `RunStats`/DB columns keep their names (`sessions_seen` etc.); elpris maps onto them (see PR C). A rename is deferred.
- Gate: `sync.test.ts` + `zaptecSyncCron.test.ts` pass **unchanged**.

## PR B — storage + pure cost math

### Schema (`bun run db:generate --name=spot_price_and_electricity_tariff`)

```ts
// src/lib/db/schema/spotPrice.ts
spot_price (
  zone text NOT NULL CHECK (zone IN PRICE_ZONES),          -- ['SE3']
  slot_start timestamptz NOT NULL,
  slot_end   timestamptz NOT NULL,
  sek_per_kwh double precision NOT NULL,                   -- ex VAT, may be negative
  PRIMARY KEY (zone, slot_start),
  CHECK (slot_end > slot_start AND slot_end - slot_start <= interval '1 hour'),  -- load-bearing for the range bound
  CHECK (sek_per_kwh > -100 AND sek_per_kwh < 100)         -- unit-drift backstop
)
// src/lib/db/schema/electricityTariff.ts
electricity_tariff (
  id uuid PK default random,
  valid_from date NOT NULL UNIQUE,                         -- Stockholm calendar date (not an instant)
  retail_markup_ore, grid_transfer_ore, energy_tax_ore double precision NOT NULL CHECK (0..1000),
  vat_percent double precision NOT NULL CHECK (0..100),
  created_at, updated_at timestamptz
)
```
PK serves upsert, the range read, and the days-present probe; `UNIQUE(valid_from)` is invariant + lookup.
No new index on `ev_charge_interval` (small; revisit past ~100k rows). **Schema-design review + migration-guard before building on it.**

### Client-safe helpers
- `src/lib/time/stockholm.ts`: `stockholmDayOf(ms)`, `stockholmDayBounds(day)` (23/24/25 h), `stockholmYearMonth(ms)`, `addDays(day, n)`.
- `src/lib/spotPrice/zones.ts` (`PRICE_ZONES`, `SPOT_ZONE = 'SE3'`), `src/lib/spotPrice/slots.ts` `validateDaySlots(day, slots)`
  (contiguous, exactly covers the Stockholm day, finite).

### Pure cost module `src/lib/evCharging/cost/` (no db import)
```ts
type PriceSlot = { startMs: number; endMs: number; sekPerKwh: number }
type EnergyInterval = { startMs: number; endMs: number; kwh: number; gridShare: number } // 1 in Phase 2
type TariffPeriod = { validFrom: string; retailMarkupOre; gridTransferOre; energyTaxOre; vatPercent }
class SlotIndex { constructor(slots: PriceSlot[]); between(startMs, endMs): PriceSlot[] }
type CostTotals = { kwh; pricedKwh; spotSek; fullKwh; feesSek; totalSek }   // spot/total incl VAT
priceIntervals(ivs: EnergyInterval[], idx: SlotIndex, tariffsAsc: TariffPeriod[]): CostTotals
tariffAt(tariffsAsc, day: string): TariffPeriod | null
avgOre(t) / isComplete(t) / emptyTotals() / mergeTotals(a, b)
```
- Allocation: each interval is split into **pieces** by overlapping slot, `kWh × overlap/duration` (uniform power
  within an interval); an uncovered part becomes a piece with no slot. Piece kWh sums to interval kWh (invariant).
- Tariff per piece by the piece's Stockholm day (slots never straddle midnight).
- `total = (spot + markup + grid + tax) × (1 + vat/100)` per grid kWh. Spot is shown incl VAT too, so `total − spot` = fees + VAT on fees.
- **Missing data is a state, never 0**: pieces without price → excluded from `pricedKwh`; without tariff → excluded from `fullKwh`.
  UI shows "delvis" when `fullKwh < kwh`, "—" when `fullKwh = 0`.
- Sessions without intervals: one synthetic interval `[startAt, endAt)` flagged `estimated` (matches overview's kWh fallback); zero-length → unknown.

### Services (ADR-0002, `setupDatabase()` tests)
- `services/spotPrice/`: `upsertDay(zone, slots)` (one tx, allow-listed ON CONFLICT update), `listSlotsOverlapping(zone, ranges)`
  or `listSlots(zone, from, to)` with `slot_start >= from − 1h`, `daysWithSlots(zone, fromDay, toDay)`.
- `services/tariff/`: `list / create / update / remove`; `TariffDomainError` codes
  `TARIFF_NOT_FOUND | TARIFF_VALID_FROM_TAKEN | TARIFF_INVALID_VALUE | TARIFF_INVALID_DATE` (check-first; 23505 → `VALID_FROM_TAKEN`).
- `services/evCharging/`: move `countedSessionFilter` to `counted.ts`; add `listSessionEnergy({ year } | { sessionIds } | { all })`
  and `earliestCountedStartAt()`.

## PR C — elpris integration

- `src/lib/effects/elpris/` (`elpris.ts` selector, `client.ts`, `parse.ts`, `errors.ts`, `adapters/notConfigured.ts`, tests with `fakeFetch`):
  ```ts
  interface ElprisClient { dayPrices(day: string, zone: PriceZone, o?: { signal?; stats? }): Promise<PriceSlot[] | null> } // null = 404
  ```
  Adapters: `VITEST` → `notConfigured`; otherwise `http` (keyless — works in dev/preview/prod). **No fake adapter.**
  ADR-0019 policy: 10 s timeout, ≤ 2 retries on 429/502/503/504/network, Retry-After ≤ 10 s. zod → `unexpected_response`, field paths only. Never logs.
- `src/lib/spotPrice/sync.ts` `runElprisSync` on `runPulledSync`:
  - Window = missing Stockholm days in `[max(2022-11-01, day of earliest counted session ?? today), tomorrow]` (stored days skipped;
    no watermark — self-healing). Newest first, cap per run, sequential, no new day after 120 s, 240 s deadline.
  - 404: future day → `notPublished` (fine); older than yesterday → counted `gaps`, warned, retried next run;
    **today/yesterday → run `failed` (`unexpected_response`) after the loop** so the backfill still lands.
  - RunStats mapping: `pages` = day requests, `sessionsSeen` = slots parsed, `upserted` = slots written, `voided` = 0,
    `timings` = `{ fetchMs, importMs, requests, retries, notPublished, gaps }`.
- Cron `src/routes/api/cron/elpris-sync.ts` via `cronHandler`; `vite.config.ts` crons: `{ path: '/api/cron/elpris-sync', schedule: '30 12,15 * * *' }`
  (UTC → 13:30/14:30 local, plus a late retry; verify Vercel accepts the list syntax, else two entries).
- Procedures: `syncStatus` → `{ zaptec, elpris }`; `recentRuns({ source, limit })`; `syncNow` runs both with `Promise.allSettled`,
  returns `{ zaptec, elpris }`, rethrows the first unexpected error after both settle; `context.timings.elpris*Ms`.
- UI: `SyncHealthAlerts` (one alert per unhealthy source); `RecentRunsCard` per source (admin); toasts per source.
  Verify `integrationHealthMessage.ts` wording and the alert email for `elpris`.

## PR D — cost read model + UI

- Composer `src/lib/evCharging/costing.ts` (sanctioned domain-orchestrator location): `listSessionEnergy` + overlapping slots + tariffs
  in parallel → `SlotIndex` → `priceIntervals`, bucketed by `stockholmYearMonth` of interval start (same as overview kWh).
- Procedures (protected): `costOverview({ year? })` → `{ tiles: { thisMonth, thisYear, allTime }, months[12] }` of `CostTotals`+derived;
  `sessionCosts({ sessionIds })` → per-session cost (null when incomplete). `overview`/`sessions` unchanged (fault isolation).
  Timings: `energyMs`, `slotsMs`, `tariffMs`, `costMs`.
- Tariff procedures: `tariff.list` (protected), `tariff.create/update/remove` (admin) + error mapper + `src/lib/orpc/tariffErrorMessage.ts`.
- Form fields (ADR-0005): `NumberField` (text + `inputMode="decimal"`, comma accepted, unit suffix), `DateField` (`YYYY-MM-DD`).
- Components (`src/components/evCharging/`): `CostTiles` (or cost lines in `TotalsTiles`), `MonthlyChart` metric toggle (stacked spot vs fees in kr),
  `SessionList` cost column, `TariffCard`, `TariffDialog` (URL state per ADR-0013; new/edit/"från nuvarande"), `PriceFootnote`
  (attribution + assumptions: grid-bought upper bound, hourly allocation, fixed fees excluded). Empty state per ADR-0016 when no tariff.
- Loader prefetches of cost queries `.catch(() => {})` — a price failure degrades the cost sections, never the route.
- i18n sv + en (`charging_cost_*`, `charging_metric_*`, `charging_tariff_*`, `charging_prices_attribution`, …).
- Docs: **ADR-0020 "Spot prices and cost model"**, ADR-0019 amendment (run helper, missing-days window, keyless adapter selection),
  CLAUDE.md code map + ADR index, `CONTEXT.md` terms (slot, tariff period, piece).

## Tests (by layer)

- Pure: allocation (aligned/unaligned/multi-slot/uncovered/negative price, kWh conservation), `tariffAt` boundaries, DST days
  (2025-03-30: 92 slots; 2025-10-26: 100 slots), hourly→15-min switch on 2025-10-01, `gridShare` < 1, `validateDaySlots`, missing-day planning.
- Effect: fakeFetch — parse, 404 → null, drift → `unexpected_response` (no payload echo), 429/5xx/Retry-After, timeout, abort.
- Services: idempotent upsert + correction, `daysWithSlots` on DST day, tariff CRUD + every error code + concurrent 23505, CHECK backstops.
- Orchestrator: ok, tomorrow 404 ok, today 404 failed-after-save, gaps, lease skip, deadline, transitions, one log line; cron 401/200/500.
- Composer: cost-month kWh == overview-month kWh on the same fixture; missing price/tariff → partial, never 0.
- Procedures: admin gates; `syncNow` runs both, one throwing doesn't skip the other.
- Browser: cost tiles partial/unknown, chart toggle, session cost cell, tariff dialog (comma decimal, duplicate date), two-source health.

## Risks / accepted gaps

- Cost is an **upper bound** (solar/battery self-supply and public charging invisible). Follow-up phase: Emaldo Power Core
  (unofficial cloud API, 5-min grid import/export/solar/battery per day) → fill `gridShare`; needs a probe + a battery-attribution decision.
- elprisetjustnu.se is free/keyless with no SLA → fail closed, health + alerts, honest "unknown".
- First backfill (~245 days) may take more than one run; older months show "delvis" until done.
- Hourly allocation of Zaptec intervals can't resolve cheaper/dearer quarters inside an hour (small error, stated in the UI).

# House energy pages (Energi) — design

Status: agreed 2026-10-05. Decision record: [ADR-0024](../../adr/0024-house-energy-pages.md).
Roadmap and checkpoints: [house energy pages roadmap](../roadmaps/2026-10-05-house-energy-pages.md).
Builds on: ADR-0023 (Emaldo readings, SoC, `C`), ADR-0018 (no held connections), ADR-0016 (empty states).

## Intent

The house's 5-minute energy flows have been stored since 2026-01-20 (ADR-0023), but they only feed the charging
cost. Show them on their own: where the solar goes, what is bought and sold, how self-sufficient the house is, how
much of the load is the car, and what the home battery takes in, gives back and loses.

**Success:**
- Per month, the owner can see where the battery's energy came from, what came back out, what was lost, and why
  winter looks so much worse than summer.
- Per month, the owner can see the solar production's split (used directly / stored / sold), bought vs sold energy,
  self-sufficiency, and car vs the rest of the house.
- Every figure matches a plain SQL sum over `house_energy_reading` (and `ev_charge_interval` for the car).
- Gaps and partial months are labelled, never silently counted as low production.
- Only aggregates reach the browser.

## Decisions (agreed with the owner)

| # | Decision |
|---|---|
| 1 | **House energy, battery as a section**: a new nav section *Energi* with sub-pages *Översikt* and *Batteri*, like `/charging`'s sub-items. |
| 2 | **One loss figure, SoC-corrected**: loss = in − out − Δstored; efficiency = out ÷ (in − Δstored). Standby/heating isn't split out (the data can't tell them apart reliably); a note explains winter. |
| 3 | **kWh only**: no kronor in this phase. |
| 4 | **Overview figures**: solar produced + where it went; grid import & export; self-sufficiency; car vs rest of house. |
| 5 | **Self-sufficiency = max(0, 1 − import ÷ load)**: grid-charged battery energy counts as bought. |
| 6 | **Periods**: tiles (this month / this year / all time) + a 12-month chart per year. No day or intraday views. |
| 7 | **Approach A**: on-read monthly aggregates, no rollup table. |
| 8 | **Read-only for every signed-in member** (`protectedProcedure`). |
| 9 | **Two PRs** after the docs PR, one per session, each with a prod checkpoint (roadmap). |

## Measured on the local full history (2026-10-05)

| Month | Days | In, solar | In, grid | Out | Solar | Export | Import | Load |
|---|---|---|---|---|---|---|---|---|
| 2026-01 | 12 | 1.8 | 110.7 | 65.0 | 8 | 4 | 671 | 620 |
| 2026-02 | 28 | 25.6 | 248.9 | 157.0 | 184 | 18 | 1881 | 1909 |
| 2026-05 | 31 | 201.6 | 19.3 | 201.5 | 939 | 399 | 364 | 898 |
| 2026-09 | 30 | 172.9 | 67.9 | 225.4 | 509 | 114 | 561 | 947 |

- A year aggregates by Stockholm month in ≈40 ms (73,945 rows).
- Idle SoC drop (no charge, no discharge) is ≈18 kWh of February's ≈117 kWh in − out; ≈0 from April. So most
  winter loss happens while the battery works; SoC steps of 1 % (≈0.08 kWh) can't split it further.
- Export beyond the solar surplus (`export − max(0, solar − charge_solar)`) is 4–18 kWh a month, within the
  balance residual (`import + solar + discharge − load − export − charges`: −20 … +21 kWh a month).
- `battery_soc_pct` is non-null on every bucket. `battery_charge_ac_kwh` is 0 throughout (checkpoint 2).
- Months in which import > load happen (January: 671 vs 620, battery losses + grid charging), hence the clamp in
  self-sufficiency.

## Read model

### Service — `src/lib/services/houseEnergy/energyOverview.ts`

`getEnergyOverview(year: number): Promise<EnergyOverview>`

```ts
type PeriodSums = {
  gridImportKwh: number; gridExportKwh: number; solarKwh: number; loadKwh: number
  batteryDischargeKwh: number; batteryChargeSolarKwh: number
  batteryChargeGridKwh: number            // charge_grid + charge_ac
  carKwh: number
  firstSocPct: number | null; lastSocPct: number | null  // first / last bucket with a SoC in the period
  buckets: number                         // readings in the period
  expectedBuckets: number                 // DST-aware: 5-min steps from period start to min(period end, now)
}
type EnergyOverview = {
  tiles: { thisMonth: PeriodSums | null; thisYear: PeriodSums | null; allTime: PeriodSums | null }
  chart: { year: number; months: (PeriodSums | null)[] }   // 12 entries, null = no reading in that month
  firstReadingDay: string | null          // Stockholm 'YYYY-MM-DD'
  availableYears: number[]                // first reading's year … current Stockholm year
}
```

- **One aggregate query per span**, grouped by Stockholm month (`date_trunc('month', bucket_start AT TIME ZONE
  'Europe/Stockholm')`): Σ of each kWh column, `count(*)`, and the first/last SoC by `bucket_start`. The chart's year
  and the current year share a query when they're the same year. All time = Σ over every month row of all years
  (one more `GROUP BY` month without a year filter), with the first and last SoC of the whole history.
- Period sums of months add up; first/last SoC of a span are those of its first/last non-empty month.
- `null` period = no reading in it. Before the first reading every period is `null` and `firstReadingDay` is null.
- **Expected buckets** use `stockholmDayBounds` (`src/lib/time/stockholm.ts`): (min(end, now) − start) ÷ 5 min,
  where `start` is the later of the period start and the first reading's Stockholm day start (so January 2026 isn't
  "missing" 19 days the integration never had). The current month's expected count runs to the newest reading's
  bucket, not to now: the sync runs hourly, and the last hour isn't a gap.
- **Car kWh**: the `/charging` overview's rule (`services/evCharging/overview.ts` `monthlyTotals`): interval kWh by
  each interval's Stockholm month, with a session's own `energy_kwh` as a fallback when it has no intervals, over
  counted sessions **of every vehicle** (the charger is part of the house load whoever charges). Extract that rule
  into an exported helper in the evCharging service (month-bucketed kWh over a `start_at` range and a vehicle scope)
  and call it from both, rather than duplicating the query. Services calling services is fine (ADR-0002).
- `year` outside `availableYears` → the chart is 12 `null`s (the procedure already bounds it; the service doesn't
  throw).

### Pure figures — `src/lib/houseEnergy/figures.ts` (client-safe)

`energyFigures(p: PeriodSums)` derives every displayed number. No imports from services except `import type`.

| Figure | Formula |
|---|---|
| `solarToBattery` | `batteryChargeSolarKwh` |
| `solarExported` | min(`gridExportKwh`, max(0, solar − solarToBattery)) |
| `solarDirect` | max(0, solar − solarToBattery − solarExported) |
| `importToBattery` | min(`gridImportKwh`, `batteryChargeGridKwh`) |
| `importDirect` | `gridImportKwh` − importToBattery |
| `selfSufficiency` | load > 0 ? max(0, 1 − import ÷ load) : null |
| `car`, `restOfHouse` | `carKwh`, max(0, load − car) |
| `batteryIn` | solarToBattery + `batteryChargeGridKwh` |
| `batteryOut` | `batteryDischargeKwh` |
| `deltaStored` | both SoCs set ? (last − first) ÷ 100 × `BATTERY_CAPACITY_KWH` : 0 |
| `loss` | batteryIn − batteryOut − deltaStored |
| `efficiency` | batteryIn − deltaStored ≥ 1 kWh ? min(1, batteryOut ÷ (batteryIn − deltaStored)) : null |
| `gridChargedShare` | batteryIn ≥ 1 kWh ? `batteryChargeGridKwh` ÷ batteryIn : null |
| `coverage` | expectedBuckets > 0 ? buckets ÷ expectedBuckets : null |
| `missingHours` | max(0, expected − buckets) × 5 ÷ 60 |

`BATTERY_CAPACITY_KWH` is imported from `src/lib/houseEnergy/mix/pool.ts` (already client-safe). `figures.ts` is
added to the `clientSafe.browser.test.tsx` guard (in `src/lib/evCharging/`, or a new one in `src/lib/houseEnergy/`).

**Display rules (components, not `figures.ts`):** |loss| < 0.5 kWh shows "≈ 0 kWh"; a negative loss of 0.5 kWh or
more shows its real value in the tooltip and "≈ 0" on the tile (meter noise across a short period); efficiency of
exactly 1 shows "≈ 100 %". `coverage < 0.99` adds "data saknas för N h" (hours rounded, at least 1).

### Procedure — `energy.overview`

- `src/lib/orpc/procedures/energy.ts`, registered as `energy` in `orpc/router.ts`.
- `protectedProcedure`, input `z.object({ year: z.number().int().min(2020).max(2100).optional() })`; missing
  year → the current Stockholm year.
- Thin glue: `getEnergyOverview(year)`; `context.timings.getEnergyOverviewMs`.
- No `errors.ts`: an empty house is data. A DB failure is the generic 500 the page handles.

## Pages

Shared by both pages:
- `?year=` search param, `.catch(undefined)` like `/charging/economy`, outside `[min(availableYears), current]`
  → current year. The **same query key** on both pages (`orpc.energy.overview.queryOptions({ input: { year } })`),
  so switching sub-page reuses the cache.
- Loader `prefetchQuery` (not ensure) + `useQuery` with `keepPreviousData`: a failed read shows `LoadErrorAlert`
  under a working heading. `ensureQueryData` on `evCharging.syncStatus` for the `emaldo` health, rendered with the
  existing `SyncHealthAlert`.
- No `refetchInterval` on the overview query (data changes hourly); focus refetch only. The health query keeps its
  60 s interval, as on the charging pages.
- Heading `EnergyHeading` in `ChargingHeading`'s shape: the view's title, a one-line description, and "senast
  synkad …" from the Emaldo health's last success. No sub-page tabs: the sidebar carries the sub-items, as on
  `/charging`.
- Empty: `firstReadingDay === null` → the shared `Empty` ("Ingen energidata ännu", description names Emaldo).

### Energi › Översikt (`/energy`)

```
[SyncHealthAlert: emaldo, only when unhealthy]
┌ Tiles: tabs Denna månad · I år · Totalt ───────────────────┐
│ Solel 509 kWh            Köpt el 561 kWh     Självförsörjning│
│ ▓▓▓░░▒ direkt · batteri  varav 68 kWh till   41 %           │
│ · såld                   batteriet                          │
│ Såld el 114 kWh          Förbrukning 947 kWh                 │
│                          varav laddning 312 kWh             │
│ note: "hittills" / "data saknas för 9 h" when it applies    │
└─────────────────────────────────────────────────────────────┘
┌ Per månad   [Solel | Nät | Förbrukning]   [◀ 2026 ▶] ───────┐
│ Solel: stacked direkt / batteri / såld                      │
│ Nät: köpt direkt + köpt till batteri above the axis,        │
│      såld below it                                          │
│ Förbrukning: laddning + övrigt hus                          │
│ Tooltip: the metric's parts + självförsörjning              │
└─────────────────────────────────────────────────────────────┘
```

### Energi › Batteri (`/energy/battery`)

```
┌ Tiles: Denna månad · I år · Totalt ─────────────────────────┐
│ In 241 kWh (▓ sol 72 % ░ nät 28 %)   Ut 225 kWh             │
│ Förlust 15 kWh (6 %)                  Verkningsgrad 94 %     │
└─────────────────────────────────────────────────────────────┘
┌ Per månad  [Energi | Verkningsgrad]   [◀ 2026 ▶] ───────────┐
│ Energi: per month an "in" bar (sol + nät stacked) beside an │
│   "ut" bar; loss and Δ laddnivå in the tooltip              │
│ Verkningsgrad: one bar per month (%), null months blank     │
└─────────────────────────────────────────────────────────────┘
Note (text-xs, muted): winter loss is mostly the battery heating itself
and standby; loss = in − ut − förändrad laddnivå (C ≈ 7,6 kWh per 100 %).
```

Loss % on the tile = loss ÷ (batteryIn − deltaStored), shown only with efficiency.

### Shared UI rules

- **Components** in `src/components/energy/` (PascalCase). Reuse from `src/components/evCharging/` as-is where
  generic: `YearSelector`, `MetricToggle`, `ChartFrame` (+ `NoData`, `TooltipRow`), `ChartPopover`,
  `LoadErrorAlert`, `SyncHealthAlert`, `format.ts`. Don't fork a charging component to tweak it; a component that
  needs a charging-specific prop changed stays where it is. Moving the generic ones to a shared folder is a
  separate refactor, not part of this work.
- **Charts**: d3-scale + SVG, the existing chart idiom (MonthlyChart). No new chart library.
- **Colours**: `--energy-solar`, `--energy-grid`, `--energy-battery` (step 4 tokens). Export: a lighter tint of
  `--energy-solar` or a hatched pattern (decide in the plan with a contrast check); car: `--brand`.
- **Months without data** render no bar (not a zero bar). The current month's tooltip says "hittills".
- **Responsive**: tiles 1 → 2 → 3/4 columns; 12 bars at phone width with short month labels, like MonthlyChart.
- **Navigation**: sidebar item *Energi* (`SunIcon`) after *Laddning*, `subItems` Översikt / Batteri; both pages in
  the Cmd+K palette (`src/components/command/commands.ts`).
- **i18n**: `energy_*`, `nav_energy*`, `meta_energy_*` keys in `messages/sv.json` (source) + `en.json`.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| Emaldo `not_configured` (Preview, local without creds) | No readings → `Empty`; the health alert explains. |
| Read fails | `LoadErrorAlert` below the heading; the health alert still renders. |
| Month with a gap (e.g. 2026-08-06, 9.4 h) | Figures from what exists; "data saknas för 9 h". |
| First, partial month (2026-01 from the 20th) | Coverage counts from the first reading's day, so no false gap. |
| Current month | Coverage runs to the newest bucket; "hittills". |
| import > load | Self-sufficiency 0 %. |
| Battery in < 1 kWh | Efficiency and grid-charged share hidden ("–"). |
| Negative loss | Tooltip shows it; tile "≈ 0 kWh". |
| `?year=` out of range | Current year. |

## Testing

- **`figures.ts`** (node, test-first): each formula; the clamps (import > load, export > surplus, efficiency > 1);
  the 1 kWh floors; null SoC → Δstored 0; coverage/missing hours.
- **`energyOverview.ts`** (node, `setupDatabase()` first): readings across a month boundary and the
  2026-03-29 spring-forward day; car kWh from intervals + the no-interval fallback, guest sessions included;
  tiles independent of the chart year; all time spanning two years; first-reading-day coverage; current month
  expected buckets to the newest reading; empty DB.
- **Extracted evCharging helper**: the existing overview tests stay green unchanged (it's a move); one new test for
  the all-vehicles scope.
- **Procedure**: year validation, default year, output has no per-bucket arrays (privacy).
- **Components** (browser): tiles per period and the notes; both metric toggles; empty state; sidebar sub-items;
  palette entries; `figures.ts` in the client-safe guard. Layout isn't testable there (no app CSS) → verified live.
- **Live**: desktop, tablet, mobile via Playwright on the local dev server.

## Out of scope (later)

- Kronor: loss cost, battery payoff, export income.
- Day drill-down, intraday curves, live power.
- A rollup table (revisit if `getEnergyOverviewMs` on prod passes ≈200 ms).
- The solar-aware economy page (its own brainstorm).

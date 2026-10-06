# Energi › Batteri (step 2) — design

Status: agreed 2026-10-06, reshaped with the owner before the build because the original step-2 design predates
steps 1b and 1c. Amends the [house energy pages design](./2026-10-05-house-energy-pages-design.md) ("Energi ›
Batteri", "Shared UI rules": charts) and [ADR-0024](../../adr/0024-house-energy-pages.md) decision 6. Builds on the
[period control design](./2026-10-05-energy-period-control-design.md) (step 1b) and the
[flow summary design](./2026-10-06-energy-flow-summary-design.md) (step 1c). Roadmap: step 2 of the
[house energy pages roadmap](../roadmaps/2026-10-05-house-energy-pages.md).
Mockup the owner approved: <https://claude.ai/artifact/9DQUpranaTQ1acazwzLM81> (version 3; prod's 2026 sums).

## Intent

The owner wants to see the home battery on its own: what it took in (from solar, from the grid), what it gave back,
what it lost, and why winter is so much worse than summer. Since step 1c, Översikt's flow diagram already shows one
period's battery loss and "Lager ±". So this page earns its place with the **seasonal story** (the loss month by
month) and a battery-centred view of the chosen period.

**Success:**
- At a glance, for any month, year or all time: how much went in (solar / bought), came out, was lost, and the
  efficiency.
- The month chart shows the winter loss without reading a number (February ≈ 43 % lost, June ≈ 5 %).
- Every figure matches a plain SQL sum over `house_energy_reading` (checkpoint 4).
- No layout shift between periods (step 1b's rule).

## Prod figures the design was shaped on (read-only, 2026-10-06; C = 7,58 kWh)

| Month | In (sol / nät) | Ut | Ändrat lager | Förlust | Share lost | Verkningsgrad |
|---|---|---|---|---|---|---|
| Jan (from the 20th) | 112,5 (1,8 / 110,7) | 65,0 | −1,3 | 48,8 | 43 % | 57 % |
| Feb | 274,5 (25,6 / 248,9) | 157,0 | −0,8 | 118,3 | 43 % | 57 % |
| Mar | 272,7 (121,3 / 151,4) | 231,4 | −0,5 | 41,8 | 15 % | 85 % |
| May | 220,9 (201,6 / 19,3) | 201,5 | +3,6 | 15,8 | 7 % | 93 % |
| Jun | 197,3 (187,5 / 9,8) | 186,8 | +0,8 | 9,7 | 5 % | 95 % |
| Sep | 240,8 (172,9 / 67,9) | 225,4 | +0,4 | 15,0 | 6 % | 94 % |
| Oct (so far) | 55,8 (21,8 / 34,0) | 49,0 | +6,1 | 0,7 | 1 % | 99 % |

`batteryToGrid` (battery energy sold) is 0,0 in every 2026 month so far.

## Owner decisions (2026-10-06)

| # | Decision |
|---|---|
| 1 | **The Summering card comes first, as a flow diagram** in Översikt's visual language (icon tiles, arrow widths by kWh, values switch, table). The original four figure tiles were dropped ("blobs in a card", step 1c). |
| 2 | **The month chart sits below it**: per month one bar of Ut with Förlust stacked on top (mockup variant A). Chosen over two aligned charts (efficiency above in/out) and a loss-only chart. |
| 3 | **The loss is its own node and arrow** (on Översikt it is a stub): on this page it is the main figure. |
| 4 | **Verkningsgrad opens the card** in Självförsörjning's ring. |
| 5 | **The same period control and `?period=`** as Översikt; clicking a month in the chart selects it; switching sub-page keeps the period. |
| 6 | **kWh only, monthly granularity, no new read** (ADR-0024 unchanged). |

## Figures

No new definitions. Everything comes from `energyFigures` (`src/lib/houseEnergy/figures.ts`): `solarToBattery`,
`batteryChargeGridKwh` (bought into the battery, `charge_grid` + `charge_ac`), `batteryIn`, `batteryOut`,
`deltaStored`, `loss`, `efficiency`, `lossShare`, `batteryToGrid`, `batteryToHouse`, `gapHours`, and
`WINTER_LOSS_SHARE` (0,25).

Display rules (shared with step 1c, `lossLabel` / `MIN_LOSS_KWH` in `flowLayout.ts`):
- Loss below 0,5 kWh, or negative: "≈ 0 kWh", no loss arrow, no loss share. The table and tooltips keep the real
  value.
- Efficiency `null` (under 1 kWh in, or under 1 kWh net in): "—", an empty ring. Exactly 1 (capped): "≈ 100 %".
- A share below 1 % that isn't 0: "< 1 %" (`formatShare`).
- Ändrat lager is signed: "+6,1", "−0,8", "0,0" (`formatSignedOneDecimal`).

## UI

### Page

```
Hemmabatteri
Vad batteriet laddade in, gav tillbaka och förlorade. Senast synkad …
[SyncHealthAlert: emaldo, only when unhealthy]
┌ Summering                         ‹ oktober 2026 (hittills) ⌄ › ┐
│ ◔ Verkningsgrad 99 %  av det som laddades in kom ut igen,       │
│                       rättat för lagret                         │
│ ┌──────────┐                                  ┌──────────┐      │
│ │☀ Solel    │──21,8──┐                ┌─49,0─▶│⌂ Ut       │      │
│ │  21,8 kWh │        ▼                │       │  49,0 kWh │      │
│ └──────────┘   ┌──────────────┐       │       └──────────┘      │
│                │▭ Batteri      │───────┤                          │
│                │ Lager +6,1 kWh│       │       ┌──────────┐      │
│ ┌──────────┐   └──────────────┘       └─0,7──▶│🔥 Förlust  │      │
│ │⊤ Köpt el  │──34,0──┘                        │  0,7 kWh  │      │
│ │  34,0 kWh │                                 │ 1 % av …  │      │
│ └──────────┘                                  └──────────┘      │
│ Pilens bredd visar mängden energi. Färgen …       [●] Visa värden│
│ Data saknas för N h                                             │
│ ▸ Visa som tabell                                               │
└─────────────────────────────────────────────────────────────────┘
┌ Batteriet per månad 2026 ───────────────────────────────────────┐
│ 43 %  43 %                                                      │
│ ░░    ░░░                                                       │
│ ██    ███  ░█   █   █   █   █   █   █   █                        │
│ jan   feb  mar apr maj jun jul aug sep okt nov dec               │
│ ■ Ut  ▨ Förlust                                                 │
│ Stapeln är det som gick genom batteriet … Klicka på en månad …  │
└─────────────────────────────────────────────────────────────────┘
Vintertid förloras mer: batteriet värmer sig självt och drar ström i vila när det är kallt. Förlusten räknas som
in − ut − ändrat lager, med 7,58 kWh per 100 % laddnivå.
```

- Route `src/routes/_authenticated/energy/battery.tsx`, title "Hemmabatteri" (`meta_energy_battery_*`).
- Same shell as `/energy` (ADR-0025): `loadRouteData` with the overview query (`energyOverviewQueryFor(period)`,
  **the same cache entry**) and `syncHealthQuery` as critical; `SectionSkeleton`s with their own bones
  (`energy-battery-flow`, `energy-battery-chart`); `LoadErrorAlert`; the shared `Empty` when there are no readings.
- The period state (resolve, rewrite of a stale `?period=`, the stale/failed figure rules, the announcement) is
  exactly Översikt's. It moves out of `energy/index.tsx` into a shared hook used by both pages (a behaviour-preserving
  refactor commit first; see "Code shape").
- The winter note sits under the chart card (`text-sm`, muted, `text-pretty`). Its capacity comes from
  `BATTERY_CAPACITY_KWH` through `formatDecimal`, never a hard-coded number.

### The Summering card (`BatteryFlow`)

Same card frame, period control, period announcement, stale dimming, gap note, "Visa värden" switch (the **same**
`localStorage` key as Översikt, `videbacken-energy-flow-values`: one preference for both diagrams) and "Visa som
tabell" as step 1c's `EnergyFlow`.

**Verkningsgrad line**: Självförsörjning's 44 px ring, the arc in `--energy-battery`, then "Verkningsgrad", the value
(28 px; 24 px narrow) and "av det som laddades in kom ut igen, rättat för lagret". The ring is decorative
(`aria-hidden`); the value is text.

**Nodes** (lucide icons, tiles as step 1c: sources tinted with their arrow colour, others neutral):

| Node | Icon | Figure | Extra line |
|---|---|---|---|
| Solel | `SolarPanel` | `solarToBattery` | — |
| Köpt el | `UtilityPole` | `batteryChargeGridKwh` | — |
| Batteri | `BatteryMedium` (tinted battery) | "Lager ±X kWh" (`deltaStored`) | — |
| Ut | `House` | `batteryOut` | "varav såld X kWh" when `batteryToGrid` ≥ 0,05 (the line's room is always reserved) |
| Förlust | `Flame` (tinted loss) | `loss` per the display rules | "X % av det som laddades in" (wide only; narrow: in the tooltip and table) |

The in-nodes show what went **into the battery**, not the period's whole solar or purchase (those are on Översikt).
The table and the tooltips say so ("Sol → batteri").

**Arrows** (colour = where the energy came from; width linear in kWh on the same scale as step 1c, max 20 px wide /
16 px narrow, 2 px floor; an arrow under 0,05 kWh is not drawn):
- Solel → Batteri (`--energy-solar`), Köpt el → Batteri (`--energy-grid`),
- Batteri → Ut (`--energy-battery`),
- Batteri → Förlust (`--energy-loss`), only when the loss reads as a value (≥ 0,5 kWh).

**Geometry** (`src/lib/houseEnergy/batteryFlowLayout.ts`, pure, client-safe; step 1c's primitives):

| | Wide (card content ≥ 860 px) | Narrow (< 860 px) |
|---|---|---|
| Height | 300 | 430 |
| Nodes | 236 × 80; Ut 236 × 92; battery 220 × 84 | `nw` = min(220, ⌊(W − 24) ÷ 2⌋) × 82; Ut and Förlust × 98; battery min(190, nw + 30) × 82 |
| Positions | Solel top-left, Köpt el bottom-left, battery centre, Ut top-right, Förlust bottom-right | Solel top-left, Köpt el top-right, battery centre, Ut bottom-left, Förlust bottom-right |
| Ports | in: right side → battery's left (−20 / +20); out: battery's right (−20 / +20) → left side | in: bottom → battery's top (∓30·k); out: battery's bottom (∓30·k) → top (±20·k); k = nw ÷ 146 |

With two nodes on each side and every arrow joining the battery, no arrow crosses another or passes through a node.
The box height is reserved per layout by a container query (no layout shift).

**Tooltip** (`ChartPopover placement="above"`, as step 1c): the arrow ("Solel → Batteri"), its kWh, and a share:
in-arrows "X % av det som laddades in"; Batteri → Ut "till huset" or, with a sale, "X till huset · Y såld"; Batteri
→ Förlust its share, the charge levels (`energy_flow_charge_level`) and, above `WINTER_LOSS_SHARE`, the winter hint
(`energy_flow_winter_hint`). The other arrows dim; hit areas ≥ 22 px.

**Table** ("Visa som tabell"; the keyboard and screen-reader path, as step 1c), rows with units: In från sol, In
från nätet, In totalt, Ändrat lager (signed), Ut, varav såld (only when ≥ 0,05), Förlust i batteriet (real value),
Verkningsgrad.

### The month chart (`BatteryMonthlyChart`)

- The visx `BarChart` (`src/components/chart/BarChart.tsx`) with one stack per month: **Ut** (`--energy-battery`) at
  the bottom, **Förlust** (max(0, loss), `--energy-loss` with a 45° hatch) on top. The bar's height is in − ändrat
  lager, so the green share of each bar is the month's efficiency.
- Above a month whose `lossShare` exceeds `WINTER_LOSS_SHARE`, its share as a label ("43 %"); no other labels (the
  data-viz rule: selective direct labels).
- Months without readings draw no bar; a month with readings but a negative loss draws only its Ut.
- Legend: Ut, Förlust (the hatch in the swatch). Hint line: "Stapeln är det som gick genom batteriet: grönt kom ut
  igen, rött förlorades. Klicka på en månad för att se den i summeringen."
- Tooltip (step 1b's card): the month ("(hittills)" for the current one), In with its sol / nät rows, Ändrat lager,
  Ut, Förlust with its share (real value), Verkningsgrad, and the gap note.
- Click / Enter selects the month (`selection`, as Översikt), selected month tinted with a bold label. The chart's
  year is the period's year; the heading is "Batteriet per månad {year}". No metric toggle.
- `BarChart` gets two small, generic extensions: a series `pattern` (a hatch drawn in the chart's own `<defs>`, also
  used by its legend swatch) and an optional `barLabel(row)` drawn above a stack. Both default off, so the existing
  charts don't change.

### Colours

New token `--energy-loss`: `#b91c1c` light, `#dc3c3c` dark (`src/styles/app.css`, with `--color-energy-loss`).
Checked with the data-viz `validate_palette.js --pairs all` against the arrows it appears with:

| Set | Light (#ffffff) | Dark (#1c1c1f) |
|---|---|---|
| solar, grid, battery, loss | CVD ΔE 9,1 (battery ↔ solar), normal 22,5: pass; contrast WARN for yellow and aqua (as step 1c) | CVD 7,2 (loss ↔ battery, the 6–8 floor band), normal 16,2: pass with the required secondary encoding |

The secondary encoding for the dark loss ↔ battery pair: the loss is a labelled node with its own icon, every value
is written (pills, nodes, table), and the chart's loss segment is hatched. The orange `#c2410c` / `#d9541e` of mockup
version 2 failed in dark against solar (normal ΔE 11,3), so the loss is red. The `--energy-grid` chroma-floor fail is
step 1b's deliberate neutral.

### Navigation

- Sidebar: *Energi* gets sub-items *Översikt* (`/energy`) and *Batteri* (`/energy/battery`), matched exactly like
  `/charging`'s. Energy links carry `?period=` between the two (never the charging `year` / `vehicle`).
- Cmd+K: an entry for `/energy/battery` ("Hemmabatteri", `BatteryChargingIcon`, keywords battery, loss, efficiency,
  Emaldo).
- `AppSidebar.browser.test.tsx` now has two "Översikt" links; its `Link` mock is keyed by `to`.

### Empty and failed states

As Översikt: no readings → the shared `Empty`; no readings in the period → "Ingen energidata för perioden." in the
reserved box; figures unavailable → the box stays blank under the alert; another year loading → the old figures stay,
dimmed.

## Code shape

1. **Refactor (behaviour-preserving, its own commit, reviewed first):**
   - the period state of `energy/index.tsx` into a shared hook (`src/components/energy/useEnergyPeriod.ts`);
   - step 1c's flow primitives generalised over node keys (`flowLayout.ts`: ports, curves, arrowheads, widths), and
     the drawing parts (`FlowNodeBox`, `ValuePill`, the icon tile, the ring, the values switch and the table frame)
     moved out of `EnergyFlowDiagram` / `EnergyFlow` into shared modules. Översikt's diagram must render identically
     (its browser tests and the 1c geometry tests stay green unchanged).
2. `BarChart` `pattern` + `barLabel`.
3. `batteryFlowLayout.ts` (geometry tests as step 1c's: nodes inside the box, no overlap, ports on edges, at 324,
   754 and 1006 px).
4. `BatteryFlow` / `BatteryFlowDiagram`, `BatteryMonthlyChart`, the route, sidebar, palette, bones.

## i18n

New `energy_battery_*` keys (sv source, en key-complete): page title and description, the Verkningsgrad line, node
labels Ut and Förlust, "varav såld", the out-arrow tooltip, the chart heading, series, hint and loss label, the
table rows, the winter note; `nav_energy_overview`, `nav_energy_battery`, `nav_energy_battery_long`,
`cmd_kw_energy_battery`, `meta_energy_battery_title`, `meta_energy_battery_description`. Reused: `energy_tile_solar`,
`energy_tile_import`, `energy_flow_battery`, `energy_flow_stored`, `energy_flow_loss_share`,
`energy_flow_charge_level`, `energy_flow_winter_hint`, `energy_flow_show_values`, `energy_flow_table_toggle`,
`energy_flow_hint`, `energy_missing_hours`, `energy_period_no_data`, `energy_chart_so_far`.

## Testing

- **`batteryFlowLayout.ts`** (node, test-first): geometry as above; the loss arrow only from 0,5 kWh; arrows under
  0,05 kWh dropped.
- **`BarChart`** (browser): a patterned series fills with its pattern and its legend swatch shows it; `barLabel`
  draws above the stack's top and nothing when it returns null; charts without them render as before.
- **`BatteryFlow`** (browser): the five nodes' figures, "≈ 0 kWh" for a small or negative loss and no loss arrow,
  "—" and an empty ring for a battery that barely ran, "varav såld" only with a sale, the switch shared with
  Översikt, the table rows, the empty and unavailable states.
- **`BatteryMonthlyChart`** (browser): one stack per month with readings, the loss label only above
  `WINTER_LOSS_SHARE`, the tooltip rows, selection, the no-data state.
- **Page** (browser): heading, both sections, the winter note naming 7,58; Översikt ↔ Batteri share one cache entry;
  empty and failed reads. `clientSafe.browser.test.tsx` guards the new route.
- **Live** (Playwright, local full history, 1440 / 820 / 390 px, light and dark): stepping periods moves neither card
  nor diagram box; no value pill overlaps a node; February's loss label shows; Översikt → Batteri keeps `?period=`
  and makes no second `energy/overview` request; console clean.

## Out of scope

- Kronor (the cost of the loss), a day view, splitting standby from round-trip loss (ADR-0024).
- Splitting the Ut arrow by charge origin (step 1c decision 6).

## Build notes (2026-10-06, step 2 build)

Decided during the build, task by task with two adversarial reviewers each and a whole-branch review. These amend the
sections above.

- **Wide second lines.** Ut's "varav såld" and Förlust's share line start under the icon tile (`x0 + 12`), not beside
  it: beside the tile there are ≈152 px, and "43 % av det som laddades in" needs ≈165 px at 13 px. On narrow nodes
  both second lines shrink to fit (13 → 11 px).
- **In-arrow shares** use `gridChargedShare` (Köpt el) and `1 − gridChargedShare` (Solel) from `figures.ts`, so they
  disappear below `MIN_BATTERY_IN_KWH` like every other battery share. Their base is what went in; the loss share and
  Verkningsgrad use what went in net of Ändrat lager (the two add up to 100 %).
- **Loss share** (node, tooltips, table, the chart's tooltip and its winter label) shows only when the loss reads as a
  value (≥ 0,5 kWh); the kWh figure stays real everywhere.
- **Unknown charge level** (first or last SoC missing): the battery node reads "Lager —", Ändrat lager reads "—" in
  the table and the chart tooltip, and the charge-level line is left out. (Översikt still shows "+0,0 kWh" there; a
  follow-up.)
- **Table.** The Förlust row carries its share, "15,0 kWh (6 %)", so the keyboard and screen-reader path has it on
  narrow screens too; Översikt's charge-level row ("laddnivå 15 → 20 %") is added when both levels are known.
- **Hint.** The battery diagram has its own hint, "… Färgen visar var den kom ifrån; rött är förlusten.", since the
  red loss arrow isn't an origin.
- **Chart labels** that would overlap are skipped, the tallest stack placed first (a full winter month beats a
  partial one). On a 390 px phone only one of two adjacent winter labels shows; the tooltip has the share.
- **The winter note** shows only with the chart card (not under a failed read of another year).
- **Geometry** is pinned from 256 to 1006 px card width (no node overlap, no arrow crossing or passing through a
  node). The narrow node width gets a floor: `nw` = min(220, max(124, ⌊(W − 24) ÷ 2⌋)), so a figure keeps ≥ 100 px of
  room on the narrowest phones (below ≈ 272 px the two top nodes sit 6 px apart); nothing changes from 272 px up.

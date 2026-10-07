# Roadmap — house energy pages (Energi)

Control document for building [the house energy pages design](../specs/2026-10-05-house-energy-pages-design.md)
([ADR-0024](../../adr/0024-house-energy-pages.md)). **One step = one session = one PR.** Each step has its own
self-contained plan. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | Read model + Energi › Översikt (service, `figures.ts`, procedure, nav section, overview page) | [plan](../plans/2026-10-05-energy-1-overview.md) | [#92](https://github.com/ljukas/videbacken/pull/92), fix [#95](https://github.com/ljukas/videbacken/pull/95) | checkpoint passed | 2026-10-05: sums and car match prod; warm `energy.overview` query 52 ms mean over 33 calls (one cold instance 736 ms total); owner accepted, asked for a month choice → step 1b |
| 1b | Period control: any month / year / all time, chart click, tooltip, validated colours, readable sizes, no layout shift | [plan](../plans/2026-10-05-energy-1b-period-control.md) | [#103](https://github.com/ljukas/videbacken/pull/103) | checkpoint passed | 2026-10-06: August, Hela 2026 and Totalt match SQL; warm `energy/overview` 64–67 ms; no shift on prod at 500 px (3 widths only locally); owner accepted, asked for a richer summary → step 1c |
| 1c | Summary as a flow diagram: visx, battery loss, icon tiles, arrow-value switch (replaces the five tiles) | [plan](../plans/2026-10-06-energy-1c-flow-summary.md) | [#112](https://github.com/ljukas/videbacken/pull/112) | checkpoint passed | 2026-10-06: Feb, Aug and Oct table (57 values) = prod SQL within 0,1 kWh; no shift over 10 periods on prod at 500 px (1440 / 820 / 390 px measured locally); owner accepted live |
| 2 | Energi › Batteri: the period's battery as a flow diagram, a month chart of out + loss, winter note (reshaped 2026-10-06) | [plan](../plans/2026-10-05-energy-2-battery.md) | [#124](https://github.com/ljukas/videbacken/pull/124) | checkpoint passed | 2026-10-07: February, May and September in / out / Δstored / loss = prod SQL at one decimal; owner accepted the winter note |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`.

## Owner prerequisites

- **Before step 1 starts:** this roadmap, the spec, ADR-0024 and the step plans are merged to `main`.
- Nothing else: no new env vars, no schema change. The Emaldo sync (ADR-0023) already fills the data.

## How a session runs a step

1. Read this roadmap, the spec and ADR-0024. Find the first step whose status isn't `checkpoint passed`.
   - If it is `merged` but its checkpoint hasn't passed, **run the checkpoint, don't start the next step**. Record
     the result here (in a small `docs(energy): …` PR, or in the next step's PR if the owner says so).
2. Open that step's plan. Its first task checks that `main` still matches the plan's assumptions (file names,
   signatures, the evCharging overview's kWh rule); fix the plan before building if not.
3. Follow `docs/feature-workflow.md` from **Phase 3 (Isolate)**: worktree → task-by-task build with the two paired
   reviewers → branch review → pre-PR gate → PR. Shaping and planning are already done here.
4. In the same PR, update this roadmap's row: PR link and status `PR open`; after merge, `merged`.
5. Stop at the end of the step. Don't start the next step in the same session.

If a step changes a design decision, amend the spec and ADR-0024 in that step's PR and note it below.

## Checkpoints (real-world gates)

Each must pass, with the result recorded in the table, before the next step starts.

1. **After step 1 (prod).** *Passed 2026-10-05 (see the log).*
   - A read-only SELECT on prod of the monthly sums (import, export, solar, load, battery columns) matches the
     page's tooltips for three months, 2026-08 among them; that month shows "data saknas för 14 h" (gaps of 9.4 h on
     08-06 and 4.6 h on 08-23).
   - The car share per month equals `/charging`'s monthly kWh with the scope set to *Alla*.
   - `rpc timing` for `energy.overview` in Vercel Runtime Logs: `totalMs` < 150 ms, `getEnergyOverviewMs` logged.
   - The owner reviews `/energy` live (copy, figures, desktop + phone) and accepts it.
2. **After step 1b (prod).**
   - `/energy?period=2026-08` shows August's figures (they match step 1's SQL) with "data saknas för 14 h"; Hela 2026
     and Totalt match the SQL sums.
   - Switching periods moves nothing: the live Playwright check's bounding boxes are identical at 1440, 820 and
     390 px.
   - `rpc timing` for a year switch: `totalMs` < 150 ms (warm).
   - The owner reviews `/energy` live (picker, chart click, tooltip, colours, sizes; desktop + phone) and accepts it.
3. **After step 1c (prod).** *Passed 2026-10-06 (see the log).*
   - For 2026-02, 2026-08 and 2026-10, every value in the card's table matches a prod SELECT within 0.1 kWh
     (the flows from `energyFigures`; the loss = in − out − ΔSoC × 7,58 kWh).
   - Switching periods moves nothing: the card and the diagram box keep their rects at 1440, 820 and 390 px.
   - The owner reviews `/energy` live (diagram, icons, loss, switch; desktop + phone) and accepts it.
4. **After step 2 (prod).** *Passed 2026-10-07 (see the log).*
   - Battery in / out / loss for 2026-02, 2026-05 and 2026-09 match a prod SELECT (with Δstored from first/last SoC)
     within 0.1 kWh.
   - The owner reviews `/energy/battery` live and accepts the winter note's wording.

Step 2 was reshaped on 2026-10-06 ([battery page design](../specs/2026-10-06-energy-battery-page-design.md)) and its
plan rewritten against steps 1b and 1c; its Task 0 still checks `main` before building.

## Log

- 2026-10-05: shaped in a brainstorm (owner decisions in the spec's table); ADR-0024, spec and this roadmap written.
  Measured locally: a year aggregates in ≈40 ms; February in − out ≈117 kWh of which only ≈18 kWh is idle SoC drop.
- 2026-10-05: step 1 built (branch `feat/energy-overview`), task by task with two adversarial reviewers each plus a
  whole-branch review. Review-driven changes, recorded in the spec: tile coverage counts months with no readings as
  missing; any newest month ends at its newest reading; `year` read from `location.search` (not `loaderDeps`) so the
  chart dims while another year loads; car figure capped at load; export got its own `--energy-export` token (the
  solar tint failed contrast); house share uses `--chart-2`. Live check on the local full history (desktop 1440,
  tablet 820, phone 390, light + dark): no horizontal overflow, console clean; 2026-02, 2026-08 and 2026-10 tooltip
  sums match SQL; August shows "Data saknas för 14 h" locally; the current month says "(hittills)". `rpc timing` for
  `energy.overview` locally: `totalMs` 77, `getEnergyOverviewMs` 75 (`houseScanMs` 68, `carMs` 5). Prod check
  (read-only): no house reading before 2026-01-20 and no counted charging before 2026-01-27.
  Rebased onto #89 mid-review: the page adopts ADR-0025 (`loadRouteData`, `useQuery` for health, `energy-tiles` /
  `energy-chart` skeletons captured with `bones:capture`); a failed read of another year keeps the year selector.
- 2026-10-05: checkpoint 1 run on prod (read-only). Monthly sums of all ten months (2026-01 … 2026-10) match the
  service's query; August's gaps add up to 14 h (9.4 h on 08-06, 4.6 h on 08-23), so the page's "14 h" is right and
  the checkpoint text said 9 h. Car kWh is `/charging`'s own `vehicle: 'all'` figure. **Timing failed:** the one
  logged `energy.overview` took `totalMs` 721 (`houseScanMs` 696); the scan alone was ≈180 ms warm (per-row Stockholm
  conversion + an on-disk sort for the SoC `array_agg`, `work_mem` 2 MB). Fixed in its own PR by summing per UTC hour
  first and probing first/last SoC through the primary key: 40–49 ms on prod, old vs new results identical (prod
  `EXCEPT` empty; local whole-output diff 0). Still open: `rpc timing` after the fix deploys, and the owner's live review.
- 2026-10-05: checkpoint 1 passed. After #95 deployed, `pg_stat_statements` on prod showed the overview query
  33 times: mean 52 ms, min 36 ms, no disk reads, no temp files; one 514 ms call matches the single logged
  `rpc timing` (`totalMs` 736, `getSessionMs` 138), the owner's forced cold load on a fresh instance. A cold first
  request (≈0.7 s) is a connection/instance cost, not this query; left as a follow-up. The owner accepted `/energy`
  functionally ("looks good"; design later) and asked to choose any month.
- 2026-10-05: step 1b shaped with the owner over a clickable mockup (<https://claude.ai/artifact/BJF8ZV8vXwH3DhsPRWVtgv>):
  stepper + a picker that never scrolls, chart click, hover outline and tooltip with shares, no layout shift,
  validated colours (data-viz validator), readable sizes (researched). Design:
  [period control](../specs/2026-10-05-energy-period-control-design.md). The owner also found text too small
  app-wide and decided the whole app follows the same scale; that pass is planned separately (ADR-0015 amendment).
- 2026-10-06: step 1b built (branch `feat/energy-period-control`), task by task with two adversarial reviewers each
  plus a whole-branch review; review-driven changes are in the spec's build notes. Live check on the local full
  history (Playwright, 1440 / 820 / 390 px, light + dark, 7 period steps each: arrows, picker, Hela 2026, Totalt):
  the previous arrow, the period trigger, the tiles card and the chart card kept identical boxes (±0.5 px) in all
  42 runs; readout figures 36 / 28 / 25.4 px; no text under 13 px; console clean. Figures vs a plain SQL sum over
  the Stockholm month: August 2026 solar 715,2 / bought 436,7 / load 896,5 kWh (SQL 715.15 / 436.75 / 896.55), Hela
  2026 4 848,2 / 5 162,0 / 7 842,7 (SQL 4848.21 / 5161.96 / 7842.70); sold and February match too; August says
  "Data saknas för 14 h". Gate: `check:ci` clean, build passes, browser 730/730, node 2424/2424, sv/en keys match.
- 2026-10-06: checkpoint 1b run on prod (read-only). August 715,2 / 436,7 / 258,8 / 896,5 kWh and "Data saknas för
  14 h" (168 missing buckets), Hela 2026 and Totalt 5 620,1 / 6 171,7 / 2 176,6 / 9 365,8 kWh: all equal a plain SQL
  sum. Hela 2026 shows no gap note (coverage ≈ 99,8 %, at or above the 0,99 rule). `energy/overview` warm: `totalMs`
  64–67 (`houseScanMs` ≈ 43); with new pool connections 111 and 147. No shift: 7 period steps on prod at 500 px kept
  identical boxes; 1440 / 820 / 390 px were measured only locally (42 runs, step 1b log), because the owner's Chrome
  window was minimised and the app refuses to be framed. Owner: "The live review looks great", but the swatches of
  the 1b mockup were lost in the build and the five tiles should be a better illustration → step 1c.
- 2026-10-06: step 1c shaped with the owner over a clickable mockup
  (<https://claude.ai/artifact/EuLriFUiKZcpxnaYhXDDHB>, version 4): research (vendor period views, Sankey on
  mobile, self-sufficiency vs self-consumption), a flow diagram in → out with the battery's loss, big lucide icon
  tiles, values on the arrows behind a switch, one-colour battery arrow. Design:
  [flow summary](../specs/2026-10-06-energy-flow-summary-design.md).
- 2026-10-06: step 1c built (branch `feat/energy-flow-summary`, PR #112), task by task with two adversarial
  reviewers each, then a whole-branch ADR + correctness review and one fix wave; rulings and changes are in the
  spec. Live check on the local full history (Playwright, 1440 / 820 / 390 px, light + dark, five periods: October,
  August, February, Hela 2026, Totalt): the period button, the Summering card and the flow box kept identical rects;
  node text inside its node, no pill on a node, no horizontal scroll, console clean, text centred on its tile within
  0,1 px. Skeleton = loaded card at 1100–1440 px (an extra `/energy` bones width at 1220 px closed a 125 px jump).
  Node muted text 5,23:1 light / 6,93:1 dark. 859 px → 490 px narrow, 860 px → 360 px wide. August table rows =
  a plain SQL sum within 0,05 kWh; loss 213,035 − 204,644 + 1,668 = 10,059 → "10,1". Gate: `check:ci` 0 errors,
  build passes, 226 files / 3 454 tests, sv/en keys match. Open: a 4-digit loss overflows the narrow battery node by
  0,9 px at 360 px (prod Totalt loss ≈ 289 kWh); checkpoint 1c on prod.
- 2026-10-06: checkpoint 1c run on prod after #112 deployed (read-only). Every value in the card's table for
  February, August and October (so far) equals a prod SELECT built like `energyFigures` within 0,1 kWh, 57 values:
  e.g. February solar 184,3 / bought 1 880,6 / load 1 908,6 / loss 118,3 kWh (SQL 184.30 / 1880.60 / 1908.59 /
  118.31; laddnivå 34 → 23 %), August loss 10,1 (SQL 10.059) with "Data saknas för 14 h", October loss 0,7 (SQL 0.682;
  laddnivå 19 → 100 %); Batteri → Såld el 0,0 in all three. No shift: stepping October → January (10 periods) on prod
  kept the period button, the card and the flow box identical at 500 px, no horizontal scroll. As in 1b the owner's
  Chrome window was minimised (resize is a no-op, the app refuses to be framed), so 1440 / 820 / 390 px stand on the
  local measurements (step 1c log); a minimised window also pauses the ResizeObserver, so the diagram draws on first
  show into its already-reserved box. Owner reviewed `/energy` live: "It looks good live!" Next: step 2.
- 2026-10-06: step 2 reshaped with the owner before building, because its plan predated 1b and 1c. Mockup
  (<https://claude.ai/artifact/9DQUpranaTQ1acazwzLM81>, version 3, prod's 2026 sums): the seasonal story leads; of
  three chart forms the owner chose one stack per month (out + the loss on top), then asked for the Summering on top
  as a battery flow diagram like Översikt's (Solel and Köpt el → Batteri "Lager ±" → Ut and Förlust, Verkningsgrad
  in the ring). New `--energy-loss` red (#b91c1c / #dc3c3c): the mockup's orange failed against dark solar
  (`--pairs all`). Design: [battery page](../specs/2026-10-06-energy-battery-page-design.md); ADR-0024 decision 6
  amended; the plan rewritten (two refactor commits first: the shared period hook, the shared flow parts).
- 2026-10-06: step 2 built (branch `feat/energy-battery`, PR #124), task by task with two adversarial reviewers
  each, then a whole-branch review and one fix wave; decisions are in the spec's build notes (loss share only from
  0,5 kWh everywhere, unknown charge level "—", in-arrow shares from `gridChargedShare`, a battery-specific hint,
  overlapping chart labels skipped tallest first, a 124 px node floor below 272 px). Live check on the local full
  history (Playwright, 1440 / 820 / 390 px, light + dark): 0,0 px shift over 12 periods, node text ≥ 26 px clear at
  390 px Totalt, February loss 118,3 kWh = SQL (43 %), Översikt ↔ Batteri keeps `?period=` with no request, console
  clean; seven months' tables = a plain SQL sum within 0,1 kWh. Gate: `check:ci` clean, build passes, 235 files /
  3 780 tests, sv/en keys match. Next: checkpoint 4 on prod after merge.
- 2026-10-07: checkpoint 4 run on prod after #124 deployed (read-only). The Summering card for February, May and
  September equals a prod SELECT over the Stockholm month (in = `charge_solar` + `charge_grid` + `charge_ac`, out =
  `discharge`, Δstored from the first / last bucket with a SoC × 7,58 kWh) at one decimal: February Solel 25,6 /
  Köpt el 248,9 / Ut 157,0 / Lager −0,8 / Förlust 118,3 kWh, 57 % (SQL loss 118.310, laddnivå 34 → 23 %); May
  201,6 / 19,3 / 201,5 / +3,6 / 15,8 kWh, 93 % (SQL 15.831, 33 → 80 %); September 172,9 / 67,9 / 225,4 / +0,4 /
  15,0 kWh, 94 % (SQL 15.035, 15 → 20 %). The owner's Chrome window was minimised again (500 px), so the diagram drew
  only once a screenshot forced a paint, as in 1c. The owner accepted the winter note's wording. The roadmap is done.
- 2026-10-07: the owner left step 2's four open items to the agent. Rulings: (1) the chart hint keeps naming its
  colours (the owner likes them; the legend names the series too). (2) Verkningsgrad and the loss share both divide by
  what stayed in (in − Δstored), so they add up to 100 %; the in-arrows' shares divide by the raw in, so the two arrows
  add up to 100 %. Each base is right for its pair; at monthly granularity Δstored is at most 7,58 kWh against months
  of 100–275 kWh in, so the copy stays. (3) Översikt's Köpt el → Batteri caps the battery's grid charge at the import,
  and Batteri doesn't. On prod every month imports at least 5× the grid charge and `charge_ac` is 0, so the figures
  are identical; kept as is. (4) Översikt's table read "0,0 kWh" for an unknown charge level: fixed to "—" like
  Batteri, in its own PR (no prod bucket lacks a SoC today, so it never showed).

# Roadmap — house energy pages (Energi)

Control document for building [the house energy pages design](../specs/2026-10-05-house-energy-pages-design.md)
([ADR-0024](../../adr/0024-house-energy-pages.md)). **One step = one session = one PR.** Each step has its own
self-contained plan. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | Read model + Energi › Översikt (service, `figures.ts`, procedure, nav section, overview page) | [plan](../plans/2026-10-05-energy-1-overview.md) | [#92](https://github.com/ljukas/videbacken/pull/92), fix [#95](https://github.com/ljukas/videbacken/pull/95) | checkpoint passed | 2026-10-05: sums and car match prod; warm `energy.overview` query 52 ms mean over 33 calls (one cold instance 736 ms total); owner accepted, asked for a month choice → step 1b |
| 1b | Period control: any month / year / all time, chart click, tooltip, validated colours, readable sizes, no layout shift | [plan](../plans/2026-10-05-energy-1b-period-control.md) | — | not started | — |
| 2 | Energi › Batteri (battery tiles, monthly chart, winter note) | [plan](../plans/2026-10-05-energy-2-battery.md) | — | not started | — |

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
3. **After step 2 (prod).**
   - Battery in / out / loss for 2026-02, 2026-05 and 2026-09 match a prod SELECT (with Δstored from first/last SoC)
     within 0.1 kWh.
   - The owner reviews `/energy/battery` live and accepts the winter note's wording.

Step 2's plan predates step 1b: its Task 0 must re-check it against step 1b's `EnergyOverview` shape (`yearTotal`,
`allTime`, `monthsWithReadings`; no `tiles.thisMonth`), the period control (no `PeriodTabs`) and the colour tokens,
and rewrite the affected tasks before building.

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

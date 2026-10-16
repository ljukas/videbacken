# Roadmap — heat pumps (Panasonic Comfort Cloud)

Control document for building [the heat pumps design](../specs/2026-10-08-heat-pumps-design.md)
([ADR-0027](../../adr/0027-heat-pump-energy-data.md)). **One step = one session = one PR.** Each step has its own
self-contained plan. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1a | Adapter + storage, nothing calls it yet: the TypeScript Comfort Cloud client (login, units, UTC day and month history), `heat_pump` + `heat_pump_reading`, the service's writes | [plan](../plans/2026-10-08-heat-pumps-1a-adapter-storage.md) | [#146](https://github.com/ljukas/videbacken/pull/146) | checkpoint passed | passed 2026-10-11: live login (1 login, 10 requests, 0 retries), both units listed (Matsal, Övervåning, `CS-HZ25ZKE`, registered 2024-10-31 / 2024-11-27), UTC day 2026-10-10 stored through `replaceDay`: 24/24 hours per unit equal the Python probe; run output clean of password, user, tokens, api key, HTML and full guids |
| 1b | Sync live: the `comfortCloud` source (CHECK migration), credentials, sync + backfill + 6-hour cron, Datakällor tile, Synka nu, health copy | [plan](../plans/2026-10-08-heat-pumps-1b-sync.md) | [#151](https://github.com/ljukas/videbacken/pull/151) | checkpoint passed | passed 2026-10-12: backfill complete (first stored UTC day = `registered_on`: 2024-10-31 / 2024-11-27, both `history_complete_at` set); 2025-11, 2026-02 and 2026-09 per unit match the app to the whole kWh, every hour of each month stored (2025-11 replaced 2025-02: the app shows months only a year back); 2025-10-26 and 2026-03-29 have 24 distinct hours per unit; 14 runs `ok` (12 admin backfill runs ≈ 120 s each, then 5.9 s and the 00:20 cron at 7.3 s, 0 retries, matching the runtime log). The owner accepted one cron run instead of four over 24 h |
| 2 | Energi › Översikt: the Användning flow diagram, the month chart's four-part Förbrukning, the Comfort Cloud health alert | [plan](../plans/2026-10-08-heat-pumps-2-overview.md) | [#157](https://github.com/ljukas/videbacken/pull/157) | checkpoint passed | 2026-10-13: Användning for 2026-02, 2026-09 and 2026-10 equals prod SQL per unit to the Wh (Matsal 454,1 / 55,5 / 38,8, Övervåning 158,0 / 36,0 / 19,8 kWh), laddning equals `/charging`'s Alla, övrigt hus = load − laddning − heat pumps; every month's Förbrukning stack sums to its load; no box moved over 11 period switches at 500 px (prod; the three widths were checked locally in #157); warm `totalMs` median 35 ms against 35.5 before (n = 19 / 20). **Failed:** warm `heatPumpMs` (median 24) exceeds `carMs` (16), the view trigger → step 2b (owner). Owner accepted Översikt; "Övrigt hus" and "Övrigt i huset" become one string. See [checkpoint 3 result](#checkpoint-3-result) |
| 2b | `heat_pump_day` materialized view (ADR-0027 decision 6's trigger, met at checkpoint 3): the heat pump sums read whole Stockholm days from the view and a range's partial first and last day from the readings by primary key, refreshed after each Comfort Cloud run that stored hours; schema review | [plan](../plans/2026-10-15-heat-pumps-2b-day-view.md) | [#164](https://github.com/ljukas/videbacken/pull/164) | checkpoint passed | passed 2026-10-15 (prod, #164 deployed 13:09 UTC): Användning for 2026-01 (Matsal 158,619 / Övervåning 67,931 kWh), 2026-02 and 2026-09 equal prod SQL, 2026-02 and 2026-09 to the Wh of checkpoint 3, and 2026-10 equals SQL at 13:11 UTC (47,977 / 23,224); warm `energy/overview` (n = 44, all `poolOpened` 0): `heatPumpMs` median 7 ms (6–33) against 24 at checkpoint 3, below `carMs` (median 13) in 44 of 44, `totalMs` median 25 (22–52) against 35; the owner's "Synka nu" run line logs `refreshMs` 92 (`ok`, 122 hours stored, 7.1 s, 0 retries) and the view then held every reading (33 551 hours); `anon` and `authenticated` have no SELECT on `heat_pump_day`. The owner accepted the zero-hours half on the test (`sync.test.ts`: a run that stored nothing logs `refreshMs` 0): every `ok` prod run re-fetches the recent days |
| 3 | Energi › Värmepumpar, consumption: page, nav, period control, month and day charts with last year and outdoor temperature, tiles | [plan](../plans/2026-10-08-heat-pumps-3-page.md) | [#166](https://github.com/ljukas/videbacken/pull/166) | checkpoint passed | passed 2026-10-16 (prod, #166 deployed 10:52 UTC): `heatPump.months` for 2026 and `heatPump.days` for 2026-01 equal SQL over the raw readings (not the view) in all 106 cells (20 unit-months of 2026, 24 of 2025's outline, 62 unit-days of January): kWh and heating kWh within 0,5 Wh, hours exact, the outdoor mean exact (e.g. 2026-02 Matsal 454,075 / Övervåning 157,996 kWh, 672 h each); the outdoor line equals the hour-weighted mean over both units every month; `lastYearSoFar` (2025-10 cut at the same hour, 367 h per unit) equals SQL (55,610 / 29,777 kWh). The rendered page agrees: 2026-02 tiles 454 / 158 kWh, +37 / +21 %, −4,2 °C; 2026-01 386 / 165 kWh, +14 / +25 %, −1,7 °C; the 15 January tooltip 8,7 + 4,0 = 12,7 kWh, 1,1 °C; År 2026 hittills 1 625 (+5 %) / 759 kWh (+1 %) with "Data saknas för 4 h" (2 h in March, 2 in July); February's outline 462,6 kWh. The owner reviewed Värmepumpar on desktop and phone and accepted it |
| 4a | Händelser: `heat_pump_event`, admin CRUD dialog, markers on the day chart | [plan](../plans/2026-10-08-heat-pumps-4a-events.md) | | not started | |
| 4b | Energisignatur: `signature.ts`, the scatter, the before/after readout | [plan](../plans/2026-10-08-heat-pumps-4b-signature.md) | | not started | |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`. `needs shaping` means
the step needs a short design pass (and its plan) before it is built.

## Owner prerequisites

- **Before step 1a starts:** this roadmap, the spec, ADR-0027 and the step plans are merged to `main`.
- **Local, already done (2026-10-08):** `PANASONIC_USER` / `PANASONIC_PASSWORD` in `.env.local` (used by step 1a's
  live check and step 1b's local run).
- **Before step 1b deploys, done 2026-10-11:** `PANASONIC_USER` / `PANASONIC_PASSWORD` are set in Vercel
  **Production** only (not Preview), as sensitive variables. Without them the source shows `not_configured`; they can
  also be overridden in Datakällor after the deploy.
- **Step 4a's checkpoint:** enter the first event, the **service on 2026-10-08, both units** (the units were set to
  maximum before the service and switched off during it; that morning's hours are not normal operation).

## How a session runs a step

1. Read this roadmap, the spec and ADR-0027. Find the first step whose status isn't `checkpoint passed`.
   - If it is `merged` but its checkpoint hasn't passed, **run the checkpoint, don't start the next step**. Record
     the result here (in a small `docs(heat-pumps): …` PR, or in the next step's PR if the owner says so).
2. Open that step's plan. Its first task checks that `main` still matches the plan's assumptions (file names,
   signatures, the source lists); fix the plan before building if not.
3. Follow `docs/feature-workflow.md` from **Phase 3 (Isolate)**: worktree → task-by-task build (schema gate right
   after a schema task) → step review (core three + every triggered specialist) → pre-PR gate → PR. Shaping and
   planning are already done here. The plans predate per-step review: a task's **Reviewers:** line no longer runs
   after that task, it names a specialist to add to the step review; the plan's branch-review task is the step review.
4. In the same PR, update this roadmap's row: PR link and status `PR open`; after merge, `merged`.
5. Stop at the end of the step. Don't start the next step in the same session.

If a step changes a design decision, amend the spec and ADR-0027 in that step's PR and note it below.

## Checkpoints (real-world gates)

Each must pass, with the result recorded in the table, before the next step starts.

1. **After step 1a (local).**
   - A one-off script (not committed) runs the new adapter with the `.env.local` credentials: login succeeds, both
     units are listed (Matsal, Övervåning, `CS-HZ25ZKE`), and yesterday's 24 hourly kWh per unit, stored through
     `replaceDay` into the local DB, equal what the Python probe returns for the same day.
   - The adapter logs no password, token, api key or raw HTML (grep the run's output).
2. **After step 1b (prod).**
   - The backfill is complete: Matsal's first stored hour is on 2024-10-31 and Övervåning's on 2024-11-27, both
     units have `registered_on` (2024-10-31, 2024-11-27) and `history_complete_at` set.
   - For three months (2025-02, 2026-02, 2026-09), each unit's kWh from a read-only prod SELECT equals the monthly
     figure the Comfort Cloud app shows (the owner reads it off the app).
   - 2025-10-26 and 2026-03-29 have 24 stored hours per unit (UTC); no hour is duplicated.
   - The source has stayed green for 24 h (four cron runs), each `integration sync run` line under 60 s.
3. **After step 2 (prod).**
   - For 2026-02, 2026-09 and 2026-10, each unit's kWh on Användning equals the prod SQL sum over the Stockholm
     month; laddning equals `/charging`'s *Alla*; övrigt hus = load − laddning − heat pumps.
   - The month chart's Förbrukning parts add up to the load.
   - Switching periods moves nothing (both cards keep their boxes at 1440, 820, 390 px).
   - `rpc timing` for `energy.overview`: `heatPumpMs` logged, the warm `totalMs` within 20 ms of before step 2, and
     `heatPumpMs` below the view trigger (ADR-0027 decision 6).
   - The owner reviews Översikt live (desktop + phone) and accepts it.
3b. **After step 2b (prod).**
   - Användning for 2026-01 (the house data's first, partial month), 2026-02 and the current month equals the
     figures recorded at checkpoint 3 (the current month: prod SQL at the time of the check).
   - Warm `heatPumpMs` below `carMs` and under 25 ms (ADR-0027 decision 6), warm `totalMs` not above checkpoint
     3's 35 ms median; at least 15 samples.
   - The Comfort Cloud run line logs `refreshMs`, and a run that stored no hours logs `refreshMs` 0.
   - `anon` and `authenticated` can't read the view: `has_table_privilege('anon', 'heat_pump_day', 'SELECT')` and
     the same for `authenticated` are both false (read-only SQL).
4. **After step 3 (prod).**
   - A month view (2026-02) and a day view (one day in 2026-01) equal SQL per unit; last year's outline equals
     2025's sums; the outdoor line equals the hour-weighted mean.
   - The owner reviews Värmepumpar live and accepts it.
5. **After step 4a (prod).**
   - The owner enters the 2026-10-08 service (both units) through the dialog; it shows on the October day chart.
   - A non-admin account sees the list but no add/edit/delete.
6. **After step 4b (prod).**
   - Once at least 14 qualifying heating days after the service exist (expected November 2026): the readout per
     unit is reproduced independently (SQL for the daily sums + a separate least-squares fit) within 0.5
     percentage points.
   - The owner judges whether the readout is plausible and the wording clear.

## Checkpoint 3 result

Run 2026-10-13 on prod (`main` at `889b919`; #157 deployed 2026-10-12 07:50 UTC), read-only: the owner's signed-in
browser, read-only SQL, `vercel logs`.

- **Figures.** `energy.overview` for 2026 and Användning's table, against SQL over the Stockholm month
  (`heat_pump_reading`, `house_energy_month`) and `evCharging.overview` with `vehicle: 'all'`. None of the three
  months is capped (the heat pumps are well under load − laddning). Shares are rounded per row, so October's add up to
  99 %.

  | Month | Matsal | Övervåning | Laddning | Övrigt hus | Load | Hours (Matsal / Övervåning) |
  |---|---|---|---|---|---|---|
  | 2026-02 | 454,075 | 157,996 | 60,091 | 1 236,431 | 1 908,593 | 672 / 672 |
  | 2026-09 | 55,462 | 36,023 | 211,034 | 644,314 | 946,833 | 720 / 720 |
  | 2026-10 | 38,790 | 19,760 | 64,478 | 340,610 | 463,638 | 303 / 302 (to 2026-10-13) |

- **Förbrukning stack.** In the month chart's Förbrukning view, each month's bar parts (laddning, Matsal,
  Övervåning, övrigt i huset) add up to the month's load at one scale, 0.09500 px/kWh, January through October.
- **No layout shift, 500 px only.** Prod sends `X-Frame-Options: DENY` and the browser window couldn't be resized,
  so the check ran at the window's 500 px: Summering and Användning kept identical boxes over 11 switches (January,
  February, March, May, August, September, October, År 2026, Totalt, then February and July again), with no
  horizontal overflow. #157 checked 1440, 820 and 390 px locally (the same split as Energi's checkpoint 1b).
- **Timing.** Every `energy/overview` line since the deploy has `heatPumpMs`. Warm means no new connection
  (`poolOpened` 0) and `queueMs` under 200; 20 read-only requests were sent from the owner's session, 2 s apart.

  | Warm `energy/overview` | n | `totalMs` | `carMs` | `heatPumpMs` | `houseScanMs` |
  |---|---|---|---|---|---|
  | Before step 2 (2026-10-07 → #154's deploy) | 20 | 35.5 (27–186) | 15.5 | — | 7 |
  | After step 2 (2026-10-13 15:00 UTC) | 19 | 35 (32–50) | 16 (14–32) | 24 (22–33) | 3 |

  `totalMs` didn't move because the car and heat pump reads run in parallel: the heat pump read is now the slower
  of the two in 17 of 19 requests. That is ADR-0027 decision 6's trigger for the `heat_pump_month` view (warm
  `heatPumpMs` over `carMs`), so the checkpoint's "below the view trigger" criterion failed. The owner chose to add
  the view now, as **step 2b**, before step 3.
- **Owner (2026-10-13).** Översikt accepted. "Övrigt i huset" (the chart's legend) and "Övrigt hus" (Användning)
  become one string, "Övrigt i huset", in a small fix PR. Colours stay in all-time name order.
- **For step 2b's design.** The overview reads the heat pumps over the house data's range, from the first house
  reading's Stockholm day (2026-01-20, mid-month) to the newest house bucket. Whole-month view rows can't answer those
  two edge months. Step 3's plan also reads a part month, last year's month up to the same moment a year ago
  (`lastYearSoFar`). `heat_pump_reading` has no `hour_start` index (the 1a schema review), so a raw read of an edge
  range scans the table unless it goes unit by unit through the primary key. Decide between per-month rows plus
  per-unit edge reads, per-day rows (which step 3's day chart could also read), or another shape, with `EXPLAIN`
  on a copy of prod's readings.

## Log

- 2026-10-08: feasibility spike (read-only live probe with `aio-panasonic-comfort-cloud` 2026.8.9): password login
  without MFA, 24 h access token, rotating refresh token, hourly history per unit stored as UTC hours, history from
  2024-10-31 / 2024-11-27, status reads flaky (`5005`). The probe's logins didn't log the owner's app out.
- 2026-10-08: shaped in a brainstorm (owner decisions in the spec's table); ADR-0027, spec and this roadmap written.
  The units were serviced on 2026-10-08 (the first event to log, step 4a).
- 2026-10-11: step plans written (one planner per step against a shared interface brief). Planning rulings folded into
  the spec and ADR: SCREAMING_SNAKE domain codes, `created_by` uuid, `registered_on` ends the backfill, the recent
  window re-fetches back to the last successful run (≤ 14 days), the offline rule fails every run while yesterday is
  empty (14-day cut-off), trailing heat pump lag < 13 h isn't "missing", `byHeatPumpName` orders units everywhere,
  the signature excludes off days (owner) and fetches its window in ≤ 800-day chunks.
- 2026-10-11: step 1a built (#146). Reviews tightened the login: the password, callback and token POSTs are never
  retried, the code is taken only from the exact app redirect URI, a 429 or a refused fresh token also blocks logins
  for 5 minutes, 4106/4103 match the JSON `code` field, and a `null` history field becomes null. The schema review
  ruled no `hour_start` index. Carried forward: **step 1b**: `deviceRegisterTime` may be a local date, so the
  backfill should also fetch `registered_on − 1`; and the `oldestDay` cursor must skip past a day `monthDays` lists
  but that stores no rows or is rejected. **Step 2**: the whole-history month read measured ≈ 11 ms at today's 35k
  rows and ≈ 43 ms at 131k, and an index doesn't help, so plan a `heat_pump_month` materialized view like
  `house_energy_month` (ADR-0024) or a `heatPumpMs` threshold for adding one.
- 2026-10-11: step 1b built. Reviews added: a persisted backfill cursor (`heat_pump.backfill_cursor`, migration 0025)
  so listed-but-empty days can't stall the walk across runs; the walk reaches `registered_on − 1` (the 1a
  carry-forward); a rejected yesterday fails the run (fail closed on a changed API) and holds that unit's backfill, as
  does a quiet yesterday. A day whose own rows the client rejects (`ComfortCloudDayError`: a repeated hour, a row
  outside the day) counts as rejected (it no longer fails every catch-up run or pins the cursor), while an answer it
  can't read at all (HTTP 400/404, not JSON, a bad envelope) still fails the run and keeps the cursor at that day; the
  catch-up resumes the day before the last success's day; a unit that answers today after a quiet yesterday only
  warns, and a unit quiet for more than 14 days (warn-only) keeps its backfill held until data returns.
- 2026-10-11: carried forward from step 1b. **Step 2**: a removed unit keeps its `heat_pump` row (`listUnits` returns
  it), so `heatPumpMissingHours` must clip expected hours at the unit's `last_seen_at` (or leave out units not listed
  recently), else "data saknas" forever. **Step 3**: the heat pump procedures map rows to `{ id, name, model, … }` and
  never return the `HeatPump` row (it carries the full `guid` and `backfill_cursor`); switch `SyncNowButton.tsx`'s
  `HEAT_PUMP_QUERY_PREFIX` to `orpc.heatPump.key()`.
- 2026-10-11: step 1b local live run (owner's account, `.env.local`): the cron route answered 401 without the secret;
  run 1 fetched 122 days (2 units, 1 login, 136 requests, 0 retries) in the 120 s budget, all counts-only in the run
  line; a second run started 2 min later got HTTP 429 after 90 more days (≈ 210 day calls in 4.5 min) and failed
  cleanly as `rate_limited`, keeping what it stored. One run per 6 h stays far below that; two "Synka nu" in a row may
  hit it. A run 15 min later recovered (`ok`, 126 days) and resumed from the saved backfill cursor.
- 2026-10-12: checkpoint 2 (prod). The owner ran "Synka nu" 12 times in ≈ 90 min (2026-10-11 17:11–18:38 UTC):
  every run `ok`, ≈ 120 day calls each, no HTTP 429 (unlike the local runs), and the backfill completed. The 18:20 cron
  fired while an admin run held the lease and logged `skipped`, as designed. After the backfill a run fetches only the
  recent days (6 day calls, 14 requests, ≈ 6–7 s). `backfill_cursor` keeps its last pre-completion value; harmless,
  `history_complete_at` stops the walk. A handful of days per unit have fewer than 24 hours (mostly the same days on
  both units, i.e. outages): step 2's and step 3's "data saknas" notes will show them.
- 2026-10-12: step 2 built. Rulings: a unit Comfort Cloud no longer lists (an older `last_seen_at` than the newest)
  counts its missing hours only up to its last listing, and the whole source failing still counts every gap (the
  1b carry-forward; spec "Expected hours"); the month read aggregates before joining the unit (≈ 13 ms over ≈ 33k
  rows, no spill), so no view yet, with a `heatPumpMs` trigger for adding one (ADR-0027 decision 6); the heat pump
  scale falls back to 1 without heat pumps; a unit with earlier readings keeps its node (0 kWh) in a new month's
  first hours before the next run; the usage arrows are scaled together when they don't fit the lane, so they never
  overlap; a long unit name is fitted in one measuring pass (one character per render crashed React past ≈ 55
  characters). Parked: capping a year as the sum of capped months, the rounded top of capped Förbrukning bars,
  colour by all-time name order. Carried forward to **step 3**: `heatPumpRead.ts` must use the same expected-hours
  rule, including the removed-unit clip; reuse or extract `heatPumpPeriods`'s unit end from `energyOverview.ts`
  rather than re-deriving it.
- 2026-10-13: checkpoint 3 (prod). The figures, the Förbrukning stack, the layout (at 500 px) and `totalMs` passed,
  and the owner accepted Översikt. Warm `heatPumpMs` (median 24 ms) exceeds `carMs` (16 ms), ADR-0027 decision 6's
  trigger, so the owner added **step 2b**, the `heat_pump_month` view, before step 3. The two "övrigt" labels become
  one string ("Övrigt i huset") in a separate fix PR. See [checkpoint 3 result](#checkpoint-3-result).
- 2026-10-15: step 2b shaped, planned and built. A per-day view (`heat_pump_day`), not per month: Översikt's range
  ends mid-day, step 3's `lastYearSoFar` is a part month, and its day chart and step 4b read days. Prod `EXPLAIN
  ANALYZE` (33.5k readings): the month read's scan 11.3 ms warm, building the day sums 28 ms (1,403 rows), a partial
  day by primary key 0.22 ms. `refreshAfterSync` moved to `integrations/` (owner). Schema review rulings: months keyed
  as dates (no session time zone in the cast), the refresh runs serially (a parallel aggregate would make
  CONCURRENTLY rewrite every row), the unique index stays (`heat_pump_id`, `day`) (every read is a near-whole-view
  day range, a 25-page scan). Carried forward: **step 3**: `daySums` reads whole days from `heat_pump_day` (means =
  `*_c_sum / nullif(*_c_hours, 0)`), joins `heat_pump` (a unit deleted since the last refresh must not show) and
  keys days and months as dates; `lastYearSoFar` is a `monthSums` call with the mid-day cut; tests store through the
  `storeHours` fixture (it refreshes) or call `refreshDaySums()`. **Step 4b**: its day reads go through step 3's
  `daySums`, so they read the view.
- 2026-10-15: checkpoint 3b (prod) passed; see row 2b. The view took the heat pump read from a median 24 ms to
  7 ms, now well under the car read, and Översikt's `totalMs` from 35 to 25 ms. A run that stores no hours doesn't
  happen on prod in practice (every `ok` run re-fetches the recent days), so that half rests on the sync test (owner).
  Next: step 3.
- 2026-10-15: step 3 built. Rulings during the build: `daySums` and `readingSpans` read `heat_pump_day` (joined with
  `heat_pump`); Översikt's unit end rule (13 h lag, removed-unit clip) moved to `services/heatPump/unitEnd.ts` and both
  pages use it (expected hours rounded up on both). The step review (six reviewers) found the change tile comparing
  unequal spans (a unit's first partial year or month passed the 99 % gate: 2025 vs Q4 2024, October 2025 vs one day),
  so the spec now says the change compares equal spans: every month of the period present and ≥ 99 % of the
  **calendar** hours (`spanHours`) in both periods, plus the expected-hours gate (a stall hides it); a running period
  ends where each unit's own data ends and last year is cut at the same hour (a removed unit never compares). Also
  fixed: a blank card when the default resolves to Totalt (1 January's first hours), a render loop in that fix, tile
  lines that collapsed, a stale chart tooltip after a month click, no empty °C axis, no "−0,0 °C". Live (local, 1440 /
  820 / 390 px, light and dark): the card keeps one height across month, year and Totalt (522 / 636 / 704 px), no
  overflow, the right axis inside the card at 390 px, colours as Användning's, figures equal SQL within 0,05.
  Local EXPLAIN: the month's days 0,23 ms (view), the spans 0,27 ms (view), a partial day 0,14 ms (primary key).
  **Bundle:** the entry grew 176,7 → 178,0 KB gz: with a third route sharing the Energi period card, rolldown stops
  merging `stockholm`, `toDate` and `energySearch` into the entry and loads them as chunks (≈ 1,0 KB of chunk
  overhead; the loader ≈ 0,3); no principled fix found in a time-boxed dig (six experiments; grouping them is barred
  by the entry rule). `/energy` 80 → 82, `/energy/heat-pumps` 65 beyond entry + shell. Owner's call in the PR.
  Next: checkpoint 4 on prod.
- 2026-10-16: checkpoint 4 (prod) passed; see row 3. The figures were checked against SQL over the raw readings, so
  they also confirm the `heat_pump_day` view the page reads. Next: step 4a (Händelser).

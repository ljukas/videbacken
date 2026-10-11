# Roadmap — heat pumps (Panasonic Comfort Cloud)

Control document for building [the heat pumps design](../specs/2026-10-08-heat-pumps-design.md)
([ADR-0027](../../adr/0027-heat-pump-energy-data.md)). **One step = one session = one PR.** Each step has its own
self-contained plan. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1a | Adapter + storage, nothing calls it yet: the TypeScript Comfort Cloud client (login, units, UTC day and month history), `heat_pump` + `heat_pump_reading`, the service's writes | [plan](../plans/2026-10-08-heat-pumps-1a-adapter-storage.md) | [#146](https://github.com/ljukas/videbacken/pull/146) | checkpoint passed | passed 2026-10-11: live login (1 login, 10 requests, 0 retries), both units listed (Matsal, Övervåning, `CS-HZ25ZKE`, registered 2024-10-31 / 2024-11-27), UTC day 2026-10-10 stored through `replaceDay`: 24/24 hours per unit equal the Python probe; run output clean of password, user, tokens, api key, HTML and full guids |
| 1b | Sync live: the `comfortCloud` source (CHECK migration), credentials, sync + backfill + 6-hour cron, Datakällor tile, Synka nu, health copy | [plan](../plans/2026-10-08-heat-pumps-1b-sync.md) | [#151](https://github.com/ljukas/videbacken/pull/151) | PR open | |
| 2 | Energi › Översikt: the Användning flow diagram, the month chart's four-part Förbrukning, the Comfort Cloud health alert | [plan](../plans/2026-10-08-heat-pumps-2-overview.md) | | not started | |
| 3 | Energi › Värmepumpar, consumption: page, nav, period control, month and day charts with last year and outdoor temperature, tiles | [plan](../plans/2026-10-08-heat-pumps-3-page.md) | | not started | |
| 4a | Händelser: `heat_pump_event`, admin CRUD dialog, markers on the day chart | [plan](../plans/2026-10-08-heat-pumps-4a-events.md) | | not started | |
| 4b | Energisignatur: `signature.ts`, the scatter, the before/after readout | [plan](../plans/2026-10-08-heat-pumps-4b-signature.md) | | not started | |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`.

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
3. Follow `docs/feature-workflow.md` from **Phase 3 (Isolate)**: worktree → task-by-task build with the two paired
   reviewers → branch review → pre-PR gate → PR. Shaping and planning are already done here.
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
   - `rpc timing` for `energy.overview`: `heatPumpMs` logged, the warm `totalMs` within 20 ms of before step 2.
   - The owner reviews Översikt live (desktop + phone) and accepts it.
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

# Roadmap — solar-aware charging cost (Emaldo)

Control document for building [the solar-aware cost design](../specs/2026-10-03-ev-charging-solar-cost-design.md)
([ADR-0023](../../adr/0023-solar-aware-charging-cost.md)). **One step = one session = one PR.** Each step has its
own self-contained plan. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | Emaldo client (effect, env, `not_configured`; unused) | [plan](../plans/2026-10-03-solar-cost-1-emaldo-client.md) | [#68](https://github.com/ljukas/videbacken/pull/68) | checkpoint passed | 2026-10-03: 288/288 + 276/276 buckets, 0 mismatches (11 requests, 1 login) |
| 2 | Raw readings sync (table, service, source, cron, backfill, health) | [plan](../plans/2026-10-03-solar-cost-2-readings-sync.md) | [#70](https://github.com/ljukas/videbacken/pull/70) | checkpoint passed | 2026-10-04: backfill 2026-01-20 → yesterday (258/258 days), health `ok`, cron listed; balance ±2 % on 225/257 days (monthly ≤1.5 %), `charge_ac` = 0 (unused) |
| 2b | Battery state of charge (SoC series, column, history re-fetch) | [plan](../plans/2026-10-04-solar-cost-2b-battery-soc.md) | [#74](https://github.com/ljukas/videbacken/pull/74) | checkpoint passed | 2026-10-04: re-fetch 258/258 days in 9 runs, all `ok`; SoC on 73,955/73,955 buckets, 0 days with nulls; 4 probe days exact; energy sums unchanged |
| 3 | Energy-mix derivation (mix + pool tables, pure modules, triggers; not shown) | [plan](../plans/2026-10-03-solar-cost-3-mix-derivation.md) | [#77](https://github.com/ljukas/videbacken/pull/77) | checkpoint passed | 2026-10-04: history rebuilt by the first cron derive (258 pool days, 98/98 counted sessions, mix kWh = session kWh); prod `C` 7.57 vs 7.58 in code; pool never above SoC; probe sessions within 1–6 pts of P |
| 4 | Cash cost uses the mix (cost math, overview, session page; economy labelled grid-only) | [plan](../plans/2026-10-03-solar-cost-4-cash-cost.md) | [#79](https://github.com/ljukas/videbacken/pull/79) | PR open | — |
| 5 | Value of own solar (line on tiles, popover, session page) | [plan](../plans/2026-10-03-solar-cost-5-solar-value.md) | — | not started | — |
| — | *Later phase:* solar-aware economy page (own brainstorm) | — | — | — | — |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`.

## Owner prerequisites

- **Before step 1 starts:** this roadmap, the spec, ADR-0023 and the five plans are merged to `main`.
- ✅ **Before checkpoint 1** (done 2026-10-03): `.env.local` has all four `EMALDO_*` vars. `EMALDO_APP_ID` and `EMALDO_APP_SECRET` come
  from `const.py` in `github.com/wertigpar/ha-emaldo`. Never commit them.
- ✅ **Before step 2 merges** (done 2026-10-03): the same four vars are set in Vercel **Production** (sensitive).
- *Optional* (since the step-3 build): **for a manual step-3 re-derive on prod**, the Supabase pooler connection
  string, pasted by the owner into the script's shell for that one run. The first derive in prod rebuilds all history
  on its own, so this is only a fallback. Prod credentials can't be pulled, and `vercel env pull` must never be used.

## How a session runs a step

1. Read this roadmap, the spec and ADR-0023. Find the first step whose status isn't `checkpoint passed`.
   - If it is `merged` but its checkpoint hasn't passed, **run the checkpoint, don't start the next step**. Record
     the result here (in a small `docs(charging): …` PR, or in the next step's PR if the owner says so).
2. Open that step's plan. Its first task checks that `main` still matches the plan's assumptions (file names,
   signatures, migrations numbering); fix the plan before building if not.
3. Follow `docs/feature-workflow.md` from **Phase 3 (Isolate)**: worktree → task-by-task build with the two paired
   reviewers → branch review → pre-PR gate → PR. Shaping and planning are already done here.
4. In the same PR, update this roadmap's row: PR link and status `PR open`; after merge, `merged`.
5. Stop at the end of the step. Don't start the next step in the same session.

If a step changes a design decision, amend the spec and ADR-0023 in that step's PR and note it below.

## Checkpoints (real-world gates)

Each must pass, with the result recorded in the table, before the next step starts.

1. **After step 1 (local).** Run the new client locally with the real credentials against two days from
   `data/private/emaldo/` (one normal day, the spring-forward day). The decoded buckets match the probe's raw files
   exactly: same bucket count, same values.
2. **After step 2 (prod).**
   - Backfill complete: the watermark has reached yesterday.
   - Emaldo health is `ok`, and Vercel's Cron Jobs list shows `/api/cron/emaldo-sync`.
   - A read-only SELECT on prod shows the daily energy balance within ≈2 % for a handful of real days.
   - `battery_charge_ac`'s meaning is settled from real data, recorded in the spec.
2b. **After step 2b (prod).**
   - The re-fetch is done: the watermark is back at the end of yesterday, with every run `ok`.
   - A read-only SELECT shows `battery_soc_pct` on ≥ 99 % of the buckets of every day since the first reading, per
     Stockholm day (a 30-day block of nulls means an old-code run; a few scattered ones are Emaldo's gaps):
     `SELECT (bucket_start AT TIME ZONE 'Europe/Stockholm')::date AS d, count(*) FILTER (WHERE battery_soc_pct IS
     NULL) AS nulls, count(*) FROM house_energy_reading GROUP BY 1 HAVING count(*) FILTER (WHERE battery_soc_pct IS
     NULL) > 0 ORDER BY 1`. Two probe days (`data/private/emaldo/data/*.level.json`) match their stored SoC exactly.
   - Whole days without SoC mean old code re-fetched them after 0015 ran: a `:45` run or "Synka nu" during the
     deploy's build, a production build that failed after migrating (the old deployment stays live), or a rollback.
     So: merge outside xx:35–xx:55, don't press "Synka nu" or roll back during the deploy, and if the build fails,
     fix forward fast. The remedy is a new migration with 0015's UPDATE; 0015 itself never runs again.
   - The energy columns of a handful of days are unchanged from before the re-fetch (daily sums).
3. **After step 3 (prod).**
   - The first derive after the deploy rebuilt all history: pool days from the first reading through today, one
     `capacity_kwh` (7.58) and `derive_version` (1), every counted session since the first reading has mix rows, and
     the `energy mix derived` log line shows no warning (plan Task 14 has the SQL).
   - `C` re-measured on prod is ≈ 7.58 (plausible 7–9 kWh per 100 %), and the pool stays at or under the measured
     SoC at each day's end.
   - A read-only SELECT of the derived mix for the seven probe sessions (`data/private/emaldo/PROBE-NOTES.md`)
     lands near the probe's proportional column. Shaped sessions may be a few points higher, and nights with
     grid-charged battery show battery-grid kWh.
   - The owner agrees the numbers match reality.
4. **After step 4 (prod, live).** The owner reviews `/charging`:
   - A sunny midday session is clearly cheaper than before; a winter night session is roughly unchanged.
   - The notice and the grid-only economy label read right.
   - Responsive at mobile, tablet and desktop.
5. **After step 5 (prod, live).** The owner reviews the solar-value copy and figures.

## Log

- 2026-10-03: roadmap, spec and ADR-0023 written after the Emaldo probe (notes in `data/private/emaldo/`,
  git-excluded).
- 2026-10-03: step 1 PR #68 opened. Reviews added a 5-min login block after a refused login (ADR-0019), a
  stale-session re-login, sibling-series cancellation, rediscovery after a stats refusal, and empty `Result` = `{}`.
  Step-2 notes are in #68's Risks section.
- 2026-10-03: #68 merged. Checkpoint 1 passed locally against the live API: 2026-06-10 (288 buckets) and
  2026-03-29 (spring-forward, 276) match the probe's raw files exactly. Step 2 may start.
- 2026-10-04: step 2 PR #70 opened. Reviews added a 5-minute alignment CHECK on `house_energy_reading`, kept readings out of
  failed-write errors, and made only yesterday strict (today and old days are skipped and warned; a bad yesterday fails
  the run after today and the backfill). Pre-check against the live API on the local DB: the whole backfill ran in 9
  runs, the daily balance was within ±2 % on the last 14 full days, and `battery_charge_ac` was 0 in every month.
  Checkpoint 2 still runs on prod after merge.
- 2026-10-04: #70 merged. Checkpoint 2 passed on prod (read-only SELECTs; no rows recorded here):
  - Backfill: 9 runs (4 admin, 5 cron), all `ok`, 1 login each. Readings span 2026-01-20 → today, every day present;
    the watermark is the end of yesterday. Health `ok`. Vercel lists `/api/cron/emaldo-sync` at `45 * * * *`.
  - Gaps: 8, from 50 min to 9.4 h, all in Emaldo's own data (no run dropped more than today's filling bucket from
    a day it stored), identical across the series. The spring-forward day has its 276 buckets. Three counted sessions
    overlap a gap (one by 90 min overnight, two inside the 9.4 h daytime hole): step 3's "gap inside a session →
    uniform spread, no house data" path runs on real data.
  - Balance (supply − use, without `charge_ac`): within ±2 % on 225 of 257 full days, median −0.42 %, monthly totals
    within ±1.53 %. The 32 outliers are all but one summer days (May–Aug) with a small, consistently negative
    error (≈0.5–1.5 kWh a day on low-load days); the one winter outlier is +4.3 % (2.9 kWh). A seasonal metering
    bias, not bad data.
  - `battery_charge_ac` is 0 in every bucket of every month: unused on this installation (spec, "Sync").
  - **For step 3:** Σ discharge ÷ Σ charge over all readings is 0.853, but 0.566 for Jan–Feb and 0.924 from March.
    In the cold months far less comes out of the battery than went in (standby or heating losses, not round trip).
    Step 3's checkpoint expects η ≈ 0.85–0.95; the all-history measure only just meets it. Decide in step 3 whether
    η is measured over all history (as the spec says) or the winter losses need their own handling.
- 2026-10-04: #72 merged. Before step 3, checkpoint 2's winter η (0.57 vs 0.92 from March) showed the planned pool
  would drift: one η and no upper bound left ≈109 kWh of phantom winter-grid energy in the pool by March, draining
  ≈10–25 kWh a month. A probe found Emaldo's SoC series (`power-level/day`, 5-min integer %, history back to January).
  Owner decision: anchor the pool to SoC. New **step 2b** syncs SoC; spec decision 7 and ADR-0023's amendment
  record it. **Step 3's plan predates this**: its Task 0 must replace `ROUND_TRIP_EFFICIENCY` / the η checkpoint
  with the capacity `C` and the SoC cap (spec "Derivation" 3) before building.
- 2026-10-04: step 2b PR #74 opened. Reviews made migration 0015 rotate a held lease token (a run in flight can't
  write the watermark back, and no second run overlaps it), pinned SoC bounds and types, and spelled out every way old
  code could undo the re-fetch. Live local re-fetch against the real API: all 258 days, SoC on every bucket, four probe
  days matching exactly. About ten back-to-back runs drew one `rate_limited` (handled); prod's hourly run was unaffected.
  Checkpoint 2b runs on prod after merge (merge outside xx:35–xx:55).
- 2026-10-04: #74 merged and deployed at 18:22 CEST, clear of the `:45` window. Right after: 16 migrations applied, the
  Emaldo watermark null, no lease, and the last run (17:45) from before the deploy, so no old-code run re-fetched
  anything. Checkpoint 2b passed on prod the same evening (read-only SELECTs; no rows recorded here):
  - Re-fetch: 9 admin "Synka" runs about a minute apart, all `ok`, 163 requests each, no rate limit; the last reported
    0 backfill days left. The watermark is the end of yesterday, health `ok`.
  - SoC on all 73,955 buckets of all 258 days since 2026-01-20; no day has a null; values span 1–100 %.
  - The stored SoC of the four probe days (2026-01-21, 02-15, 06-10, 10-03) matches the raw `power-level` responses
    exactly (md5 over every bucket), and six days (including the spring-forward day and the 9.4 h gap day) match the
    local re-fetch exactly.
  - Energy columns: the six days' sums per column equal an independent local re-fetch to 6 decimals. Prod's own
    pre-re-fetch values were replaced, so this is the closest available "unchanged" check.
  - Prod's SQL sessions print doubles with `extra_float_digits = 0`: compare numbers, not their text.
  Next: step 3 in a new session, starting with its plan revision for the SoC cap (Log, 2026-10-04 above).
- 2026-10-04: step 3 built ([#77](https://github.com/ljukas/videbacken/pull/77)). Task 0 revised the plan for the SoC cap from the local full history: a row's
  SoC is the bucket's middle, so the cap uses the mean of two rows, and `C` = 7.58 kWh per 100 %. The per-task and
  branch reviews changed the design in a few places (spec "Derivation", amendments):
  - checkpoints carry a derive version, so a fix to the math rebuilds history by itself;
  - pending derives are queued durably, in the same transaction as the change they cover;
  - a derive resumes one day early, so the previous day's last bucket gets its cap;
  - requested days are clamped to [the day before the first reading, today];
  - a session longer than a year, or with a slot ≥ 1000 kWh, is skipped and stays all-grid instead of failing every
    derive;
  - battery spots are bounded only to finite values (losses make winter battery energy ≈ 1.8× its purchase spot).
  Local rehearsal: a full-history derive takes ≈ 0.3 s; five of the seven probe sessions land within 0–6 points of
  the proportional column (shaped ones higher), 03-17 is 98 vs 94, and 02-15 is 73 % direct grid but 100 % grid-origin
  (the battery charged from the grid while feeding the car). The three tables ship as migration 0017 (main took 0016).
- 2026-10-04: #77 merged at 20:13 CEST; its production deployment was created at 20:37. Checkpoint 3 passed on prod
  the same evening (read-only SELECTs and the runtime log; no readings recorded here):
  - Derive: the first derive ran inside the 20:45 Emaldo cron run, found no checkpoint and rebuilt from the first
    reading in 1.5 s (`deriveMs` 1545; 73,980 readings, 98 sessions, 1,747 mix rows, 0 skipped). The 21:00 Zaptec run
    re-derived 9 days in 0.2 s. No `energy mix derive failed` warning; the request queue is empty. The fallback
    script wasn't needed.
  - Coverage: 258 pool days, 2026-01-20 → today, one capacity (7.58). All 98 counted sessions since the first
    reading have mix rows, no uncounted session has any, and Σ mix kWh = Σ session kWh (1688.2). The 89 sessions
    without rows are all under the 0.5 kWh noise threshold (mostly the installation day's flapping, 2026-01-27).
  - `C` on prod: 7.57 kWh per 100 % over 35,408 discharge-only bucket pairs, 0.01 from the code's 7.58, so no
    capacity PR. The cap query returns no rows: the pool never ends a day above the measured SoC.
  - Probe sessions, derived direct-grid share vs the probe's P (grid-origin share in brackets): 02-15 73 vs 88 (96),
    03-17 98 vs 94 (99), 03-29 53 vs 49 (53), 06-10 44 vs 45 (45), 06-12 71 vs 65 (76; the probe's shaped figure was
    71), 07-15 60 vs 60 (61), 09-06 60 vs 57 (60). Grid-charged battery shows on the nights: 02-15 5.8 kWh, 06-12
    1.3 kWh. 03-17's 0.4 kWh without house data is the probe's known 95-minute Emaldo gap. 02-15's grid-origin
    share is 96 % on prod vs 100 % in the local rehearsal: prod's pool carries 1.0 kWh of February solar into
    that night.
  - The owner accepted the numbers. Next: step 4 (cash cost uses the mix) in a new session.
- 2026-10-04: step 4 PR [#79](https://github.com/ljukas/videbacken/pull/79) opened (cash cost). Task 0 found the
  overview tiles had moved on since the plan (icon readouts, one footer line), so Task 6 was adapted. Reviews and the
  owner changed a few things, recorded in the spec's "As built (step 4)" block:
  - the tile line counts only energy that cost nothing ("N % egen solel", owner's call);
  - the copy says "husets energidata", the app's established term;
  - the session page's grid-only range marker reads "Denna laddning", not "Faktiskt", beside the cash hero;
  - the source bar has its own colour tokens;
  - the economy lead sits beside its controls and links the overview;
  - an all-solar scope or year shows 0 kr, never "nothing priced".
  Checked live on the local DB at 360 / 820 / 1600 px in both themes. Checkpoint 4 (prod, the owner's review) is next.

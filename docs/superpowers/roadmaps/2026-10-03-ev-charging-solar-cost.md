# Roadmap — solar-aware charging cost (Emaldo)

Control document for building [the solar-aware cost design](../specs/2026-10-03-ev-charging-solar-cost-design.md)
([ADR-0023](../../adr/0023-solar-aware-charging-cost.md)). **One step = one session = one PR.** Each step has its
own self-contained plan. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | Emaldo client (effect, env, `not_configured`; unused) | [plan](../plans/2026-10-03-solar-cost-1-emaldo-client.md) | [#68](https://github.com/ljukas/videbacken/pull/68) | checkpoint passed | 2026-10-03: 288/288 + 276/276 buckets, 0 mismatches (11 requests, 1 login) |
| 2 | Raw readings sync (table, service, source, cron, backfill, health) | [plan](../plans/2026-10-03-solar-cost-2-readings-sync.md) | — | not started | — |
| 3 | Energy-mix derivation (mix + pool tables, pure modules, triggers; not shown) | [plan](../plans/2026-10-03-solar-cost-3-mix-derivation.md) | — | not started | — |
| 4 | Cash cost uses the mix (cost math, overview, session page; economy labelled grid-only) | [plan](../plans/2026-10-03-solar-cost-4-cash-cost.md) | — | not started | — |
| 5 | Value of own solar (line on tiles, popover, session page) | [plan](../plans/2026-10-03-solar-cost-5-solar-value.md) | — | not started | — |
| — | *Later phase:* solar-aware economy page (own brainstorm) | — | — | — | — |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`.

## Owner prerequisites

- **Before step 1 starts:** this roadmap, the spec, ADR-0023 and the five plans are merged to `main`.
- ✅ **Before checkpoint 1** (done 2026-10-03): `.env.local` has all four `EMALDO_*` vars. `EMALDO_APP_ID` and `EMALDO_APP_SECRET` come
  from `const.py` in `github.com/wertigpar/ha-emaldo`. Never commit them.
- ✅ **Before step 2 merges** (done 2026-10-03): the same four vars are set in Vercel **Production** (sensitive).
- **For the step-3 history re-derive on prod:** the Supabase pooler connection string, pasted by the owner into the
  script's shell for that one run. Prod credentials can't be pulled, and `vercel env pull` must never be used for this.

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
3. **After step 3 (prod).**
   - `η` is set from the measured history and looks plausible (≈0.85–0.95).
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

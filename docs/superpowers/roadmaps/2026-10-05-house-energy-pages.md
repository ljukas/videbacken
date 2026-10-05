# Roadmap — house energy pages (Energi)

Control document for building [the house energy pages design](../specs/2026-10-05-house-energy-pages-design.md)
([ADR-0024](../../adr/0024-house-energy-pages.md)). **One step = one session = one PR.** Each step has its own
self-contained plan. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | Read model + Energi › Översikt (service, `figures.ts`, procedure, nav section, overview page) | not written | — | not started | — |
| 2 | Energi › Batteri (battery tiles, monthly chart, winter note) | not written | — | not started | — |

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

1. **After step 1 (prod).**
   - A read-only SELECT on prod of the monthly sums (import, export, solar, load, battery columns) matches the
     page's tooltips for three months, 2026-08 (the 9.4 h gap) among them; that month shows "data saknas för 9 h".
   - The car share per month equals `/charging`'s monthly kWh with the scope set to *Alla*.
   - `rpc timing` for `energy.overview` in Vercel Runtime Logs: `totalMs` < 150 ms, `getEnergyOverviewMs` logged.
   - The owner reviews `/energy` live (copy, figures, desktop + phone) and accepts it.
2. **After step 2 (prod).**
   - Battery in / out / loss for 2026-02, 2026-05 and 2026-09 match a prod SELECT (with Δstored from first/last SoC)
     within 0.1 kWh.
   - The owner reviews `/energy/battery` live and accepts the winter note's wording.

## Log

- 2026-10-05: shaped in a brainstorm (owner decisions in the spec's table); ADR-0024, spec and this roadmap written.
  Measured locally: a year aggregates in ≈40 ms; February in − out ≈117 kWh of which only ≈18 kWh is idle SoC drop.

# Roadmap — Klimat and Shelly sensor improvements

Control document for building [the Klimat readability design](../specs/2026-10-06-climate-readability-design.md):
the Shelly app name in a clearer sensor dialog, and the `/sensors` (Klimat) page at the app's readable sizes with
the range control next to the charts. **One step = one session = one PR.** Both plans were written up front
(2026-10-06), each starting with a task that checks `main` still matches it.

Ask for it as "the next step of the Shelly improvements roadmap" (or "the Klimat roadmap").

## Status

| # | Step | Plan | Execution | PR | Status | Checkpoint result |
|---|---|---|---|---|---|---|
| 0 | Spec, plans and this roadmap | — | — | [#122](https://github.com/ljukas/videbacken/pull/122) | merged | — |
| 1 | Shelly name + sensor dialog: `shelly_name` column, webhook `name` param, own → Shelly → `Sensor a1b2`, dialog Enhet box (Shelly name, MAC), live badge, "Återställ", runbook | [plan](../plans/2026-10-06-climate-1-shelly-name.md) | subagent-driven | [#123](https://github.com/ljukas/videbacken/pull/123) | merged | — |
| 2 | Klimat page: "Just nu" card (tiles with location, readable sizes, named 40 px edit button) and "Historik" card (range control in the header, chips and both charts), chart text 13–14 px, no per-chart legends, bones | [plan](../plans/2026-10-06-climate-2-page-readability.md) | native | PR_LINK | PR open | — |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`.

**Order.** Step 1, then step 2. The steps share no code (step 2 is presentation only), so **step 2 does not wait
for checkpoint 1**: that checkpoint needs the owner at the devices, and may lag. Two steps open at once conflict
only in the browser-test device fixtures and `messages/*.json`; the second to merge takes `main` in.

## Owner prerequisites

- **After step 1 deploys:** append `&name=${config.sys.device.name}` to both webhooks (temperature change, humidity
  change) of **one** sensor, then wake it (button on the back). The other three follow once checkpoint 1 passes.
  The runbook (`docs/runbooks/shelly-webhook-setup.md`) has the full URL.

## How a session runs a step

1. Read this roadmap and the spec. Find the next step:
   - a step that is `merged` but whose checkpoint hasn't passed → **run that checkpoint** (if the owner is
     available for it) and record the result here; checkpoint 1 alone doesn't block step 2 (see *Order*);
   - otherwise the first step that is `not started` (or `in progress` / `PR open`: continue it).
2. Open the step's plan and build it the way its **Execution** column (and the plan's header) says:
   subagent-driven = `superpowers:subagent-driven-development`; native = `superpowers:executing-plans`. The plan's
   Task 0 checks `main` and creates the worktree; then follow `docs/feature-workflow.md` from **Phase 4 (Build)**.
3. In the same PR, update this roadmap's row: PR link and status `PR open`; after merge, `merged`.
4. Stop at the end of the step.

If a step changes a design decision, amend the spec in that step's PR.

## Checkpoints (real-world gates)

1. **After step 1 (prod).**
   - The owner updates one sensor's webhook and wakes it. A read-only `SELECT mac, shelly_name FROM sensor_device`
     on prod shows that sensor's `shelly_name` **equal to its name in the Shelly app**.
     - If it's null or the device ID: the app name isn't stored on the device (`sys.device.name`). Stop, record it,
       and re-shape (the dialog's MAC still identifies devices; nothing shipped breaks).
   - The other sensors keep reporting (old URL, no name) and keep their names.
   - The edit dialog shows that sensor's Shelly name, and its MAC reads like the Shelly app's device information.
   - "Återställ" + Spara on a sensor with an own name brings back its Shelly name on the tile.
   - Then the owner updates the other three sensors.
2. **After step 2 (prod, owner review).**
   - At desktop, tablet and phone widths: the range control sits in the Historik header with the charts; nothing
     moves when switching ranges; the tiles show locations; text reads at the new sizes.
   - The owner accepts the page live (or lists changes for a follow-up step here).

## Log

- 2026-10-06: brainstormed via `/feature-workflow`; spec approved; both plans written against `main` with #118 (the
  visx Klimat charts) merged; owner chose subagent-driven for step 1 and native for step 2.
- 2026-10-06: step 1 built subagent-driven (4 tasks, each with its two reviewers, then a whole-branch review). Review
  changes to the plan: a Shelly name with a control character (a NUL would abort the insert) counts as no name; the
  dialog's badge and Återställ are 14 px; the dialog description keeps its old copy until step 2's tiles show the
  location (the rewording moved into step 2's plan).
- 2026-10-07: step 2 built native (4 tasks, then a whole-branch review by two reviewers). Changes to the plan: the
  hover card is portaled, so it gets its own `text-sm`; the tiles switch to 4 columns from their own width
  (`@container`), not `md` (the spec is amended); the bones are captured with four sensors. Checkpoint 1 not started
  yet (prod: no `shelly_name` on any sensor).

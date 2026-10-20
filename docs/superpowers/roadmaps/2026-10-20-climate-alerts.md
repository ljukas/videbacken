# Roadmap — climate alerts

Control document for building [the climate alerts design](../specs/2026-10-19-climate-alerts-design.md)
([ADR-0028](../../adr/0028-climate-alerts.md)). **One step = one session = one PR.** Each step has its own
self-contained plan. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | Rules: the `sensor_alert_rule` table, own-scoped service and procedures, the bell on each tile (count of your switched-on rules) and the "Larm för …" dialog (list with on/off switches, form with the count hint, delete). Nothing evaluates rules or sends email yet | [plan](../plans/2026-10-20-climate-alerts-1-rules.md) | | not started | |
| 2 | Value alerts: merged-reading evaluation on the Shelly webhook for temperature, humidity and battery rules; rule state + `sensor_alert_event` history; alert and recovery emails through the queue; the bell's red firing state; the list rows' state dots and "sedan …" (moved from step 1); "Senaste larm" in the dialog | written when step 2 starts | | not started | |
| 3 | Silence: the hourly cron firing silence rules, recovery on the next webhook, the silence emails | written when step 3 starts | | not started | |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`. Steps 2 and 3 are fully
designed in the spec; their plans are written at the start of their session, against the shapes step 1 actually
merged.

## Owner prerequisites

- **Before step 1 starts:** this roadmap, the spec, ADR-0028 and step 1's plan are merged to `main`.
- **Step 1's checkpoint:** a second account to sign in with as a plain `user` (an existing member, or a temporary
  invite at `/admin` revoked afterwards).
- **Step 2's checkpoint:** a rule you're happy to see fire on purpose (e.g. Förråd "över 5 °C", 2 mätningar), then
  edited back.
- **Step 3's checkpoint:** taking a sensor's batteries out for longer than its silence rule (≥ 3 h), then back in.

## How a session runs a step

1. Read this roadmap, the spec and ADR-0028. Find the first step whose status isn't `checkpoint passed`.
   - If it is `merged` but its checkpoint hasn't passed, **run the checkpoint, don't start the next step**. Record
     the result here (in a small `docs(climate): …` PR, or in the next step's PR if the owner says so).
2. Open that step's plan (for steps 2 and 3, write it first with `superpowers:writing-plans`, into
   `docs/superpowers/plans/`, and link it here). Its first task checks that `main` still matches the plan's
   assumptions; fix the plan before building if not.
3. Follow `docs/feature-workflow.md` from **Phase 3 (Isolate)**: worktree → task-by-task build (schema gate right
   after a schema task) → step review (core three + every specialist the plan names) → pre-PR gate → PR. The owner
   chose **subagent-driven** execution (`superpowers:subagent-driven-development`) on 2026-10-20.
4. In the same PR, update this roadmap's row: PR link and status `PR open`; after merge, `merged`.
5. Stop at the end of the step. Don't start the next step in the same session.

If a step changes a design decision, amend the spec and ADR-0028 in that step's PR and note it below.

## Checkpoints (real-world gates)

Each must pass, with the result recorded in the table, before the next step starts.

1. **After step 1 (prod).**
   - The owner creates, on a phone: Förråd temperature under 5 °C (2), Fack 1 temperature under 0 °C (2), Förråd
     battery under 20 % (2), Fack 3 silence 6 h. The bells show 2 / 1 / 1; the form's hint for count 2 reads
     "≈ 2–4 timmar" on Fack 1 and Fack 3.
   - Pausing one rule drops its bell's count; deleting one removes it. Read-only SQL shows exactly the owner's rows
     with the entered values.
   - Signed in as a plain `user`, the second account sees plain bells, none of the owner's rules, and can create and
     delete a rule of its own (then deletes it).
   - Desktop, tablet and phone widths: the tile names don't collapse with two icon buttons.
2. **After step 2 (prod).** A deliberate rule fires on a real reading: one alert email (subject, facts, link),
   the bell turns red, "Senaste larm" shows it as ongoing; editing the rule back ends it quietly (no email), the
   history entry reads "avslutad (ändrad)". A real recovery email arrives for a rule recovering on its own (a
   temporary rule above the current value, then lowered below it by the weather, or the battery rule after a swap).
   Exactly one email per transition in the runtime logs, Förråd bursts included.
3. **After step 3 (prod).** Batteries out of one sensor: one silence email within an hour after the rule's hours;
   batteries back in: one recovery email within seconds of its first reading.

## Changes since the spec

- **Step 1:** the list rows' state dots (red firing / green OK / grey paused) and "sedan …" move to step 2: with
  nothing evaluated yet, a green "OK" would claim a rule is watched. A paused rule shows in muted text.
- **Step 1:** deleting a rule confirms inline in the form, not in a stacked `AlertDialog` (recorded in ADR-0028).
- **Step 1:** the count hint shows minutes while the span's upper end is under 120 min ("≈ 30–60 min"), else whole
  hours ("≈ 2–4 timmar").
- **Step 1:** with the bell and the admin's pencil (both 40 px, as specified), the tiles go to one column on the
  narrowest phones (card under ~304 px), and the location line sits under the name row, full width.
- **For step 2's plan:** keep the firing state off the rule row (an open `sensor_alert_event` = firing, a partial
  unique index on `rule_id where ended_at is null`; schema review of step 1). Decide whether to cap rules per user
  (security review of step 1: uncapped rules × one webhook = that many emails once).

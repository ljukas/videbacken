# ADR 0022 — Live Vehicle-State Attribution

- **Status**: Accepted
- **Date**: 2026-10-02
- **Deciders**: Lukas
- **Decision in one line**: Poll the official MyŠkoda Public API every 15 minutes, store every poll as a snapshot of
  the car's plug state and position, and attribute sessions after the exported log by the majority of known time —
  ours when the car was mostly plugged in at home, guest when it mostly wasn't — leaving them alone when we don't know.

**Spec**: [live attribution design](../superpowers/specs/2026-10-02-ev-charging-live-attribution-design.md).
**Extends**: [ADR-0021](./0021-charging-session-vehicle-attribution.md) (the session-row attribution model and its
precedence). **Builds on**: [ADR-0019](./0019-external-data-integrations.md) (a pulled, health-tracked source).

---

## Context

ADR-0021 attributes sessions from the car's exported MySkoda log, which ends 2026-09-27; the unofficial API that
produced it is closed to third parties. After that every session defaults to ours, so a forgotten guest inflates
our cost. The official MyŠkoda Public API reports **current state only**, at 20 requests/hour per VIN, with a key
that expires after about six months.

A live probe showed what that state is worth: the car reports **on change** — plug-in within ≈1–3 min,
a pause or resume within minutes — and otherwise keeps its last report (one report held for over an hour while
charging). The `isVehicleInSavedLocation` flag flipped to `false` while the car sat plugged in at home, so it can't
tell home from away. And after an unplug the car kept sending fresh reports saying `CONNECTED` for ≈27 min while it
drove 4 km; only its position (`IN_MOTION`, then parked elsewhere) told the truth promptly.

## Decision

1. **Store snapshots, not verdicts.** `vehicle_state_snapshot` holds one row per poll (append-only): plug state,
   charging state, position class (`at_home`), SoC, odometer. A poll's state counts as known until the next poll, but
   never for more than 20 minutes, so a polling gap stays unknown.
2. **Majority evidence rule, inside `reattributeSessions`.** For a session outside the exported log's coverage, trimmed
   by 10 min at each end, each poll is *here* (`CONNECTED` and not known to be away), *not here* (`DISCONNECTED`,
   moving, or parked outside the geofence) or unknown. When here + not-here time covers at least half the window, the
   majority decides (**ours** on a tie); otherwise the session is **unchanged**. Sessions under 40 min and sessions
   with an unreliable Zaptec clock are never decided. Decided rows get `vehicle_source = 'skoda_live'`. Polls are read
   per session window through a `LATERAL` bounded on `polled_at` (measured ≈20–30 ms vs 5–10 s for an unbounded
   `lead()` over 2–3 years of polls).
3. **Precedence**: admin > exported log (inside its coverage) > live snapshots > default.
4. **Home is a GPS geofence**, not the API's home flag: the parked position is compared in memory with
   `SKODA_HOME_COORDINATES` (150 m) and only the boolean is stored. No position → plug state alone.
5. **Snapshots carry SoC and odometer** for Phase 6; never GPS, address or plate.
6. **Key expiry is tracked generically** on `integration_sync` (`credential_expires_at`,
   `credential_reminder_days`), with an admin warning from 30 days and emails at 30 and 7 days; a reminder nobody
   received is released and retried. Partial delivery is final: a threshold is claimed once and delivery is
   at-least-once, so admins whose publish failed don't get that threshold's email (the warn records it).
   Days left are Stockholm calendar days, so reminders fall due at Stockholm midnight and the expiry day itself
   reads "today". Each publish is bounded at 5 s so a hung queue can't eat the run and skip the re-match.
   Accepted residuals:
   - A function that dies between the claim commit and the publish loses that threshold; a lost 30-day claim is
     covered by the 7-day one.
   - A header missing right after a renewal keeps the old date until it reappears, and every poll logs a warning.
   - An expiry that drifts by under 24 h is ignored (the stored date and the reminders sent are kept); a renewal
     moves it by months.
7. **Alerts wait for a streak**: a per-source `ALERT_AFTER_FAILURES` (Škoda 3) so a single 503/429 at a 15-min
   cadence doesn't email every admin. The cron runs at :07/:22/:37/:52, off Zaptec's hourly :00, so the two re-matches
   don't run concurrently.
8. **Privacy**: the snapshot table is a household presence history. Raw rows never reach the client beyond the admin
   card's latest timestamps; the UI shows per-session results only (all users are household members); RLS on with no
   policies; no presence in logs; no GPS/address/plate stored. Every poll is kept for now; Phase 6 sets retention.

## Alternatives considered

- **Synthesize `vehicle_charge_record` rows from snapshot sequences** and reuse ADR-0021's re-match unchanged.
  Rejected: the record table assumes a complete log (coverage = min..max), so every polling gap would mark sessions
  as guests; open charges would need records that grow; a 15-min poll can miss short charges entirely.
- **Decide at poll time and store only the verdict.** Rejected: Zaptec reports a session only once it ends (hourly
  sync), so there's nothing to attach a verdict to while the car charges, and nothing to re-derive from later.
- **Any connected-at-home evidence → ours** (the first draft). Rejected after the unplug probe: the ≈27 min of stale
  `CONNECTED` after an unplug would make the common "we unplug, the guest plugs in" session ours.
- **One row per distinct car report** (bumping a `last_polled_at`). Rejected: position changes independently of the
  charging part's timestamp, and position is what exposes a stale `CONNECTED`.
- **Snapshots captured inside the session only** (no "state holds" interval). Rejected: a guest charging while our
  car sleeps elsewhere produces no report at all, so the main case would stay "antaget".
- **The API's `isVehicleInSavedLocation` as the home signal.** Rejected after the probe (false at home).
- **Plug state alone.** Simpler and no personal-data env var, but our car plugged in elsewhere while a guest charges
  here would be "ours". The owner chose the geofence.

## Consequences

- A fourth `vehicle_source` value; the session page says "enligt bilens status".
- Attribution quality depends on the car reporting state changes promptly (observed: plug-in, pause, resume, and
  position). A short guest session right after we unplug at home (under ≈1 h) can still be outvoted into "ours" by
  the stale `CONNECTED`; an admin tag fixes it.
- A polling outage leaves sessions "antaget" (ours), never guest — the safe direction for "our cost".
- Snapshot SoC can lag reality by an hour or more; Phase 6 must use only fresh reports.
- The key must be renewed every ≈6 months in the MyŠkoda app and redeployed (runbook `skoda-api-key.md`).
- ≈96 polls/day write ≈96 snapshots (≈35 000/year, kept for Phase 6) and ≈96 `integration_sync_run` rows (pruned at
  90 days). The run history's session-named columns mean "a poll" for Škoda (`sessionsSeen`/`upserted` = 1 per stored
  poll).
- Accepted residual: two concurrent multi-row writers (the re-match UPDATE and a Zaptec `importSessions` page
  transaction, or two re-matches during a first-deploy backfill colliding with an admin sync) can deadlock in
  theory. Postgres aborts one side (40P01); that run only warns or fails and recovers on the next. Steady state
  changes 0-1 rows and the crons (:00 vs :07/:22/:37/:52) don't overlap.
- Roll forward only once `skoda_live` rows exist: PR 1 code can't label them, so rolling back leaves rows it can't
  display.
- The 20 requests/h per VIN are shared by the cron (4/h), the admin's "Synka nu" on the Škoda tile, and any local testing with the
  same key; the client retries at most once.

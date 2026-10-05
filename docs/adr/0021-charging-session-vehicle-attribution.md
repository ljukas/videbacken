# ADR 0021 — Charging-Session Vehicle Attribution

- **Status**: Accepted — extended by [ADR-0022](./0022-live-vehicle-state-attribution.md)
- **Date**: 2026-10-01
- **Deciders**: Lukas
- **Decision in one line**: Each charge session carries its own `vehicle` (`ours` | `other`) and `vehicle_source`
  (`default` | `skoda` | `admin`, + `skoda_live`, ADR-0022); sessions are ours by default, a stored copy of the car's
  own charging log re-derives attribution after every import and sync, and an admin tag always wins.

**Spec**: [EV charging Phase 5 design](../superpowers/specs/2026-10-01-ev-charging-phase5-design.md).
**Research**: [scope map](../superpowers/specs/2026-09-28-ev-charging-scope-map.md) ("Attributing sessions").
**Builds on**: [ADR-0019](./0019-external-data-integrations.md), [ADR-0020](./0020-spot-prices-and-cost-model.md),
[ADR-0006](./0006-file-storage.md) (no file bytes through a function).

---

## Context

The owner wants charging totals for **our car** (a Škoda Enyaq) without guests' charging mixed in. Zaptec can't
tell cars apart: `tokenName` is null on every session and the owner authorizes every session, guests' included.

The only per-car source is the Enyaq's own charging log, exported once from the MySkoda app (2026-09-30). The
unofficial API that produced it closes to third parties in October 2026, and the official Public API reports current
state only. Measured against the real data, **time overlap** with that log attributes 91 of 95 sessions; the energy
figures agree too loosely to use, and the planned peak-power hint fails because the car follows the solar at 2–4 kW.

## Decision

1. **Attribution is a property of the session row.** `ev_charge_session.vehicle` (`ours` | `other`, default
   `ours`) and `vehicle_source` (`default` | `skoda` | `admin`, + `skoda_live`, ADR-0022; default `default`), both text + CHECK. The Zaptec
   sync's upsert sets only Zaptec-owned columns, so it can never clobber them.
2. **Ours by default.** A session nothing has decided counts as ours. Guests are rare and the owner is present for
   them, so flagging the exception is less work than tagging every session — and stays correct after the Škoda log
   ends.
3. **The car's log is stored, not just applied.** `vehicle_charge_record` keeps the imported rows (times, kWh, SoC,
   a public-charger flag; never location names or prices). Attribution is then **recomputable**: one
   `UPDATE … FROM` runs after each import and each Zaptec sync, so a replacement session gets attributed without
   re-uploading, and Phase 6 inherits the SoC data.
4. **Admin wins.** The re-match never touches `vehicle_source = 'admin'`. "Automatiskt" resets a session to
   `default` and re-runs the rule.
5. **The CSV is parsed in the browser.** Only the needed fields go to an admin RPC as structured rows: no file bytes
   through a Vercel Function (ADR-0006), and the address in the export never leaves the device.
6. **One query seam.** `countedSessionFilter({ vehicle })` is the single place every scoped read filters on
   vehicle; procedures and routes default to `all` (`DEFAULT_VEHICLE_SCOPE` in `src/lib/evCharging/vehicle.ts`).
   *Amended 2026-10-05:* routes defaulted to `ours` until the owner asked for Alla as the starting view — guests are
   part of what the charger delivered. The scope is a page-level filter, carried across the charging views by the
   sidebar.

## Alternatives considered

- **A separate `ev_session_attribution` table** (row only when decided, default ours when absent). Keeps the Zaptec
  mirror pure, but every read — including the hot overview queries — needs a left join plus `coalesce`. Rejected:
  cost on every read for flexibility nobody needs yet.
- **A `vehicle` entity table with a `vehicle_id` FK** (the Enyaq + named guests). Ready for the guest ledger, but
  forces naming guests now, which the owner deferred. The chosen model extends to it additively (a nullable
  `guest_id` constrained to `vehicle = 'other'`).
- **Unknown until tagged.** Always correct, but every new session needs a click. Rejected by the owner.
- **Poll the official Škoda Public API now.** Automatic going forward, but adds a pulled source, an expiring API key
  and an external 15-min scheduler. Deferred (scope-map step 4); it would write `vehicle_charge_record` rows with a
  new `source`, and the same re-match would use them — built differently in ADR-0022 (per-poll snapshots, not
  records).
- **Upload the CSV file to storage and parse server-side.** Violates ADR-0006 for no gain, and sends personal data
  (an address) to the server.

## Consequences

- Every charging list/aggregate read gains a `vehicle` scope; forgetting to thread it shows up as guests in "our"
  totals, which the per-read scope tests guard. By-id reads (the session page, `sessionCosts`, which prices the ids
  the scoped list chose) and the years list / spot-price backfill are deliberately unscoped.
- `services/evCharging/attribution.ts` reads `vehicle_charge_record` (owned by `services/vehicleCharge`) for the
  single `UPDATE … FROM` re-match: a deliberate read-only exception to ADR-0002 table ownership, since one
  statement can't span two services. A CHECK (`ev_charge_session_vehicle_default_check`) keeps `default` rows 'ours'.
- Sessions after the export are "ours · antaget" until tagged or until ADR-0022's live poll decides them; a forgotten
  guest the poll can't decide still inflates our cost. The session page shows the source so it's visible.
- An admin tag on a session that Zaptec later voids/replaces does not carry over to the replacement.
- Coverage is derived from the stored log; importing a later export extends it automatically.

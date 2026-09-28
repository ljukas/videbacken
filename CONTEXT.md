# Domain glossary

Names for domain concepts, so code, docs and reviews use one vocabulary.
Architecture terms (module, interface, seam, adapter, depth) live in
`.claude/skills/improve-codebase-architecture/LANGUAGE.md`.

## EV charging

**Charger** — the physical Zaptec Go at the house ("Förrådet"). Identified by Zaptec's charger id.

**Charging session** — one plug-in-to-unplug period as reported by Zaptec, with total kWh and
hourly **intervals**. Keyed by Zaptec's session id; may be **voided** or **replaced** by Zaptec later.

**Interval** — a `[start, end)` slice of a session with the kWh delivered in it. Hour-aligned
(first and last may be partial). The unit Phase 2 prices.

**Counted session** — a session that counts toward stats: not voided, not replaced, and at least
the noise threshold (0.5 kWh). Everything else (e.g. commissioning blips) is stored but hidden.

**Live state** — the charger's current mode (disconnected / connected / charging / finished) and power, read on demand.

## Integrations

**Integration** — an external data source we pull from on a schedule: `zaptec` now; `elpris`
(spot prices) and `skoda` later.

**Sync run** — one execution of an integration's sync (triggered by cron or an admin). Produces
exactly one run record and one `integration sync run` log line.

**Integration health** — an integration's derived state: `never_synced`, `not_configured`, `ok`,
`stale`, or `failing`. **Transition** — the change a sync run causes: `started_failing` or
`recovered` (these trigger the admin alert email).

**Lease** — the short-lived claim a sync run holds so two runs of the same integration never overlap.

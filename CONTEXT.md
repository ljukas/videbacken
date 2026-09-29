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

## Cost

**Spot price slot** — one day-ahead SE3 price for `[slot_start, slot_end)`: 15 min since 2025-10-01, an hour before;
a Stockholm day has 92/96/100 of them. SEK/kWh ex VAT, may be negative. Stored a whole day at a time.

**Tariff period** — the per-kWh costs on top of spot (retail markup, grid transfer, energy tax, VAT) that apply from
its `valid_from` Stockholm date until the next period starts. Fixed monthly fees are not part of it.

**Piece** — the part of an interval that falls in one price slot; the unit the cost math prices.

**Grid share** — the fraction of an interval's energy bought from the grid (1 until a solar/battery source says
otherwise); only that share is priced.

**Complete / partial cost** — complete when every grid kWh has both a price and a tariff; otherwise partial, and the
missing energy is shown as missing, never as 0 kr.

## Integrations

**Integration** — an external data source we pull from on a schedule: `zaptec` (sessions) and `elpris`
(spot prices); `skoda` later.

**Sync run** — one execution of an integration's sync (triggered by cron or an admin). Produces
exactly one run record and one `integration sync run` log line.

**Integration health** — an integration's derived state: `never_synced`, `not_configured`, `ok`,
`stale`, or `failing`. **Transition** — the change a sync run causes: `started_failing` or
`recovered` (these trigger the admin alert email).

**Lease** — the short-lived claim a sync run holds so two runs of the same integration never overlap.

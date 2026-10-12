# ADR 0027 — Heat Pump Energy Data (Panasonic Comfort Cloud)

- **Status**: Accepted
- **Date**: 2026-10-08
- **Deciders**: Lukas
- **Decision in one line**: Pull the two Panasonic air-to-air heat pumps' hourly electricity use and temperatures
  from the Comfort Cloud API into our own tables, show what the house's consumption was used for on Energi ›
  Översikt, and judge the units' efficiency over time with a weather-corrected energy signature around
  admin-logged events, read-only, with no control of the units.

**Spec**: [heat pumps design](../superpowers/specs/2026-10-08-heat-pumps-design.md).
**Roadmap**: [heat pumps roadmap](../superpowers/roadmaps/2026-10-08-heat-pumps.md).
**Builds on**: [ADR-0019](./0019-external-data-integrations.md) (a pulled, health-tracked source),
[ADR-0024](./0024-house-energy-pages.md) (the Energi pages, `figures.ts`, aggregates-only),
[ADR-0026](./0026-integration-credential-store.md) (GUI-set credentials).

---

## Context

The house has two Panasonic CS-HZ25ZKE air-to-air heat pumps ("Matsal", "Övervåning"), both connected to Panasonic
Comfort Cloud. Energi shows where the house's electricity comes from (Emaldo, ADR-0024) and how much of it the car
took, but nothing else about what it was used for. The owner wants to see the heat pumps' share, how their
consumption develops over time, and whether events such as a service change their efficiency. Control of the units
isn't wanted.

Comfort Cloud has no official API. The Home Assistant integration `sockless-coding/panasonic_cc` and its library
`aio-panasonic-comfort-cloud` (Python, maintained, last release 2026-08-23) reverse-engineered the phone app's API.
The only TypeScript client (`panasonic-comfort-cloud-client`) has no MFA support. A read-only live probe with the
Python library on 2026-10-08 found:

- **Login:** Auth0 (`authglb.digital.panasonic.com`) with PKCE, then a Comfort Cloud session login
  (`accsmart.panasonic.com/auth/v2/login`). Our account logged in with the password alone, no MFA prompt, in
  ≈0.5 s; five logins within minutes were not throttled and did **not** log the owner's phone app out. The access
  token lasts 24 h; the refresh token rotates on every use. Every API call carries an app version and an
  `x-cfc-api-key` header (SHA-256 over a constant baked into the app, the timestamp and the token).
- **Energy:** `POST /deviceHistoryData` with `dataMode` 0 (day) returns 24 hourly rows per unit: `consumption`
  (kWh, 1 Wh resolution), the heating and cooling share of it, and the hour's average setpoint, indoor and outdoor
  temperature. `-255` means "no value" (hours not yet reached; the cost field when no tariff is set).
- **Hours are UTC.** `osTimezone` only shifts a fixed 24-hour window: with `+00:00`, every row is an exact UTC
  hour, and both DST days (2025-10-26, 2026-03-29) return 24 rows. DST can't cause gaps or duplicates.
- **Freshness and depth:** the current hour fills in near real time (10:00 was partly filled at 10:34). History
  starts 2024-10-31 (Matsal) and 2024-11-27 (Övervåning), complete since. `dataMode` 2 (month) returns daily totals.
- **Status reads** are flaky: the live status endpoint intermittently answers `500 {"code":5005,"Adapter
  Communication error"}`. History reads don't depend on it.
- **Size:** Matsal ≈ 2,300 kWh a year, Övervåning ≈ 1,000; ≈ 27 W standby each (≈ 20 kWh a month).

Comfort Cloud reports only electricity in, not heat out, so the units' true efficiency (COP) can't be measured.

## Decision

1. **Comfort Cloud is a fifth pulled source** (`comfortCloud`, ADR-0019): fail closed (`not_configured` without
   credentials), health-tracked, an alert email on failure, a Datakällor tile and "Synka nu". Credentials are
   `user` + `password`, GUI-settable per ADR-0026 with `PANASONIC_USER` / `PANASONIC_PASSWORD` as the env fallback.
   The owner's own account is used (logins don't end other sessions, unlike Emaldo's).
2. **A TypeScript port, not a Python runtime.** The adapter ports the login, the `x-cfc-api-key` header and the
   two calls we need (list units, one UTC day of hourly history) into `src/lib/effects/comfortCloud/`, on the
   shared `fetchWithRetry` and tested with `fakeFetch`. It sends a pinned app version and, when Comfort Cloud
   answers that a new version is published, looks the current one up as upstream does. When Panasonic changes the
   login, we follow upstream's fix by hand.
3. **Password login, tokens in memory only.** The client logs in with the password and keeps the 24-hour access
   token only in memory (a warm instance may reuse it on a later run); no token is ever stored and the rotating
   refresh token is never used. At four runs a day a login costs nothing. A demanded MFA code or a rejected
   password fails the run as `auth_failed`, with a message that says which.
4. **Hourly rows, stored as UTC hours.** `heat_pump` (one row per unit, named as in Comfort Cloud) and
   `heat_pump_reading` (unit × `hour_start`: kWh, heating and cooling share, average setpoint, indoor and outdoor
   °C). `-255` is never stored. Every request uses `osTimezone: "+00:00"`.
5. **Sync four times a day, with a backfill.** Each run replaces, for each unit, today and every previous UTC day back
   to the day before the last successful run's (at least two, at most 14; the current hour is partial and gets
   corrected), then backfills each unit backwards from its oldest stored day, using the month call to skip days
   without data, down to the unit's registration date (`deviceRegisterTime`, the first data day). The walk's position
   is persisted (`heat_pump.backfill_cursor`) so days that answer nothing can't stall it, it reaches
   `registered_on − 1` (the register day may be a local date), and a unit's backfill pauses while its latest day is
   bad.
6. **Only daily sums reach the browser.** Hourly rows tell when someone is home and heating; like the Emaldo
   readings they stay on the server. The service sums per Stockholm month and day on read. Measured in step 2: the
   month read aggregates the readings before joining the unit (≈ 13 ms over ≈ 33k rows locally, no sort spill), so
   no view yet. Add a `heat_pump_month` materialized view (like `house_energy_month`, ADR-0024) when the warm
   `heatPumpMs` in `rpc timing` exceeds `carMs` (the two reads run in parallel, so only the slower shows in
   `totalMs`) or 25 ms. A unit Comfort Cloud no longer lists counts its missing hours only up to its last listing
   (the spec's "Expected hours" rule).
7. **Energi › Översikt gets a second flow diagram, "Användning"**: the period's load split into laddning, each
   heat pump and övrigt hus, beside Summering ("energy in"). The month chart's Förbrukning stacks the same parts.
   The definitions live in `figures.ts` (ADR-0024 decision 4): the heat pumps are capped at load − laddning, and
   övrigt hus is what remains, never negative.
8. **A heat pump page, Energi › Värmepumpar**: consumption per month (with last year and the outdoor temperature)
   and per day, the period's tiles, an event log, and the energy signature. Months and days only.
9. **Efficiency = an energy signature around events.** Per unit, each qualifying heating day is a point (x = the
   day's average indoor − outdoor temperature, y = its kWh). A line fitted to the days before an event predicts
   the days after it; the readout is the mean difference between actual and predicted kWh. It is a relative
   before/after comparison on the units' own sensors, not an absolute efficiency, and it says "not enough data"
   until enough heating days have passed.
10. **Events are an admin-entered log** (`heat_pump_event`: date, unit or both, type, note). Admins write
    (`adminProcedure`); everyone signed in reads. Events mark the day chart and are the signature's split points.
11. **kWh only, read only.** No kronor and no control in this roadmap.

## Alternatives considered

- **Wrap the Python library in a Vercel Python function.** Upstream fixes would be a version bump, but it adds a
  second runtime and build path that Nitro doesn't manage, an internal endpoint to secure, and breaks the
  one-adapter-per-system shape. Kept as the fallback if the login ever needs scraping we can't port.
- **A bridge at home** (Home Assistant, an ESPHome board on the units' CN-CNT port, or a script pushing to a
  webhook). Needs always-on hardware we don't run; the cloud already has the data, with history.
- **Persist and refresh tokens instead of logging in.** Saves ≈0.5 s a run but means writing a rotating secret
  back to the encrypted store on every run, and a lost write strands the source. Not worth it at four runs a day.
- **Store daily totals only** (the month call). One call per month, but it loses the hourly heating/cooling split
  and the hour-level alignment with the house readings that a later energy-mix or cost phase would need.
- **Plain kWh over time as the efficiency measure.** A mild winter would read as a gain. The signature corrects
  for the temperature difference; the plain series stays on the page as context.
- **Choose any two periods to compare instead of logging events.** Flexible, but nothing remembers when the
  service happened, and the comparison can't be repeated later.
- **A separate outdoor sensor for the signature.** The Shelly sensors are all indoors; the units' own outdoor
  sensors come with every hour, aligned with the energy.

## Consequences

- One new source: a migration widens the source CHECKs (`integration_sync`, `integration_sync_run`,
  `integration_credential`; the `suspect_fields` CHECK stays, as `user` and `password` already exist); every
  exhaustive per-source switch (health copy,
  credential copy, Datakällor, Synka nu, source marks) gets an entry.
- Three new tables. Readings grow by ≈ 17.5k rows a year for two units.
- A dependency on an unofficial API. A change on Panasonic's side fails the source closed (health tile, alert);
  the pages keep showing stored data, and Översikt notes missing heat pump hours instead of inflating övrigt hus
  silently.
- The signature depends on the units' own sensors (the indoor one sits in the unit, the outdoor one can catch sun),
  so its figures are only compared with themselves.
- Hourly storage leaves room for later phases: heat pump cost at spot price, the heat pumps' solar/battery mix,
  control. Each would be its own decision.

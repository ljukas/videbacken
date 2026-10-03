# EV charging — automatic attribution from the car's live state — design

Status: agreed 2026-10-02. Scope: [scope map](./2026-09-28-ev-charging-scope-map.md) step 4 ("Automatic via Škoda
snapshots"). Decision record: [ADR-0022](../../adr/0022-live-vehicle-state-attribution.md).
Builds on: [Phase 5 design](./2026-10-01-ev-charging-phase5-design.md), ADR-0019, ADR-0021.

## Intent

Since the MySkoda export ended (2026-09-27), every new Zaptec session is "Vår bil · antaget": a guest nobody
remembers to tag counts as ours. Poll the **official MyŠkoda Public API** every 15 minutes, keep what the car
reports, and let new sessions be marked ours or guest **by themselves**. An admin tag still always wins.

**Success:** over the following weeks, real sessions get the right attribution with no clicks; when the Škoda feed
is down or the key has expired, sessions stay "antaget" — never wrongly "Gäst". The key's expiry never surprises
anyone: admins are warned in the app and by email well before it lapses.

## What the API really does (a live probe of the owner's Enyaq)

Docs + OpenAPI spec: `https://public.api.connect.skoda-auto.cz/docs` (public). Live calls, redacted:

- One read endpoint: `GET /api/v1/vehicles/{vin}?include=charging,odometer,parkingPosition`, header `X-API-Key`.
  No vehicle list — the VIN is configuration.
- **Key lifetime ≈ 6 months**: every response carries `X-API-Key-Expires-At`, ≈ the key's creation time + 180 days
  (to the second). Expired → 401 `problems/api-key-expired`; wrong VIN/key → 403 `problems/api-key-not-authorized`.
- **Rate limit 20/h per VIN, fixed hourly window** (`RateLimit-Remaining` went 18→15, then back to 19 with
  `RateLimit-Reset: 3600`). Errors including 5xx count; 401/403 don't.
- **Each part has its own `carCapturedTimestamp`** — when the car last reported it. A GET does not wake the car.
- **The car reports on change, not continuously.** After a plug-in the odometer part was reported ≈1 min later and
  the charging part ≈3 min later (`CHARGING`, `AC`, `CONNECTED`, `LOCKED`). While charging steadily the charging part
  then froze for over an hour (its SoC unchanged throughout, though the battery gained several percent meanwhile). A
  pause by the house's load balancing was reported within ≈3 min (`CHARGING_INTERRUPTED`, 0 kW); the resume within
  seconds (`CHARGING`).
  → A report's state **holds until the car reports again**; its SoC can be stale by an hour or more.
- **The plug state is wrong for a while after an unplug.** After an unplug and drive-off, fresh charging reports
  over the next ≈10 min still said `CONNECTED`/`LOCKED` while `parkingPosition.state` was `IN_MOTION` and the
  odometer rose by 4 km; `DISCONNECTED` arrived only ≈27 min after the unplug. Position and odometer updated
  promptly, **independently of the charging part**.
  → Classify **every poll** (plug *and* position), and let the **majority of known time** decide, so a stale stretch
  at a session's edge is outvoted.
- `chargeType` and `state` are **omitted** when not applicable (unplugged: `state: CONNECT_CABLE`, no `chargeType`).
  Enums "may gain new values".
- **`isVehicleInSavedLocation` is unreliable** as a home signal: `true` while unplugged at home and while charging,
  `false` while plugged in at home with charging interrupted (and the profile was absent from that response).
  → Not used; a GPS geofence replaces it.
- A 200 can be partial: an omitted part is listed in `errors[]` (e.g. `CHARGING_UNAVAILABLE`).

## Decisions (agreed with the owner)

| # | Decision |
|---|---|
| 1 | Keep the raw evidence: a `vehicle_state_snapshot` table (one row **per poll**) + an evidence rule (approach A). Rejected: B — synthesise `vehicle_charge_record` rows from snapshot sequences (the log's min..max coverage would turn every polling gap into "guest"; short sessions missed); C — decide at poll time (Zaptec only reports finished sessions, hourly). |
| 2 | Decide on **plug state + position** (`IN_MOTION`, a GPS geofence); the API's home flag is not used. |
| 2b | **Majority of known time** decides (rule v2), not "any connected evidence" (v1): after an unplug the car reported `CONNECTED` for ≈27 min, which under v1 would make the "we unplug, the guest plugs in" session ours. |
| 3 | A polling gap never makes a guest: without enough known state a session stays as it is (`default` = ours). |
| 4 | Store SoC and odometer in the snapshots now (Phase 6 can't backfill them). Never GPS, address or plate. |
| 5 | Key expiry: admin-only warning in the app from 30 days before; email admins at 30 and at 7 days. |
| 6 | No email per guest session — the Gäst badge and the Gäster scope are enough. |
| 7 | Three stacked PRs: collect → attribute → remind. |

## Data model

### `vehicle_state_snapshot` — new (PR 1)

One row **per poll** (append-only): what the car's latest reports said at that moment.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid pk default random` | |
| `polled_at` | `timestamptz not null` | when we asked; index |
| `captured_at` | `timestamptz` null | `charging.carCapturedTimestamp`; null when the charging part is missing |
| `charging_state` | `text` null | raw `charging.status.state` (no CHECK: new values may appear) |
| `charge_type` | `text` null | raw `chargeType` |
| `plug_state` | `text` null | raw `plugConnectionState` |
| `charge_power_kw` | `double precision` null | CHECK `>= 0` |
| `parking_state` | `text` null | raw `parkingPosition.state` (`PARKED`, `IN_MOTION`) |
| `at_home` | `boolean` null | `PARKED` inside the geofence → true; `PARKED` outside or `IN_MOTION` → false; no position or no home point → null |
| `soc_percent` | `smallint` null | CHECK `0..100`; may be stale (see probe) |
| `odometer_km` | `integer` null | CHECK `>= 0` |
| `odometer_captured_at` | `timestamptz` null | the odometer part's own timestamp |

`.enableRLS()`. Raw text columns are length-capped (CHECK `char_length <= 64`) so API drift can't write megabytes.
≈96 rows/day ≈ 35 000/year → no pruning (Phase 6 reads them). The index on `polled_at` serves the rule's range
scan; the schema-design review decides.

### `integration_sync` — two columns (PR 3)

Generic, so any future expiring credential reuses them:

- `credential_expires_at timestamptz` null — last expiry the source reported.
- `credential_reminder_days smallint` null, CHECK `in (30, 7)` — the reminder already emailed **for this expiry**;
  reset to null whenever `credential_expires_at` changes (a renewed key).

### `ev_charge_session.vehicle_source` — one value (PR 2)

`VEHICLE_SOURCES` gains `skoda_live` (the CHECK follows the array). `skoda` keeps meaning "the car's exported log".

## The rule (PR 2, inside `reattributeSessions`)

Precedence: **admin > the exported log (inside its coverage) > live snapshots > default**.

For every counted session with `vehicle_source <> 'admin'` whose `start_at` is **not** inside the export's coverage
(`vehicle_charge_record` min..max, unchanged):

- **Window** `W = [start_at + 10 min, end_at − 10 min]`. Sessions under 40 min (a window under 20 min) and sessions
  with `reliable_clock = false` → undecided (owner ruling). The margin covers the ≈3
  min the car took to report plug-in.
- **Each poll's known interval** = `[polled_at, min(next polled_at, polled_at + 20 min)]` (`lead()` over
  `polled_at`): the state it saw is taken to hold until the next poll, but never across a polling gap.
- **Each poll is classified**:
  - **here** — `plug_state = 'CONNECTED'` and `at_home is distinct from false` (position unknown → plug alone);
  - **not here** — `plug_state = 'DISCONNECTED'` or `at_home = false` (moving, or parked elsewhere — this wins over a
    `CONNECTED` that may be stale);
  - **unknown** — anything else (no plug state, position not contradicting).
- `here` / `notHere` = the summed overlap of each class's known intervals with `W`.
- **Decide** when `here + notHere ≥ ½ |W|`: **ours** if `here ≥ notHere`, else **guest**. Otherwise **unchanged**
  (a `default` row stays `default`; a decided row keeps its answer).

Decided rows get `vehicle_source = 'skoda_live'`. Same statement shape as today: one `UPDATE … FROM`, the admin and
counted guards repeated in the UPDATE's WHERE, only changed rows written, `{ ours, other, changed }` counts both
branches. `setSessionVehicle(id, null)` ("Automatiskt") re-runs it for one session as today.

Accepted residuals (an admin tag fixes them):
- **A short guest session right after we unplug at home**: the car may claim `CONNECTED` for ≈25 min, so a guest
  session under ≈1 h can be outvoted into "ours".
- Our car plugged in elsewhere with no position (`at_home` null) while a guest charges here → ours.

## Poller (PR 1)

- **Effect** `src/lib/effects/skoda/` (Zaptec shape: `skoda.ts` selector + `client.ts` + `errors.ts` + `parse.ts` +
  `adapters/notConfigured.ts` + fixtures + tests). `vehicleState({ signal, stats })` → parsed state +
  `keyExpiresAt`. Zod-parsed with a strict envelope and **each part (`charging`, `odometer`, `parkingPosition`) parsed
  on its own** — a malformed part is dropped (listed in `invalidParts`), the poll still counts; field paths only in
  errors; enum fields are plain strings; leaves nullish; SoC/odometer rounded.
  The client returns the parked position to its caller and never logs it. `SkodaError extends IntegrationError`.
  Status mapping: 401 → `auth_failed`, 403 and 404 (unknown VIN) → `forbidden`, 429 → `rate_limited`,
  5xx/network → `unreachable`, other → `unexpected_response`. Retries: none on 429; 502/503/504/network/timeouts at most
  **once** (a `retryLimit` on the shared policy in `effects/http.ts`), so the worst case is 4 polls × 2 = 8 requests/h,
  under the 20. Error bodies are never read (a 403 body names the VIN). Unset `SKODA_API_KEY` or `SKODA_VIN` →
  `notConfigured` (fails `not_configured`, ADR-0019); no fake/devLog adapter.
- **Geofence** `src/lib/vehicleState/geofence.ts` (pure): parse `SKODA_HOME_COORDINATES` (`"lat,lon"`), haversine
  distance (≈5 lines; no geo library installed — trivial, so hand-rolled), `HOME_RADIUS_M = 150`. `at_home` =
  `PARKED` and within radius; `IN_MOTION` or parked outside → false; missing position or no home point → null. Unset/invalid home point → warn
  once per instance and `geofence: 'off'` on the run line, not a failure.
- **Service** `src/lib/services/vehicleState/` (owns `vehicle_state_snapshot`): `recordSnapshot(input)` —
  one insert per poll (append-only).
- **Sync** `src/lib/vehicleState/sync.ts` `runSkodaSync` on `runPulledSync` (source `skoda`, lease, health, run row,
  alerts, one log line): fetch → snapshot (the charging part missing → a row with null plug state: ok run; a missing part logs at info, an
  invalid part at warn — counts only for missing parts) → expiry
  bookkeeping (added in PR 3) → `reattributeSessions()` (added in PR 2) raced against the deadline, failure = warn.
  Timings `fetchMs`, `snapshotMs`, `reattributeMs` (+ `reminderMs` in PR 3). The run line never carries presence
  (no plug state, position or `at_home`). Run stats: `sessionsSeen` = 1, `upserted` = 1 when the
  row was stored.
- **Cron** `/api/cron/skoda-sync`, `7,22,37,52 * * * *` (every 15 min — offset from Zaptec's `0 * * * *` so the two
  re-matches never run at once) in `vite.config.ts`, `CRON_SECRET`-gated via `handleCronRun`.
- **Health**: `STALE_AFTER_MS.skoda` 26 h → 1 h; a new per-source `ALERT_AFTER_FAILURES` (Škoda **3**, the others 1)
  so a single 503/429 at a 15-min cadence doesn't email every admin (owner ruling). Procedures' `chargingSource` enum
  and `syncNow` gain `skoda`; `vehicleStateLatest` (admin) returns `{ polledAt, capturedAt }` only.

## Key-expiry reminder (PR 3)

- After each successful poll the sync stores `keyExpiresAt` (`integrationSync.recordCredentialExpiry`; a changed date
  resets `credential_reminder_days`). Then, if `≤ 30 days` remain and no reminder sent → claim 30 and email; if
  `≤ 7 days` remain and 7 not sent → claim 7 and email. The claim is a conditional UPDATE … RETURNING, so two runs
  never claim the same reminder; if no admin could be emailed (none active, or every publish failed) the claim is
  released and the next poll retries. A missing header keeps the stored date (warn). The expiry is returned only in
  the health's `adminDetail` (admins).
- Email: new React Email `CredentialExpiryEmail` ("Škoda-nyckeln går ut den 15 januari 2027"; the 7-day one "Sista påminnelsen: …"): what to do —
  create a new key in MyŠkoda (https://go.skoda.eu/api-keys), replace `SKODA_API_KEY` in Vercel (Production), redeploy. New queue topic
  `email_credential_expiry` to every active admin (the recipe in CLAUDE.md; same fan-out as the sync alert).
- After expiry the poll gets 401 → the existing `auth_failed` health alert + email. Nothing extra.
- Runbook `docs/runbooks/skoda-api-key.md` (create key, set the three env vars, redeploy, verify with "Hämta bilens status").

## UI (sv + en; responsive)

- **PR 1** — Översikt `SyncHealthAlert` for `skoda` (**admin-only**, like elpris: a household member can't act on
  the car feed) with real copy (replaces the Zaptec-copy stubs), e.g.
  `auth_failed` → "Škoda-nyckeln fungerar inte längre (har den gått ut?). En admin behöver skapa en ny."; admin card
  "Bilens laddlogg" → **"Bilens data"**: CSV coverage (as today) + "Senaste kontakt med bilen: 11:08" + **Hämta bilens status** (its own
  label, distinct from the heading's "Synka nu"); plus a Škoda run-history card.
- **PR 2** — "Vem laddade?" copy for `skoda_live`: "Vår bil · enligt bilens status" / "Gäst · enligt bilens status".
- **PR 3** — admin-only warning `Alert` on Översikt from 30 days before expiry, only while the source is healthy
  (after expiry the `auth_failed` alert takes over); destructive styling from 7 days: "Škoda-nyckeln går ut 15 januari 2027
  (om 12 dagar). Skapa en ny i MyŠkoda-appen, byt SKODA_API_KEY i Vercel och deploya om."; the card shows "Nyckeln
  gäller till 15 januari 2027".

## Errors and edge cases

| Case | Behaviour |
|---|---|
| Key expired / revoked | 401 → `auth_failed` alert + email; sessions stay as they are |
| Wrong VIN / key not for this car | 403 → `forbidden` |
| Rate limited | 429 → `rate_limited`, no retry; next cron run |
| Charging part missing (`errors[]`) | ok run, a row with unknown plug state, info (only the count) |
| A part in a shape we reject | that part dropped, the rest kept; ok run, warn (our part names) |
| Unknown enum value | stored raw; the rule only matches `CONNECTED` |
| Polling down during a session | known coverage < ½ → unchanged ("antaget") |
| Session < 40 min, or unreliable clock | unchanged |
| Car asleep away all day, guest charges | every poll says not here (unplugged / away) → guest |
| We unplug at home, hand the cable to a guest | ≈25 min of stale `CONNECTED` is outvoted by the rest of the session → guest (a guest session under ≈1 h may still read as ours) |
| Our car drives off still reporting `CONNECTED` | `IN_MOTION` / outside the geofence → not here |
| Car plugged in elsewhere, position known | connected but `at_home = false` → guest |
| Home point unset | geofence off; plug state and whether the car is moving decide; warned once per instance |
| Export coverage | the exported log keeps deciding inside it |
| Duplicate cron delivery | lease → second run skipped |

## Testing

- **Node**: client status mapping + partial responses + header parsing (`fakeFetch`, fixtures from the probe,
  redacted); geofence (inside/outside/IN_MOTION/missing/unset); `recordSnapshot`; sync: snapshot
  written, missing part, not_configured, reattribute failure is a warn; the rule — ours, guest, gap → unchanged,
  margin, < 40 min, unreliable clock, majority (stale `CONNECTED` at the start of a long guest session → guest), < ½ known → unchanged,
  polling gap > 20 min not bridged, connected + `IN_MOTION` → not here, `at_home` null → plug alone, admin wins, export precedence, idempotent;
  reminder at 30/7 days, no double-send, reset on renewal; email template render.
- **Browser**: Škoda health copy, "Bilens data" card, `skoda_live` copy, expiry warning admin-only.
- **Live**: a local "Hämta bilens status" against the real API (uses the VIN's real quota); the cron route with the secret.

## Delivery

1. `feat(charging): poll the Škoda API for the car's state` — snapshot table, effect, geofence, service, sync, cron,
   health, card + Synka nu, ADR-0022, this spec, `.env.example`, CLAUDE.md.
2. `feat(charging): attribute new sessions from the car's live state` — rule, `skoda_live`, copy, ADR-0021 note.
3. `feat(charging): remind admins before the Škoda API key expires` — credential columns, reminder, email + topic,
   warning, runbook, ADR-0019 note, scope map step 4 done.

After PR 1 merges: the owner sets `SKODA_API_KEY`, `SKODA_VIN`, `SKODA_HOME_COORDINATES` in Vercel **Production
only** (Preview has its own database, but would share the VIN's 20 requests/h).

## Privacy

`vehicle_state_snapshot` is a household presence history (plugged in / moving / parked away, every 15 min). Rules:
raw rows are never returned to the client except the admin card's latest `{ polledAt, capturedAt }`; the UI shows
per-session results only ("Vår bil / Gäst · enligt bilens status" — acceptable because every user belongs to the household);
RLS stays on with no policies (Supabase's anon/authenticated roles can't read it); no presence in logs; GPS,
address and plate are never stored. Retention: every poll is kept for now (re-matching old sessions and Phase 6
need it); Phase 6 sets a retention rule once it knows what it needs (owner ruling 2026-10-02).

## Out of scope

A live "laddar nu" tile; adaptive polling while charging; Phase 6 insights (the data starts accumulating); guest
ledger; using charge power to match sessions.

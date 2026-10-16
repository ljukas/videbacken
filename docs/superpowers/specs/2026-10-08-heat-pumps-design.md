# Heat pumps (Panasonic Comfort Cloud) — design

Status: agreed 2026-10-08. Decision record: [ADR-0027](../../adr/0027-heat-pump-energy-data.md).
Roadmap and checkpoints: [heat pumps roadmap](../roadmaps/2026-10-08-heat-pumps.md).
Builds on: ADR-0019 (pulled sources), ADR-0024 (Energi pages, `figures.ts`), ADR-0025 (deferred loading, lazy admin
dialogs), ADR-0026 (credential store), ADR-0013 (small CRUD in a responsive dialog), ADR-0016 (empty states).

## Intent

The house has two Panasonic CS-HZ25ZKE air-to-air heat pumps, "Matsal" and "Övervåning", connected to Comfort
Cloud. Energi shows where the electricity comes from, but not what it is used for beyond the car. Bring the heat
pumps' data home and answer data questions: what share of the house's consumption the heat pumps take, how their
consumption develops over time, and whether an event (today's service, a filter cleaning) changes their efficiency.
Controlling the units is out of scope.

**Success:**
- Energi › Översikt shows a second flow diagram, **Användning**: the period's consumption split into laddning,
  each heat pump and övrigt hus. The month chart's Förbrukning stacks the same parts.
- Energi › Värmepumpar shows consumption per month and per day since the first reading (2024-10-31), against last
  year and the outdoor temperature, with logged events marked.
- An energy signature says, per unit, how the kWh after an event compare with what the days before it predict at
  the same temperature difference, or says plainly that there isn't enough data yet.
- Every figure equals a plain SQL sum over `heat_pump_reading` (and the existing sources for the rest).
- Only daily sums reach the browser.

## Owner decisions (2026-10-08)

| # | Decision |
|---|---|
| 1 | **Data, not control.** Read-only; no commands to the units. |
| 2 | **TypeScript port** of the Comfort Cloud client as an effect adapter (approach A), not a Python function. |
| 3 | **Password login, tokens in memory only**, sync about every 6 hours, plus a backfill of the whole history. |
| 4 | **Efficiency = energy signature**: daily kWh against the indoor − outdoor temperature difference, before vs after an event. |
| 5 | **Events are an admin-entered log** (date, unit or both, type, note); everyone sees them. |
| 6 | **Heat pump page: months + days.** Daily sums are the finest data sent to the browser. |
| 7 | **kWh only**, no kronor. |
| 8 | **Översikt gets a NEW flow diagram**, "Användning", beside Summering ("energy in"); not an extension of Summering. |
| 9 | **The month chart's Förbrukning** stacks laddning, each heat pump and övrigt hus. |
| 10 | **The owner's own Comfort Cloud account** is used: the probe's five logins didn't log the phone app out. |
| 11 | **Slicing**: docs PR, then steps 1a, 1b, 2, 3, 4a, 4b, one session and one PR each (roadmap). |
| 12 | **Off days don't count in the signature** (2026-10-11): a day qualifies only if the unit was heating (heating kWh ≥ 50 % of the day's kWh). |

## What the API gives (live probe, 2026-10-08)

See ADR-0027's context for the full list. The facts the build depends on:

| Fact | Consequence |
|---|---|
| Day history = 24 rows, `dataTime "YYYYMMDD HH"`, in the window `osTimezone` shifts; data is stored per UTC hour | Always send `"+00:00"`: rows are exact UTC hours, DST-proof |
| `consumption` kWh at 1 Wh; `heatConsumptionRate` / `coolConsumptionRate` (0…1); `averageSettingTemp`, `averageInsideTemp`, `averageOutsideTemp` (°C, 0.25 steps) | One reading row per unit-hour with these six values |
| `-255` = no value (future hours; `cost` without a tariff) | Never stored; a temperature of `-255` is stored as null |
| The current hour fills in near real time | Re-fetch the last days every run |
| Month history (`dataMode` 2) = one row per day with the day's total | Cheap backfill probe: one call says which days have data |
| Every history response carries `deviceRegisterTime` (`YYYYMMDD`): the unit's first data day (Matsal `20241031`, Övervåning `20241127`) | The backfill's exact end; stored per unit |
| History from 2024-10-31 (Matsal), 2024-11-27 (Övervåning) | Backfill ≈ 1,400 day calls in total |
| Live status intermittently `500 {"code":5005}` | The sync never reads status; history only |

Response shapes captured by the probe become the adapter's fixtures (step 1a).

## Source and adapter (steps 1a, 1b)

### Effect: `src/lib/effects/comfortCloud/`

Shaped like `effects/emaldo/`: `comfortCloud.ts` (types, selector, facade via `keyedAdapter`), `client.ts`,
`errors.ts` (`ComfortCloudError extends IntegrationError`, `op`: `'login' | 'units' | 'history'`),
`adapters/notConfigured.ts`, `parse.ts`, `fixtures.ts`, `index.ts`, registered in `effects/index.ts`.

```ts
type ComfortCloudUnit = { guid: string; name: string; model: string }
type ComfortCloudHour = {
  hourStart: Date                  // UTC
  energyKwh: number
  heatShare: number | null         // 0…1
  coolShare: number | null
  setpointC: number | null
  insideC: number | null
  outsideC: number | null
}
type ComfortCloudHistory<T> = {
  registeredOn: string             // YYYY-MM-DD, from deviceRegisterTime: the unit's first data day
  rows: T[]                        // only rows with a value
}
interface ComfortCloudClient {
  units(): Promise<ComfortCloudUnit[]>
  dayHours(guid: string, utcDay: string /* YYYY-MM-DD */): Promise<ComfortCloudHistory<ComfortCloudHour>>
  monthDays(guid: string, utcMonth: string /* YYYY-MM */): Promise<ComfortCloudHistory<{ day: string; energyKwh: number }>>
}
```

`createComfortCloudClient({ fetch, user, password })` logs in with the password lazily, on the first call. The
token lives only in the client's memory, never in the database. `keyedAdapter` keeps the client while the
credentials are unchanged, so a warm instance may reuse the token on a later run; the client logs in again once
the token is older than 23 h (it lasts 24 h) or a call answers 401 without `4106`. The rotating refresh token is
never used.

**Login** (port of `aio-panasonic-comfort-cloud` 2026.8.9 `panasonicauthentication.py`, password path only):
1. PKCE verifier (43 random chars) and S256 challenge; `GET https://authglb.digital.panasonic.com/authorize` with
   the app's client id, audience, scope `openid offline_access comfortcloud.control a2w.control`, the app's
   redirect URI and `auth0Client`; expect 302. A redirect straight to the app redirect URI with a `code` skips to
   step 4.
2. Follow the redirect (200); keep the `_csrf` cookie. `POST /usernamepassword/login` (JSON: client id, redirect
   URI, tenant `pdpauthglb-a1`, `_csrf`, `state`, username, password, connection `PanasonicID-Authentication`).
3. Parse the hidden inputs of the HTML answer. An `mfa_token` input or an Auth0 Guardian config (`window.__g_config`)
   means MFA is demanded → `ComfortCloudError('auth_failed', 'login', { message: 'Comfort Cloud demands a 2FA
   code…' })`. Otherwise `POST /login/callback` (form-encoded, 302), follow the redirect (302) and read `code`
   from its `Location`.
4. `POST /oauth/token` (authorization_code + verifier) → access token (`expires_in` 86400).
5. `POST https://accsmart.panasonic.com/auth/v2/login` (`{ language: 0 }`, API headers without client id) →
   `clientId`, sent as `x-client-id` on every later call.

**API headers** on every `accsmart` call: `x-app-name: Comfort Cloud`, `x-app-type: 1`, `x-app-version`,
`x-app-timestamp` (`YYYY-MM-DD HH:mm:ss`, the UTC wall clock: what upstream sends on a UTC host like Vercel; the
header and the key always use the same string), `x-cfc-api-key`,
`x-user-authorization-v2: Bearer <token>`, `user-agent: G-RAC`. `x-cfc-api-key` = SHA-256 hex of
`"Comfort Cloud" + <app key constant> + <timestamp as UTC epoch ms> + "Bearer " + token`, with `cfc` inserted after
the 9th character. The constants (client id, `auth0Client`, redirect URI, app key) are copied from upstream into
one `constants.ts` with a comment naming the upstream version they came from.

**App version:** a pinned constant (`4.4.0` at the probe). A `401` whose body contains `4106` means a newer app is
published: fetch the version from the Play Store page (regex `\["(\d+\.\d+\.\d+)"\]`, upstream's method), keep it
in memory for the client's lifetime, retry the call once. A failed lookup → `unexpected_response`.

**Calls:**
- `units()`: `GET /device/group` → every device of every group (`deviceGuid`, `deviceName`, `deviceModuleNumber`).
  Non-air-conditioner devices (Aquarea, HWS) are ignored.
- `dayHours(guid, day)`: `POST /deviceHistoryData` `{ deviceGuid, dataMode: 0, date: 'YYYYMMDD', osTimezone:
  '+00:00' }`; the body carries the raw guid (upstream's `/`→`f` replacement is only for URL path segments). Each
  row's `dataTime` must belong to `day`; any other shape → `unexpected_response`. Rows with `consumption < 0` are
  dropped; temperatures of `-255` become null. A response whose `temperatureUnit` isn't 0 (Celsius) →
  `unexpected_response`, naming the unit setting.
- `monthDays(guid, month)`: the same call with `dataMode: 2` and the month's first day; days with
  `consumption < 0` are dropped.

**Errors** (codes from `integrationHealth.ts`): a rejected password (400/401 from `/usernamepassword/login`) or a
demanded MFA code → `auth_failed` (the message says which, `suspectFields: ['user', 'password']` for a rejected
password); 403 → `forbidden`; 429 → `rate_limited`; network failure or 5xx → `unreachable`; anything unparseable or
an unexpected status → `unexpected_response`. Timeouts and retries via `fetchWithRetry` (10 s, retry 502/503/504
once), as Emaldo. After an `auth_failed`, the client refuses to log in again for 5 minutes (Auth0 locks accounts
after repeated failures; Emaldo does the same). A redirect that leaves the Auth0 origin (other than the app's
redirect URI) is refused. The upstream step-up check (a final redirect without a `code` that leads to an MFA page) is
ported too.

**Cookies and HTML:** the Auth0 steps need a cookie jar for `authglb.digital.panasonic.com` and a hidden-input parse.
Neither was installed: step 1a adds `tough-cookie` (the jar) and `htmlparser2` (hidden inputs, entity-decoded), both
verified against the real flow's shapes (server-only, so bundle size doesn't matter). `fetchWithRetry` with
`redirect: 'manual'` returns 302s unread with `Location` and `Set-Cookie` intact.

**Logging:** never the password, tokens, the api key, the `mfa_token` or raw HTML; unit guids only shortened.

### Credentials (step 1b)

`CREDENTIAL_SOURCES` gains `comfortCloud`; `CREDENTIAL_FIELDS.comfortCloud = ['user', 'password']` (both secret,
both required); `CREDENTIAL_ENV_VARS.comfortCloud = { user: 'PANASONIC_USER', password: 'PANASONIC_PASSWORD' }`.
Field copy and hints in `integrationCredentialsMessage.ts`. Both field names already exist, so the `suspect_fields`
CHECK doesn't change; the source CHECK does.

## Schema (steps 1a, 2b, 4a)

All tables end with `.enableRLS()`; schema-design review + `migration-guard` before merge (Non-negotiable).

**`heat_pump`** (step 1a)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK, default random | |
| `guid` | text, unique, not null | Comfort Cloud device guid |
| `name` | text, not null | as in Comfort Cloud, refreshed every sync |
| `model` | text, not null | e.g. `CS-HZ25ZKE` |
| `registered_on` | date, null | `deviceRegisterTime` from the latest history response: the first day with data |
| `history_complete_at` | timestamptz, null | set when the backfill walk has passed `registered_on − 1` (days that answered nothing or were rejected are passed over, not stored) |
| `backfill_cursor` | date, null | the next UTC day the backfill walk looks at (the walk passed over every listed day above it); null = start below the oldest stored day. Added in step 1b (migration 0025) |
| `first_seen_at`, `last_seen_at` | timestamptz, not null | |

**`heat_pump_reading`** (step 1a)

| Column | Type | Notes |
|---|---|---|
| `heat_pump_id` | uuid, FK → `heat_pump` on delete cascade | |
| `hour_start` | timestamptz | on a whole UTC hour (CHECK `date_bin('1 hour', hour_start, timestamptz '2000-01-01 00:00:00+00') = hour_start`, as `house_energy_reading`; `date_trunc` would follow the session time zone) |
| `energy_kwh` | double precision, not null | CHECK ≥ 0 and < 5 (a 2.5 kW unit can't use 5 kWh an hour) |
| `heat_share`, `cool_share` | double precision, null | CHECK 0…1 |
| `setpoint_c`, `inside_c`, `outside_c` | double precision, null | CHECK −60…60 |

PK (`heat_pump_id`, `hour_start`). The reads filter by time across both units, so the plan checks whether an index on
`hour_start` pays (the schema review decides against the real queries).

**`heat_pump_day`** (step 2b): a materialized view of `heat_pump_reading`, one row per unit and Stockholm day with
readings. The sum reads use it, so a request never scans the readings (ADR-0027 decision 6, met at checkpoint 3: warm
`heatPumpMs` 24 ms against `carMs` 16 ms). Defined in a custom migration and declared `.existing()` in
`schema/heatPump.ts`, like `house_energy_month` (ADR-0024): drizzle-kit can't declare its unique index, and changing it
means a new custom migration (drop, create, index, the guarded `REVOKE`).

| Column | Type | Notes |
|---|---|---|
| `heat_pump_id` | uuid | |
| `day` | date | Stockholm calendar day: `(hour_start AT TIME ZONE 'Europe/Stockholm')::date`. Offsets are whole hours, so each UTC hour lies in one day, DST days included (23 or 25 hours) |
| `kwh`, `heat_kwh`, `cool_kwh` | double precision | Σ kWh; Σ kWh × share, a null share counting 0 |
| `inside_c_sum`, `outside_c_sum`, `setpoint_c_sum` | double precision, null | Σ over the hours that have a value |
| `inside_c_hours`, `outside_c_hours`, `setpoint_c_hours` | int | how many hours have a value. A sum and a count, not a mean, so a month (or any range of days) gets the exact hour-weighted mean: Σ sum ÷ Σ hours, the same figure as `avg()` over the hours |
| `hours` | int | hours with a reading |
| `first_hour`, `last_hour` | timestamptz | the day's first and newest stored hour (the read models' expected hours) |

Unique index (`heat_pump_id`, `day`) (`REFRESH … CONCURRENTLY` needs one; ≈ 730 rows a year, so no other index). No
RLS on a materialized view: the migration revokes `anon` and `authenticated`, guarded as in migration 0021. Measured
on prod (2026-10-15, 33.5k readings): building it takes ≈ 28 ms (1,403 rows); today's month read scans the readings in
≈ 11 ms.

**`heat_pump_event`** (step 4a)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `occurred_on` | date, not null | Stockholm calendar day |
| `heat_pump_id` | uuid, null, FK → `heat_pump` (restrict) | null = all units |
| `kind` | text, not null, CHECK in (`service`, `filter`, `setting`, `other`) | |
| `note` | text, null | ≤ 500 chars (service-validated) |
| `created_by` | uuid, FK → `user` on delete set null | |
| `created_at`, `updated_at` | timestamptz, not null | |

Index on `occurred_on`. The source CHECK migration (step 1b) widens `integration_sync_source_check`,
`integration_sync_run_source_check` and `integration_credential_source_check`.

## Service (steps 1a, 1b, 2, 2b, 3, 4a)

`src/lib/services/heatPump/` (`heatPump.ts`, `monthSums.ts`, `daySums.ts`, `heatPumpRead.ts`, `errors.ts`, `index.ts`,
colocated tests with `setupDatabase()`):

- `upsertUnits(units, now)`, `listUnits()` (1a): insert or update by guid (name, model, `last_seen_at`); list.
- `newestHour(heatPumpId)` (1b): the unit's newest stored hour, for the offline rule.
- `setBackfillCursor(heatPumpId, day)` (1b): saves where the unit's backfill walk continues.
- `replaceDay(heatPumpId, utcDay, hours)`: in one transaction, delete the unit's hours of that UTC day and insert
  the given ones. Rejects an hour outside the day or a value outside the CHECKs (`HeatPumpDomainError`
  `INVALID_READING`), so a bad row fails the day, not the run (Emaldo's `rejectedDays` pattern).
- `oldestDay(heatPumpId)`, `setRegisteredOn(heatPumpId, day)` (from each history response; a date earlier than the
  stored one clears `history_complete_at`, so the backfill reopens), `markHistoryComplete(heatPumpId, now)`.
- Reads: `monthSums({ from, to })` (step 2, `monthSums.ts`) and `daySums({ from, to })` + `readingSpans` (step 3,
  `daySums.ts`). Both sum per unit per Stockholm month or day from UTC hours, the ADR-0024 way (sum per UTC hour,
  then convert the hour; Stockholm offsets are whole hours). They return kWh, heating kWh (Σ kWh × heat share, a
  null share counting 0), cooling kWh, the hour-weighted mean indoor / outdoor / setpoint temperature and the hour
  count.
- **Both read `heat_pump_day`** (amended in step 2b). `monthSums({ from, to })` keeps its signature and rows; `from`
  and `to` may be any instants. In one statement it takes the whole Stockholm days inside [from, to) from the view,
  and a partial first day [from, next midnight) and a partial last day [last midnight, to) from the readings, then
  groups the three parts by unit and Stockholm month. The partial days filter `heat_pump_id = ANY(the units)` so they
  run on the primary key (≈ 0.2 ms on prod), never a scan. Översikt's range starts at a Stockholm midnight and ends at
  the newest house bucket, so it only has a partial last day; step 3's `lastYearSoFar` (a month a year back, cut at
  the same hour) is the same call. Step 3's `daySums` reads whole days from the view (Värmepumpar ends at now floored
  to the hour, which no stored hour passes). The partial days see an hour as soon as it is stored; whole days lag
  until the run's refresh.
- `refreshDaySums()` (step 2b): `REFRESH MATERIALIZED VIEW CONCURRENTLY heat_pump_day` in a transaction with
  `lock_timeout` 5 s and `statement_timeout` 8 s, like `houseEnergy.refreshMonthSums`, and without parallel workers
  (a parallel aggregate adds the floats in a varying order, so CONCURRENTLY would rewrite every row). Months in the
  read are keyed as dates, so no value passes through the session time zone. Every writer of
  `heat_pump_reading` calls it after writing (today only the Comfort Cloud sync, once per run). Tests that write
  readings and then read sums refresh first.
- **Expected hours** (DST-aware, from `stockholmDayBounds`) are added by the read models, not the sums: from the
  later of the period start and the unit's first reading, to the period's end, clipped to an end point: the newest
  house bucket on Översikt (`energyOverview`, step 2), the later of the newest stored hour's end and now floored to
  the hour on Värmepumpar (`heatPumpRead.ts`, step 3), in whole hours rounded up. Both pages take a unit's end from one
  shared rule (`services/heatPump/unitEnd.ts`, extracted in step 3). Hours after a unit's newest stored hour count as missing only once that trailing gap is ≥ 13 h
  (`STALE_AFTER_MS.comfortCloud`); gaps inside the stored range always count. So a stall of both units shows as
  missing on both pages, and the 6-hourly sync's normal lag shows on neither. Amended in step 2:
  - **A unit Comfort Cloud no longer lists** is one whose `last_seen_at` is older than the newest of any unit's (one
    sync run upserts every listed unit with one timestamp). Its trailing gap counts only up to the later of its
    newest stored hour's end and when it was last listed (never past the period's clipped end), so a removed unit
    isn't missing forever. When the whole source fails, every `last_seen_at` freezes together, no unit counts as
    removed and the gap still counts. Limits: a lone remaining unit can't be detected as removed (its gap keeps
    counting), and a unit dropped from one listing and back later counts its gap only up to that listing.
  - **A unit still listed but sending no data** keeps counting as missing ("värmepumpsdata saknas") while Datakällor
    turns green again after 14 days (the sync then only warns): intended, the data is missing.
  - **A unit appears in a period** when it has hours or expected hours there, or (unless removed) when its first
    reading lies before the period's clipped end: in a new month's first hours, before the next run, it shows
    0 kWh with nothing missing rather than vanishing (and övrigt hus silently holding its kWh).
  - **The cap is per period**: Σ heat pumps > load − laddning scales the heat pumps of that period, so a year's
    figures are not the sum of its capped months when a month's house data has gaps (known; a follow-up).
- Events (step 4a): `listEvents()`, `createEvent`, `updateEvent`, `deleteEvent`, with `HeatPumpDomainError` codes
  `UNKNOWN_HEAT_PUMP`, `FUTURE_DATE`, `EVENT_NOT_FOUND`, `NOTE_TOO_LONG`.

Every code literal is exercised in the tests (`test-completeness`).

## Sync (steps 1b, 2b)

`src/lib/heatPump/sync.ts` + `comfortCloudSyncCron.ts`, `src/routes/api/cron/comfort-cloud-sync.ts`, cron
`{ path: '/api/cron/comfort-cloud-sync', schedule: '20 */6 * * *' }` in `vite.config.ts` (no collision with
`:45` Emaldo, Škoda's `:07` + 15 min, elpris `:30`). Runs inside `runPulledSync` (lease, progress, health, one
`integration sync run` line, alert on a transition).

Per run:
1. `units()` → `upsertUnits`.
2. **Recent:** for each unit, today and every previous UTC day back to the day *before* the day the last successful
   run started (a success at 00:20 may have run before the previous day's hour 23 settled; at least the two previous
   days, at most 14 days counting today; a capped catch-up warns `comfort cloud catch-up capped` with the number of
   days it skipped) → `dayHours` → `replaceDay`. So an outage of up to two weeks heals itself on the first good run;
   an empty answer never deletes stored hours.
3. **Backfill**, for each unit without `history_complete_at`, newest first, while the run's budget allows
   (`DAY_BUDGET_MS`-style: no new day after ≈120 s; at most 60 days per unit per run; 500 ms between day calls):
   - the walk starts at the lower of (the day before the unit's oldest stored day, or three days before today with
     none) and `backfill_cursor`;
   - `monthDays` for the walk's month → the listed days with data at or below it, newest first → `dayHours` →
     `replaceDay` each; then the last day of the month before;
   - the walk stops at `registered_on − 1` (Comfort Cloud's register day may be a local date, so the first UTC hours
     can fall on the day before); once it passes that day, `markHistoryComplete`. When it stops short (budget, cap,
     error) it saves `backfill_cursor`, so a listed day that answers no hours or is rejected is passed over for good
     (re-fetch by setting `backfill_cursor` to NULL); a failed call leaves the cursor at or above that day, for the
     next run to retry. A month answer the client can't parse (e.g. no parseable `deviceRegisterTime`) fails the run
     (`unexpected_response`) and the cursor stays.
   - A unit whose yesterday was rejected or quiet in this run is not backfilled that run (a bad answer must not walk
     the cursor past history); it resumes on the next run with a healthy yesterday. So a unit quiet for more than 14
     days (warn-only, below) keeps its backfill held until data returns.
4. Progress: days done / days planned. Counters on the run line: units, days and months fetched, hours stored, empty
   days, rejected days, units completed, backfill days left (an estimate).

A day is **rejected** when its hours fail validation (`INVALID_READING`) or the client rejects the day's own rows
(`ComfortCloudDayError`: a repeated hour, a row outside the day, a row of the wrong shape): nothing is stored, what's
stored is kept, it counts in `rejectedDays` and warns `comfort cloud day rejected` with the unit name, day and code
only. An answer the client can't read at all (an HTTP 400/404, a body that isn't JSON, a bad envelope, temperatures
not in °C, terms to accept) is about the account, not the day: it fails the run, like every other day error (login,
unreachable, rate limited, …), and the backfill cursor stays at that day.

`STALE_AFTER_MS.comfortCloud` = 13 h (two missed runs); `ALERT_AFTER_FAILURES.comfortCloud` = 2.

A unit whose yesterday (the most recent complete UTC day) has no hours fails the run (`unexpected_response`, naming
the unit and day) as long as its newest stored hour is within the last 14 days: Comfort Cloud returns past hours
reliably, so an empty yesterday means the unit or its Wi-Fi adapter was offline. It keeps failing every run until
data returns (no false "recovered" email); after 14 days without data it only logs a warning
(`comfort cloud unit without data`), so a removed unit stops alerting. A unit that already answers again (its newest
stored hour is from today) only warns (`comfort cloud unit missed yesterday`): yesterday's hole won't fill and the
unit is back. A unit registered after yesterday has no yesterday to miss. The checks run after the backfill, so its
progress still lands.
The recent window reads `last_success_started_at` (the last successful run) only to know how far back to re-fetch.
The backfill's position is `backfill_cursor` (below the oldest stored day when that is lower), and
`history_complete_at` says when it is done. Zero units listed fails the run (`unexpected_response`); a rejected
**yesterday** fails it too (`unexpected_response`, naming the unit and day — a changed unit or range on Panasonic's
side must fail closed); any other rejected day only warns and counts (`rejectedDays`).

**Refreshing `heat_pump_day`** (step 2b). After the units are synced, in a `finally` (so also when the run then fails
or hits its deadline), a run that stored at least one hour (`hoursStored > 0`) refreshes the view through the shared
`refreshAfterSync` (moved from `houseEnergy/` to `src/lib/integrations/refreshAfterSync.ts`, taking the view's name for
its warning). Best effort with a 10 s budget: a failure is a warning (`heat pump day refresh failed`), never a failed
run, and the next run's refresh repairs it. A run that stored nothing doesn't refresh. `refreshMs` goes into the run
stats and the `integration sync run` line.

**Per-source wiring** (exhaustive switches the compiler flags; the full list is in the step 1b plan):
`INTEGRATION_SOURCES`, `policy.ts`, `integrationHealthMessage.ts`, `integrationCredentialsMessage.ts`, the
`credentials` procedure's input union, `evCharging.syncNow` + `SyncNowButton`, `SyncSourceMark` (icon + a
`--source-comfort-cloud` token), `syncSourceCopy.ts`, `SyncHealthAlert` copy, the Datakällor entry on
`/charging/settings`, i18n (`sv` + `en`), and the tests that pin source lists.

## Read model (steps 2, 3)

### `energy.overview` (step 2)

`PeriodSums` gains `heatPumps: HeatPumpPeriod[]`:

```ts
type HeatPumpPeriod = { id: string; name: string; kwh: number; hours: number; expectedHours: number }
```

`getEnergyOverview` adds one grouped read (`heatPump.monthSums` over the house data's range) and adds unit months
into every period the way it adds house months. Units are ordered by `byHeatPumpName` (Swedish collation, then id; one client-safe helper used by every step for
order and colour). Timed as `heatPumpMs`.

`figures.ts` (pure, client-safe, test-first):

| Figure | Rule |
|---|---|
| `car` | min(`carKwh`, load) (unchanged) |
| `heatPumps[i].kwh` | the unit's kWh × min(1, max(0, load − car) ÷ Σ units' kWh); Σ = 0 → 0 |
| `heatPumpShare[i]` | load > 0 ? `heatPumps[i].kwh` ÷ load : null |
| `restOfHouse` | max(0, load − car − Σ `heatPumps[i].kwh`) (was load − car) |
| `heatPumpMissingHours` | max over units of max(0, expectedHours − hours) |

`restOfHouse` changes meaning (it now excludes the heat pumps); its only reader outside `figures.ts` is the month
chart's `house` series, which step 2 changes anyway. Summering is unaffected (it shows `car` only).

### Heat pump procedures (steps 3, 4a, 4b)

`src/lib/orpc/procedures/heatPump.ts`, registered as `heatPump`:

| Procedure | Gate | Input | Returns |
|---|---|---|---|
| `months` | protected | `{ year?: int }` | units; per unit the months of the year and of the year before that lie inside its history (kWh, heating/cooling kWh, mean outdoor °C, hours, expected hours, span hours); year omitted → every month of the history (`year: null`, for Totalt); `availableYears`, `firstReadingDay`, `monthsWithReadings`, `newestMonth`, `lastYearSoFar` |
| `days` | protected | `{ from: date, to: date }` (≤ 800 days) | per unit per Stockholm day: kWh, heating/cooling kWh, mean indoor/outdoor/setpoint °C, hours, expected hours |
| `events.list` | protected | — | all events, newest first |
| `events.create` / `update` / `delete` | admin | Zod schemas | the event; domain errors mapped via `.errors(heatPumpErrors)` |

Each records `context.timings` (`heatPumpMonthsMs`, `heatPumpDaysMs`, plus the read's sub-timings
`heatPumpCoverageMs`, `heatPumpMonthSumsMs`, `heatPumpSoFarMs`, `heatPumpDaySumsMs`). No hourly rows in any output (a
procedure test pins it).

## Energi › Översikt: Användning (step 2)

```
┌ Användning ─────────────────────────────────────── (period from Summering's control) ┐
│                                   ┌──────────────────────────┐                        │
│                          ╭───────►│ 🚗 Laddning   32,9 kWh 13 %│                        │
│ ┌───────────────────┐    │        └──────────────────────────┘                        │
│ │ 🏠 Förbrukning     │────┼───────►│ ❄ Värmepump Matsal   … %  │                        │
│ │    259,7 kWh       │    │        │ ❄ Värmepump Övervåning … %│                        │
│ └───────────────────┘    ╰───────►│ ⌂ Övrigt hus        … %  │                        │
│ Pilens bredd visar mängden energi.                         [Visa värden ●]            │
│ ▸ Visa som tabell                                                                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- A new card below Summering, built like `EnergyFlowDiagram` with visx and hand-placed (no layout library): one
  node left, one node per consumer right in the order laddning, units by name, övrigt hus; on a narrow card the
  source node on top and the consumers below.
- Arrow width = kWh; each arrow in its consumer's colour: `--energy-car` (existing), `--energy-heat-pump-1` … `-3`
  (new, by unit order; validated for ≥ 3:1 contrast in both themes with the data-viz validator, like
  `--energy-export`), `--energy-house` (existing).
- Each consumer node: icon, name, kWh and its share of the load. Values on the arrows follow the existing
  "Visa värden" preference (the same remembered switch as Summering) on the wide layout. On the narrow layout the
  arrows share one lane, so there are no value pills and no switch; the nodes always carry kWh and share.
- "Visa som tabell": consumer, kWh, share.
- Notes: "värmepumpsdata saknas för N h" when `heatPumpMissingHours ≥ 1` (övrigt hus is overstated by that much);
  Summering's "data saknas" note stays where it is.
- Same period, same query as Summering: no extra request. Changing the period moves nothing (the house energy roadmap's step 1b rule,
  measured at 1440, 820, 390 px).
- A period before the first heat pump reading: no heat pump nodes; laddning + övrigt hus only.
- The month chart's `load` metric: `METRIC_SERIES.load` becomes `car`, one series per unit, `house`; the tooltip
  lists them. Units come from the data.
- The Energi pages show a `comfortCloud` `SyncHealthAlert` when unhealthy; the heading's "senast synkad" stays
  Emaldo's.

## Energi › Värmepumpar (steps 3, 4a, 4b)

Route `src/routes/_authenticated/energy/heat-pumps.tsx` (`/energy/heat-pumps`), sidebar sub-item *Värmepumpar*
after *Batteri*, Cmd+K entry. Loader per ADR-0025 (`loadRouteData`; sections in `SectionSkeleton` with captured
bones).

```
[SyncHealthAlert: comfortCloud, only when unhealthy]
Värmepumpar — Förbrukning och temperatur från Panasonic Comfort Cloud. Senast synkad …
┌ Förbrukning ──────────────────────────────── [◀ 2026 ▶ ▾] ┐
│ Matsal 1 512 kWh (−8 % mot 2025)   Övervåning 698 kWh   Ute 6,1 °C │
│ ▇▇ bars per month (Matsal + Övervåning stacked), last year as a faint │
│ outline beside each bar, outdoor °C as a thin line on a right axis   │
│ month chosen → bars per day, event markers ▲ on their days           │
└───────────────────────────────────────────────────────────────────┘
┌ Energisignatur ─────────────── [Matsal | Övervåning]  Händelse [Service 8 okt ▾] ┐
│ scatter: x = inne − ute (°C), y = kWh per dygn; before ● after ○, a line each     │
│ "Efter service: 9 % lägre förbrukning vid samma temperaturskillnad (±4 %,         │
│  24 dagar efter, 90 före)"  or "Inte tillräckligt med data än (6 av 14 dagar)"    │
│ note: the units' own sensors → a before/after comparison, not an absolute figure  │
└───────────────────────────────────────────────────────────────────────────────────┘
┌ Händelser ────────────────────────────────────────── [+ Lägg till] (admin) ┐
│ 8 okt 2026 · Båda · Service · "Årlig service"                 [⋯] (admin) │
└────────────────────────────────────────────────────────────────────────────┘
```

**Förbrukning** (step 3):
- Period control and `?period=` as on Översikt (the Energi `PeriodControl`): a year → 12 month bars; a month → one bar
  per day; Totalt → one bar per month over the whole history. Clicking a month bar selects that month. No period asked
  for: the current month, else the newest month with readings this year, else Totalt (then the history is read).
- Bars: units stacked, in the Användning colours. Last year: a faint outline bar beside each month (year view only).
  Outdoor temperature: a line of the hour-weighted mean on a right-hand °C axis (`BarChart` gained two opt-in options,
  a right-axis line and an outline series; no axis when no row has a value).
- Tiles: kWh per unit for the period; the mean outdoor temperature; "hittills" on a running period. **The change vs
  the same period a year earlier** (amended in step 3) compares equal spans, per unit: it shows only when, in both
  periods, the unit has every month of the period (12 for a past year, January … the running month, or the one month)
  and its stored hours are ≥ 99 % of the period's **calendar** hours (`spanHours`, never clipped to the unit's first
  hour or end, so a unit's first partial month or a removed unit never compares), and ≥ 99 % of its expected hours (so
  a stall hides it). A running period ends where the unit's own data ends (a still-listed unit lagging under 13 h is
  compared over its own span; a removed unit isn't clipped and so never compares), and last year is cut at the same
  Stockholm wall-clock hour a year earlier (`lastYearSoFar`; 29 February → 28 February).
- Missing hours: the same "data saknas för N h" note as Energi. Every tile line keeps its height, so switching
  period moves nothing.
- Data: `heatPump.months` for year views; `heatPump.days` for the chosen month. Unlike Översikt, a unit's months are
  those inside its history up to its end: the "a unit appears in a period" rule (Expected hours) is Översikt's.

**Händelser** (step 4a):
- A list, newest first. Admins add, edit and delete through a responsive dialog (`useUrlDialog`, `useAppForm`,
  `ResponsiveDialog` pattern; admin-only, so `React.lazy` + `LazyDialogMount` + `useIdlePreload`, ADR-0025 §6).
- Fields: date (default today, not in the future), unit (Båda / each unit), type (Service, Filterrengöring,
  Inställning, Annat), note (optional).
- Events show as markers on the day chart: a ▼ above the day's stack in the unit's colour (a marker on a lower
  segment would sit inside the upper one), plus a dashed line across the column for an event covering every unit;
  the type and note in the tooltip. The "every unit" choice reads "Båda" with exactly two units, "Alla" otherwise.
- The roadmap records the first event to enter: **service on 2026-10-08, both units.**

**Energisignatur** (step 4b), computed in the browser from `heatPump.days` by a pure, client-safe module
`src/lib/heatPump/signature.ts` (test-first):

- **Qualifying day** (per unit): every hour of the Stockholm day present (23, 24 or 25; so today's partial day and a
  unit's first day never count), and never today, even with every hour stored (a manual sync late in the day stores
  a partial last hour; amended in step 4b); the unit was heating (heating kWh ≥ 50 % of the day's kWh: a unit that was switched
  off reports a heating share of 0, one that idles in heat mode 1; owner decision 2026-10-11); cooling kWh ≤ 2 % of
  the day's kWh; indoor and outdoor
  means present; ΔT = mean indoor − mean outdoor ≥ 3 °C; the day isn't an event day for that unit.
- **Event** for a unit: events with that unit or Båda. Default: the latest `service`; without one, the latest event of
  any kind; with none, "Ingen händelse loggad än" and no chart. Switching unit resets to that unit's default.
- **Before set:** qualifying days from the previous event for the unit (or the first reading) up to the event day,
  the latest 90 of them. **After set:** qualifying days from the day after the event up to the next event (or today).
- **Fit:** ordinary least squares kWh = a + b·ΔT on the before set. It needs ≥ 14 days spanning ≥ 4 °C of ΔT, else
  "inte tillräckligt med data före händelsen".
- **Readout:** after-days whose ΔT lies outside the before set's ΔT range are drawn hollow and left out (no
  extrapolation). With ≥ 14 remaining after-days: change = (Σ actual − Σ predicted) ÷ Σ predicted, shown as "N %
  lägre/högre förbrukning vid samma temperaturskillnad", with an approximate margin
  ±1.96 × s × √n ÷ Σ predicted (s = the before-fit's residual standard deviation; parameter uncertainty ignored,
  which the note says). Fewer: "Inte tillräckligt med data än (k av 14 dagar)".
- **Library first:** the step 4b plan checks for a small, maintained regression helper (e.g. `simple-statistics`)
  before writing the least-squares fit by hand; d3-array (installed) has none.
- The chart: scatter (visx): before = filled circles, after = filled squares in a second colour, extrapolated
  after-days = hollow squares; each set's fitted line over its ΔT range (the after-line fits the counted after-days,
  none when they span less than 1 °C), the before line solid and the after line dashed, both clipped to the plot
  (the kWh axis starts at 0; a line that dips below it at low ΔT is cut there; amended in step 4b). The margin is the residual SD with n − 2 degrees of freedom, rounded up to a
  whole percent (at least ±1 %); a change that rounds to 0 % reads "ingen skillnad". Σ predicted ≤ 0 counts as
  not enough data before. A before set of ≥ 14 days that spans < 4 °C says the days give no usable line.
- Data: `heatPump.days` for (event − 400 days, not before the first reading) to (the next event or today), fetched in
  chunks of at most 800 days.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| No credentials (Preview, local) | `not_configured`; pages show `Empty` ("Ingen värmepumpsdata ännu", names Comfort Cloud); Användning has no heat pump nodes |
| Password rejected / MFA demanded | `auth_failed` with a message naming which; alert email; stored data still shown |
| Panasonic changes the login or the app key | `unexpected_response` / `auth_failed`; health alert; the port gets fixed from upstream |
| New app version (`401` + `4106`) | Version looked up, call retried once |
| Live status `5005` | Not used by the sync |
| Partial current hour | Stored; corrected by the next run's re-fetch |
| A unit offline for hours | Missing hours → "data saknas för N h" (Värmepumpar) and "värmepumpsdata saknas för N h" (Användning). Hours after a unit's newest stored hour count as missing only once that trailing gap is ≥ 13 h (the stale threshold), so the 6-hourly sync's normal lag shows no note; gaps inside the stored range always count |
| A unit offline for a whole day | Yesterday empty → the run fails (`unexpected_response`, naming the unit and day) every run until data returns, as long as the unit had data within 14 days; after 14 days without data it only logs a warning (a removed unit stops alerting). A unit already answering today only warns (yesterday's hole won't fill). Either way its backfill is held until yesterday answers |
| Yesterday's hours fail validation (e.g. a changed unit), or the client rejects its rows | The run fails (`unexpected_response`, naming the unit and day) every run while it lasts; the unit's backfill is held; other rejected days are skipped with a warning |
| A day whose rows the client rejects (a repeated hour, a row outside the day, a row of the wrong shape) | Rejected like a day that fails validation: skipped with a warning (unit, day, code), counted in `rejectedDays`; the catch-up and the backfill move past it. An answer the client can't read at all (HTTP 400/404, not JSON, a bad envelope) fails the run instead and the backfill retries that day |
| Σ heat pumps > load − laddning (meter noise, or heat pump hours present where house buckets are missing) | Heat pumps scaled down to fit; övrigt hus 0. Per period: a year is capped as a whole, not as the sum of its capped months, so with a house-data gap in one month the year's övrigt hus can read lower (known) |
| A unit Comfort Cloud no longer lists (another unit was listed after it last was) | Its trailing gap counts only up to the later of its newest stored hour's end and its last listing; no node in a later period. The whole source failing freezes every listing together, so the gap still counts. A lone remaining unit can't be detected as removed; a unit dropped from one listing and back counts its gap only to that listing |
| A unit still listed but sending no data for more than 14 days | Still counted as missing ("värmepumpsdata saknas för N h") while Datakällor is green again (warn-only after 14 days): intended, the data is missing |
| A new month's first hours, before the next 6-hourly run | Each listed unit with earlier readings keeps its node at 0 kWh, nothing missing |
| A unit renamed in Comfort Cloud | Name refreshed on the next sync; history kept (keyed by guid) |
| A third unit added | Discovered, backfilled, a third colour (a fourth gets a neutral colour; colours never cycle) |
| A gap of a whole month in a unit's history | The backfill continues to `registered_on − 1`; empty months cost one month call each |
| Fewer than 14 qualifying days before/after | The signature says so; no number |

## Testing

- **Adapter** (node, `fakeFetch`, fixtures from the probe): the login sequence (happy path, rejected password, `mfa_token`,
  Guardian config, missing `code`), the `x-cfc-api-key` against upstream's algorithm on a fixed timestamp + token,
  the version retry on `401`/`4106`, `dayHours` parsing (`-255`, UTC hours, a row outside the day →
  `unexpected_response`), `monthDays`, error mapping per status, nothing secret in logged messages.
- **Service** (`setupDatabase()` first): `replaceDay` (replace, reject out-of-day and out-of-range rows), `upsertUnits`,
  month and day sums across a month boundary and both DST days (2025-10-26, 2026-03-29), expected hours clipped to
  the first reading and the newest hour, events CRUD with every domain error code. Step 2b: after a refresh,
  `monthSums` over `heat_pump_day` equals a raw reference sum over the readings for ranges with a mid-day `from`, a
  mid-day `to`, both DST days and a month boundary (UTC 22:00 / 23:00); a partial day stored after the refresh is
  counted, a whole day stored after it is not until the next refresh.
- **Sync** (step 2b): a run that stored hours refreshes once (also when it then fails), one that stored none doesn't,
  a failed refresh warns without failing the run, `refreshMs` is in the run line.
- **Sync**: recent days and the capped catch-up, backfill order and budget, stop at `registered_on − 1` → complete,
  the persisted cursor across runs, a gap month skipped, a rejected day counted (failed validation or bad rows), an
  account-wide error failing the run with the cursor kept, a quiet or rejected yesterday failing the run and holding
  the backfill, progress, `not_configured`.
- **`figures.ts`**: the heat pump cap, shares, `restOfHouse`, missing hours; Summering's figures unchanged.
- **`signature.ts`**: qualifying-day rules, before/after windows around events, the fit on known data, the
  extrapolation exclusion, the margin, the not-enough-data states.
- **Procedures**: gates (events writes are admin-only), input validation, no hourly rows in outputs.
- **Components** (browser): Användning nodes and table, the month chart's series, the heat pump page's tiles, events
  list and dialog, signature states; client-safe guards for `figures.ts` and `signature.ts`. Layout is verified live
  (no app CSS in browser tests).
- **Live:** 1440, 820, 390 px, light and dark; no layout shift when the period changes.

## Out of scope (later)

- Controlling the units (power, mode, setpoint).
- Kronor: heat pump cost at spot price, the heat pumps' solar/battery mix.
- An hourly profile or intraday view.
- Absolute efficiency (COP); a different outdoor temperature source.

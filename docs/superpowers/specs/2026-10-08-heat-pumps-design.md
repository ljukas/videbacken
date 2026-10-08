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
`x-app-timestamp` (`YYYY-MM-DD HH:mm:ss`, local wall clock as the app sends it), `x-cfc-api-key`,
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
  '+00:00' }`; the guid gets upstream's `/`→`f` replacement. Each row's `dataTime` must belong to `day`; any other
  shape → `unexpected_response`. Rows with `consumption < 0` are dropped; temperatures of `-255` become null.
- `monthDays(guid, month)`: the same call with `dataMode: 2` and the month's first day; days with
  `consumption < 0` are dropped.

**Errors** (codes from `integrationHealth.ts`): rejected password or demanded MFA → `auth_failed` (the message
says which, `suspectFields: ['user', 'password']` for a rejected password); 403 → `forbidden`; 429 →
`rate_limited`; network failure → `unreachable`; anything unparseable or an unexpected status → `unexpected_response`.
Timeouts and retries via `fetchWithRetry` (10 s, retry 502/503/504 once), as Emaldo.

**Cookies and HTML:** the Auth0 steps need a cookie jar for `authglb.digital.panasonic.com` and a hidden-input parse.
Neither is installed. The step 1a plan picks a maintained library for each (candidates: `tough-cookie`,
`htmlparser2`; server-only, so bundle size doesn't matter) per CLAUDE.md's reuse rule; hand-rolling only with the
reason written down.

**Logging:** never the password, tokens, the api key, the `mfa_token` or raw HTML; unit guids only shortened.

### Credentials (step 1b)

`CREDENTIAL_SOURCES` gains `comfortCloud`; `CREDENTIAL_FIELDS.comfortCloud = ['user', 'password']` (both secret,
both required); `CREDENTIAL_ENV_VARS.comfortCloud = { user: 'PANASONIC_USER', password: 'PANASONIC_PASSWORD' }`.
Field copy and hints in `integrationCredentialsMessage.ts`. Both field names already exist, so the `suspect_fields`
CHECK doesn't change; the source CHECK does.

## Schema (steps 1a, 4a)

All tables end with `.enableRLS()`; schema-design review + `migration-guard` before merge (Non-negotiable).

**`heat_pump`** (step 1a)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK, default random | |
| `guid` | text, unique, not null | Comfort Cloud device guid |
| `name` | text, not null | as in Comfort Cloud, refreshed every sync |
| `model` | text, not null | e.g. `CS-HZ25ZKE` |
| `registered_on` | date, null | `deviceRegisterTime` from the latest history response: the first day with data |
| `history_complete_at` | timestamptz, null | set when the backfill has stored every day back to `registered_on` |
| `first_seen_at`, `last_seen_at` | timestamptz, not null | |

**`heat_pump_reading`** (step 1a)

| Column | Type | Notes |
|---|---|---|
| `heat_pump_id` | uuid, FK → `heat_pump` on delete cascade | |
| `hour_start` | timestamptz | on a whole UTC hour (CHECK `date_trunc('hour', hour_start) = hour_start`) |
| `energy_kwh` | double precision, not null | CHECK ≥ 0 and < 5 (a 2.5 kW unit can't use 5 kWh an hour) |
| `heat_share`, `cool_share` | double precision, null | CHECK 0…1 |
| `setpoint_c`, `inside_c`, `outside_c` | double precision, null | CHECK −60…60 |

PK (`heat_pump_id`, `hour_start`). The reads filter by time across both units, so the plan checks whether an index on
`hour_start` pays (the schema review decides against the real queries).

**`heat_pump_event`** (step 4a)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `occurred_on` | date, not null | Stockholm calendar day |
| `heat_pump_id` | uuid, null, FK → `heat_pump` (restrict) | null = all units |
| `kind` | text, not null, CHECK in (`service`, `filter`, `setting`, `other`) | |
| `note` | text, null | ≤ 500 chars (service-validated) |
| `created_by` | text, FK → `user` on delete set null | |
| `created_at`, `updated_at` | timestamptz, not null | |

Index on `occurred_on`. The source CHECK migration (step 1b) widens `integration_sync_source_check`,
`integration_sync_run_source_check` and `integration_credential_source_check`.

## Service (steps 1a, 1b, 3, 4a)

`src/lib/services/heatPump/` (`heatPump.ts`, `errors.ts`, `index.ts`, colocated tests with `setupDatabase()`):

- `upsertUnits(units, now)`: insert or update by guid (name, model, `last_seen_at`).
- `replaceDay(heatPumpId, utcDay, hours)`: in one transaction, delete the unit's hours of that UTC day and insert
  the given ones. Rejects an hour outside the day or a value outside the CHECKs (`HeatPumpDomainError`
  `invalid_reading`), so a bad row fails the day, not the run (Emaldo's `rejectedDays` pattern).
- `oldestDay(heatPumpId)`, `setRegisteredOn(heatPumpId, day)` (from each history response), `markHistoryComplete(heatPumpId, now)`.
- Reads: `monthSums({ from, to })` and `daySums({ from, to })`. Both sum per unit per Stockholm month or day from
  UTC hours, the ADR-0024 way (sum per UTC hour, then convert the hour; Stockholm offsets are whole hours). They
  return kWh, heating kWh (Σ kWh × heat share), cooling kWh, the hour-weighted mean indoor / outdoor / setpoint
  temperature, the hour count and the expected hour count (DST-aware, from `stockholmDayBounds`, clipped to the
  unit's first reading and to the newest stored hour, as ADR-0024 clips buckets).
- Events (step 4a): `listEvents()`, `createEvent`, `updateEvent`, `deleteEvent`, with `HeatPumpDomainError` codes
  `unknown_heat_pump`, `future_date`, `event_not_found`, `note_too_long`.

Every code literal is exercised in the tests (`test-completeness`).

## Sync (step 1b)

`src/lib/heatPump/sync.ts` + `heatPumpSyncCron.ts`, `src/routes/api/cron/comfort-cloud-sync.ts`, cron
`{ path: '/api/cron/comfort-cloud-sync', schedule: '20 */6 * * *' }` in `vite.config.ts` (no collision with
`:45` Emaldo, Škoda's `:07` + 15 min, elpris `:30`). Runs inside `runPulledSync` (lease, progress, health, one
`integration sync run` line, alert on a transition).

Per run:
1. `units()` → `upsertUnits`.
2. **Recent:** for each unit, today and the two previous UTC days → `dayHours` → `replaceDay`.
3. **Backfill**, for each unit without `history_complete_at`, newest first, while the run's budget allows
   (`DAY_BUDGET_MS`-style: no new day after ≈120 s; at most 60 days per unit per run):
   - start from the day before the unit's oldest stored day (with no readings at all: three days before today);
   - `monthDays` for that day's month → the days with data before the start, newest first → `dayHours` →
     `replaceDay` each;
   - the walk stops at `registered_on`; once the day before the oldest stored day is earlier than `registered_on`,
     `markHistoryComplete`. A history response without a parseable `deviceRegisterTime` → `unexpected_response`.
4. Progress: days done / days planned. Counters on the run line: units, days fetched, hours stored, rejected days,
   backfill days left (an estimate).

`STALE_AFTER_MS.comfortCloud` = 13 h (two missed runs); `ALERT_AFTER_FAILURES.comfortCloud` = 2.

A unit whose yesterday comes back empty while the day before it has data fails the run (`unexpected_response`):
Comfort Cloud returns past hours reliably, so an empty yesterday means the unit or its Wi-Fi adapter was offline,
which is worth an alert. No `last_success_started_at` watermark is needed: each unit's oldest stored day is its own
backfill cursor, and `history_complete_at` says when it is done.

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
into every period the way it adds house months. Units are ordered by name. Timed as `heatPumpMs`.

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
| `months` | protected | `{ year?: int }` | units; per unit 12 months of the year and of the year before (kWh, heating/cooling kWh, mean outdoor °C, hours, expected hours); `availableYears`; `firstReadingDay` |
| `days` | protected | `{ from: date, to: date }` (≤ 800 days) | per unit per Stockholm day: kWh, heating/cooling kWh, mean indoor/outdoor/setpoint °C, hours, expected hours |
| `events.list` | protected | — | all events, newest first |
| `events.create` / `update` / `delete` | admin | Zod schemas | the event; domain errors mapped via `.errors(heatPumpErrors)` |

Each records `context.timings` (`heatPumpMonthsMs`, `heatPumpDaysMs`). No hourly rows in any output (a procedure test
pins it).

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
  "Visa värden" preference (the same remembered switch as Summering).
- "Visa som tabell": consumer, kWh, share.
- Notes: "värmepumpsdata saknas för N h" when `heatPumpMissingHours ≥ 1` (övrigt hus is overstated by that much);
  Summering's "data saknas" note stays where it is.
- Same period, same query as Summering: no extra request. Changing the period moves nothing (step 1b's rule,
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
- Period control and `?period=` as on Översikt (step 1b's `PeriodControl`): a year → 12 month bars; a month → one bar
  per day; Totalt → one bar per month over the whole history. Clicking a month bar selects that month.
- Bars: units stacked, in the Användning colours. Last year: a faint outline bar beside each month (year view only).
  Outdoor temperature: a line of the hour-weighted mean on a right-hand °C axis (the visx `BarChart` gets a line
  overlay; the plan decides whether that's an extension of `src/components/chart/` or a sibling component).
- Tiles: kWh per unit for the period; the change vs the same period a year earlier, shown only when both periods have
  ≥ 99 % of their expected hours; the mean outdoor temperature. "hittills" on a running period.
- Missing hours: the same "data saknas för N h" note as Energi.
- Data: `heatPump.months` for year views; `heatPump.days` for the chosen month.

**Händelser** (step 4a):
- A list, newest first. Admins add, edit and delete through a responsive dialog (`useUrlDialog`, `useAppForm`,
  `ResponsiveDialog` pattern; admin-only, so `React.lazy` + `LazyDialogMount` + `useIdlePreload`, ADR-0025 §6).
- Fields: date (default today, not in the future), unit (Båda / each unit), type (Service, Filterrengöring,
  Inställning, Annat), note (optional).
- Events show as markers on the day chart (on their unit's bars, or across for Båda) with the type in the tooltip.
- The roadmap records the first event to enter: **service on 2026-10-08, both units.**

**Energisignatur** (step 4b), computed in the browser from `heatPump.days` by a pure, client-safe module
`src/lib/heatPump/signature.ts` (test-first):

- **Qualifying day** (per unit): all expected hours present; cooling kWh ≤ 2 % of the day's kWh; indoor and outdoor
  means present; ΔT = mean indoor − mean outdoor ≥ 3 °C; the day isn't an event day for that unit.
- **Event** for a unit: events with that unit or Båda. Default: the latest `service`.
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
- The chart: scatter (visx), before and after in two colours, each set's fitted line drawn over its ΔT range.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| No credentials (Preview, local) | `not_configured`; pages show `Empty` ("Ingen värmepumpsdata ännu", names Comfort Cloud); Användning has no heat pump nodes |
| Password rejected / MFA demanded | `auth_failed` with a message naming which; alert email; stored data still shown |
| Panasonic changes the login or the app key | `unexpected_response` / `auth_failed`; health alert; the port gets fixed from upstream |
| New app version (`401` + `4106`) | Version looked up, call retried once |
| Live status `5005` | Not used by the sync |
| Partial current hour | Stored; corrected by the next run's re-fetch |
| A unit offline for hours | Missing hours → "data saknas för N h" (Värmepumpar) and "värmepumpsdata saknas för N h" (Användning) |
| Σ heat pumps > load − laddning (meter noise, or heat pump hours present where house buckets are missing) | Heat pumps scaled down to fit; övrigt hus 0 |
| A unit renamed in Comfort Cloud | Name refreshed on the next sync; history kept (keyed by guid) |
| A third unit added | Discovered, backfilled, a third colour |
| A gap of a whole month in a unit's history | The backfill continues to `registered_on`; empty months cost one month call each |
| Fewer than 14 qualifying days before/after | The signature says so; no number |

## Testing

- **Adapter** (node, `fakeFetch`, fixtures from the probe): the login sequence (happy path, rejected password, `mfa_token`,
  Guardian config, missing `code`), the `x-cfc-api-key` against upstream's algorithm on a fixed timestamp + token,
  the version retry on `401`/`4106`, `dayHours` parsing (`-255`, UTC hours, a row outside the day →
  `unexpected_response`), `monthDays`, error mapping per status, nothing secret in logged messages.
- **Service** (`setupDatabase()` first): `replaceDay` (replace, reject out-of-day and out-of-range rows), `upsertUnits`,
  month and day sums across a month boundary and both DST days (2025-10-26, 2026-03-29), expected hours clipped to
  the first reading and the newest hour, events CRUD with every domain error code.
- **Sync**: recent days, backfill order and budget, stop at `registered_on` → complete, a gap month skipped, a rejected
  day counted, progress, `not_configured`.
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

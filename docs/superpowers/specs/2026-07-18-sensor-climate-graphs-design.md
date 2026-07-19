# Sensor climate graphs — design spec

**Date:** 2026-07-18
**Status:** Approved (design), pending implementation plan
**Feature:** Ingest temperature/humidity webhooks from Shelly H&T Gen3 sensors and
present them as two range-scalable line charts.

---

## 1. Goal & scope

Add the app's first domain feature: a **Climate** page showing a **temperature**
chart and a **humidity** chart for a set of Shelly H&T Gen3 sensors placed under
the house. Each sensor pushes readings via an outbound HTTP webhook; the app
ingests, stores, aggregates, and charts them. Charts have a **shared range
selector**: 24h, 1 month, 3 months, 6 months, 1 year, All time.

### In scope
- A public webhook receiver endpoint for Shelly devices.
- Schema for devices + readings.
- A `sensor` service owning all DB access + domain rules (ADR-0002).
- oRPC read procedures (device list, aggregated series) + admin procedures
  (rename/delete device).
- A `/sensors` page: two charts, shared range selector, per-device toggles,
  current-value tiles, admin device editing.
- i18n (sv source + en), tests, migration, env var.
- Local-network (LAN) test path for a single hand-held device, plus the
  production (Vercel HTTPS) path for the permanent installation.

### Out of scope (YAGNI for v1)
- Realtime/SSE push (we poll instead — see §7).
- Pre-aggregated rollup tables / TimescaleDB (raw + query-time bucketing is
  ample at this scale).
- Alerting/thresholds, CSV export, per-device dedicated pages, min/max bands
  (server returns avg only in v1; min/max is a documented later extension).
- Device-clock timestamps (we use server receipt time).

---

## 2. Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Production endpoint | **Vercel prod HTTPS** | Stable public endpoint reachable from home wifi; matches existing Vercel/arn1 hosting. LAN→dev-machine is the first test step, not the end state. |
| Device onboarding | **Auto-register on first webhook** | Unknown MAC auto-creates an unnamed device row; admin names it later. Lowest friction for 4 sensors. |
| Freshness | **Poll ~60s** (no SSE) | Robust on Vercel serverless (ADR-0004's in-process pub/sub is single-instance and won't fire reliably on serverless). Data cadence is minutes, so polling is plenty. |
| Storage | **Raw readings, aggregate at query time** | 4 sensors × ~event-driven cadence ≈ well under ~500k rows/year; trivial. No rollups. |
| Reading shape | **One snapshot row per webhook** (both temp + humidity) | Shelly status-placeholders let every webhook carry current temp *and* humidity regardless of which event fired — cleaner than per-metric rows. |
| Webhook auth | **Shared secret in query string** (`SHELLY_WEBHOOK_TOKEN`) | Shelly Gen3 webhooks cannot set custom headers; the secret must ride in the URL. Adequate for a home sensor feed. |
| Reading timestamp | **Server receipt time** (`recorded_at default now()`) | Device wakes and fires within seconds; simpler and more reliable than a battery device's clock. |
| Charts | **shadcn `Chart` (Recharts)**, server-side bucket aggregation | Matches the shadcn/Radix stack; server bucketing bounds payload size for long ranges. |

---

## 3. Device facts (Shelly H&T Gen3)

Grounded in the official Shelly Gen2/Gen3 webhook docs
(<https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Webhook/>) and
the H&T Gen3 KB:

- Battery-powered; **sleeps** and wakes on `temperature.change` /
  `humidity.change` events (threshold-based) plus periodic wakeups.
- Webhook = **outbound HTTP GET**; values substituted into the URL as query
  params. **No POST/JSON body, no custom headers.** Interpolated values are
  urlencoded by the device.
- Placeholders used:
  - `${config.sys.device.mac}` — device identity (the MAC).
  - `${status["temperature:0"].tC}` — current temperature in °C.
  - `${status["humidity:0"].rh}` — current relative humidity %.
  - `${status["devicepower:0"].battery.percent}` — battery % (best-effort;
    exact path to be confirmed against the device's live status JSON during the
    hardware test — treat battery as optional).
- Limits (battery device): **10 hooks**, **5 URLs per hook**, **300-char URL**.
  HTTPS supported (built-in CA).
- Using `status[...]` (not `ev.*`) placeholders means both temp and humidity are
  present on **every** webhook, whichever event fired.

**Configured webhook URL** (one URL, referenced by both the temp-change and
humidity-change hooks):

```
https://<app-domain>/api/webhooks/shelly
    ?token=<SHELLY_WEBHOOK_TOKEN>
    &mac=${config.sys.device.mac}
    &t=${status["temperature:0"].tC}
    &h=${status["humidity:0"].rh}
    &batt=${status["devicepower:0"].battery.percent}
```

≈120 chars after substitution — safely under the 300-char cap. The LAN test URL
is identical with `http://<mac-lan-ip>:14600`.

---

## 4. Data model

New file `src/lib/db/schema/sensor.ts`, re-exported from `schema/index.ts`.
snake_case columns, all timestamps `timestamptz` (non-negotiable per CLAUDE.md).

### `sensor_device`
One row per physical Shelly, keyed by MAC.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk `defaultRandom()` | |
| `mac` | `text` notNull **unique** | Device identity from `${config.sys.device.mac}`. Stored normalized (lowercased, `:`-stripped — see §5). |
| `name` | `text` nullable | Friendly name ("NW corner"); null until an admin sets it. |
| `location` | `text` nullable | Optional free text. |
| `battery_pct` | `integer` nullable | Last reported battery %. |
| `last_seen_at` | `timestamptz` nullable | Bumped on every webhook. |
| `created_at` | `timestamptz` notNull `defaultNow()` | |

Index: unique on `mac` (implicit via unique constraint).

### `sensor_reading`
One snapshot row per webhook.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk `defaultRandom()` | |
| `device_id` | `uuid` notNull → `sensor_device.id` `onDelete: 'cascade'` | |
| `temperature_c` | `real` nullable | JS number (not `numeric`, which returns a string). |
| `humidity_pct` | `real` nullable | |
| `battery_pct` | `integer` nullable | |
| `recorded_at` | `timestamptz` notNull `defaultNow()` | Server receipt time. |

Indexes / constraints:
- `index('sensor_reading_device_recorded_idx').on(device_id, recorded_at)` — the
  range-scan access path.
- check: `temperature_c IS NULL OR temperature_c BETWEEN -60 AND 100`.
- check: `humidity_pct IS NULL OR humidity_pct BETWEEN 0 AND 100`.
- check: `battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100`.

Drizzle `relations`: `sensor_device` has many `sensor_reading`; reading belongs
to one device.

**Migration:** `bun run db:generate --name=add_sensor_tables && bun run db:migrate`.
All-new tables — no timestamptz-alter `USING` hazard.

---

## 5. Sensor service (`src/lib/services/sensor/`)

Owns **all** DB access + domain rules (ADR-0002). Shape copied from
`services/user/`: `sensor.ts`, `sensor.test.ts` (`setupDatabase()` first),
`errors.ts`, `index.ts` barrel.

### Domain errors (`errors.ts`)
`SensorDomainError` with English `code` union:
- `DEVICE_NOT_FOUND` — rename/delete targets a missing device id.

(Ingestion never raises a domain error for an unknown MAC — that's the
auto-register happy path.)

### Functions
- `recordReading({ mac, temperatureC, humidityPct, batteryPct })` — **one
  transaction**: normalize MAC → upsert `sensor_device` by MAC (insert unnamed if
  new) → insert `sensor_reading` → bump `last_seen_at` + `battery_pct`. Returns
  the device id. This is the auto-register path.
- `listDevices()` — all devices with a computed `displayName`
  (`name ?? "Sensor " + last4(mac)`), `last_seen_at`, `battery_pct`.
- `getSeries({ range, deviceIds? })` — returns aggregated buckets (see §6).
  Bucketing done in SQL.
- `getLatestPerDevice()` — the newest reading per device, for the current-value
  tiles. (May be folded into `listDevices` via a lateral join.)
- `renameDevice(id, { name, location })` — admin; throws `DEVICE_NOT_FOUND`.
- `deleteDevice(id)` — admin; cascade removes readings; throws
  `DEVICE_NOT_FOUND`.

**MAC normalization:** lowercase + strip separators, so `AA:BB:CC...`,
`aabbcc...`, and `AA-BB-CC...` all resolve to one device. Applied on both write
(`recordReading`) and any lookup.

---

## 6. Aggregation & range mapping

Server buckets readings so the payload stays ~100–400 points regardless of
range. Bucketing uses an epoch-floor expression
(`to_timestamp(floor(extract(epoch from recorded_at) / <bucketSeconds>) *
<bucketSeconds>)`) grouped by device + bucket, selecting `avg(temperature_c)`
and `avg(humidity_pct)`.

| Range key | Window | Bucket | ~points |
|---|---|---|---|
| `24h` | 24 hours | 10 min | ~144 |
| `1m` | 30 days | 3 h | ~240 |
| `3m` | 90 days | 12 h | ~180 |
| `6m` | 180 days | 1 day | ~180 |
| `1y` | 365 days | 1 day | ~365 |
| `all` | since first reading | 1 day, or 1 week if span > ~400 days | bounded |

`range` is a Zod enum: `['24h','1m','3m','6m','1y','all']`.

### `getSeries` response shape
```ts
{
  buckets: Array<{
    t: number                     // bucket start, epoch ms
    perDevice: Record<string, {   // key = device id
      tempAvg: number | null
      humAvg: number | null
    }>
  }>
}
```
Client reshapes `buckets` into two Recharts series sets (one line per device per
chart), sharing a device→color mapping. A missing device key in a bucket renders
as a gap in that device's line.

---

## 7. Backend ↔ client (oRPC + TanStack Query)

New `src/lib/orpc/procedures/sensor.ts`, registered in `orpc/router.ts` as
`sensor`. Procedures are thin glue → service (ADR-0002), gate chosen per op:

| Procedure | Gate | Input | Returns |
|---|---|---|---|
| `sensor.listDevices` | `protectedProcedure` | — | devices + displayName, last-seen, battery, latest reading |
| `sensor.series` | `protectedProcedure` | `{ range, deviceIds? }` | aggregated buckets (§6) |
| `sensor.renameDevice` | `adminProcedure` | `{ id, name, location }` | updated device |
| `sensor.deleteDevice` | `adminProcedure` | `{ id }` | — |

Typed oRPC `.errors({ DEVICE_NOT_FOUND: { status: 404 } })` on the admin
procedures, mapping `SensorDomainError` by code (client localizes by code, same
pattern as `userErrorMessage`).

**Polling:** the page uses `orpc.sensor.series.queryOptions(...)` with
`refetchInterval: 60_000` **only for the `24h` and `1m` ranges** (a new reading
won't visibly move a 1-year daily chart) plus refetch-on-window-focus.
`listDevices`/latest tiles poll on the same 60s cadence.

---

## 8. Webhook receiver (`src/routes/api/webhooks/shelly.ts`)

Plain TanStack Start server route, **GET** handler, modeled on `api/log.ts`
(public, outside the `_authenticated` guard — confirmed by the existing
unauthenticated `api/log.ts` and `api/rpc/$.ts` precedent). Thin: no `db.`
access — everything through the service.

Flow:
1. Read `token` query param; **constant-time compare** to `SHELLY_WEBHOOK_TOKEN`.
   Mismatch/missing → `401`. (Also `500`/log if the env var is unset.)
2. Zod-parse the query: `mac` required (non-empty string), `t`/`h`/`batt`
   coerced numbers, each optional but range-validated. Reject implausible → `400`.
3. `await sensorService.recordReading({ mac, temperatureC, humidityPct, batteryPct })`.
4. Return **`204`** (no body). Log ingestion at debug/info via `~/lib/logger`.

No realtime publish (polling handles freshness). All logging via
`~/lib/logger/server` — never `console.*` (ADR-0003).

---

## 9. Page & charts (`src/routes/_authenticated/sensors.tsx`)

New authenticated route. **English URL `/sensors`**, localized nav label. Add a
`AppSidebar` entry (icon: a Lucide thermometer/gauge). Rendered inside the shared
`PageContainer`. Responsive (desktop/tablet/mobile; no fixed pixel widths).

Layout, top → bottom:
```
┌─ Climate ────────────────────────────────────────────────┐
│  [ 24h ][ 1M ][ 3M ][ 6M ][ 1Y ][ All ]   ← shared range   │
│  ◉ NW corner  ◉ Kitchen  ◉ Boiler  ◉ SW    ← device toggle  │
├───────────────────────────────────────────────────────────┤
│  Current:  [21.4°C · 48%] [19.8°C · 52%] … ← per-device     │
├───────────────────────────────────────────────────────────┤
│  Temperature (°C)  — multi-line, one colored line / device  │
├───────────────────────────────────────────────────────────┤
│  Humidity (%)      — multi-line, one colored line / device  │
└───────────────────────────────────────────────────────────┘
```

Components (new, under `src/components/sensor/`):
- `RangeSelector` — shadcn `ToggleGroup` (single-select), drives both charts.
  Selected range persisted in the URL search param so a reload/deep-link keeps it.
- `DeviceToggles` — show/hide each device's lines across both charts; shared
  device→color map.
- `CurrentReadingTiles` — a stat tile per device (latest temp/humidity, battery,
  "last seen" relative time via `date-fns`).
- `TemperatureChart` / `HumidityChart` — shadcn `Chart` (Recharts `LineChart`),
  tooltip + legend, brand-consistent accessible palette (follow the `dataviz`
  skill for categorical colors, light + dark).
- **Admin device editing:** an edit affordance per device (name/location) via the
  URL-dialog pattern (ADR-0013), calling `sensor.renameDevice`. Visible only when
  `context.user.role === 'admin'`.

**Empty state:** shared `Empty` component (ADR-0016) when no devices exist yet
("No sensors reporting — trigger one to see it here") and per-chart when a device
has no readings in-range.

**shadcn install:** `bunx shadcn@latest add chart` (Radix/radix-nova variant per
`components.json` — never `shadcn init --base`).

---

## 10. i18n

All user-facing strings via Paraglide (`messages/sv.json` source-of-truth +
`messages/en.json` key-complete). Keys under a `sensors_*` namespace (page title,
range labels, chart titles, axis/unit labels, empty states, admin dialog,
tiles). "Videbacken" stays untranslated; URL path stays English (`/sensors`).
Run `bun run i18n:compile` after adding keys.

---

## 11. Environment & config

- Add `SHELLY_WEBHOOK_TOKEN` (32+ char random secret; `openssl rand -base64 32`)
  to `.env`, `.env.example`, and the Vercel project env (all environments used).
- LAN test: `server.host: true` in `vite.config.ts` (or `bun run dev --host`) so
  the dev server binds `0.0.0.0:14600` and is reachable on the LAN; approve the
  macOS firewall prompt for bun/node.

---

## 12. Testing

Vitest **node** project (`setupDatabase()` first — per-test Postgres schema):

- **Service** (`sensor.test.ts`):
  - `recordReading` auto-registers an unknown MAC (creates one device),
    inserts a reading, bumps `last_seen_at`/battery.
  - Repeat MAC (any separator/case variant) resolves to the **same** device.
  - `getSeries` buckets correctly per range (avg within bucket; device grouping;
    gaps for empty buckets).
  - Value validation / check constraints reject out-of-range temp & humidity.
  - `renameDevice` / `deleteDevice` on a missing id throw
    `SensorDomainError('DEVICE_NOT_FOUND')`. **Every `SensorDomainError.code`
    literal exercised** (ADR-0002 testing rule).
- **Webhook route:** 401 on bad/missing token; 400 on bad params; 204 happy path
  (row inserted + device auto-registered).
- **Optional** browser test (`sensors.browser.test.tsx`, `renderWithProviders`)
  for the chart page rendering with seeded query cache.

---

## 13. Build sequence

1. `sensor.ts` schema + `schema/index.ts` re-export → generate + migrate.
2. `sensor` service (`sensor.ts`, `errors.ts`, `index.ts`) + `sensor.test.ts`.
3. Webhook route `api/webhooks/shelly.ts` + route test; add `SHELLY_WEBHOOK_TOKEN`.
4. oRPC `sensor.ts` procedures + register in `router.ts`.
5. `bunx shadcn@latest add chart`.
6. `/sensors` page + `components/sensor/*` (range selector, toggles, tiles, charts,
   admin dialog).
7. Sidebar nav entry + i18n keys (sv + en) + `i18n:compile`.
8. Enable dev-server LAN host; end-to-end hardware test with the hand-held device
   (press button → confirm row → confirm chart).

---

## 14. Open items to confirm during hardware test

- Exact battery placeholder path (`${status["devicepower:0"].battery.percent}`
  vs `.V`) against the device's live status JSON.
- Whether the periodic wakeup alone (no threshold crossing) fires the webhook, or
  thresholds must be set low to guarantee regular points. (Affects only device
  configuration, not app code.)

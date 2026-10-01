# EV charging Phase 5 — ours vs others — design

Status: agreed 2026-10-01. Scope + research: [scope map](./2026-09-28-ev-charging-scope-map.md) ("Phase 5",
"Attributing sessions"). Decision record: [ADR-0021](../../adr/0021-charging-session-vehicle-attribution.md).
Builds on: [Phase 1](./2026-09-28-ev-charging-phase1-design.md), ADR-0019, ADR-0020.

## Intent

**Know our own charging cost.** Every charging total (kWh, cost, economy, patterns) can be limited to *our car*
(the Škoda Enyaq), to *guests*, or to everything. Read-only for everyone signed in; admins correct attributions.

The **guest ledger** (kWh + cost per named guest, Swish settlement) is **deferred** (owner decision): guests are
simply "others" in this phase. Named guests are an additive change later (a nullable `guest_id`, see ADR-0021).

## What the data says (2026-10-01, local DB vs the MySkoda export)

Measured against the 95 counted Zaptec sessions (2026-01-27 → 2026-09-28, 1 660 kWh) and the Enyaq's MySkoda CSV
export (197 sessions, 2025-10-10 → 2026-09-27; see the `skoda-charging-export` note — never committed):

- **91 of 95 Zaptec sessions overlap an Enyaq charge in time** → the export attributes almost all history.
- **4 sessions overlap nothing** (incl. 49 kWh on 2026-07-17) → guests, or gaps in the car's log.
- kWh agreement is loose (Škoda ÷ Zaptec median 0.94, p10 0.57; Škoda rounds to whole kWh and splits differently),
  so **time overlap** is the signal; energy is not used.
- The scope map's **peak-power hint is unusable**: the Enyaq follows the solar, so many of its sessions peak at
  2–4 kW — the same as a one-phase guest car.
- **Nothing automatic exists after 2026-09-27**: the export ends there and the unofficial MySkoda API closes for
  third parties in October 2026. Polling the official Public API is scope-map step 4, deferred.
- 46 non-public Enyaq charges (801 kWh) happened away from this charger — a Phase 6 concern, not this one.

## Decisions (agreed with the owner)

| # | Decision |
|---|---|
| 1 | Purpose: our own cost first; guest ledger deferred. |
| 2 | Sessions after the export (and any session no rule decides) count as **ours by default**; an admin flags guests. |
| 3 | Attribution lives **on the session row** (`vehicle`, `vehicle_source`), plus a stored **`vehicle_charge_record`** of the car's own charging log (approach A of 3; B = a separate attribution table joined on every read, C = a vehicle entity table now). |
| 4 | Škoda-derived attribution is **recomputed** by one `UPDATE … FROM` after each import and each Zaptec sync; an **admin tag always wins** and is never overwritten. |
| 5 | The CSV is **parsed in the browser** (papaparse, lazy-loaded); only the needed fields reach the server — no file bytes through a function (ADR-0006), and location/price never leave the device. |
| 6 | Views get a **Vår bil · Gäster · Alla** scope selector, URL param `vehicle`, **default Vår bil**. |

## Data model

### `ev_charge_session` — two new columns (additive; defaults backfill existing rows)

| Column | Type | Meaning |
|---|---|---|
| `vehicle` | `text not null default 'ours'`, CHECK `in ('ours','other')` | who charged |
| `vehicle_source` | `text not null default 'default'`, CHECK `in ('default','skoda','admin')` | why we think so |

- `default` — no rule decided; counts as ours (decision 2). A third CHECK, `ev_charge_session_vehicle_default_check`
  (`vehicle_source <> 'default' OR vehicle = 'ours'`, migration 0008), keeps an undecided row from being 'other'.
- `skoda` — derived from `vehicle_charge_record` by the re-match rule.
- `admin` — set by an admin; nothing automatic ever overwrites it.

The Zaptec sync's upsert only sets the columns in `zaptecOwnedSessionUpdateSet()`, so it never touches these.
No new index is expected (≈100–200 sessions/year; reads already range-scan `start_at`); the schema-design review
decides against the actual queries.

### `vehicle_charge_record` — new (the car's own charging log)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid pk default random` | |
| `source` | `text not null`, CHECK `in ('skoda_export')` | room for later sources (Public API snapshots) |
| `source_session_id` | `text not null` | unique with `source` → re-import is idempotent |
| `start_at`, `end_at` | `timestamptz not null` | CHECK `end_at >= start_at` |
| `energy_kwh` | `double precision not null` | CHECK `>= 0` |
| `start_soc_percent`, `end_soc_percent` | `smallint` null | CHECK `0..100` (Phase 6) |
| `is_public` | `boolean not null` | the row had a location name; the name itself is dropped |
| `created_at`, `updated_at` | `timestamptz` | house convention |

`.enableRLS()`. **Not stored**: location name, prices, charging location, battery/comfort energy (empty anyway).

### Coverage and the re-match rule

**Coverage** = `min(start_at) … max(end_at)` over all records (the car's log is complete for its period wherever
it charged), computed on the fly (never stored). The admin card shows the same coverage.

For every **counted** session (`countedSessionFilter()`) whose `start_at` lies inside coverage and whose
`vehicle_source <> 'admin'`:

- overlaps (`record.start_at < session.end_at and record.end_at > session.start_at`) **any non-public** record →
  `vehicle = 'ours', vehicle_source = 'skoda'`;
- otherwise → `vehicle = 'other', vehicle_source = 'skoda'`.

Sessions outside coverage are left as they are (`default` stays `default`). Public records never match (a public
charge can't be at our charger). The update is idempotent and deterministic, so concurrent runs (import + sync)
converge by the next re-match: a statement's snapshot can write back a stale answer once, and the hourly sync
heals it. The admin tag is re-checked in the UPDATE's own WHERE, so a concurrent admin tag is never overwritten.

## Services

- **Client-safe vocabulary** `src/lib/evCharging/vehicle.ts` (no db import): `VEHICLES`, `VEHICLE_SCOPES`
  (`ours | other | all`), `VEHICLE_SOURCES`, the zod `vehicleScope`, the import row schema, and the MySkoda CSV
  column names. Covered by the `clientSafe.browser.test.tsx` guard.
- **The one seam**: `countedSessionFilter({ vehicle? })` (`services/evCharging/counted.ts`) adds
  `eq(vehicle, …)` for `ours`/`other`; nothing for `all`/omitted. Threaded through as a `vehicle` input:
  `getOverview`, `listSessions`, `getChargingPatterns`, `getChargingTimeline`, `listSessionEnergy`, and via it
  `getCostOverview`, `getEconomyOverview`.
- **Deliberately unscoped**: `getSessionCosts` (it prices the ids the scoped list chose), `distinctCountedYears` (the year list doesn't change with the scope),
  `earliestCountedStartAt` (spot-price backfill must cover every session), `getSessionEnergy` /
  `getSessionEconomy` (a session page opens whatever its vehicle).
- **`services/evCharging/attribution.ts`** (writes session rows):
  - `reattributeSessions({ sessionId? }): { ours, other, changed }` — the re-match rule above, one statement;
    `ours`/`other` count every session the rule decided, `changed` the rows written. `sessionId` limits it to one
    session (used by the reset); a non-uuid id decides nothing.
  - `setSessionVehicle(sessionId, vehicle | null)` — `'ours'|'other'` sets `vehicle_source = 'admin'`; `null`
    ("Automatiskt") resets to `vehicle = 'ours', vehicle_source = 'default'` then re-runs the rule for that session. Unknown or
    uncounted id → `EvChargingDomainError('EV_SESSION_NOT_FOUND')` (existing code).
- **Read models return the attribution**: session rows from `listSessions` and the economy session table carry
  `vehicle`; `getSessionEnergy` / `getSessionEconomy` carry `vehicle` + `vehicleSource` (badge + "Vem laddade?").
- **`services/vehicleCharge/`** (owns `vehicle_charge_record`; `user/` shape):
  - `importRecords(rows): { inserted, unchanged }` — one transaction, upsert on `(source, source_session_id)`.
  - `coverage(): { from, to, count } | null`.

## Procedures (`orpc/procedures/evCharging.ts`)

- Reads `overview`, `sessions`, `costOverview`, `patterns`, `timeline`, `economy` take
  `vehicle: vehicleScope.default('all')` — the procedure default keeps old callers' meaning; **routes pass
  `'ours'`** by default.
- `setSessionVehicle` — `adminProcedure`, `{ sessionId: uuid, vehicle: 'ours' | 'other' | null }` →
  `{ vehicle, vehicleSource }`; `EV_SESSION_NOT_FOUND` → 404.
- `importVehicleRecords` — `adminProcedure`, `{ rows }` (≤ 5 000; a year is ≈ 200, ≈150 B/row, far below the
  4.5 MB body limit) → `importRecords` then `reattributeSessions` → `{ inserted, unchanged, ours, other }`;
  sub-timings `vehicleImportMs`, `vehicleReattributeMs`. `setSessionVehicle` records `vehicleTagMs`.
  **Import-row contract** (`vehicleRecordInput`; the PR 2 parser must meet it exactly): a strict object (an extra
  key → BAD_REQUEST); `startAt`/`endAt` dates within 2000-01-01..2100-01-01 with `endAt >= startAt`;
  `energyKwh` 0..1000; `sourceSessionId` trimmed, 1..100 chars; `startSocPercent`/`endSocPercent` integer 0..100
  or null; `isPublic` boolean; 1..5 000 rows.
- `vehicleRecordCoverage` — `adminProcedure` → `coverage()`.
- **Sync hook**: `runZaptecSync` calls `reattributeSessions()` after a successful import. The re-match is skipped
  (warn) when the run signal has already aborted, and otherwise raced against the run deadline. A failure or
  cut-off is a warn, never a failed run — health tracks Zaptec, not attribution (ADR-0019). The SQL isn't
  cancelled by a cut-off; the next sync re-derives. The sync records `reattributeMs` in the run row's timings and
  `reattributeChanged` on the run line.

## UI

- **Scope selector** (everyone): segmented control **Vår bil · Gäster · Alla** beside the `YearSelector` on
  Översikt, Mönster and Ekonomi (the `MetricToggle` pattern, Radix ToggleGroup). Search param
  `vehicle: z.enum(['ours','other','all']).optional().catch(undefined)`; missing = `ours`, so a clean URL shows our
  car. In `loaderDeps`, so SSR prefetch and query keys follow it; switching keeps the year and uses `replace`.
  Every tile, chart and table on the page follows it. Under the heading, when not Alla: "Visar bara vår bil" /
  "Visar bara gäster". Scope-aware empty states ("Inga gästladdningar 2026").
- **Gäst badge** on guest rows in `SessionList`, `EconomySessionTable` and the session page header. Our sessions
  carry no badge.
- **Session page — "Vem laddade?"**: everyone sees one line, e.g. "Vår bil · matchad mot bilens laddlogg"
  (`skoda`), "Vår bil · antaget" (`default`), "Gäst · satt av admin" (`admin`). Admins also get an inline select
  **Vår bil / Gäst / Automatiskt**, saved immediately with a toast (ADR-0016; one field, no dialog), invalidating the
  `evCharging` queries.
- **Import** (admins, Översikt): card **"Bilens laddlogg"** with coverage ("197 laddningar, 10 okt 2025 – 27 sep
  2026") or "Ingen laddlogg importerad", and **Importera** → `?dialog=vehicleImport` (responsive overlay,
  ADR-0013; `useAppForm`, ADR-0005). In the dialog: pick the CSV → papaparse (dynamically imported) → zod per row →
  preview ("197 laddningar · 10 okt 2025 – 27 sep 2026 · 12 publika (plats sparas inte)", plus a count of rows
  dropped as unreadable) → **Importera** → "91 laddningar vår bil, 4 gäster". Wrong file → "Filen ser inte ut som
  en MySkoda-export".
- Commit `/data/private/` to `.gitignore` (today it's only in a local `.git/info/exclude`).
- All strings in `messages/sv.json` + `en.json`. Responsive: on mobile the year + scope controls stack.

## Errors and edge cases

| Case | Behaviour |
|---|---|
| Enyaq charging elsewhere while a guest charges here | marked ours; admin tag fixes it (rare) |
| Gap in the car's log | a real Enyaq session marked other; admin tag fixes it |
| Session straddling the coverage end | inside iff `start_at` is inside coverage |
| Voided/replaced session | replacement arrives `default`, next re-match covers it; an admin tag on the old row does **not** carry over (documented) |
| Record insert fails | one statement, all or nothing |
| Re-match fails after the import | import + re-match are two writes: the records stay stored; re-importing (the re-match runs regardless of `inserted`) or the next sync recovers |
| Unparseable CSV rows | dropped client-side, counted in the preview; the server's zod is strict |
| Re-match fails inside sync | warn log; sync result unaffected |

## Testing

- **Node (per-test schema)**: re-match — overlap → ours, none → other, admin wins, reset re-derives, outside
  coverage stays `default`, public records ignored, uncounted sessions untouched; `importRecords` idempotent;
  `coverage`; `setSessionVehicle` not-found. Scope on every scoped read (guest kWh excluded under `ours`, alone
  under `other`, all under `all`), including cost and economy totals. Sync calls the re-match and survives its
  failure.
- **Browser**: scope selector (default, URL round-trip, year kept); import dialog with a **synthetic** fixture CSV
  using the export's quoting (preview, wrong file, result); "Vem laddade?" for admin vs user; Gäst badge;
  client-safe guard for `vehicle.ts`.
- **Live**: import the real CSV locally → 91 ours / 4 other; desktop, tablet, mobile widths.

## Delivery

1. `feat(charging): attribute sessions to our car or guests` — schema + migration (migration-guard + schema-design
   review), services, procedures, sync hook, ADR-0021, this spec.
2. `feat(charging): filter charging views by vehicle` — scope selector, badges, session-page tagging, import card +
   dialog, `.gitignore`.

## Out of scope

Guest ledger and named guests; Škoda Public API polling (scope-map step 4); Phase 6 car insights (SoC is stored
for it); the Phase 4 follow-up giving `/charging/economy` tiles the verdict treatment.

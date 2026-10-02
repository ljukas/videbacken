# EV charging (Zaptec Go) — feasibility + scope map

Status: research / scope map. Date: 2026-09-28. Phase 1 design (supersedes details below): [phase1 design](./2026-09-28-ev-charging-phase1-design.md).

## Context (from the owner)

- Zaptec Go at home, **authorization required**; the owner authorizes almost every
  session themselves — including guests' cars (so Zaptec's `authorizedUser` is
  nearly always the owner and does **not** identify the car).
- Price zone **SE3**, **15-minute spot contract**, **no capacity fee** (effektavgift).
- Visible to **all signed-in users** (read-only), like the climate module; admins mutate.
- Our car: **Škoda Enyaq**. Goal: split total charging into "us" vs "others".

## Verdict

Everything asked for is feasible. The only hard part is **ours vs others**, because
nothing in Zaptec identifies a vehicle.

| Capability | Source | Confidence |
|---|---|---|
| kWh per session / month / year | Zaptec `GET /api/sessions/archived` | High |
| When during the day (≈15-min energy) | Zaptec `energyDetails[]` per session | High (semantics to verify) |
| Spot cost per session | elprisetjustnu.se SE3, 15-min since 2025-10-01, history to 2021 | High |
| Real total cost | spot + retailer markup + nätavgift + energiskatt (36.0 öre ex VAT, 2026) × 1.25 | High (tariff values are settings) |
| Ours vs others | Manual tagging and/or Škoda public API snapshots | Medium |

## Phase 0 probe results (2026-09-28, live API)

- Password grant works; **token lifetime is 24 h** (`expires_in` ≈ 86400), not 1 h.
- One charger ("Förrådet", Zaptec Go, fw 2.6.0.6). `sessions/archived` returns
  `{ sessions, cursor, hasMore }`.
- **History starts 2026-01-27** (installation). 183 sessions total.
  January has 87 sessions of < 0.5 kWh with no user — commissioning noise; the
  import should flag sessions below ~0.5 kWh as noise, not delete them.
  Feb–Sep ≈ 1 600 kWh across 96 real sessions (≈ 10–17 per month).
- **`energyDetails` is per-interval and hour-aligned**, not 15-min: points at the
  session start, every `:00:00`, and the session end; values sum exactly to `energy`
  (0 mismatches). → Cost uses the **mean of the four 15-min prices** in each hour
  (pro-rated for partial first/last hours). Cheaper/dearer quarters inside an hour
  can't be resolved from this data; the error is small and should be stated in the UI.
- **Attribution via Zaptec is impossible:** `tokenName` is null on all 183 sessions and
  `authorizedUser` is the owner on every real session. Steps 1 (probe) fails; use
  manual tagging, a guest RFID tag, or Škoda snapshots.
- Peak hourly energy ≈ 10.8 kWh → the Enyaq charges at ~11 kW three-phase. A guest
  car on one phase would peak at ~3.7 kWh/h — a usable **heuristic hint** for auto-suggestions.
- Charger state (`/api/chargers/{id}/state`, 82 observations) includes per-phase
  voltage/current, charge power, operation mode, and the current session — enough for
  a live "laddar nu" tile.
- `signed` is false and `sessionSignature` is OCMF with hourly meter readings (matches `energyDetails`).

## Data sources

### Zaptec (api.zaptec.com)
- Auth: OAuth2 password grant (`POST /oauth/token`), token 3600 s, no refresh →
  store `ZAPTEC_USERNAME`/`ZAPTEC_PASSWORD` as env vars, re-login per sync.
  Zaptec says the password grant "will be phased out" (no date) — **risk**.
- Build on **`GET /api/sessions/archived`** (`From`/`To` required, filter on end time,
  `To` exclusive; `InstallationId` or `ChargerId`; cursor paging, `PageSize` ≤ 200).
  Session: `id, startDateTime, endDateTime, energy, energyDetails[{timestamp, energy}],
  authorizedUser, tokenName, chargerId, voided, replacedBySessionId, offline, reliableClock`.
- **Not** `/api/chargehistory` — deprecated, removed 2027-01-01.
- `GET /api/chargers/{id}/state` for a live "charging now" tile.
- Limits 10 req/s; fair-use: documented endpoints only, descriptive `User-Agent`, no aggressive polling.
- Push (Azure Service Bus / AMQP) is a held connection → off the table (ADR-0018).

### Spot prices
- **elprisetjustnu.se**: `/api/v1/prices/YYYY/MM-DD_SE3.json`, `SEK_per_kWh` ex VAT,
  96 rows/day since 2025-10-01 (24 before), tomorrow published ~13:00. Free, credit
  line requested ("Elpriser tillhandahålls av Elpriset just nu.se").
- Fallback: ENTSO-E Transparency (free token, A44, SE3 = `10Y1001A1001A46L`).

### Škoda Enyaq
- **Unofficial MySkoda API (`myskoda` lib) is shut off for third-party clients in
  October 2026.** It is the only source with *charging history* and *trip statistics*.
  → **Time-sensitive:** do a one-time export of Enyaq charging history now
  (`myskoda` `charging_statistics`, or CSV from the app) for backfill.
- **Official MyŠkoda Public API** (Aug 2026, free): API key created in the app,
  VIN-bound, expires (manual renewal), **20 req/h/VIN**. **Current state only** —
  `charging.status` (state, chargePowerInKw, AC/DC, SoC, plug state),
  `isVehicleInSavedLocation` (home flag), `odometer.mileageInKm`, `parkingPosition`.
  No history → attribution must come from **snapshots taken during sessions**.

## Attributing sessions: ours vs others

Ordered cheapest → most automated. Each step stands on its own.

1. **Probe first.** Check real sessions: when the owner authorizes via RFID vs the
   app, is `tokenName` set in one case and null in the other? If the Enyaq is always
   started one way and guests another, attribution is free.
2. **Guest RFID tag.** Give guests a dedicated "Gäst" tag → `tokenName` separates
   them with zero infrastructure. (Behavior change, not code.)
3. **Manual tagging (admin).** Each session gets a `vehicle` label (Enyaq / guest /
   named guest), editable in a dialog on `/charging` (ADR-0013). A handful of
   sessions per month makes this realistic, and it is the ground truth the
   automation below can be checked against.
4. **Built 2026-10 (ADR-0022)** — the majority rule replaced "any snapshot inside the window" below. **Automatic via Škoda snapshots.** Poll the public API every ~15 min (4 req/h,
   well under 20/h) and store snapshots. A session is **ours** if a snapshot inside
   its window shows `chargeType=AC` + `state=CHARGING` (or plug connected) +
   `isVehicleInSavedLocation=true`, ideally with power ≈ Zaptec power. Otherwise
   **others**. Cross-check: ΔSoC × usable capacity ≈ 85–92 % of wall kWh.
   - Scheduling: Vercel Hobby cron is daily only, so a 15-min trigger needs an
     external scheduler (e.g. GitHub Actions `schedule` → `POST /api/cron/…` with a
     shared secret). Short request/response, nothing held open → OK under ADR-0018.
   - Auto-classification only *suggests*; a manual tag (step 3) always wins.

Recommendation (after the probe ruled out step 1): step 3 in the first attribution
slice, pre-filled with a peak-power hint (≈ 11 kW → probably the Enyaq; ≤ ~3.7 kW →
probably a guest), plus step 2 as a habit change; step 4 as a follow-up.

## Scope map (phased)

Each phase is shippable on its own and builds on the previous ones.

### Phase 0 — Probe (no app code)
- One real `sessions/archived` call: confirm `energyDetails` is per-interval vs
  cumulative, how far back history goes, and `tokenName`/`authorizedUser` behavior.
- Export Enyaq charging history via `myskoda` **before the October cutoff**.

### Phase 1 — Sessions + totals
- Schema: `ev_charge_session` (upsert on Zaptec id; handle `voided`/`replacedBySessionId`),
  `ev_charge_interval` (session, timestamp, kWh).
- `src/lib/effects/zaptec/` (http + devLog adapters) — fetch only; service owns persistence.
- `src/lib/services/evCharging/` — import, aggregation queries.
- Sync: hourly Vercel cron (Pro) + admin "Synka nu" + first-run backfill. `rpc timing` sub-timings.
- `/charging` page: tiles (this month / this year / all time kWh, session count),
  monthly bar chart with year selector, session list.

#### Connection health (part of Phase 1 — required, not polish)
Every external source (Zaptec now; elpris in Phase 2; Škoda in Phase 5) records
its sync outcome so a broken integration is visible instead of silently stale.
- `integration_sync` row per source: `lastAttemptAt`, `lastSuccessAt`,
  `status` (`ok` | `error`), `errorCode`, `consecutiveFailures`, `lastErrorMessage` (admin-only).
- Error codes (English union, per ADR-0002 style): `auth_failed` (401/400 from
  `/oauth/token` — wrong or changed password, or the password grant was retired),
  `forbidden` (403 — role lost), `rate_limited` (429), `unreachable` (network/5xx/timeout),
  `unexpected_response` (payload no longer matches our schema — API changed).
  Parse responses with zod so API drift surfaces as `unexpected_response`, not a crash.
- UI on `/charging` (everyone sees it; ADR-0016 feedback conventions):
  - Always: "Senast synkad 06:02" under the page title.
  - **Stale** (no success in > 3 h) or **error**: a warning/destructive alert at the
    top with a code-specific message, e.g. `auth_failed` → "Inloggningen mot Zaptec
    fungerar inte längre. En admin behöver uppdatera Zaptec-lösenordet." The data
    below stays visible, labelled as possibly outdated.
  - Admins additionally see the raw error, attempt time, and a "Försök igen" button.
- Notify: email admins (existing email effect) on the **first** failure of a streak
  and again on recovery — not on every failed run.
- Same mechanism later covers Škoda API-key expiry (`X-API-Key-Expires-At` → warn
  14 days ahead) and missing spot prices.

### Phase 2 — Prices + cost
- `spot_price` (zone, slot_start, sek_per_kwh); fetched in the same sync job
  (back-filled for all session dates, then daily).
- Allocate each `energyDetails` interval across the 15-min price slots it overlaps
  (timestamps are not aligned to :00/:15); hourly slots before 2025-10-01.
- Tariff settings (admin): retailer markup öre/kWh, nätavgift öre/kWh, energiskatt,
  VAT. Store versioned with a valid-from date so old sessions keep old tariffs.
- Show **spot cost** and **estimated total cost** per session / month / year.

### Phase 3 — When we charge
- Weekday × hour heatmap (kWh), hour-of-day histogram.
- Calendar heatmap (daily kWh across the year).
- Session timeline: plug-in → charging → plug-out (idle plugged-in time).

### Phase 4 — How economically
- Paid average öre/kWh vs the day's average spot and the month's average spot.
- **Smartness score**: where our cost sat between the cheapest and most expensive
  way to deliver the same kWh inside the plug-in window.
- Counterfactuals per session / month: "charge immediately at plug-in" vs actual vs
  optimal (cheapest slots within the window) → kronor saved / left on the table.
- Price overlay on a session detail chart (energy bars + spot line).

### Phase 5 — Ours vs others
Design (supersedes details below): [phase5 design](./2026-10-01-ev-charging-phase5-design.md), ADR-0021.
- Attribution steps 1–3 above; per-vehicle split in every chart/total.
- **Guest ledger**: kWh + total cost per guest per month — "what X owes us" (Swish
  amount), marked as settled by an admin.
- Follow-up: step 4 (Škoda snapshots + auto-suggest).

### Phase 6 — Car insights (needs Škoda data)
- Cost per km and kWh/100 km (home charging cost ÷ odometer Δ; note public charging is invisible).
- SoC at plug-in / plug-out distribution; charging losses (wall vs battery kWh).
- km per month; share of charging done at home vs elsewhere (SoC rose while away).

### Phase 2b — Grid fee from Eltariff-API (when Vattenfall Eldistribution publishes)
- [Eltariff-API](https://github.com/RI-SE/Eltariff-API) (RISE; free, keyless, machine-readable grid tariffs) —
  grid companies register in the catalogue `https://eltariff.se/tariffcatalogue/{all,lookup/{mpid}}`; target: every
  Swedish grid company by 2027-01-01, Ei preparing regulation. Vattenfall Eldistribution is a project partner.
- **Status 2026-09-29 (verified):** not published — catalogue v0.6.6 has 13 entries, none for Vattenfall or the
  facility prefix `735999100…`; lookup of a synthetic ID in that range → 404; no Vattenfall sample/issue in the repo;
  no endpoint on vattenfalleldistribution.se.
- When live: a third pulled source (ADR-0019) that looks up the facility's tariff and writes the grid-transfer part of
  the tariff periods automatically (`validPeriod` → `valid_from`); also carries any future power/time-of-use fee
  (Vattenfall paused its effektavgift rollout in 2026-03).
- Until then, a monthly catalogue check (own small PR) emails admins when the facility's range appears. The facility
  ID lives in an env var (not in the repo); the check matches ranges locally, never sending the ID.
  **Built 2026-09-30** (`src/lib/gridTariff/`, cron `/api/cron/grid-tariff-catalogue` on the 1st at 06:00 UTC, env
  `GRID_FACILITY_ID`). Stateless: it emails every month while covered. Delete it when Phase 2b lands. Not a
  health-tracked source; see ADR-0019's watcher amendment. Re-probed 2026-09-30: still 13 entries, no Vattenfall.
- Energy tax needs no API: statutory, same for everyone, changes 1 January → built-in table
  (`ENERGY_TAX_ORE_BY_YEAR`, pre-fills new periods). Bixia's monthly "rörliga kostnader" stays manual (no API).

### Later / nice-to-have
- Live "laddar nu" tile from charger state (polled via TanStack Query `refetchInterval`, ADR-0018).
- Year-over-year comparison, year-to-date projection.
- Cheapest-window forecast for tonight (tomorrow's prices are known after ~13:00).
- Efficiency vs outside temperature (join our own climate sensors!).
- ENTSO-E as a second price source.

## Other data worth showing (from Zaptec alone)

- Peak charge power per session (max interval kWh ÷ interval hours) — reveals 1-phase vs 3-phase guests.
- kWh-per-session distribution; average session length; plugged-in-but-idle hours.
- Most expensive and cheapest session of the year; kronor per month trend.
- Data quality flags: `offline` / unreliable clock / voided-and-replaced sessions.

## Risks / open questions

1. Zaptec password grant deprecation (no date) — login flow may need replacing.
2. ~~`energyDetails` semantics~~ — settled: per-interval, hourly (see probe results).
3. ~~Zaptec history depth~~ — settled: full history since installation (2026-01-27).
4. Škoda public API key expiry — needs an "API key expires in N days" warning for admins.
5. 15-min external scheduler (GitHub Actions `schedule`) is best-effort and can lag
   several minutes; acceptable for session matching.
6. Secrets: Zaptec password + Škoda API key live only in Vercel env vars.

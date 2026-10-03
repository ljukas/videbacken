# EV charging — solar-aware cost (Emaldo) — design

Status: agreed 2026-10-03. Decision record: [ADR-0023](../../adr/0023-solar-aware-charging-cost.md).
Roadmap and checkpoints: [solar-aware cost roadmap](../roadmaps/2026-10-03-ev-charging-solar-cost.md).
Builds on: ADR-0019 (pulled sources), ADR-0020 (cost model, `gridShare` seam), ADR-0021/0022 (vehicle scope).

## Intent

Every charging kWh is priced as bought from the grid today, so the cost is an upper bound. The house has solar and an
Emaldo home battery. Show what charging **really costs in cash**, and separately **what the own solar used was
worth** (the export income given up).

**Success:**
- A sunny midday session costs clearly less than today; a winter night session is roughly unchanged.
- The page says what is included ("includes solar and battery from <date>").
- When Emaldo is down, costs fall back to "all grid", labelled, never silently wrong.
- The stored mix is enough for a later solar-aware economy page without new data.

## Decisions (agreed with the owner)

| # | Decision |
|---|---|
| 1 | Show both: **cash cost** as the headline, **value of own solar used** as a separate line. Export pays the plain 15-min spot price (no bonus), so a solar kWh is worth its slot's spot, ex VAT. |
| 2 | Battery = **average-cost pool**: grid inflows at the paid spot, solar inflows at 0 kr cash / their spot as value. Emaldo's AI charges from the grid when cheap. |
| 3 | **Proportional split**: the car gets the same supply mix as the whole house in each 5-minute step. |
| 4 | **Derive at sync, price on read**: the sync stores a money-free mix; kronor stay on read (ADR-0020). |
| 5 | **Economy page stays grid-only** for now and is labelled so; solar-aware economy is a later phase. |
| 6 | Built as five PRs, one per session, steered by the roadmap. |

## What the API does (live probe, 2026-10-03)

Protocol reverse-engineered by `github.com/wertigpar/ha-emaldo` (MIT, one maintainer, active, beta).
Local probe notes and a working TS client: `data/private/emaldo/` (git-excluded; real readings).

- **Every call** is `POST https://{host}{path}{APP_ID}`, form-encoded.
  - Hosts: `/bmt/stats/*` → `dp.emaldo.com`; everything else → `api.emaldo.com`.
  - Headers: `User-Agent: okhttp/4.9.0`, `X-Online-Host: {host}`.
  - Fields: `json` = hex(RC4(APP_SECRET, body + `"gmtime"`)), `token` = hex(RC4(APP_SECRET, `"{token}_{gmtime}"`)),
    `gm=1`. `gmtime` = epoch ms × 1e6, which exceeds `Number.MAX_SAFE_INTEGER`, so it's built as a string.
  - RC4 starts a fresh keystream per field.
- **Response** `{Status, Result, ErrorMessage}`: `Status 1` ok, `-12` session expired; `Result` is hex → RC4 →
  raw (unframed) Snappy, with plain bytes as a fallback.
- **Login** `/user/login/` `{email, password}` → 36-char token. A login ends the account's other sessions.
- **Discovery**: `/home/list-homes/` → homes; `/bmt/list-bmt/` `{home_id, models:[], page_size:30, addtime:1,
  order:"asc"}` → devices `{id, model}`. **Pick the home that has a device**, never the first.
- **Day stats** `{home_id, id, model, offset}`, offset 0 = today (Stockholm), −1 = yesterday, positive → empty:
  - `/bmt/stats/grid/day/` (+ `get_real: true, query_interval: 5`): `[min, import, emergency_import, export, …]`
  - `/bmt/stats/mppt-v2/day/`: `[min, str1, str2, str3, third_party, state]`
  - `/bmt/stats/load/usage-v2/day/`: `[min, ?, load, ?]` (load includes the charger)
  - `/bmt/stats/battery-v2/day/`: `[min, discharge, charge_solar(mppt), charge_grid, charge_ac, state]`
  - Values are average W per 5 min; kWh = W × 5/60/1000. Response carries `start_time` (local midnight, epoch s).
- **Timestamps**: bucket start = `start_time + min × 60`. `min` counts elapsed minutes, so DST days have 276 or 300
  buckets. Drop any row at or past the next day's `start_time`.
- **Gaps**: rows can be missing (one 95-min hole, identical across all four series). Never assume 288.
- **Today** is partial and its newest bucket is still filling → drop the newest bucket of offset 0.
- History reaches far past the charger's installation (2026-01-27); ≈1100 days back returns empty, not an error.
- Daily energy balance (import + solar + discharge ≈ load + export + charge) holds within ≈1.4 %.
- No documented rate limit; the HA integration polls every 60 s. A token survived several minutes; TTL unknown.

**Probe results on seven real sessions** (proportional grid share, uniform spread): sunny midday ≈45–49 %, summer
day ≈57–60 %, summer night ≈65 %, winter/spring night ≈88–94 %. House-first ran 0–12 points higher, car-first up to
32 points lower. During one winter night session the battery took ≈17 kWh from the grid while feeding the house.

## Data model

All tables `.enableRLS()`, timestamps `timestamptz`, server-only (no raw rows to the client).

**`house_energy_reading`**: one row per 5-minute bucket.
- `bucket_start` (PK).
- kWh, each `>= 0`: `grid_import_kwh`, `grid_export_kwh`, `solar_kwh` (sum of all mppt strings + third party),
  `load_kwh`, `battery_discharge_kwh`, `battery_charge_solar_kwh`, `battery_charge_grid_kwh`,
  `battery_charge_ac_kwh`.
- Written per Stockholm day: delete the day's range and insert, in one transaction (like `spot_price.replaceDay`).

**`ev_charge_energy_mix`**: one row per charging session × 15-minute slot.
- `session_id` (FK → `ev_charge_session`, cascade), `slot_start` (UTC quarter-hour); PK `(session_id, slot_start)`.
- kWh, each `>= 0`: `kwh` (the session's energy in this slot), `grid_kwh`, `solar_kwh`, `battery_grid_kwh`,
  `battery_solar_kwh`, `battery_unpriced_kwh`, `no_house_data_kwh`.
- `battery_grid_spot_sek`, `battery_solar_spot_sek`: average spot (SEK/kWh ex VAT) of that battery energy; null
  when its kWh is 0.
- CHECK: the parts sum to `kwh` (within 1e-9 × `kwh` + 1e-9).

**`battery_pool_day`**: the pool's state at the end of each Stockholm day.
- `day` (date, PK), `stored_kwh`, `grid_kwh`, `grid_spot_sek_sum`, `solar_kwh`, `solar_spot_sek_sum`,
  `unpriced_kwh`.
- A re-derive from day D starts from D−1's row, or an empty pool if there's none.

The integration source list gains `emaldo` (CHECK constraints on `integration_sync` / `integration_sync_run`).

## Sync (roadmap step 2)

- **`src/lib/effects/emaldo/`** (step 1): `fetchDay(offset)` → typed buckets, with login, re-login once on `-12`,
  and discovery inside the client.
  - `not_configured` adapter when any of the four env vars is missing.
  - Error mapping: login refused or `-12` after re-login → `auth_failed`; network, 5xx or timeout → `unreachable`;
    undecodable or unparseable response, or an unknown negative `Status` → `unexpected_response`, with an
    admin-only message hinting at a rotated app secret.
  - zod parses every payload.
  - RC4 is hand-rolled (≈15 lines; OpenSSL 3 disables it in Node). Snappy uses the `snappyjs` package if maintained
    (checked in step 1), otherwise a ≈50-line raw decoder, with the reason in the PR.
- **`src/lib/houseEnergy/sync.ts`** through `runPulledSync`:
  - Each run fetches yesterday and today (dropping today's newest bucket) and replaces those days.
  - **Backfill**: while the watermark is older than yesterday, a run also walks forward from the watermark, at most
    30 days per run within the deadline. The first watermark is 7 days before the first Zaptec session, which lets
    the pool settle before the first session it prices.
  - `ALERT_AFTER_FAILURES.emaldo = 1`; stale after 3 h without success, like Zaptec.
- **Cron** `/api/cron/emaldo-sync` at `45 * * * *`: after Zaptec's `:00`, clear of Škoda's `:07/:22/:37/:52`.
- **Sync now** on `/charging` also runs Emaldo. The health alert lists Emaldo like the other sources, with
  sv/en messages per error code.
- Step 2 records the semantics of `battery_charge_ac` from real data. Until then it's treated as **grid-origin**:
  conservative, it never makes charging look cheaper than it was.

## Derivation (roadmap step 3)

Pure and client-safe, in `src/lib/houseEnergy/mix/`, with no db or I/O. `src/lib/houseEnergy/derive.ts`
orchestrates it through services.

1. **Shape the car's energy into 5-minute buckets** (`shape.ts`).
   - Baseline = the median house load of the 6 buckets before the session's start.
   - Each bucket gets a weight = `max(0, load − baseline)`. Each Zaptec interval's kWh is spread over its buckets
     by weight × overlap share.
   - Uniform spread instead when: the weights sum to 0, the baseline is missing, or any covered bucket lacks data.
   - Then clamp each bucket to its `load_kwh` and move the excess to buckets with headroom in the same interval
     (uniform when none has headroom).
   - Invariant: each interval's kWh total is exact.
2. **House supply per bucket** (`supply.ts`).
   - grid → house = `max(0, import − charge_grid − charge_ac)`.
   - solar → house = `max(0, solar − export − charge_solar)`.
   - battery → house = `max(0, discharge − max(0, export − solar))`, so battery energy that was exported isn't
     counted as house supply.
   - Normalise the three to fractions of their sum. A bucket with zero load or zero sum has no house data.
3. **Battery pool** (`pool.ts`), run forward bucket by bucket.
   - Inflows enter at `η` × kWh. `η` is the measured round-trip efficiency, a constant in `pool.ts` set in step 3
     from the backfilled history (Σ discharge ÷ Σ charge over all data), with its measurement date.
   - Grid inflows (`charge_grid` + `charge_ac`) carry their slot's spot. Solar inflows carry their slot's spot as
     value. An inflow in a slot with no spot price joins `unpriced_kwh`.
   - An outflow removes energy proportionally from every part.
   - An outflow larger than the pool empties it, and the excess counts as grid-origin at the current slot's spot:
     conservative, absorbs drift.
4. **Car mix** (`carMix.ts`): per bucket, car kWh × the house fractions.
   - The battery part splits by the pool's composition into battery-grid (+ average spot), battery-solar
     (+ average spot) and battery-unpriced.
   - A bucket with no house data → `no_house_data_kwh`.
   - Buckets aggregate into 15-minute slots: kWh sums, battery spots kWh-weighted.
5. **Re-derive from day D**:
   - Widen D back to the start day of any counted session overlapping D.
   - Load D−1's pool checkpoint, run forward to the last reading, rewrite checkpoints ≥ D and the mix rows of every
     session overlapping [D, end], in one transaction. `context.timings` / run stats record `deriveMs`.
   - Triggers, each after its sync succeeds:
     - Emaldo: earliest replaced day.
     - Zaptec: earliest new or changed session's start day.
     - elpris: earliest day it filled that was missing before.
   - An admin "Re-derive all" is **not** built; a fix ships with a one-off script or migration-time call.
6. **Read-time guard**: when a session's Σ mix `kwh` ≠ its interval energy (|Δ| > 1e-6 kWh), the reader ignores
   its mix (falls back to all-grid) and logs a warning. This catches a Zaptec change the re-derive hasn't reached.

## Cost and display (roadmap steps 4–5)

**Math** (`src/lib/evCharging/cost/`, pure):
- A priced piece gains optional mix fields; without them it is all-grid, as today.
- Cash cost:
  - `grid_kwh` + `no_house_data_kwh` → (slot spot + fees) × (1 + VAT).
  - `battery_grid_kwh` → (`battery_grid_spot_sek` + the use day's fees) × (1 + VAT).
  - Solar parts → 0 kr.
  - `battery_unpriced_kwh` → counted as no-price energy ("at least … kr").
- `CostTotals` gains `solarKwh`, `batteryKwh`, `noHouseDataKwh`, `solarValueSek`.
- Solar value = `solar_kwh` × slot spot + `battery_solar_kwh` × `battery_solar_spot_sek`: no fees, no VAT. A
  missing slot spot leaves that kWh out of the value and counts it.
- `costInputs.ts` loads mix rows for the counted sessions in one query and builds pieces. Sessions without mix rows
  keep `gridShare: 1`. New sub-timing `costMixMs`.
- The economy path (`economy/`) keeps `gridShare: 1`; its comments point to this spec.

**Step 4: cash cost on screen.**
- Overview tiles, the monthly chart and session list costs become the cash cost. Subline: "34 % från sol och
  batteri" / "34 % from solar and battery".
- The cost notice says what's included: solar and battery are counted from the first day with house data, and
  energy without house data is counted as bought from the grid.
- The session page hero becomes the cash cost, plus a grid / solar / battery bar with kWh for each.
- Economy content (the verdict, best-to-worst range and what-if tiles on the economy and session pages) is headed as
  spot timing **as if all energy were bought from the grid**.

**Step 5: value of own solar.** One line under the cash cost: "Värde av egen sol: 212 kr (vad den hade gett vid
försäljning)". Shown on the overview tiles, in the monthly chart popover and on the session page. Hidden when no
solar was used.

All copy goes in `messages/{sv,en}.json` (sv is the source). Vehicle scope (Vår bil · Gäster · Alla) works
unchanged: the mix is per session.

## Errors, health, privacy

- Emaldo failing → no new readings → no new mix rows → new sessions priced all-grid (upper bound). The health alert
  explains it; admins get the first-failure email.
- Readings are a household load profile: server-only, RLS, never logged raw, never sent to the client. Only
  per-session aggregates leave the server.
- The run log line carries counts and timings, never readings.

## Testing

- **Pure modules** (`shape`, `supply`, `pool`, `carMix`, the cost math): test-first with **synthetic** fixtures.
  Cases: DST days (276/300 buckets), gaps, the clamp, the pool's drift case, grid-charged battery, zero load.
  **Never commit real readings**: the repo is public.
- **Effect**: `fakeFetch`; test fixtures are produced by encrypting and compressing synthetic payloads in-test
  (RC4 is symmetric; `snappyjs` compresses). Every error-code path is covered.
- **Services**: `setupDatabase()`; replace-day atomicity, checkpoint round-trip, mix rewrite scope.
- **Sync / derive orchestrators**: the trigger chain and the "from day D" window.
- **UI**: browser tests for the new subline, the mix bar, the notice and the solar-value line; responsive check at
  360 / 820 / 1600.

## Out of scope

- Solar-aware economy page (what-ifs and score): a later phase, its own brainstorm.
- Exported battery energy's income.
- Per-minute charger power.
- A Zaptec-free car-load estimate.
- The admin "re-derive all" button.
- Retention for `house_energy_reading`: kept, like vehicle snapshots.

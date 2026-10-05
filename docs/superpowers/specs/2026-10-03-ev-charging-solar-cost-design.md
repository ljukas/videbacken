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
| 6 | Built as five PRs, one per session, steered by the roadmap (plus step 2b, added 2026-10-04). |
| 7 | **The pool follows the battery's state of charge** (2026-10-04, after checkpoint 2): inflows enter at their full kWh, and after each bucket the pool is trimmed to the measured SoC, keeping its cost. A single round-trip efficiency is gone: losses vary by season (≈0.57 in Jan–Feb, ≈0.92–0.99 from March), and an unbounded pool kept ≈100 kWh of phantom winter-grid energy into the summer. |

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
    - Live rows carry 13 (grid), 6 (mppt), 4 (usage) and 6 (battery) columns; unused columns are ignored. Grid import = import + emergency_import.
  - `/bmt/stats/mppt-v2/day/`: `[min, str1, str2, str3, third_party, state]`
  - `/bmt/stats/load/usage-v2/day/`: `[min, ?, load, ?]` (load includes the charger)
  - `/bmt/stats/battery-v2/day/`: `[min, discharge, charge_solar(mppt), charge_grid, charge_ac, state]`
  - Values are average W per 5 min; kWh = W × 5/60/1000. Response carries `start_time` (local midnight, epoch s).
- **Timestamps**: bucket start = `start_time + min × 60`. `min` counts elapsed minutes, so DST days have 276 or 300
  buckets. Drop any row at or past the next day's `start_time`.
- **Gaps**: rows can be missing (one 95-min hole, identical across all four series). Never assume 288. The full
  history (checkpoint 2) has 8 gaps from 50 min to 9.4 h, one of them across a whole sunny afternoon.
- **Today** is partial and its newest bucket is still filling → drop the newest bucket of offset 0.
- **State of charge** (probe 2026-10-04): `/bmt/stats/battery/power-level/day/` (same body as the others, no extra
  fields) answers the same day shape, rows `[minute, percent]`: integer SoC % every 5 minutes, back to at least
  2026-01-21 (≈80 ms a call). The battery's own `state` column is a mode flag (15/17), not SoC. Fitting ΔSoC
  against the flows on four days: ≈11 % per kWh, so ≈8.5–9 kWh delivered per 100 % in summer and ≈7 kWh in winter,
  with winter charging losing ≈25–35 %. `b-sensor` returns no capacity.
- History reaches far past the charger's installation (2026-01-27); ≈1100 days back returns empty, not an error.
- Daily energy balance (import + solar + discharge ≈ load + export + charge) holds within ≈1.4 %. Over the full
  history (checkpoint 2): ±2 % on 225 of 257 days, with a small negative bias on low-load summer days.
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
- `battery_soc_pct` (step 2b): the battery's state of charge, 0–100, for the row's minute as Emaldo reports it;
  null when the SoC series lacks that minute. It is the battery's state at the bucket's **middle** (settled in step
  3: the change from one row to the next splits evenly between the two buckets' flows, in every month).
- Written per Stockholm day: delete the day's range and insert, in one transaction (like `spot_price.replaceDay`).

**`ev_charge_energy_mix`**: one row per charging session × 15-minute slot.
- `session_id` (FK → `ev_charge_session`, cascade), `slot_start` (UTC quarter-hour); PK `(session_id, slot_start)`.
- kWh, each `>= 0`: `kwh` (the session's energy in this slot), `grid_kwh`, `solar_kwh`, `battery_grid_kwh`,
  `battery_solar_kwh`, `battery_unpriced_kwh`, `no_house_data_kwh`.
- `battery_grid_spot_sek`, `battery_solar_spot_sek`: average spot (SEK/kWh ex VAT) of that battery energy; null
  when its kWh is 0.
- CHECK: the parts sum to `kwh` (within 1e-9 × `kwh` + 1e-9); `0 < kwh < 1000`; `slot_start` on a UTC quarter-hour;
  each battery spot set exactly when its kWh > 0, and finite. No value bound on the spots: losses raise them (step
  3 found ≈ 1.8× the inflow spot in Jan–Feb, up to ≈ 5×), and one row over a bound would fail every later derive.

**`battery_pool_day`**: the pool's state at the end of each Stockholm day.
- `day` (date, PK), `stored_kwh`, `grid_kwh`, `grid_spot_sek_sum`, `solar_kwh`, `solar_spot_sek_sum`,
  `unpriced_kwh`.
- A re-derive from day D starts from D−1's row, or an empty pool if there's none.
- `capacity_kwh` and `derive_version`: the `C` and the derive math's version the row was computed with. A
  checkpoint with another `C` or version is never resumed from: the derive rebuilds from the first reading. So
  changing `C`, or bumping `DERIVE_VERSION` with a fix to the math, rebuilds history at the next trigger.
- `derived_at`; `stored_kwh < 1000` and finite spot sums (NaN and ±Infinity refused).

**`energy_mix_derive_request`** (step 3): a durable queue of pending derives, `(id, from_day, requested_at)`. A
sync adds its day (after its data commits), then runs the derive. A derive takes every request its transaction can
see (`DELETE … RETURNING`) and derives from the earliest day among them. A derive that fails rolls the delete back,
so the next one covers it.

The integration source list gains `emaldo` (CHECK constraints on `integration_sync` / `integration_sync_run`).

## Sync (roadmap step 2)

- **`src/lib/effects/emaldo/`** (step 1): `fetchDay(offset)` → typed buckets, with login, re-login once on `-12`,
  and discovery inside the client.
  - `not_configured` adapter when any of the four env vars is missing.
  - Error mapping: login refused or `-12` after re-login → `auth_failed`; network, 5xx or timeout → `unreachable`;
    HTTP 429 → `rate_limited`; undecodable or unparseable response, or an unknown negative `Status` →
    `unexpected_response`, with an admin-only message hinting at a rotated app secret; any `EMALDO_*` unset →
    `not_configured`.
  - A refused login blocks new logins for 5 minutes (ADR-0019, as Zaptec): calls that need a login reject with the
    same `auth_failed`, sending nothing. Network, timeout, 5xx and 429 on login don't block; the sync layer backs off.
  - A `Status 1` with an empty, missing or null `Result` reads as `{}`, so the schemas decide (login fails on
    `token`, a home without a device is `[]`, stats fails on a path).
  - zod parses every payload.
  - RC4 is hand-rolled (≈15 lines; OpenSSL 3 disables it in Node). Snappy uses the `snappyjs` package (step 1: MIT, no
    dependencies, ≈2.4 M weekly downloads, raw format with a `maxLength` guard; last release 2022, acceptable for a
    frozen format). It doesn't reject every non-Snappy input, so a result counts only once it parses as JSON, Snappy
    first, then plain. `start_time` is capped at 2100, so a garbage day start fails closed.
- **`src/lib/houseEnergy/sync.ts`** through `runPulledSync`:
  - Each run fetches yesterday and today (dropping today's newest bucket) and replaces those days.
  - **Backfill**: while the watermark is older than yesterday, a run also walks forward from the watermark, at most
    30 days per run within the deadline. The first watermark is 7 days before the first Zaptec session, which lets
    the pool settle before the first session it prices.
  - `ALERT_AFTER_FAILURES.emaldo = 1`; stale after 3 h without success, like Zaptec.
- **Cron** `/api/cron/emaldo-sync` at `45 * * * *`: after Zaptec's `:00`, clear of Škoda's `:07/:22/:37/:52`.
- **Sync now** on `/charging` also runs Emaldo. The health alert lists Emaldo like the other sources, with
  sv/en messages per error code.
- **SoC** (step 2b) is a fifth series fetched with the other four. It never gates a bucket: a minute missing from it,
  or a value outside 0–100, stores null. The request itself is part of the day, though: a refused or unparseable SoC
  answer fails the day like any series (a day is all-or-nothing), so a broken SoC endpoint raises the Emaldo alert. Step 2b's migration clears the Emaldo watermark once, so the next runs
  re-fetch the whole history (≈9 hourly runs) and fill `battery_soc_pct`.
- `battery_charge_ac` is **unused on this installation**: 0 in every bucket from 2026-01-20 to 2026-10-04
  (checkpoint 2, prod). It stays stored and keeps the **grid-origin** treatment below, which is conservative (it
  never makes charging look cheaper) and moot while the column is 0. If it ever turns non-zero, settle its meaning
  from that data before trusting the mix.

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
   - Inflows enter at their full kWh: no efficiency factor.
   - Grid inflows (`charge_grid` + `charge_ac`) carry their slot's spot. Solar inflows carry their slot's spot as
     value. An inflow in a slot with no spot price joins `unpriced_kwh`.
   - An outflow removes energy proportionally from every part.
   - An outflow larger than the pool empties it, and the excess counts as grid-origin at the current slot's spot:
     conservative, absorbs drift.
   - **SoC anchor** (decision 7): after each bucket, the pool is capped at `SoC / 100 × C`, using the SoC at the
     bucket's **end**: the mean of that bucket's row and the next one, as a row's SoC is mid-bucket. Without both
     values, or when the next row isn't the very next bucket, the bucket isn't capped (the next one is). Above the
     cap, every part's kWh shrinks by the same factor and its spot sum stays, so
     charging, standby and heating losses raise the average cost (and solar value) of what is left. Below the cap
     nothing changes: the pool never invents energy. A bucket without SoC is not capped.
   - `C` = kWh the battery delivers per 100 % SoC: `BATTERY_CAPACITY_KWH` in `pool.ts`, **7.58**, measured
     2026-10-04 over 2026-01-20 → 2026-10-04 (`measureBatteryCapacity`: Σ discharge ÷ Σ SoC drop / 100 over adjacent
     pairs of discharge-only buckets, each pair counting the mean of its two discharges). By month ≈ 6.2 in Jan–Feb,
     7.5–8.1 from March; one constant, and only 3 kWh of all history ever discharged beyond the pool. Too large a `C`
     keeps old energy slightly longer; too small empties the pool early (the excess rule then prices it as grid).
4. **Car mix** (`carMix.ts`): per bucket, car kWh × the house fractions.
   - The battery part splits by the pool's composition into battery-grid (+ average spot), battery-solar
     (+ average spot) and battery-unpriced.
   - A bucket with no house data → `no_house_data_kwh`.
   - Buckets aggregate into 15-minute slots: kWh sums, battery spots kWh-weighted.
5. **Re-derive from day D**:
   - D is the earlier of the trigger's day and every queued request's day, clamped to today, then moved **one day
     back**: D−1's checkpoint may have been written before D's first reading existed, so its last bucket went
     uncapped. Re-deriving D−1 makes a resume equal a full derive.
   - Widen D back to the start day of any counted session overlapping D.
   - Load D−1's pool checkpoint, run forward to the last reading, rewrite checkpoints ≥ D and the mix rows of every
     session overlapping [D, end], in one transaction. `context.timings` / run stats record `deriveMs`.
   - Triggers, each after its sync stored something (even when the run then fails, see the amendments):
     - Emaldo: earliest replaced day.
     - Zaptec: earliest new or changed session's start day.
     - elpris: earliest day it filled that was missing before.
   - An admin "Re-derive all" is **not** built; a fix ships with a one-off script or migration-time call.
6. **Read-time guard**: when a session's Σ mix `kwh` ≠ its interval energy (|Δ| > 1e-6 kWh), the reader ignores
   its mix (falls back to all-grid) and logs a warning. This catches a Zaptec change the re-derive hasn't reached.
   Σ mix `kwh` equals Σ of the session's **stretches** (its Zaptec intervals, or `energyKwh` for an estimated
   session), which is what step 4 compares against.

**Amendments (step 3 build, 2026-10-04).**
- Shaping: the baseline needs at least 3 of the 6 pre-session buckets. A zero-length stretch lands in its start
  bucket. A bucket's cap is its load minus car energy an earlier interval already put there. Excess no headroom can
  take spreads by overlap (the load is exceeded, the kWh kept).
- Pool: within one bucket the inflow joins before the outflow leaves, then the SoC cap applies; below 1e-9 kWh the
  pool resets to empty; a cap of 0 empties it.
- Losses raise the cost of what is left, as decision 7 says: over the history, battery energy averaged ≈ 1.8× its
  inflow spot in Jan–Feb (median; p95 2.5×) and 1.01–1.14× from March. Real winter economics: ≈ 55 % comes back out.
- Each derive runs in one transaction holding a transaction-scoped advisory lock, reads included, so a concurrent
  derive never writes older data over newer. Timeouts: lock wait 20 s, statement 25 s, idle 60 s.
- Triggers fire on whatever a sync stored, **even if the run then fails**: a stored change is never detected as new
  again. The day is queued durably (`energy_mix_derive_request`) in the same transaction that stores the change
  (Zaptec page import, spot day, readings day), and again before the run derives, so a derive that fails is covered by the
  next one, and a request waiting over 3 h is warned about. A derive is best effort, with a 30 s budget, and never
  changes a run's outcome.
- No derive window starts before the day before the first reading. A session longer than a year, or with a slot of
  1000 kWh or more, is a glitch: it gets no mix rows (all-grid) and a counts-only warning, never blocking the rest.
- With no house readings at all, nothing is derived (sessions keep no mix rows and stay all-grid). Sessions before
  the first reading never get mix rows.
- `pruneUncounted` drops the mix of every session no longer counted, whenever it ended.
- Emaldo replaces yesterday and today on every run, so it derives from yesterday hourly: not change detection, but
  idempotent. elpris storing only tomorrow's prices triggers nothing. A run past its deadline only queues its day.
- The first derive in prod finds no checkpoint and rebuilds all history (≈ 0.3 s locally on the full history). A
  one-off re-derive script remains: `scripts/deriveEnergyMix.ts` (`bun --no-env-file`, explicit `DATABASE_URL`).

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
- Overview tiles, the monthly chart and session list costs become the cash cost. Subline: "34 % egen solel" /
  "34 % own solar power" (owner, step 4: only the energy that cost nothing; originally "från sol och batteri").
- The cost notice says what's included: solar and battery are counted from the first day with house data, and
  energy without house data is counted as bought from the grid.
- The session page hero becomes the cash cost, plus a grid / solar / battery bar with kWh for each.
- Economy content (the verdict, best-to-worst range and what-if tiles on the economy and session pages) is headed as
  spot timing **as if all energy were bought from the grid**.

**As built (step 4, 2026-10-04):**
- A session without a usable mix is priced exactly as before but labelled: its energy counts as `noHouseDataKwh`,
  so the page says how much had no house data instead of silently showing an upper bound. The read-time guard warns
  only when a mix exists but no longer matches (once per pricing call); a missing mix is normal.
- `avgOre` is the cash öre per charged kWh whose cost is known: `totalSek / (fullKwh + (kwh − gridKwh))`, own solar
  in the denominator at 0 kr; null when nothing bought is priced. Identical to before for all-grid energy.
- `gridKwh` keeps its name but means bought kWh: grid, no-house-data, battery-from-grid and battery of unknown
  price. `isComplete` is unchanged, so battery energy of unknown price makes a total "minst …" / a session "—".
  "No price" checks use the bought energy (`gridKwh > 0 && fullKwh === 0`): all-own-solar is a true 0 kr, and the
  cost shows for a scope whose energy was all own solar.
- Cost months follow each mix piece's own Zaptec interval (the one it starts in, or the first), as the kWh overview
  does. They can differ only when a stretch boundary is off the quarter-hour at a month change: then that quarter's
  kWh of the new month's first stretch counts in the earlier month.
- The cost note under the overview figures says what's included: "Sol och batteri räknas in från och med {date}"
  (`CostOverview.houseDataFrom` = the first reading), or that all charging counts as bought while there's no house
  data. A tile's footer says "Husets energidata saknas för N % av laddningen" once house data exists at all.
- The tile subline counts only energy that cost nothing (`ownSolarShare` = (kwh − gridKwh) / kwh): battery energy
  the battery took from the grid is bought. The session page's bar keeps the physical grid / solar / battery split.
- The session hero is `detail.cost` (a `CostSummary` on the `session` procedure); the verdict, range bar and
  what-ifs sit under the heading "Pristajming som om all el hade köpts från elnätet" and use the grid-only
  `economy.actual`, whose range marker reads "Denna laddning" (not "Faktiskt", which would contradict the hero).
- The source bar has its own colour tokens (`--energy-grid/solar/battery`; green and amber mean timing verdicts on
  the same card), leaves out a source under 0.05 kWh, and is a captioned figure whose legend carries the figures.
- The economy page opens with a grid-only lead pointing to the overview for the cash cost. After checkpoint 4 its
  grid-only figures were renamed so none reads as the cash cost: series "Faktisk tajming" (was "Faktiskt") and "Vid
  laddning" (was "Betalt"), tile "Spotpris vid laddning" (was "Betalt spotpris"), session-table column "Kostnad som
  köpt el" (was "Kostnad").
- `CostTotals` also carries `solarPricedKwh` / `solarUnpricedKwh` (solar-origin kWh with and without a spot to value
  it), for step 5's solar value.

**Step 5: value of own solar.** One line under the cash cost: "Värde av egen sol: 212 kr (vad den hade gett vid
försäljning)". Shown on the overview tiles, in the monthly chart's kr tooltip (under the total) and on the session
page (to the öre). Display rules (`src/components/evCharging/solarValue.ts`):
- Hidden below 0.05 kWh of solar-origin energy (direct solar + battery-from-solar), so a night session charged from
  a solar-filled battery still shows its value. A non-finite total is hidden too, never printed.
- Some solar without a spot price → "minst …"; none priced → "Värde av egen sol: okänt, spotpris saknas". Never 0 kr.
  Unpriced solar under 1e-6 kWh is float noise and doesn't make it "minst".
- A negative spot gives a negative value ("−3 kr": exporting would have cost money), "minst −3 kr" as a floor.
- An estimated session marks it "≈", like its cost, unless it's a "minst" floor (already a hedge).
- It shows even where the cash cost is unknown ("—", a "Pris saknas" stub month): the value needs only spot prices.
- Set as a note, not a price: small muted text with a sun on the tiles and the session page. In the tooltip it sits
  below a hairline, without a swatch, with a hint saying what it means, or why it's unknown (the tooltip ignores the
  pointer, so a dash's title could never show).

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

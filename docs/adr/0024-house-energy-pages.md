# ADR 0024 — House Energy Pages

- **Status**: Accepted
- **Date**: 2026-10-05
- **Deciders**: Lukas
- **Decision in one line**: Show the house's energy (solar, grid, self-sufficiency, car vs house, and the home
  battery's in / out / loss) on a new **Energi** section, read on demand as monthly sums over the stored Emaldo
  readings, so only aggregates ever reach the browser and no new table or sync is needed.

**Spec**: [house energy pages design](../superpowers/specs/2026-10-05-house-energy-pages-design.md).
**Roadmap**: [house energy pages roadmap](../superpowers/roadmaps/2026-10-05-house-energy-pages.md).
**Builds on**: [ADR-0023](./0023-solar-aware-charging-cost.md) (the Emaldo readings, `C`),
[ADR-0018](./0018-polled-sync-replaces-realtime-sse.md) (freshness without held connections).

---

## Context

ADR-0023 made the house's 5-minute energy flows a stored source (`house_energy_reading`, every bucket since
2026-01-20, with battery state of charge). They feed only the charging cost today. The owner asked to see the
battery on its own (energy in and out per month, how much is lost) and, while shaping it, the whole house: where
the solar goes, what is bought and sold, how self-sufficient the house is, and how much of the load is the car.

The readings are a household load profile. The schema says they are server-only, never logged raw and never
sent to the client.

Measured on the full local history (2026-10-05):
- A year of readings (≈74k rows) aggregates by Stockholm month in ≈40 ms.
- Winter loss is large: in February ≈43 % of what went into the battery didn't come back (≈6–9 % from April).
  While the battery is idle its SoC falls only ≈18 kWh of February's ≈117 kWh loss, so most of the winter loss
  happens while it charges or discharges. With SoC in whole percent (≈0.08 kWh), standby/heating loss can't be told
  apart from round-trip loss reliably.
- Export beyond the solar surplus is small (4–18 kWh a month, within the meter's 1–2 % balance residual).

## Decision

1. **A new nav section, Energi** (`/energy`), with two sub-pages: **Översikt** (`/energy`) and **Batteri**
   (`/energy/battery`). Read-only, so every signed-in member sees them (`protectedProcedure`, ADR-0017).
2. **On-read monthly aggregates.** One service query groups `house_energy_reading` by Stockholm month for the
   chart's year, plus the current month, the current year and all time for the tiles. The car's kWh comes from
   `ev_charge_interval`, the same source as `/charging`'s monthly chart. No rollup table.
   - *Amended 2026-10-07:* the month sums are now read from the materialized view `house_energy_month`, which the
     Emaldo sync refreshes once per run that stored a day. Still no hand-kept rollup table. Design:
     [month sums view](../superpowers/specs/2026-10-07-energy-month-sums-view-design.md).
3. **Only sums cross the wire.** The procedure returns period totals, never buckets; the load-profile rule stands.
4. **One set of definitions, in one pure client-safe module** (`src/lib/houseEnergy/figures.ts`):
   - **Self-sufficiency** = max(0, 1 − import ÷ load). Grid-charged battery energy (and its loss) counts as
     bought, matching the charging tiles' "egen solel".
   - **Battery loss** = in − out − Δstored, with Δstored = (last SoC − first SoC) ÷ 100 × `C`
     (`BATTERY_CAPACITY_KWH`). **Efficiency** = out ÷ (in − Δstored). One loss figure; a note explains that winter
     loss is mostly the battery heating itself, without splitting it.
   - Battery `charge_ac` counts as grid-charged, as in the derive.
5. **kWh only.** No kronor on these pages in this phase.
6. **Monthly granularity only:** tiles (this month / this year / all time) and a 12-month chart per year. No day
   or intraday views.
   - *Amended 2026-10-05 (step 1b):* the tiles show any **chosen** month, year or all time (`?period=`), picked with a
     period control or by clicking a month in the chart; the chosen period's year is the chart's year. Still monthly
     granularity, still on-read. Design: [period control](../superpowers/specs/2026-10-05-energy-period-control-design.md).
   - *Amended 2026-10-06 (step 1c):* the overview's period figures are drawn as a flow diagram (solar and bought in,
     the battery with its loss in the middle, consumption and sold out) instead of five tiles; the same figures, plus
     the battery's loss and two derived outflows (`batteryToGrid`, `batteryToHouse`) in `figures.ts`. Still the
     period's sums, still on-read. Design: [flow summary](../superpowers/specs/2026-10-06-energy-flow-summary-design.md).
   - *Amended 2026-10-06 (step 2):* the Batteri page leads with the chosen period's battery as a flow diagram (solar
     and bought in, the battery with its change in stored energy, out and the loss as its own node), its efficiency
     in a ring, then a month chart of out with the loss stacked on top, instead of four figure tiles and a chart with a
     metric toggle. Same figures (`figures.ts`), same read. Design:
     [battery page](../superpowers/specs/2026-10-06-energy-battery-page-design.md).
7. **Freshness:** no polling interval; focus refetch, and the Emaldo sync health alert shows when data is stale.
   - *Amended 2026-10-07:* the month sums are only as fresh as the last refresh of `house_energy_month`. A failed
     refresh is a warning (`house energy month refresh failed`), not a health alert, so the Emaldo source can be green
     while the pages lag until the next successful run. Every run retries.

## Alternatives considered

- **A battery-only page.** Smaller, but the same readings answer the wider house questions at little extra cost.
- **A daily rollup table written by the Emaldo sync.** Trivial reads, but a migration, a backfill and a second copy
  of the truth that `replaceDay` must keep in step. Premature at ≈105k rows a year; revisit if `energy.overview`'s
  timing on prod passes ≈200 ms.
- **Computing figures in the browser from readings.** Ships the load profile to the client. Rejected.
- **Simple in − out loss.** Off by up to one full battery (`C` ≈ 7.6 kWh) per period. SoC is on every bucket, so the
  correction is free.
- **A separate idle-loss figure.** Measurable, but it explains ≈15 % of the winter loss and would mislead.
- **Physical self-sufficiency** (any battery discharge counts as own). Flatters winter, when the battery is mostly
  grid-charged at night.
- **Day drill-down or an intraday curve.** Daily loss is noisy (± one SoC step), and an hourly curve would relax the
  load-profile rule. Deferred until there's a concrete need.
- **Kronor (loss cost, battery payoff).** Deferred; the energy figures are checked on prod first.

## Consequences

- Two read-only pages and one procedure; no schema change, no new sync, no new env vars.
- Request time grows with history (≈40 ms per year of readings locally). The procedure records `getEnergyOverviewMs`,
  so the rollup alternative can be revisited on evidence.
  - *Amended 2026-10-05 (checkpoint 1):* on prod the per-row Stockholm conversion plus a full sort (spilling past the
    2 MB `work_mem`) took ≈180 ms, and one RPC logged 721 ms. The scan now sums per UTC hour first (exact: Stockholm's
    offsets are whole hours), converts only the hours, and reads first/last SoC through the primary key: ≈45 ms on
    prod for ≈74k rows. Still on read, no rollup table. The cost still grows linearly (≈8.9k rows a month): around
    2–2.5× today's rows (mid–late 2027) the scan alone reaches the 150 ms budget, and past ≈25–30k hours the hourly
    hash spills to disk at prod's `work_mem`. Watch `houseScanMs`; a per-month rollup written in `replaceDay`'s
    transaction is the next step then.
  - *Amended 2026-10-07:* that step is taken early, as a **materialized view** instead of a rollup table. On prod the
    overview query's mean was already 160 ms over 108 calls (min 36, max 719: a long tail on a ≈ 33 ms scan), and the
    hourly hash used 2.7 MB of its ≈ 4.3 MB limit (`work_mem` × `hash_mem_multiplier` 2), so it spills at ≈ 10k hours
    (mid–late 2027), not 25–30k. `house_energy_month` holds the same monthly sums and first/last SoC; the Emaldo sync
    refreshes it `CONCURRENTLY` once per run that stored a day (best effort, a warning on failure, repaired by the next
    run), and `energy.overview` reads it. Postgres computes it from the readings, so it can't drift from them the way
    a hand-kept table could; `pg_ivm` and TimescaleDB, which maintain such views incrementally, aren't available on
    prod. Decision 2's "no rollup table" holds; the read is now one row per month, not a scan. Design:
    [month sums view](../superpowers/specs/2026-10-07-energy-month-sums-view-design.md).
- `figures.ts` is the single home of the house-energy definitions; a later kronor or economy phase builds on it.
- `C` is a code constant (ADR-0023). If it changes, past loss figures change with it, which is intended.

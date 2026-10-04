# ADR 0023 — Solar-Aware Charging Cost

- **Status**: Accepted
- **Date**: 2026-10-03
- **Deciders**: Lukas
- **Decision in one line**: Pull the house's 5-minute energy flows from the Emaldo cloud, derive at sync time how
  each charging slot was supplied (grid, solar, battery, with a running battery cost pool), store that mix without
  money, and keep pricing it on read, so charging cost becomes the real cash cost plus the value of own solar used.

**Spec**: [solar-aware cost design](../superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md).
**Roadmap**: [solar-aware cost roadmap](../superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md).
**Builds on**: [ADR-0019](./0019-external-data-integrations.md) (a pulled, health-tracked source),
[ADR-0020](./0020-spot-prices-and-cost-model.md) (on-read cost, the `gridShare` seam).

---

## Context

ADR-0020 prices every charged kWh as bought from the grid, so the cost is an upper bound. The house has solar
panels and an Emaldo Power Core home battery. Emaldo's AI ("Emaldo Energie") sometimes charges the battery from
the grid when it's cheap. Surplus solar is exported and paid at the plain 15-min spot price; the house uses and
stores its own production first.

Emaldo has no official API. A community integration (`wertigpar/ha-emaldo`, MIT) reverse-engineered the cloud API
the phone app uses. A live probe (2026-10-03) confirmed it reports per-day, 5-minute average power for grid import
and export, solar strings, house load (which includes the charger) and battery charge/discharge, with history far
older than the charger. The probe ported the protocol to ≈150 lines of TypeScript.

The probe also showed:
- On real sessions the grid share ranged from ≈45 % (sunny midday) to ≈94 % (winter night).
- The battery was charged from the grid **during** a night charging session, so battery energy isn't free.
- Zaptec's first interval can span hours before the car actually started drawing. Spreading its kWh evenly over
  the interval puts energy in the wrong hours, while the house load shows the real start as a clean jump.

## Decision

1. **Emaldo is a fourth pulled source** (`emaldo`, ADR-0019): hourly sync, fail closed, health-tracked, alert on
   the first failure. All four parameters (`EMALDO_USER`, `EMALDO_PASSWORD`, `EMALDO_APP_ID`, `EMALDO_APP_SECRET`)
   are env vars; the app id and secret are never committed. A dedicated Emaldo account is used, because a login
   ends that account's other sessions.
2. **Raw flows are stored as data**: `house_energy_reading`, one row per 5-minute bucket, kWh per flow. A fetched
   day replaces its stored day; gaps stay gaps.
3. **The mix is derived at sync time, without money.** For each charging session and 15-minute slot,
   `ev_charge_energy_mix` stores kWh from the grid, from solar, from battery energy that came from the grid (with the
   average spot it was bought at), from battery energy that came from solar (with the average spot at storage), and
   kWh with no house data. Re-derived from the earliest affected day when Emaldo, Zaptec or spot data change.
4. **Car and house get the same mix** in each 5-minute step (proportional), not house-first or car-first.
5. **The battery is an average-cost pool** run forward through history: inflows from grid and solar mix in at their
   spot price; outflows carry the pool's current composition. After each 5-minute step the pool is capped at the
   battery's measured state of charge, keeping its cost, so losses raise the price of what is left (amended
   2026-10-04, below). A daily checkpoint lets a re-derive restart from the first changed day.
6. **Inside a Zaptec interval, the car's kWh are shaped by the house load's rise above its pre-session baseline**;
   the interval's kWh stay exact. Without a usable shape the spread stays uniform.
7. **Pricing stays on read** (ADR-0020). Cash cost = grid kWh at (slot spot + fees) × VAT, battery-from-grid kWh at
   (stored spot + the use day's fees) × VAT, solar 0 kr. **Value of own solar used** = solar kWh × slot spot +
   battery-from-solar kWh × stored spot, ex VAT, no fees — what export would have paid. Energy without house data
   is counted as grid-bought and shown as such.
8. **The economy page stays grid-only** (spot timing as if everything were bought from the grid) and says so. A
   solar-aware economy page is a later phase; the stored mix is its input.

## Alternatives considered

- **Everything on read.** Purest to ADR-0020, but the battery pool depends on days of history before each session;
  a year view would read ≈100k readings per request, far past the ≈300 ms budget.
- **Materialize kronor.** Fast reads, but every tariff edit then needs a recompute job and staleness bookkeeping,
  the reason ADR-0020 rejected it. The stored mix carries spot prices (data) but no tariffs (settings).
- **House first (the car's marginal cost).** Defensible, but needs a claim about what the house would have done
  without the car. Probe: 0–12 points above proportional.
- **Car first.** Flatters the car; at night it ignored that the battery was itself grid-charged. Probe: up to
  32 points below proportional.
- **Battery energy as free.** Wrong whenever Emaldo's AI charges from the grid, which the probe caught mid-session.
- **Cash cost only.** Hides that solar used for the car is export income given up. The owner wants both numbers.
- **One measured round-trip efficiency** (the original decision 5, amended 2026-10-04). Checkpoint 2 measured 0.853
  over all history, but 0.57 in Jan–Feb and 0.92–0.99 from March: in the cold, far less comes out than went in.
  With one η and no upper bound the pool kept ≈100 kWh of phantom winter-grid energy in a ≈9 kWh battery into the
  summer, costing summer battery energy as February grid energy. A per-month η balances each month but leaves the
  pool unbounded inside it, and a fixed capacity cap holds the pool full all winter. Emaldo reports SoC every 5
  minutes back to January, so the pool follows the real battery instead.

## Consequences

- Cost becomes realistic: midday summer charging roughly halves; winter night charging barely changes.
- **The integration rests on an unofficial API** and an app secret extracted from Emaldo's Android app. A rotated
  secret or a forced app update breaks it until the secret is re-extracted. It fails closed: cost falls back to
  "all grid", the upper bound, and the health alert says so. Emaldo may not permit third-party clients.
- The household's load profile is stored: like the vehicle snapshots, it's presence-adjacent data, kept server-side
  behind RLS and never exposed raw to the client.
- Battery-from-grid energy is priced with the fees of the day it is used, not the day it was bought; fees change
  monthly at most, so the error is small and stated.
- A new trigger chain: Zaptec, elpris and Emaldo syncs each schedule a re-derive. A derive bug produces wrong
  mixes, not wrong raw data, so a fix plus a full re-derive repairs history.

## Amendment 2026-10-04: SoC-anchored pool

Decision 5 originally scaled inflows by one measured round-trip efficiency. Checkpoint 2's history showed the losses
are seasonal and that an unbounded pool drifts far past the battery's size (Alternatives, "One measured round-trip
efficiency"). The pool now takes inflows at full kWh and is capped at `SoC / 100 × C` after each bucket, `C` being
the kWh the battery delivers per 100 % SoC, measured from history. The SoC series is synced as roadmap step 2b, before
the derivation (step 3) is built.

Step 3 (2026-10-04) settled the rest from the full history: a row's SoC is the battery's state at its bucket's middle,
so the cap uses the mean of two rows, and `C` = 7.58 kWh per 100 %. Losses raising the cost of what is left make
winter battery energy ≈ 1.8× its purchase spot. Checkpoints also carry a derive version, so a fix to the math rebuilds
history by itself, and pending derives are queued durably, so a derive that fails is retried by the next one
(spec "Derivation", amendments).

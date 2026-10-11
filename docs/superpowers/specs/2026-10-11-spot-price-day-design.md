# Design — server latency step 6: stored daily spot averages

Roadmap: [server latency](../roadmaps/2026-10-07-server-latency.md), step 6. Amends ADR-0020 (one paragraph: the
daily spot averages are stored on write; the cost math stays on read).

## Why

`evCharging/economy` (`/charging/economy`) reads the selected year's per-day average spot price through
`dailyAverageSpot`, which converts every slot of the year to its Stockholm day and groups them in Postgres. On prod
that is 24 476 slots for ~255 rows: 61 ms in `EXPLAIN ANALYZE`, all buffer hits, so CPU. `economyDailySpotMs` was
56–247 ms on prod, and 205 of `economy`'s 245 ms at checkpoint 5. The work grows with every 15-min slot stored.

Prod on 2026-10-11: 24 764 SE3 slots over 258 Stockholm days (2026-01-27 → 2026-10-11).

## Decision

A `spot_price_day` table holds each stored day's time-weighted average. `spotPrice.replaceDay`, the only writer of
`spot_price`, upserts the day's row in the same transaction as its slots. `dailyAverageSpot` reads ~255 rows by
primary key.

Alternatives (owner chose the table, 2026-10-11):

- **A statement trigger on `spot_price`.** Every write path would keep the table current, but there is one writer;
  drizzle can't model triggers (a hand-written custom migration), and the logic would live in the database, out of
  the service tests' reach (ADR-0002).
- **A materialized view refreshed after each sync** (the `house_energy_month` pattern, ADR-0024). Free backfill, but
  each refresh regroups every slot (~60 ms per stored year, growing) and a missed refresh serves stale averages. A
  refresh can't run inside `replaceDay`'s per-day transaction without one refresh per day.

### Schema (`src/lib/db/schema/spotPrice.ts`)

```ts
spotPriceDay = pgTable('spot_price_day', {
  zone: text().notNull(),                         // CHECK zone IN PRICE_ZONES, like spot_price
  day: date({ mode: 'string' }).notNull(),        // Stockholm calendar day
  avgSekPerKwh: doublePrecision().notNull(),      // time-weighted, ex VAT
  coveredSeconds: integer().notNull(),            // CHECK > 0 AND <= 90000 (a 25 h DST day)
}, PK (zone, day)).enableRLS()
```

- No FK: `spot_price` has no per-day row to point at.
- No `fetched_at`: the day's slots carry it, and both are written in the same transaction.
- `double precision` matches `spot_price.sek_per_kwh`. No range CHECK on the average: it is an average of values
  `spot_price`'s CHECK already bounds.
- Re-exported from the schema barrel.

### Write (`src/lib/services/spotPrice/spotPrice.ts`)

`replaceDay` deletes the day's slots, inserts the new ones, then (new) upserts the day's row, then calls
`requestDerive`, all in one transaction:

```sql
INSERT INTO spot_price_day (zone, day, avg_sek_per_kwh, covered_seconds)
SELECT zone, $day::date,
       sum(sek_per_kwh * extract(epoch FROM slot_end - slot_start))
         / sum(extract(epoch FROM slot_end - slot_start)),
       sum(extract(epoch FROM slot_end - slot_start))
FROM spot_price
WHERE zone = $zone AND slot_start >= $dayStart AND slot_start < $dayEnd
GROUP BY zone
ON CONFLICT (zone, day) DO UPDATE
  SET avg_sek_per_kwh = excluded.avg_sek_per_kwh, covered_seconds = excluded.covered_seconds
```

- Aggregated in SQL with today's `dailyAverageSpot` expression, so the runtime write, the migration's backfill and
  the old numbers share one definition.
- `validateDaySlots` already rejects an empty or partial day, so every stored day gets its row; a failure rolls back
  the slots and the average together.

### Read

`dailyAverageSpot(zone, fromDay, toDay)` keeps its signature and `DailySpot[]` result:
`SELECT day, avg_sek_per_kwh, covered_seconds FROM spot_price_day WHERE zone = $1 AND day BETWEEN $2 AND $3 ORDER BY
day`, with `coveredMs = covered_seconds * 1000`. Nothing above the service changes: `getEconomyOverview`,
`averageSpotOre` and the `economyDailySpotMs` timing keep their shape.

### Migration

1. `bun run db:generate --name=spot_price_day`: the table, CHECKs, PK, RLS.
2. `bun run db:generate --custom --name=backfill_spot_price_day`: one `INSERT … SELECT … GROUP BY zone, (slot_start
   AT TIME ZONE 'Europe/Stockholm')::date … ON CONFLICT DO UPDATE` with the write's aggregate. Idempotent; on prod
   ~25 000 slots into 258 rows.

**Deploy window.** `vercel-build` migrates before the new code serves. If the old code's elpris sync stored a day
between the backfill and the cutover, that day would have no row, and the page would quietly leave it out of the
average (missing ≠ 0). The sync runs at 12:30 and 15:30 UTC only: merge outside 12:25–12:45 and 15:25–15:45 UTC.
The checkpoint's day-count check catches a gap; the fix is re-running the backfill statement on prod (a write, owner
approval) or the next sync of that day.

## Tests (`src/lib/services/spotPrice/spotPrice.test.ts`)

- `replaceDay` writes the day's row; re-storing the day at the other granularity with new prices updates it (one row,
  new values); a rejected day writes no row; replacing one day leaves its neighbours' rows alone.
- DST days: 23 h and 25 h days store `covered_seconds` 82 800 and 90 000.
- The existing `dailyAverageSpot` tests stay as the read contract (range bounds, zone, empty, DST days).
- "unequal slot lengths" inserts `spot_price` directly; `validateDaySlots` forbids mixed lengths within a day, so
  that case can't reach the only writer. It becomes two days of different granularity stored through `replaceDay`,
  checking `coveredMs` carries the weight across days.
- New: slots inserted without `replaceDay` are not visible to `dailyAverageSpot` (pins the read path).
- `chargingEconomy.test.ts` already stores prices through `replaceDay`; its overview figures stay unchanged.
- **Equivalence (in the migration task, not a test):** on a local DB with a year of slots, the old aggregate query
  and the backfilled table agree. Same SQL over the same PK-ordered rows, so exact equality is expected; any float
  difference is reported with its size.

## Checkpoint 6 (prod)

After the deploy:

1. `economyDailySpotMs` on `evCharging/economy` is ≤ 10 ms warm (56–247 before), and `economy`'s `totalMs` drops by
   about as much. Get lines by navigating in the browser, not by reloading (a reload renders `economy` during SSR).
2. `/charging/economy` figures are unchanged (owner).
3. A read-only SELECT on prod: every Stockholm day in `spot_price` has a `spot_price_day` row, and each row equals the
   old aggregate for that day.

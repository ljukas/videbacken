# Energy month sums as a materialized view — design

- **Date**: 2026-10-07
- **Status**: approved in brainstorm (approach A), spec under owner review
- **ADR**: amends [ADR-0024](../../adr/0024-house-energy-pages.md) Consequences (the planned rollup becomes a
  materialized view). Roadmap: [house energy pages](../roadmaps/2026-10-05-house-energy-pages.md) (done; this is a
  follow-up, one PR).

## Why

`energy.overview` scans every `house_energy_reading` row on every request (ADR-0024 decision 2). Measured on prod
2026-10-07 (read-only, 74 724 rows, 6 235 hours):

- `pg_stat_statements` for the overview query since the #95 fix: **108 calls, mean 160 ms**, min 36, max 719 ms,
  no temp blocks. The scan alone is ≈ 33 ms without instrumentation, so the mean is a long tail (a cold or busy
  instance meeting a 75k-row scan). The 150 ms budget is already passed on average.
- The hourly hash aggregate uses **2 705 kB**. With `work_mem` 2 184 kB × `hash_mem_multiplier` 2 ≈ 4.3 MB, it spills to
  disk at ≈ 10k hours (mid–late 2027), not the 25–30k ADR-0024 estimated.
- Growth: ≈ 8.9k rows a month, cost roughly linear.

The owner wants the rollup now, but **computed by Postgres**, not a second table our code keeps in step with every
replaced day.

## Options looked at

| Option | Verdict |
|---|---|
| **Materialized view, refreshed `CONCURRENTLY` once per Emaldo run** | **Chosen.** Built into Postgres 17; can't drift (it is the query's result as of the last refresh); one call after the sync. |
| `pg_ivm` (incremental view maintenance) | Not available on prod (checked `pg_available_extensions`), not in `postgres:17-alpine` (local, CI). |
| TimescaleDB continuous aggregates | Not offered on prod's Postgres 17. |
| Trigger-maintained rollup table | The hand-kept table the owner wants to avoid, moved into plpgsql; Drizzle doesn't model triggers. |
| Refresh inside `replaceDay` | A 30-day backfill would refresh 30 times, each inside a day's write transaction. |
| A view of hourly sums | The read would still aggregate a growing set. |

## Design

### 1. The view: `house_energy_month`

One row per Stockholm month with readings, the same values `monthRows()` returns today:

| Column | Meaning |
|---|---|
| `year`, `month` | Stockholm calendar month (int) |
| `grid_import_kwh`, `grid_export_kwh`, `solar_kwh`, `load_kwh`, `battery_discharge_kwh`, `battery_charge_solar_kwh` | sums |
| `battery_charge_grid_kwh` | sum of `battery_charge_grid_kwh + battery_charge_ac_kwh` (ADR-0023: ac counts as grid) |
| `buckets` | readings in the month (int) |
| `first_bucket`, `last_bucket` | the month's first and last `bucket_start` (timestamptz) |
| `first_soc_pct`, `last_soc_pct` | SoC of the month's first / last bucket that has one (nullable) |

The definition is today's query moved into SQL: sum per UTC hour (`date_bin('1 hour', …)`), convert only the hours
with `AT TIME ZONE 'Europe/Stockholm'`, group by year and month; the two SoC values are the existing primary-key probes
(`ORDER BY bucket_start ASC|DESC LIMIT 1` within `first_bucket … last_bucket`, `battery_soc_pct IS NOT NULL`), now run at
refresh time. Created `WITH DATA` (populated by the migration, ≈ 50 ms on prod).

**Unique index** `house_energy_month_year_month_idx` on `(year, month)`: required by `REFRESH … CONCURRENTLY`, and
the read's order.

**Grants.** A materialized view can't enable RLS; `test/rls.test.ts` checks only `relkind IN ('r','p')`, so it is
unaffected. Prod's Data API is off and the runtime role is `postgres`. After deploy, a read-only check confirms the
view has no `anon` / `authenticated` grant (the migration can't `REVOKE` from roles that don't exist in
`postgres:17-alpine`); if Supabase's default privileges granted any, a follow-up migration revokes them guarded by a
role-exists check.

### 2. The migration

`bun run db:generate --custom --name=house_energy_month_view`: a custom migration holding `CREATE MATERIALIZED VIEW`
and `CREATE UNIQUE INDEX`, no `"public".` qualifiers (the test setup runs every migration in a per-test schema).
The schema module declares it with `pgMaterializedView('house_energy_month', {…columns}).existing()`, so queries are
typed and drizzle-kit never generates or drops it. Changing the definition later = a new custom migration
(`DROP MATERIALIZED VIEW` + create + index).

Every Vercel deploy migrates (CLAUDE.md gotcha): prod gets the view on the next production deploy, populated.

### 3. The refresh

`houseEnergy.refreshMonthSums()` (service, ADR-0002): `db.refreshMaterializedView(houseEnergyMonth).concurrently()`,
i.e. `REFRESH MATERIALIZED VIEW CONCURRENTLY house_energy_month`.
`CONCURRENTLY` keeps the old rows readable during the refresh; a second refresh waits on the first (an EXCLUSIVE lock).
The Emaldo runs hold a lease, so they don't overlap anyway.

The Emaldo sync's `execute` `finally` (`src/lib/houseEnergy/sync.ts`) calls it **before** `deriveAfterSync`, only when
the run stored a day (`run.earliestReplacedDay !== null`):

- Best effort, like the derive: a 10 s budget (`withDeadline`), a failure or timeout is `log.warn('house energy
  month refresh failed', …)`, never a failed run (health tracks the source, ADR-0019).
- Runs also when the run's deadline has fired: it is short, and skipping it would leave the pages an hour behind.
- Time spent → `run.refreshMs`, in the run's `timings` and log fields.
- Self-healing: every run stores yesterday and today, so a missed refresh is repaired by the next run (≤ 1 h).

No other code writes readings (`replaceDay` has one caller). A future writer must call the refresh; the schema
module's comment says so.

### 4. The read

`monthRows()` in `src/lib/services/houseEnergy/energyOverview.ts` becomes one `SELECT … FROM house_energy_month ORDER
BY year, month`; the `hourly` / `monthly` CTEs and `edgeSoc` go. Everything after it (expected buckets, totals, the car
figure, `EnergyOverview`'s shape) is unchanged. The timing keeps its name, `houseScanMs`, so prod before/after compare
on the same key.

### 5. Freshness

Readings change only in the Emaldo sync. Between a run storing its days and its refresh (seconds), the pages show the
previous run's sums. ADR-0024 decision 7 (focus refetch, no polling, the Emaldo health alert when stale) stands.

## Testing

- `energyOverview.test.ts`: the existing cases refresh after writing readings (one helper), and expect the same
  results as today: the view must not change a figure.
- New service test: a replaced day is invisible to the overview until `refreshMonthSums()` runs, then visible; a
  refresh over an empty table works; first/last SoC skip null-SoC buckets at a month's edge; a DST month (March,
  October) keeps its hours in the right month.
- Sync tests (`sync.test.ts`): refreshes once per run that stored a day (also when the run then fails); not when none
  was stored; a refresh failure warns and the run still succeeds; the refresh runs before the derive.
- `test/rls.test.ts` unchanged and green.

## Verification (the PR's checkpoint, on prod after deploy)

1. **Same figures:** for 2026-02, 2026-08 and Totalt, the view's row (or sum) equals a plain SQL sum over
   `house_energy_reading` (the checkpoint 1b/1c queries), and `/energy` + `/energy/battery` show the same values as
   before the deploy.
2. **Grants:** `house_energy_month` has no `anon` / `authenticated` privilege.
3. **Refresh:** the next Emaldo run logs `refreshMs` and no refresh warning; the view's newest `last_bucket` moves.
4. **Speed:** `pg_stat_statements` for the new read and `rpc timing` for `energy.overview` (`houseScanMs`) against
   today's 160 ms mean.

## Out of scope

- Kronor, day views, any UI change.
- The car figure's read (`getChargingOverview`, `carMs`): unchanged.
- A rollup for other readers (the energy-mix derive reads 5-minute buckets by design).

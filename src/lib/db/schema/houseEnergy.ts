import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  check,
  date,
  doublePrecision,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { evChargeSession } from './evCharging'

/**
 * Absurd-value backstop for one 5-minute bucket, in kWh (a 120 kW average; a
 * 25 A three-phase main fuse allows ≈ 1.5). It catches a unit slip (W stored as
 * kWh), not real data; the Emaldo parser does the real validation. Changing it
 * changes the rendered CHECK text: run `bun run db:generate`.
 */
export const HOUSE_BUCKET_KWH_MAX = 10
const kwhMax = sql.raw(String(HOUSE_BUCKET_KWH_MAX))

const kwhCheck = (name: string, column: AnyPgColumn) =>
  check(`house_energy_reading_${name}_check`, sql`${column} >= 0 AND ${column} < ${kwhMax}`)

// One row per 5-minute bucket of the house's energy flows, pulled from the
// Emaldo cloud (ADR-0023). Written a whole Stockholm day at a time
// (`houseEnergy.replaceDay`: delete the day's range, then insert, in one
// transaction), so a re-fetched day never leaves stale buckets behind; gaps
// stay gaps. A household load profile: server-only, never logged raw, never
// sent to the client. Kept indefinitely, like vehicle_state_snapshot. The
// primary key serves every read: the day replace, range reads and min().
export const houseEnergyReading = pgTable(
  'house_energy_reading',
  {
    /** The response's start_time + the row's minute offset, as a UTC instant. */
    bucketStart: timestamp('bucket_start', { withTimezone: true }).primaryKey(),
    gridImportKwh: doublePrecision('grid_import_kwh').notNull(),
    gridExportKwh: doublePrecision('grid_export_kwh').notNull(),
    /** Every MPPT string plus the third-party (AC-coupled) inverter. */
    solarKwh: doublePrecision('solar_kwh').notNull(),
    /** The whole house, the car charger included. */
    loadKwh: doublePrecision('load_kwh').notNull(),
    batteryDischargeKwh: doublePrecision('battery_discharge_kwh').notNull(),
    /** Emaldo's battery `charge_mppt`: charged straight from the panels. */
    batteryChargeSolarKwh: doublePrecision('battery_charge_solar_kwh').notNull(),
    batteryChargeGridKwh: doublePrecision('battery_charge_grid_kwh').notNull(),
    /**
     * Emaldo's battery `charge_ac`, stored as reported. Its meaning is settled
     * from real data at the roadmap's checkpoint 2; until then the derivation
     * treats it as grid-origin (spec, "Sync").
     */
    batteryChargeAcKwh: doublePrecision('battery_charge_ac_kwh').notNull(),
    /**
     * The battery's state of charge, % (0–100), for the row's minute as
     * Emaldo reports it; null when its SoC series lacked the minute. Step 3
     * caps the battery pool at it (spec "Derivation" 3).
     */
    batterySocPct: doublePrecision('battery_soc_pct'),
  },
  (table) => [
    // Every bucket starts on a 5-minute boundary (Stockholm's offsets are
    // whole hours), so each lies inside exactly one quarter-hour price slot —
    // the mix derivation relies on it. date_bin is immutable, unlike extract().
    check(
      'house_energy_reading_bucket_aligned_check',
      sql`date_bin('5 minutes', ${table.bucketStart}, timestamptz '2000-01-01 00:00:00+00') = ${table.bucketStart}`,
    ),
    kwhCheck('grid_import_kwh', table.gridImportKwh),
    kwhCheck('grid_export_kwh', table.gridExportKwh),
    kwhCheck('solar_kwh', table.solarKwh),
    kwhCheck('load_kwh', table.loadKwh),
    kwhCheck('battery_discharge_kwh', table.batteryDischargeKwh),
    kwhCheck('battery_charge_solar_kwh', table.batteryChargeSolarKwh),
    kwhCheck('battery_charge_grid_kwh', table.batteryChargeGridKwh),
    kwhCheck('battery_charge_ac_kwh', table.batteryChargeAcKwh),
    // NULL passes a CHECK: a missing SoC is allowed, a wrong one is not.
    check(
      'house_energy_reading_battery_soc_pct_check',
      sql`${table.batterySocPct} >= 0 AND ${table.batterySocPct} <= 100`,
    ),
  ],
).enableRLS()

// ── Energy mix (ADR-0023, roadmap step 3) ───────────────────────────────

// One row per counted charging session × 15-minute UTC slot: how that slot's
// charging energy was supplied — straight from the grid, straight from solar,
// from the battery (split by what had charged it: grid energy at the average
// spot it was bought at, solar at the average spot it would have sold for, or
// energy stored in a slot without a price), or with no house data (priced as
// grid). Money-free: kronor are priced on read (ADR-0020). Written only by the
// derive (delete + insert per session, one transaction), never updated.
export const evChargeEnergyMix = pgTable(
  'ev_charge_energy_mix',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => evChargeSession.id, { onDelete: 'cascade' }),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    /** The session's energy in this slot; the six parts below sum to it. */
    kwh: doublePrecision('kwh').notNull(),
    gridKwh: doublePrecision('grid_kwh').notNull(),
    solarKwh: doublePrecision('solar_kwh').notNull(),
    batteryGridKwh: doublePrecision('battery_grid_kwh').notNull(),
    /** Average spot (SEK/kWh ex VAT) the battery's grid energy was bought at; null when its kWh is 0. */
    batteryGridSpotSek: doublePrecision('battery_grid_spot_sek'),
    batterySolarKwh: doublePrecision('battery_solar_kwh').notNull(),
    /** Average spot (SEK/kWh ex VAT) of the slots the battery's solar energy was stored in; null when its kWh is 0. */
    batterySolarSpotSek: doublePrecision('battery_solar_spot_sek'),
    batteryUnpricedKwh: doublePrecision('battery_unpriced_kwh').notNull(),
    noHouseDataKwh: doublePrecision('no_house_data_kwh').notNull(),
  },
  (table) => [
    // Serves every query: the cost read's `session_id IN (…) ORDER BY
    // session_id, slot_start`, the derive's delete by session ids, and the FK
    // cascade from ev_charge_session. No other index.
    primaryKey({ name: 'ev_charge_energy_mix_pk', columns: [table.sessionId, table.slotStart] }),
    // UTC quarter-hours: the cost math joins these to 15-min spot slots.
    check(
      'ev_charge_energy_mix_slot_start_check',
      sql`date_bin('15 minutes', ${table.slotStart}, timestamptz '2000-01-01 00:00:00+00') = ${table.slotStart}`,
    ),
    // `kwh < 1000` also refuses NaN (Postgres sorts it above every number); a
    // NaN or infinite part then fails the parts-sum check. Not a per-slot
    // bound: an estimated session puts all its energy in one slot.
    check(
      'ev_charge_energy_mix_kwh_nonneg_check',
      sql`${table.kwh} > 0 AND ${table.kwh} < 1000 AND ${table.gridKwh} >= 0 AND ${table.solarKwh} >= 0
        AND ${table.batteryGridKwh} >= 0 AND ${table.batterySolarKwh} >= 0
        AND ${table.batteryUnpricedKwh} >= 0 AND ${table.noHouseDataKwh} >= 0`,
    ),
    // The parts are kWh × fractions, so they sum to `kwh` up to float rounding.
    check(
      'ev_charge_energy_mix_parts_sum_check',
      sql`abs(${table.kwh} - (${table.gridKwh} + ${table.solarKwh} + ${table.batteryGridKwh}
        + ${table.batterySolarKwh} + ${table.batteryUnpricedKwh} + ${table.noHouseDataKwh}))
        <= 1e-9 * ${table.kwh} + 1e-9`,
    ),
    // A spot exactly when there is energy to price, and finite ('Infinity'
    // also refuses NaN). No value bound: battery losses raise the average cost
    // of what is left in the pool without a proven limit (spec decision 7; the
    // history shows ≈ 1.8× in winter, up to ≈ 5×), and one row over a bound
    // would fail every later derive. Negative spots are real.
    check(
      'ev_charge_energy_mix_battery_grid_spot_check',
      sql`(${table.batteryGridKwh} > 0) = (${table.batteryGridSpotSek} IS NOT NULL)
        AND (${table.batteryGridSpotSek} IS NULL
          OR (${table.batteryGridSpotSek} > '-Infinity' AND ${table.batteryGridSpotSek} < 'Infinity'))`,
    ),
    check(
      'ev_charge_energy_mix_battery_solar_spot_check',
      sql`(${table.batterySolarKwh} > 0) = (${table.batterySolarSpotSek} IS NOT NULL)
        AND (${table.batterySolarSpotSek} IS NULL
          OR (${table.batterySolarSpotSek} > '-Infinity' AND ${table.batterySolarSpotSek} < 'Infinity'))`,
    ),
  ],
).enableRLS()

// The battery cost pool's state at the end of each Stockholm day: the derive's
// checkpoint (ADR-0023). A re-derive from day D resumes from D−1's row.
// `capacity_kwh` (C, kWh per 100 % SoC) and `derive_version` are what the
// state was computed with: a checkpoint with another C or version is never
// resumed from (the derive rebuilds from the first reading), so changing
// either re-derives history by itself. Spot sums may be negative.
export const batteryPoolDay = pgTable(
  'battery_pool_day',
  {
    // The PK serves both queries: the point lookup of D−1 and `day >= D`.
    day: date('day', { mode: 'string' }).primaryKey(),
    storedKwh: doublePrecision('stored_kwh').notNull(),
    gridKwh: doublePrecision('grid_kwh').notNull(),
    gridSpotSekSum: doublePrecision('grid_spot_sek_sum').notNull(),
    solarKwh: doublePrecision('solar_kwh').notNull(),
    solarSpotSekSum: doublePrecision('solar_spot_sek_sum').notNull(),
    unpricedKwh: doublePrecision('unpriced_kwh').notNull(),
    capacityKwh: doublePrecision('capacity_kwh').notNull(),
    /** The derive math's version (derive.ts `DERIVE_VERSION`), bumped with any change to it. */
    deriveVersion: smallint('derive_version').notNull(),
    /** When the derive wrote this checkpoint (shows whether a re-derive reached it). */
    derivedAt: timestamp('derived_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'battery_pool_day_kwh_nonneg_check',
      // `stored_kwh < 1000` also refuses NaN; a NaN part then fails the sum check.
      sql`${table.storedKwh} >= 0 AND ${table.storedKwh} < 1000 AND ${table.gridKwh} >= 0 AND ${table.solarKwh} >= 0
        AND ${table.unpricedKwh} >= 0`,
    ),
    check(
      'battery_pool_day_stored_sum_check',
      sql`abs(${table.storedKwh} - (${table.gridKwh} + ${table.solarKwh} + ${table.unpricedKwh}))
        <= 1e-9 * ${table.storedKwh} + 1e-9`,
    ),
    check(
      'battery_pool_day_spot_sums_finite_check',
      sql`${table.gridSpotSekSum} > '-Infinity' AND ${table.gridSpotSekSum} < 'Infinity'
        AND ${table.solarSpotSekSum} > '-Infinity' AND ${table.solarSpotSekSum} < 'Infinity'`,
    ),
    check('battery_pool_day_derive_version_check', sql`${table.deriveVersion} >= 1`),
    check(
      'battery_pool_day_capacity_kwh_check',
      sql`${table.capacityKwh} > 0 AND ${table.capacityKwh} < 100`,
    ),
  ],
).enableRLS()

// Pending energy-mix derives (ADR-0023): each sync that stored a change adds
// the day to derive from before it runs the derive. A derive consumes every
// request up to the highest id it saw when it took the lock, deriving from
// the earliest day among them, and deletes those rows in its transaction. A
// derive that fails (lock wait, timeout, bug, frozen instance) leaves its
// request behind, so the next derive covers it: no stored change is lost. A
// request added while a derive runs has a higher id and survives it.
export const energyMixDeriveRequest = pgTable('energy_mix_derive_request', {
  // The PK serves both reads: min(from_day) / max(id), and `id <= $1`.
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  fromDay: date('from_day', { mode: 'string' }).notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS()

import { sql } from 'drizzle-orm'
import { type AnyPgColumn, check, doublePrecision, pgTable, timestamp } from 'drizzle-orm/pg-core'

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
  ],
).enableRLS()

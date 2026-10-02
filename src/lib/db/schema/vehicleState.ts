import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/** Raw API strings are capped so API drift can't write megabytes. */
export const VEHICLE_STATE_TEXT_MAX = 64
const textMax = sql.raw(String(VEHICLE_STATE_TEXT_MAX))

// One row per poll of the MyŠkoda Public API (ADR-0022): what the car's latest
// reports said when we asked. Append-only (no updated_at, like
// integration_sync_run). A household presence history: never GPS, address or
// plate — `at_home` is the only trace of the position — and never exposed raw
// beyond the admin "latest" read (ADR-0022, Privacy).
export const vehicleStateSnapshot = pgTable(
  'vehicle_state_snapshot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    polledAt: timestamp('polled_at', { withTimezone: true }).notNull(),
    /** charging.carCapturedTimestamp; null when the charging part was missing. */
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    chargingState: text('charging_state'),
    chargeType: text('charge_type'),
    plugState: text('plug_state'),
    chargePowerKw: doublePrecision('charge_power_kw'),
    parkingState: text('parking_state'),
    /** Parked inside the geofence → true; parked outside or moving → false; unknown → null. */
    atHome: boolean('at_home'),
    socPercent: smallint('soc_percent'),
    odometerKm: integer('odometer_km'),
    odometerCapturedAt: timestamp('odometer_captured_at', { withTimezone: true }),
  },
  (table) => [
    index('vehicle_state_snapshot_polled_at_idx').on(table.polledAt),
    check(
      'vehicle_state_snapshot_charging_state_length_check',
      sql`${table.chargingState} IS NULL OR char_length(${table.chargingState}) <= ${textMax}`,
    ),
    check(
      'vehicle_state_snapshot_charge_type_length_check',
      sql`${table.chargeType} IS NULL OR char_length(${table.chargeType}) <= ${textMax}`,
    ),
    check(
      'vehicle_state_snapshot_plug_state_length_check',
      sql`${table.plugState} IS NULL OR char_length(${table.plugState}) <= ${textMax}`,
    ),
    check(
      'vehicle_state_snapshot_parking_state_length_check',
      sql`${table.parkingState} IS NULL OR char_length(${table.parkingState}) <= ${textMax}`,
    ),
    check(
      'vehicle_state_snapshot_charge_power_nonneg_check',
      sql`${table.chargePowerKw} IS NULL OR ${table.chargePowerKw} >= 0`,
    ),
    check(
      'vehicle_state_snapshot_soc_percent_check',
      sql`${table.socPercent} IS NULL OR ${table.socPercent} BETWEEN 0 AND 100`,
    ),
    check(
      'vehicle_state_snapshot_odometer_nonneg_check',
      sql`${table.odometerKm} IS NULL OR ${table.odometerKm} >= 0`,
    ),
  ],
).enableRLS()

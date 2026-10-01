import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { VEHICLE_RECORD_SOURCES } from '../../evCharging/vehicle'
import { sqlList } from '../sqlList'

// The car's own charging log (ADR-0021): one row per charge the car itself
// recorded, wherever it charged. Imported from the MySkoda export; location
// names and prices are never stored (`is_public` keeps only the fact). Read by
// the vehicle re-match and, later, Phase 6's SoC insights.
export const vehicleChargeRecord = pgTable(
  'vehicle_charge_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    sourceSessionId: text('source_session_id').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    energyKwh: doublePrecision('energy_kwh').notNull(),
    startSocPercent: smallint('start_soc_percent'),
    endSocPercent: smallint('end_soc_percent'),
    isPublic: boolean('is_public').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // Re-importing the same export is a no-op.
    unique('vehicle_charge_record_source_session_id_unique').on(
      table.source,
      table.sourceSessionId,
    ),
    check(
      'vehicle_charge_record_source_check',
      sql`${table.source} IN (${sqlList(VEHICLE_RECORD_SOURCES)})`,
    ),
    check('vehicle_charge_record_end_at_check', sql`${table.endAt} >= ${table.startAt}`),
    check('vehicle_charge_record_energy_kwh_nonneg_check', sql`${table.energyKwh} >= 0`),
    check(
      'vehicle_charge_record_start_soc_percent_check',
      sql`${table.startSocPercent} IS NULL OR ${table.startSocPercent} BETWEEN 0 AND 100`,
    ),
    check(
      'vehicle_charge_record_end_soc_percent_check',
      sql`${table.endSocPercent} IS NULL OR ${table.endSocPercent} BETWEEN 0 AND 100`,
    ),
  ],
).enableRLS()

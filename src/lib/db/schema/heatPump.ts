import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  date,
  doublePrecision,
  integer,
  pgMaterializedView,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Backstop for one unit-hour, kWh: a 2.5 kW unit can't use 5 kWh in an hour (ADR-0027). It
 * catches a unit slip, not real data; the service validates first. Changing it (or the
 * temperature bounds) changes the rendered CHECK text: run `bun run db:generate`.
 */
export const HEAT_PUMP_HOUR_KWH_MAX = 5
/** Plausible setpoint / indoor / outdoor temperature, °C (inclusive). */
export const HEAT_PUMP_TEMP_MIN_C = -60
export const HEAT_PUMP_TEMP_MAX_C = 60

const kwhMax = sql.raw(String(HEAT_PUMP_HOUR_KWH_MAX))
const tempMin = sql.raw(String(HEAT_PUMP_TEMP_MIN_C))
const tempMax = sql.raw(String(HEAT_PUMP_TEMP_MAX_C))

// One row per Panasonic Comfort Cloud air-to-air heat pump (ADR-0027), keyed by Comfort Cloud's
// device guid. `name` and `model` are refreshed by every sync (a rename keeps the history).
// `registered_on` is the unit's first data day (a UTC day, as parse.ts reads
// `deviceRegisterTime`), from the latest history answer: the backfill stops there and
// sets `history_complete_at`.
export const heatPump = pgTable('heat_pump', {
  id: uuid('id').primaryKey().defaultRandom(),
  guid: text('guid').notNull().unique(),
  name: text('name').notNull(),
  model: text('model').notNull(),
  registeredOn: date('registered_on', { mode: 'string' }),
  historyCompleteAt: timestamp('history_complete_at', { withTimezone: true }),
  // The next UTC day the backfill walk looks at: every day above it, down to the oldest stored
  // day, has been fetched or passed over (listed but empty, or rejected). Null: start below the
  // oldest stored day. Read with the unit row, so no index.
  backfillCursor: date('backfill_cursor', { mode: 'string' }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
}).enableRLS()

// NULL passes a CHECK: a missing value is allowed, a wrong one is not.
const shareCheck = (name: string, column: AnyPgColumn) =>
  check(`heat_pump_reading_${name}_check`, sql`${column} BETWEEN 0 AND 1`)
const tempCheck = (name: string, column: AnyPgColumn) =>
  check(`heat_pump_reading_${name}_check`, sql`${column} BETWEEN ${tempMin} AND ${tempMax}`)

// One row per unit and UTC hour: the hour's kWh, its heating and cooling share, and the hour's
// mean setpoint, indoor and outdoor temperature, as Comfort Cloud reports them (osTimezone
// +00:00, so rows are exact UTC hours). Written one UTC day at a time by `heatPump.replaceDay`
// (delete the unit's day, then insert, in one transaction): a re-fetched day never leaves stale
// hours, gaps stay gaps. Comfort Cloud's -255 ("no value") is never stored. Hourly rows tell when
// someone is home and heating: server-only, never logged raw, never sent to the client (only
// daily sums, ADR-0027 decision 6). The primary key serves the day replace, the oldest-day min()
// and per-unit ranges.
export const heatPumpReading = pgTable(
  'heat_pump_reading',
  {
    heatPumpId: uuid('heat_pump_id')
      .notNull()
      .references(() => heatPump.id, { onDelete: 'cascade' }),
    hourStart: timestamp('hour_start', { withTimezone: true }).notNull(),
    energyKwh: doublePrecision('energy_kwh').notNull(),
    heatShare: doublePrecision('heat_share'),
    coolShare: doublePrecision('cool_share'),
    setpointC: doublePrecision('setpoint_c'),
    insideC: doublePrecision('inside_c'),
    outsideC: doublePrecision('outside_c'),
  },
  (table) => [
    primaryKey({ name: 'heat_pump_reading_pkey', columns: [table.heatPumpId, table.hourStart] }),
    // date_bin, not date_trunc: date_trunc on timestamptz follows the session TimeZone (and is only
    // STABLE); date_bin against a UTC origin is the same everywhere (as house_energy_reading).
    check(
      'heat_pump_reading_hour_aligned_check',
      sql`date_bin('1 hour', ${table.hourStart}, timestamptz '2000-01-01 00:00:00+00') = ${table.hourStart}`,
    ),
    check(
      'heat_pump_reading_energy_kwh_check',
      sql`${table.energyKwh} >= 0 AND ${table.energyKwh} < ${kwhMax}`,
    ),
    shareCheck('heat_share', table.heatShare),
    shareCheck('cool_share', table.coolShare),
    tempCheck('setpoint_c', table.setpointC),
    tempCheck('inside_c', table.insideC),
    tempCheck('outside_c', table.outsideC),
  ],
).enableRLS()

// Per-unit Stockholm day sums of heat_pump_reading (ADR-0027 decision 6, amended 2026-10-15): what the
// heat pump sum reads take whole days from, so a request never scans the readings. A materialized view,
// defined in the custom migration 0027 (Drizzle can't declare its unique index, which REFRESH …
// CONCURRENTLY needs), hence `.existing()`: drizzle-kit never generates or drops it. Changing it = a new
// custom migration (drop, create, index + the guarded REVOKE). It is only as fresh as its last refresh:
// every writer of heat_pump_reading must call `heatPump.refreshDaySums()` after it writes (today: the
// Comfort Cloud sync, once per run that stored hours).
export const heatPumpDay = pgMaterializedView('heat_pump_day', {
  heatPumpId: uuid('heat_pump_id').notNull(),
  /** Stockholm calendar day. */
  day: date('day', { mode: 'string' }).notNull(),
  kwh: doublePrecision('kwh').notNull(),
  heatKwh: doublePrecision('heat_kwh').notNull(),
  coolKwh: doublePrecision('cool_kwh').notNull(),
  /** Σ over the hours with a value (null when none has); `…Hours` counts those hours. */
  insideCSum: doublePrecision('inside_c_sum'),
  insideCHours: integer('inside_c_hours').notNull(),
  outsideCSum: doublePrecision('outside_c_sum'),
  outsideCHours: integer('outside_c_hours').notNull(),
  setpointCSum: doublePrecision('setpoint_c_sum'),
  setpointCHours: integer('setpoint_c_hours').notNull(),
  hours: integer('hours').notNull(),
  firstHour: timestamp('first_hour', { withTimezone: true }).notNull(),
  lastHour: timestamp('last_hour', { withTimezone: true }).notNull(),
}).existing()

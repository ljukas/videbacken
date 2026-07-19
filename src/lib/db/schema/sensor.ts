import { relations, sql } from 'drizzle-orm'
import { check, index, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// One row per physical Shelly H&T Gen3, keyed by its MAC. `name`/`location` are
// null until an admin names it — devices auto-register on first webhook, then an
// admin labels them at /sensors.
export const sensorDevice = pgTable('sensor_device', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Normalized MAC (lowercase, separators stripped) — the device identity from
  // `${config.sys.device.mac}`. Normalization lives in the service.
  mac: text('mac').notNull().unique(),
  name: text('name'),
  location: text('location'),
  batteryPct: integer('battery_pct'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// One snapshot row per webhook: every Shelly webhook carries both current temp
// and humidity via status-placeholders, so both columns are normally populated.
// `real` (not `numeric`) so values read back as JS numbers for charting.
export const sensorReading = pgTable(
  'sensor_reading',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => sensorDevice.id, { onDelete: 'cascade' }),
    temperatureC: real('temperature_c'),
    humidityPct: real('humidity_pct'),
    batteryPct: integer('battery_pct'),
    // Server receipt time — the device wakes and fires within seconds; simpler
    // and more reliable than trusting a battery device's clock.
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('sensor_reading_device_recorded_idx').on(table.deviceId, table.recordedAt),
    check(
      'sensor_reading_temp_range_check',
      sql`${table.temperatureC} IS NULL OR ${table.temperatureC} BETWEEN -60 AND 100`,
    ),
    check(
      'sensor_reading_humidity_range_check',
      sql`${table.humidityPct} IS NULL OR ${table.humidityPct} BETWEEN 0 AND 100`,
    ),
    check(
      'sensor_reading_battery_range_check',
      sql`${table.batteryPct} IS NULL OR ${table.batteryPct} BETWEEN 0 AND 100`,
    ),
  ],
)

export const sensorDeviceRelations = relations(sensorDevice, ({ many }) => ({
  readings: many(sensorReading),
}))

export const sensorReadingRelations = relations(sensorReading, ({ one }) => ({
  device: one(sensorDevice, {
    fields: [sensorReading.deviceId],
    references: [sensorDevice.id],
  }),
}))

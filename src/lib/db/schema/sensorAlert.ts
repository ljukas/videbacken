import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  ALERT_COUNT_MAX,
  ALERT_COUNT_MIN,
  BATTERY_MAX,
  BATTERY_MIN,
  HUMIDITY_MAX,
  HUMIDITY_MIN,
  SENSOR_ALERT_DIRECTIONS,
  SENSOR_ALERT_KINDS,
  type SensorAlertDirection,
  type SensorAlertKind,
  SILENCE_HOURS_MAX,
  SILENCE_HOURS_MIN,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
} from '../../sensor/alerts'
import { sqlList } from '../sqlList'
import { user } from './betterAuth'
import { sensorDevice } from './sensor'

const raw = (n: number) => sql.raw(String(n))

// A user's own alert rule on one climate sensor (ADR-0028). Which columns a kind uses is the
// `shape` CHECK: temperature/humidity = direction + threshold + count; battery = 'below' +
// threshold + count; silence = silence_hours only. Bounds come from the client-safe vocabulary
// so the form, the service and the DB agree. The service owns the rest (one silence rule per
// device, ownership).
export const sensorAlertRule = pgTable(
  'sensor_alert_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => sensorDevice.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SensorAlertKind>().notNull(),
    direction: text('direction').$type<SensorAlertDirection>(),
    threshold: real('threshold'),
    count: integer('count'),
    silenceHours: integer('silence_hours'),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check('sensor_alert_rule_kind_check', sql`${table.kind} IN (${sqlList(SENSOR_ALERT_KINDS)})`),
    check(
      'sensor_alert_rule_direction_check',
      sql`${table.direction} IS NULL OR ${table.direction} IN (${sqlList(SENSOR_ALERT_DIRECTIONS)})`,
    ),
    check(
      'sensor_alert_rule_shape_check',
      sql`(${table.kind} IN ('temperature', 'humidity') AND ${table.direction} IS NOT NULL AND ${table.threshold} IS NOT NULL AND ${table.count} IS NOT NULL AND ${table.silenceHours} IS NULL)
        OR (${table.kind} = 'battery' AND ${table.direction} = 'below' AND ${table.threshold} IS NOT NULL AND ${table.count} IS NOT NULL AND ${table.silenceHours} IS NULL)
        OR (${table.kind} = 'silence' AND ${table.silenceHours} IS NOT NULL AND ${table.direction} IS NULL AND ${table.threshold} IS NULL AND ${table.count} IS NULL)`,
    ),
    check(
      'sensor_alert_rule_threshold_check',
      sql`${table.threshold} IS NULL
        OR (${table.kind} = 'temperature' AND ${table.threshold} BETWEEN ${raw(TEMPERATURE_MIN)} AND ${raw(TEMPERATURE_MAX)})
        OR (${table.kind} = 'humidity' AND ${table.threshold} BETWEEN ${raw(HUMIDITY_MIN)} AND ${raw(HUMIDITY_MAX)})
        OR (${table.kind} = 'battery' AND ${table.threshold} BETWEEN ${raw(BATTERY_MIN)} AND ${raw(BATTERY_MAX)})`,
    ),
    check(
      'sensor_alert_rule_count_check',
      sql`${table.count} IS NULL OR ${table.count} BETWEEN ${raw(ALERT_COUNT_MIN)} AND ${raw(ALERT_COUNT_MAX)}`,
    ),
    check(
      'sensor_alert_rule_silence_hours_check',
      sql`${table.silenceHours} IS NULL OR ${table.silenceHours} BETWEEN ${raw(SILENCE_HOURS_MIN)} AND ${raw(SILENCE_HOURS_MAX)}`,
    ),
    index('sensor_alert_rule_user_device_idx').on(table.userId, table.deviceId),
  ],
).enableRLS()

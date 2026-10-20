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
  uniqueIndex,
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
  SENSOR_ALERT_END_REASONS,
  SENSOR_ALERT_KINDS,
  type SensorAlertDirection,
  type SensorAlertEndReason,
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
// so the form, the service and the DB agree. The service owns ownership checks.
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
        OR (${table.kind} = 'battery' AND ${table.direction} IS NOT NULL AND ${table.direction} = 'below' AND ${table.threshold} IS NOT NULL AND ${table.count} IS NOT NULL AND ${table.silenceHours} IS NULL)
        OR (${table.kind} = 'silence' AND ${table.silenceHours} IS NOT NULL AND ${table.direction} IS NULL AND ${table.threshold} IS NULL AND ${table.count} IS NULL)`,
    ),
    check(
      'sensor_alert_rule_threshold_check',
      sql`${table.threshold} IS NULL
        OR (${table.kind} = 'temperature' AND ${table.threshold} BETWEEN ${raw(TEMPERATURE_MIN)} AND ${raw(TEMPERATURE_MAX)} AND ${table.threshold} * 2 = round(${table.threshold} * 2))
        OR (${table.kind} = 'humidity' AND ${table.threshold} BETWEEN ${raw(HUMIDITY_MIN)} AND ${raw(HUMIDITY_MAX)} AND ${table.threshold} = round(${table.threshold}))
        OR (${table.kind} = 'battery' AND ${table.threshold} BETWEEN ${raw(BATTERY_MIN)} AND ${raw(BATTERY_MAX)} AND ${table.threshold} = round(${table.threshold}))`,
    ),
    check(
      'sensor_alert_rule_count_check',
      sql`${table.count} IS NULL OR ${table.count} BETWEEN ${raw(ALERT_COUNT_MIN)} AND ${raw(ALERT_COUNT_MAX)}`,
    ),
    check(
      'sensor_alert_rule_silence_hours_check',
      sql`${table.silenceHours} IS NULL OR ${table.silenceHours} BETWEEN ${raw(SILENCE_HOURS_MIN)} AND ${raw(SILENCE_HOURS_MAX)}`,
    ),
    index('sensor_alert_rule_user_idx').on(table.userId, table.createdAt, table.id),
    index('sensor_alert_rule_device_idx').on(table.deviceId),
  ],
).enableRLS()

// One firing of a rule (ADR-0028): open while `ended_at` is null, with the rule's values
// snapshotted when it fired. `rule_id` goes null when the rule is deleted; no CHECK ties it to
// `ended_at`, because a sensor or user delete cascades into both tables and the rule's SET NULL
// may reach an open event before its own cascade delete does. The service writes the snapshot
// only from a valid rule, so there is no shape CHECK.
export const sensorAlertEvent = pgTable(
  'sensor_alert_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id').references(() => sensorAlertRule.id, { onDelete: 'set null' }),
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
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason').$type<SensorAlertEndReason>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('sensor_alert_event_kind_check', sql`${table.kind} IN (${sqlList(SENSOR_ALERT_KINDS)})`),
    check(
      'sensor_alert_event_direction_check',
      sql`${table.direction} IS NULL OR ${table.direction} IN (${sqlList(SENSOR_ALERT_DIRECTIONS)})`,
    ),
    check(
      'sensor_alert_event_end_reason_check',
      sql`${table.endReason} IS NULL OR ${table.endReason} IN (${sqlList(SENSOR_ALERT_END_REASONS)})`,
    ),
    check(
      'sensor_alert_event_end_check',
      sql`(${table.endedAt} IS NULL) = (${table.endReason} IS NULL)`,
    ),
    check(
      'sensor_alert_event_ended_after_started_check',
      sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
    ),
    uniqueIndex('sensor_alert_event_open_rule_idx')
      .on(table.ruleId)
      .where(sql`${table.endedAt} IS NULL`),
    index('sensor_alert_event_history_idx').on(
      table.userId,
      table.deviceId,
      table.startedAt.desc(),
      table.id.desc(),
    ),
  ],
).enableRLS()

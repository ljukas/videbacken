import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import {
  INTEGRATION_ERROR_CODES,
  INTEGRATION_SOURCES,
  SYNC_RUN_OUTCOMES,
  SYNC_TRIGGERS,
} from '../../integrationHealth'

// Renders a JS string array as a literal, comma-separated SQL `IN (...)` list,
// so each CHECK constraint's allowed values stay single-sourced with the
// exported const array (never a duplicated literal list in the DDL). Must use
// `sql.raw` (not `sql`/`sql.join`'s value interpolation): CHECK constraints are
// static DDL text, not a parameterized query — interpolating values there emits
// `$1, $2, …` placeholders with no bind values, which is invalid in a migration.
function sqlList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', '))
}

// Current health snapshot + sync lease, one row per integration source. Updated
// in place by every sync run (never appended); `integration_sync_run` below is
// the append-only history. The lease (`running_since`/`lease_until`/
// `lease_token`) prevents overlapping runs of the same source; `lease_token`
// (not a timestamp comparison) is what a run compares against to confirm it
// still holds the lease before writing its result.
export const integrationSync = pgTable(
  'integration_sync',
  {
    source: text('source').primaryKey(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastSuccessStartedAt: timestamp('last_success_started_at', { withTimezone: true }),
    failingSince: timestamp('failing_since', { withTimezone: true }),
    runningSince: timestamp('running_since', { withTimezone: true }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    // `not_configured` is a code like the others: a failing row with that code
    // (e.g. missing credentials), not a distinct non-failing state.
    errorCode: text('error_code'),
    lastErrorMessage: text('last_error_message'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      'integration_sync_source_check',
      sql`${table.source} IN (${sqlList(INTEGRATION_SOURCES)})`,
    ),
    check(
      'integration_sync_consecutive_failures_nonneg_check',
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      'integration_sync_error_code_check',
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${sqlList(INTEGRATION_ERROR_CODES)})`,
    ),
    check(
      'integration_sync_last_error_message_length_check',
      sql`${table.lastErrorMessage} IS NULL OR char_length(${table.lastErrorMessage}) <= 500`,
    ),
    check(
      'integration_sync_failures_error_code_check',
      sql`(${table.consecutiveFailures} = 0) = (${table.errorCode} IS NULL)`,
    ),
    check(
      'integration_sync_error_code_failing_since_check',
      sql`(${table.errorCode} IS NULL) = (${table.failingSince} IS NULL)`,
    ),
    check(
      'integration_sync_last_error_message_error_code_check',
      sql`${table.lastErrorMessage} IS NULL OR ${table.errorCode} IS NOT NULL`,
    ),
    check(
      'integration_sync_running_since_lease_until_check',
      sql`(${table.runningSince} IS NULL) = (${table.leaseUntil} IS NULL)`,
    ),
    check(
      'integration_sync_lease_until_token_check',
      sql`(${table.leaseUntil} IS NULL) = (${table.leaseToken} IS NULL)`,
    ),
  ],
)

// Append-only history: one row per sync attempt, for the health dashboard and
// debugging. Never updated after insert.
export const integrationSyncRun = pgTable(
  'integration_sync_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    trigger: text('trigger').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    outcome: text('outcome').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    since: timestamp('since', { withTimezone: true }),
    pages: integer('pages').notNull().default(0),
    sessionsSeen: integer('sessions_seen').notNull().default(0),
    upserted: integer('upserted').notNull().default(0),
    voided: integer('voided').notNull().default(0),
    timings: jsonb('timings').$type<Record<string, number>>().notNull().default({}),
  },
  (table) => [
    index('integration_sync_run_source_started_idx').on(table.source, table.startedAt.desc()),
    check(
      'integration_sync_run_source_check',
      sql`${table.source} IN (${sqlList(INTEGRATION_SOURCES)})`,
    ),
    check(
      'integration_sync_run_trigger_check',
      sql`${table.trigger} IN (${sqlList(SYNC_TRIGGERS)})`,
    ),
    check('integration_sync_run_duration_ms_nonneg_check', sql`${table.durationMs} >= 0`),
    check(
      'integration_sync_run_outcome_check',
      sql`${table.outcome} IN (${sqlList(SYNC_RUN_OUTCOMES)})`,
    ),
    check(
      'integration_sync_run_error_code_check',
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${sqlList(INTEGRATION_ERROR_CODES)})`,
    ),
    check(
      'integration_sync_run_error_message_length_check',
      sql`${table.errorMessage} IS NULL OR char_length(${table.errorMessage}) <= 500`,
    ),
    check(
      'integration_sync_run_outcome_error_code_check',
      sql`(${table.outcome} = 'ok') = (${table.errorCode} IS NULL)`,
    ),
  ],
)

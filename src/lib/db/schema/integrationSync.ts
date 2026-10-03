import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  CREDENTIAL_REMINDER_DAYS,
  INTEGRATION_ERROR_CODES,
  INTEGRATION_SOURCES,
  SYNC_RUN_OUTCOMES,
  SYNC_TRIGGERS,
} from '../../integrationHealth'
import { sqlList } from '../sqlList'

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
    // When this failure streak sent its `started_failing` alert; null while no
    // alert is open. Tracked on its own (not derived from `errorCode`) because a
    // streak can pass through `not_configured`, which never alerts — only this
    // column knows whether a `recovered` email is owed.
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
    runningSince: timestamp('running_since', { withTimezone: true }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    // Consecutive alertable failures (not_configured excluded and resets it); the
    // alert threshold counts these. Never more than `consecutiveFailures`, but
    // that invariant is enforced by `nextRow`, not a DB CHECK: code from before
    // this column (an instant rollback) zeroes `consecutive_failures` on success
    // and leaves this column alone, which such a CHECK would reject.
    alertableFailures: integer('alertable_failures').notNull().default(0),
    // `not_configured` is a code like the others: a failing row with that code
    // (e.g. missing credentials), not a distinct non-failing state.
    errorCode: text('error_code'),
    lastErrorMessage: text('last_error_message'),
    // Last expiry the source's credential reported (Škoda's X-API-Key-Expires-At);
    // null for sources without one.
    credentialExpiresAt: timestamp('credential_expires_at', { withTimezone: true }),
    // The smallest reminder threshold already emailed for this expiry; reset to
    // null whenever credential_expires_at changes (a renewed key).
    credentialReminderDays: smallint('credential_reminder_days'),
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
    check('integration_sync_alertable_failures_nonneg_check', sql`${table.alertableFailures} >= 0`),
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
      'integration_sync_alerted_at_error_code_check',
      sql`${table.alertedAt} IS NULL OR ${table.errorCode} IS NOT NULL`,
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
    check(
      'integration_sync_credential_reminder_days_check',
      sql`${table.credentialReminderDays} IS NULL OR ${table.credentialReminderDays} IN (${sql.raw(CREDENTIAL_REMINDER_DAYS.join(', '))})`,
    ),
    check(
      'integration_sync_credential_reminder_expiry_check',
      sql`${table.credentialReminderDays} IS NULL OR ${table.credentialExpiresAt} IS NOT NULL`,
    ),
  ],
).enableRLS()

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
).enableRLS()

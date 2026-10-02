// Shared vocabulary for third-party integration sync health (Zaptec today; elpris
// and Skoda are placeholders for later phases). Dependency-free and client-safe —
// no `db`/`postgres` import here — so the client can import these unions for
// status badges without dragging the db layer (and its `Buffer` usage) into the
// browser bundle. See `src/lib/sensor/range.ts` for the same pattern.
export const INTEGRATION_SOURCES = ['zaptec', 'elpris', 'skoda'] as const
export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number]

export const INTEGRATION_ERROR_CODES = [
  'auth_failed',
  'forbidden',
  'rate_limited',
  'unreachable',
  'unexpected_response',
  'not_configured',
  'internal_error',
] as const
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number]

export const SYNC_TRIGGERS = ['cron', 'admin'] as const
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number]

export const SYNC_RUN_OUTCOMES = ['ok', 'failed', 'error'] as const
export type SyncRunOutcome = (typeof SYNC_RUN_OUTCOMES)[number]

export type HealthTransition = 'none' | 'started_failing' | 'recovered'
export type HealthState = 'never_synced' | 'not_configured' | 'ok' | 'stale' | 'failing'

/** Sources whose credential expires and is renewed by hand (ADR-0022). */
export const EXPIRING_CREDENTIAL_SOURCES = ['skoda'] as const
export type ExpiringCredentialSource = (typeof EXPIRING_CREDENTIAL_SOURCES)[number]
/** Admins see a warning from this many days before expiry (while the source is healthy). */
export const CREDENTIAL_WARN_DAYS = 30
/** Reminder emails, largest first; each sent once per expiry date. Changing or reordering this changes the rendered DB CHECK: run `bun run db:generate`. */
export const CREDENTIAL_REMINDER_DAYS = [30, 7] as const
export type CredentialReminderDays = (typeof CREDENTIAL_REMINDER_DAYS)[number]

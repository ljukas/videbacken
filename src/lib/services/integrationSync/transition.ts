import type {
  HealthState,
  HealthTransition,
  IntegrationErrorCode,
  IntegrationSource,
} from '~/lib/integrationHealth'
import { STALE_AFTER_MS } from './policy'
import { sanitizeErrorMessage } from './sanitize'

// Pure health rules: no db, no clock. `integrationSync.ts` loads the locked row,
// calls `nextRow`, and writes the result back in one transaction.

export type RunStats = {
  since: Date | null
  pages: number
  sessionsSeen: number
  upserted: number
  voided: number
  timings: Record<string, number>
}

// `syncedUntil` is how far the run imported every session: the next run's
// fetch window starts from it (`lastSuccessStartedAt`, the watermark). A
// success defaults it to the run's start; a failure that still finished some
// windows (a long backfill hitting the deadline) passes it so that progress is
// kept rather than refetched from scratch.
export type SyncOutcome =
  | { ok: true; stats: RunStats; syncedUntil?: Date }
  | {
      ok: false
      kind: 'failed' | 'error'
      code: IntegrationErrorCode
      message: string
      stats: RunStats
      syncedUntil?: Date
    }

// The health-bearing columns of an `integration_sync` row (lease columns are
// owned by `beginAttempt`/`recordOutcome`, not by these rules).
export type HealthSnapshot = {
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  lastSuccessStartedAt: Date | null
  failingSince: Date | null
  alertedAt: Date | null
  consecutiveFailures: number
  errorCode: IntegrationErrorCode | null
  lastErrorMessage: string | null
}

// Alert transitions: an alert opens on the first alertable failure of a
// streak (`started_failing`) and closes on the next success (`recovered`), so
// every `recovered` pairs with a `started_failing`. `not_configured` (e.g.
// missing credentials) never opens an alert, but it doesn't close one either —
// `auth_failed` → `not_configured` → ok still sends `recovered`, and
// `not_configured` → `auth_failed` sends `started_failing`. A code change
// between alertable codes is the same outage and never re-alerts.
export function nextRow(
  prev: HealthSnapshot,
  outcome: SyncOutcome,
  now: Date,
  startedAt: Date,
): { row: HealthSnapshot; transition: HealthTransition } {
  const wasFailing = prev.consecutiveFailures > 0
  const alertOpen = prev.alertedAt !== null
  if (outcome.ok) {
    return {
      row: {
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastSuccessStartedAt: outcome.syncedUntil ?? startedAt,
        failingSince: null,
        alertedAt: null,
        consecutiveFailures: 0,
        errorCode: null,
        lastErrorMessage: null,
      },
      transition: alertOpen ? 'recovered' : 'none',
    }
  }
  const opensAlert = !alertOpen && outcome.code !== 'not_configured'
  return {
    row: {
      lastAttemptAt: now,
      lastSuccessAt: prev.lastSuccessAt,
      lastSuccessStartedAt: outcome.syncedUntil ?? prev.lastSuccessStartedAt,
      failingSince: wasFailing ? prev.failingSince : now,
      alertedAt: opensAlert ? now : prev.alertedAt,
      consecutiveFailures: prev.consecutiveFailures + 1,
      errorCode: outcome.code,
      lastErrorMessage: sanitizeErrorMessage(outcome.message),
    },
    transition: opensAlert ? 'started_failing' : 'none',
  }
}

// Stale = the last success is strictly older than the source's policy window.
export function deriveState(
  source: IntegrationSource,
  row: HealthSnapshot | null,
  now: Date,
): HealthState {
  if (!row?.lastAttemptAt) return 'never_synced'
  if (row.errorCode === 'not_configured') return 'not_configured'
  if (row.errorCode) return 'failing'
  // Attempted with no error ⇒ a success was recorded; guard anyway.
  if (!row.lastSuccessAt) return 'never_synced'
  return now.getTime() - row.lastSuccessAt.getTime() > STALE_AFTER_MS[source] ? 'stale' : 'ok'
}

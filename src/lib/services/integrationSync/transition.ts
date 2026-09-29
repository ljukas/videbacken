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

export type SyncOutcome =
  | { ok: true; stats: RunStats }
  | {
      ok: false
      kind: 'failed' | 'error'
      code: IntegrationErrorCode
      message: string
      stats: RunStats
    }

// The health-bearing columns of an `integration_sync` row (lease columns are
// owned by `beginAttempt`/`recordOutcome`, not by these rules).
export type HealthSnapshot = {
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  lastSuccessStartedAt: Date | null
  failingSince: Date | null
  consecutiveFailures: number
  errorCode: IntegrationErrorCode | null
  lastErrorMessage: string | null
}

// Alert transitions: a streak starting (0 → ≥1 failures) or ending (≥1 → 0).
// `not_configured` (e.g. missing credentials) is its own state and never alerts
// — neither when it starts nor when it clears. A code change mid-streak is the
// same outage and never re-alerts. The row keeps only the current code, so
// "a not_configured streak" is judged by the code at the edge in question.
export function nextRow(
  prev: HealthSnapshot,
  outcome: SyncOutcome,
  now: Date,
  startedAt: Date,
): { row: HealthSnapshot; transition: HealthTransition } {
  const wasFailing = prev.consecutiveFailures > 0
  if (outcome.ok) {
    return {
      row: {
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastSuccessStartedAt: startedAt,
        failingSince: null,
        consecutiveFailures: 0,
        errorCode: null,
        lastErrorMessage: null,
      },
      transition: wasFailing && prev.errorCode !== 'not_configured' ? 'recovered' : 'none',
    }
  }
  return {
    row: {
      lastAttemptAt: now,
      lastSuccessAt: prev.lastSuccessAt,
      lastSuccessStartedAt: prev.lastSuccessStartedAt,
      failingSince: wasFailing ? prev.failingSince : now,
      consecutiveFailures: prev.consecutiveFailures + 1,
      errorCode: outcome.code,
      lastErrorMessage: sanitizeErrorMessage(outcome.message),
    },
    transition: !wasFailing && outcome.code !== 'not_configured' ? 'started_failing' : 'none',
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

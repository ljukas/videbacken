import { queue } from '~/lib/effects'
import { IntegrationError } from '~/lib/effects/integrationError'
import type {
  HealthTransition,
  IntegrationErrorCode,
  IntegrationSource,
  SyncTrigger,
} from '~/lib/integrationHealth'
import type { Logger } from '~/lib/logger'
import {
  beginAttempt,
  type IntegrationHealth,
  internalErrorMessage,
  type RunStats,
  recordOutcome,
  type SyncOutcome,
  reportProgress as writeProgress,
} from '~/lib/services/integrationSync'
import * as userService from '~/lib/services/user'
import { baseLocale } from '~/paraglide/runtime'

/**
 * The fields every source's sync run shares. Deliberately carries no error
 * message: the admin-only detail lives in the health snapshot, never in the
 * returned run or the log line.
 */
export type RunBase = {
  source: IntegrationSource
  trigger: SyncTrigger
  outcome: 'ok' | 'failed' | 'skipped' | 'error'
  code: IntegrationErrorCode | null
  transition: HealthTransition
  startedAt: Date
  since: Date | null
  /**
   * End of the last stretch that fully imported — the next watermark (defaults
   * to `startedAt` on success). Set it when a run makes partial progress.
   */
  syncedUntil: Date | null
  durationMs: number
}

export type PulledSyncSpec<R extends RunBase> = {
  source: IntegrationSource
  trigger: SyncTrigger
  now: () => Date
  /** Overall budget for the run's remote calls; aborts `execute`'s signal. */
  deadlineMs: number
  log: Logger
  /** The run with the source's own counters zeroed, spread over `base`. */
  init: (base: RunBase) => R
  /**
   * The source's fetch + import. Mutates `run` as progress lands, so a failure
   * part-way still reports what landed. An `IntegrationError` → `failed`;
   * anything else → `error` (recorded best effort, then rethrown).
   */
  execute: (ctx: {
    run: R
    signal: AbortSignal
    now: () => Date
    log: Logger
    /**
     * Best effort: the run's progress for its Datakällor tile, in the source's
     * own unit. Throttled (`done === total` always writes); a failed write is
     * logged and never fails the run.
     */
    reportProgress: (done: number, total: number) => Promise<void>
  }) => Promise<void>
  /** The recorded run-history stats. Sees `run` before `finalize` has run. */
  toRunStats: (run: R) => RunStats
  /**
   * Folds client-side counters into `run` once it has ended (after the outcome
   * is recorded), before the log line.
   */
  finalize?: (run: R) => void
  /** The source's own run-line fields, logged after — never instead of — the common ones. */
  logFields: (run: R) => Record<string, unknown>
}

/** At most one progress write per second per run; the UI polls every 5 s. */
const PROGRESS_INTERVAL_MS = 1_000

/**
 * The lifecycle every pulled integration's sync run shares (ADR-0019): lease →
 * source-specific fetch/import under a deadline → record the outcome once →
 * alert admins on a streak edge → exactly one `integration sync run` log line.
 * Each source supplies only its own work (`execute`) and counters.
 */
export async function runPulledSync<R extends RunBase>(spec: PulledSyncSpec<R>): Promise<R> {
  const { source, trigger, now, log } = spec
  const startedAt = now()
  const run = spec.init({
    source,
    trigger,
    outcome: 'skipped',
    code: null,
    transition: 'none',
    startedAt,
    since: null,
    syncedUntil: null,
    durationMs: 0,
  })
  let thrown: unknown
  let progressWrites = 0
  const deadline = new AbortController()
  const deadlineTimer = setTimeout(
    () => deadline.abort(new DOMException('sync deadline exceeded', 'TimeoutError')),
    spec.deadlineMs,
  )

  try {
    const attempt = await beginAttempt(source, { now: startedAt })
    // Another run holds the lease (also absorbs duplicate cron deliveries).
    if (!attempt.acquired) return run

    let lastProgressMs = Number.NEGATIVE_INFINITY
    const reportProgress = async (done: number, total: number) => {
      const t = Math.floor(total)
      if (!(t > 0)) return
      const d = Math.min(t, Math.max(0, Math.floor(done)))
      const at = now()
      if (d < t && at.getTime() - lastProgressMs < PROGRESS_INTERVAL_MS) return
      lastProgressMs = at.getTime()
      try {
        await writeProgress(source, attempt.attemptId, { done: d, total: t }, { now: at })
        // Counts write calls that didn't throw; a lost lease stores no row.
        progressWrites++
      } catch (error) {
        log.warn('integration sync progress write failed', { source, error })
      }
    }

    let outcome: SyncOutcome
    try {
      await spec.execute({ run, signal: deadline.signal, now, log, reportProgress })
      run.outcome = 'ok'
      outcome = { ok: true, stats: spec.toRunStats(run), syncedUntil: run.syncedUntil }
    } catch (error) {
      const failed = error instanceof IntegrationError
      if (!failed) thrown = error
      run.outcome = failed ? 'failed' : 'error'
      run.code = failed ? error.code : 'internal_error'
      outcome = {
        ok: false,
        kind: failed ? 'failed' : 'error',
        code: run.code,
        message: failed ? error.message : internalErrorMessage(error),
        stats: spec.toRunStats(run),
        syncedUntil: run.syncedUntil,
      }
    }

    // The outcome is written once (ADR-0019). If that write throws, it is not
    // retried as `internal_error` — whether it committed is unknown; the lease
    // expires and the next run redoes the work.
    try {
      const recorded = await recordOutcome(source, outcome, {
        attemptId: attempt.attemptId,
        trigger,
        startedAt,
        now: now(),
        log,
      })
      run.transition = recorded.transition
      await alertAdmins(source, recorded.transition, recorded.health, log)
    } catch (recordError) {
      if (run.outcome !== 'error') throw recordError
      // Recording an unexpected error is best effort: it must not mask it.
      log.warn('integration sync outcome could not be recorded', { source, error: recordError })
    }
    if (run.outcome === 'error') throw thrown
    return run
  } catch (error) {
    thrown = error
    run.outcome = 'error'
    run.code = 'internal_error'
    throw error
  } finally {
    clearTimeout(deadlineTimer)
    run.durationMs = Math.max(0, now().getTime() - startedAt.getTime())
    spec.finalize?.(run)
    const fields = {
      source: run.source,
      trigger: run.trigger,
      outcome: run.outcome,
      code: run.code,
      transition: run.transition,
      since: run.since,
      syncedUntil: run.syncedUntil,
      durationMs: run.durationMs,
      progressWrites,
      ...spec.logFields(run),
    }
    if (run.outcome === 'error') log.error('integration sync run', { ...fields, error: thrown })
    else if (run.outcome === 'failed') log.warn('integration sync run', fields)
    else log.info('integration sync run', fields)
  }
}

/**
 * (typically an `IntegrationError`, so the run records `failed`, `unreachable`; any Error works for callers that only catch it).
 * (an `IntegrationError`, so the run records `failed`, typically `unreachable`).
 */
export function withDeadline<T>(
  p: Promise<T>,
  signal: AbortSignal,
  makeError: () => Error,
): Promise<T> {
  // A call that settles after the deadline must not surface as unhandled.
  p.catch(() => {})
  if (signal.aborted) return Promise.reject(makeError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(makeError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

// One alert message per active admin on a streak edge. Tier-2: a publish (or
// the admin lookup) failing is logged and never fails the run — the health
// snapshot already records the outcome.
async function alertAdmins(
  source: IntegrationSource,
  transition: HealthTransition,
  health: IntegrationHealth,
  log: Logger,
): Promise<void> {
  if (transition === 'none') return
  let admins: { email: string }[]
  try {
    admins = await userService.listActiveAdmins()
  } catch (error) {
    log.warn('integration sync alert publish failed', { source, transition, error })
    return
  }
  await Promise.all(
    admins.map((admin) =>
      queue
        .publish('email_integration_sync_alert', {
          to: admin.email,
          source,
          transition,
          code: health.code,
          failingSince: health.failingSince?.toISOString() ?? null,
          locale: baseLocale,
        })
        .catch((error) =>
          log.warn('integration sync alert publish failed', { source, transition, error }),
        ),
    ),
  )
}

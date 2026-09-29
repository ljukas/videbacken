import { queue } from '~/lib/effects'
import {
  newCallStats,
  type ZaptecCallStats,
  type ZaptecClient,
  ZaptecError,
  type ZaptecOp,
  zaptec,
} from '~/lib/effects/zaptec'
import type { HealthTransition, IntegrationErrorCode, SyncTrigger } from '~/lib/integrationHealth'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import { importSessions, upsertChargers } from '~/lib/services/evCharging'
import {
  beginAttempt,
  getLastSuccessStartedAt,
  type IntegrationHealth,
  internalErrorMessage,
  type RunStats,
  recordOutcome,
  type SyncOutcome,
} from '~/lib/services/integrationSync'
import * as userService from '~/lib/services/user'
import { baseLocale } from '~/paraglide/runtime'

/**
 * The Zaptec sync run — the domain orchestrator both the hourly cron route and
 * the admin `syncNow` procedure call (ADR-0001 amendment, ADR-0019). Ties the
 * Zaptec client, the charging service, the integration-health lease/outcome
 * and the alert email together, and emits exactly one `integration sync run`
 * log line per call.
 *
 * Deliberately carries no error message: the admin-only detail lives in the
 * health snapshot, never in the returned run or the log line.
 */
export type SyncRun = {
  source: 'zaptec'
  trigger: SyncTrigger
  outcome: 'ok' | 'failed' | 'skipped' | 'error'
  code: IntegrationErrorCode | null
  transition: HealthTransition
  startedAt: Date
  since: Date | null
  /**
   * End of the last fetch window that fully imported — the next watermark.
   * Before `startedAt` when a backfill ran out of budget (or failed) part-way.
   */
  syncedUntil: Date | null
  durationMs: number
  authMs: number
  fetchMs: number
  importMs: number
  pages: number
  chargers: number
  sessionsSeen: number
  upserted: number
  voided: number
  /**
   * Sessions never imported because they were invalid: dropped by the Zaptec
   * parser (unexpected shape) or rejected by the charging service.
   */
  skipped: number
}

const SOURCE = 'zaptec'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** Re-fetch window before the last success, to catch late/offline sessions. */
const LOOKBACK_MS = 7 * DAY_MS
const FIRST_RUN_SINCE = new Date('2020-01-01T00:00:00Z')
// Session fetch windows (ADR-0019): oldest first, each finished window moves
// the watermark, and one that overflows `MAX_PAGES` is halved and retried.
/** Longest window. Must exceed `LOOKBACK_MS`, so a window ends past the previous watermark. */
const WINDOW_MS = 90 * DAY_MS
/** Shortest window; one this short that still overflows fails the run. */
const MIN_WINDOW_MS = HOUR_MS
/** No new window starts once the run is this old; the next run continues. */
const WINDOW_BUDGET_MS = 120_000
/** Per installation and window. */
const MAX_PAGES = 20

/** A window's session paging went past `MAX_PAGES`. */
class PageCapExceeded extends ZaptecError {
  constructor() {
    super('unexpected_response', 'sessions', undefined, {
      message: `Zaptec sessions exceeded ${MAX_PAGES} pages for one installation`,
    })
  }
}
/**
 * Overall budget for the run's Zaptec calls. Well under Vercel's 300 s function
 * limit, so a slow run still fails as `unreachable`, records its outcome and
 * emits its run line (the lease is 5 min).
 */
const RUN_DEADLINE_MS = 240_000

export async function runZaptecSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
  /** Overrides the 240 s Zaptec deadline (tests). */
  deadlineMs?: number
  deps?: { zaptec?: ZaptecClient; log?: Logger }
}): Promise<SyncRun> {
  const now = opts.now ?? (() => new Date())
  const client = opts.deps?.zaptec ?? zaptec
  const log = opts.deps?.log ?? logger
  const startedAt = now()
  const stats = newCallStats()
  const run: SyncRun = {
    source: SOURCE,
    trigger: opts.trigger,
    outcome: 'skipped',
    code: null,
    transition: 'none',
    startedAt,
    since: null,
    syncedUntil: null,
    durationMs: 0,
    authMs: 0,
    fetchMs: 0,
    importMs: 0,
    pages: 0,
    chargers: 0,
    sessionsSeen: 0,
    upserted: 0,
    voided: 0,
    skipped: 0,
  }
  let thrown: unknown
  const deadlineMs = opts.deadlineMs ?? RUN_DEADLINE_MS
  const deadline = new AbortController()
  const deadlineTimer = setTimeout(
    () => deadline.abort(new DOMException('sync deadline exceeded', 'TimeoutError')),
    deadlineMs,
  )

  try {
    const attempt = await beginAttempt(SOURCE, { now: startedAt })
    // Another run holds the lease (also absorbs duplicate cron deliveries).
    if (!attempt.acquired) return run

    let outcome: SyncOutcome
    try {
      await fetchAndImport(client, run, stats, deadline.signal, now)
      run.outcome = 'ok'
      outcome = { ok: true, stats: runStats(run, stats), syncedUntil: run.syncedUntil }
    } catch (error) {
      const failed = error instanceof ZaptecError
      if (!failed) thrown = error
      run.outcome = failed ? 'failed' : 'error'
      run.code = failed ? error.code : 'internal_error'
      outcome = {
        ok: false,
        kind: failed ? 'failed' : 'error',
        code: run.code,
        message: failed ? error.message : internalErrorMessage(error),
        stats: runStats(run, stats),
        syncedUntil: run.syncedUntil,
      }
    }

    // The outcome is written once (ADR-0019). If that write throws, it is not
    // retried as `internal_error` — whether it committed is unknown; the lease
    // expires and the next run redoes the window.
    try {
      const recorded = await recordOutcome(SOURCE, outcome, {
        attemptId: attempt.attemptId,
        trigger: opts.trigger,
        startedAt,
        now: now(),
        log,
      })
      run.transition = recorded.transition
      await alertAdmins(recorded.transition, recorded.health, log)
    } catch (recordError) {
      if (run.outcome !== 'error') throw recordError
      // Recording an unexpected error is best effort: it must not mask it.
      log.warn('integration sync outcome could not be recorded', {
        source: SOURCE,
        error: recordError,
      })
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
    run.authMs = Math.round(stats.authMs)
    run.fetchMs = Math.round(stats.fetchMs)
    run.importMs = Math.round(run.importMs)
    run.skipped += stats.rejected
    const fields = {
      source: run.source,
      trigger: run.trigger,
      outcome: run.outcome,
      code: run.code,
      transition: run.transition,
      since: run.since,
      syncedUntil: run.syncedUntil,
      durationMs: run.durationMs,
      authMs: run.authMs,
      fetchMs: run.fetchMs,
      importMs: run.importMs,
      pages: run.pages,
      chargers: run.chargers,
      sessionsSeen: run.sessionsSeen,
      upserted: run.upserted,
      voided: run.voided,
      skipped: run.skipped,
    }
    if (run.outcome === 'error') log.error('integration sync run', { ...fields, error: thrown })
    else if (run.outcome === 'failed') log.warn('integration sync run', fields)
    else log.info('integration sync run', fields)
  }
}

// Chargers, then sessions window by window (oldest first) and installation by
// installation, one charging-service transaction per page. Mutates `run` as it
// goes, so a failure part-way still reports what landed: earlier pages stay
// imported, and `run.syncedUntil` marks the last window that fully did.
// Every Zaptec call gets the run's deadline `signal` and is also raced against
// it, so even a client that ignores the signal can't outlast the deadline.
async function fetchAndImport(
  client: ZaptecClient,
  run: SyncRun,
  stats: ZaptecCallStats,
  signal: AbortSignal,
  now: () => Date,
): Promise<void> {
  const chargers = await withDeadline(client.chargers({ stats, signal }), signal, 'chargers')
  run.chargers = chargers.length
  await upsertChargers(chargers)

  const lastSuccessStartedAt = await getLastSuccessStartedAt(SOURCE)
  const since = lastSuccessStartedAt
    ? new Date(lastSuccessStartedAt.getTime() - LOOKBACK_MS)
    : FIRST_RUN_SINCE
  run.since = since

  const installationIds = [...new Set(chargers.map((c) => c.installationId))]
  let windowStart = since
  let windowMs = WINDOW_MS
  while (windowStart < run.startedAt) {
    // Always at least one window per run, so a run can never make no progress.
    const elapsed = now().getTime() - run.startedAt.getTime()
    if (run.syncedUntil !== null && elapsed >= WINDOW_BUDGET_MS) return
    const windowEnd = new Date(Math.min(windowStart.getTime() + windowMs, run.startedAt.getTime()))
    try {
      for (const installationId of installationIds) {
        await importWindow(client, run, stats, signal, {
          installationId,
          since: windowStart,
          until: windowEnd,
        })
      }
    } catch (error) {
      // Pages that already imported are upserted again, harmlessly. Later
      // windows keep the narrower length — dense stretches tend to be long.
      if (!(error instanceof PageCapExceeded) || windowMs / 2 < MIN_WINDOW_MS) throw error
      windowMs /= 2
      continue
    }
    run.syncedUntil = windowEnd
    windowStart = windowEnd
  }
}

async function importWindow(
  client: ZaptecClient,
  run: SyncRun,
  stats: ZaptecCallStats,
  signal: AbortSignal,
  window: { installationId: string; since: Date; until: Date },
): Promise<void> {
  const { installationId, since, until } = window
  let pages = 0
  const iterator = client
    .sessionsEndedSince(since, { installationId, until, stats, signal })
    [Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await withDeadline(iterator.next(), signal, 'sessions')
      if (next.done) break
      const page = next.value
      pages++
      if (pages > MAX_PAGES) throw new PageCapExceeded()
      run.pages++
      run.sessionsSeen += page.length
      const importStart = performance.now()
      const result = await importSessions(page, { installationId })
      run.importMs += performance.now() - importStart
      run.upserted += result.upserted
      run.voided += result.voided
      run.skipped += result.skipped
    }
  } finally {
    // Not awaited: a generator stuck past the deadline would never settle.
    iterator.return?.()?.catch(() => {})
  }
}

/** Races a Zaptec call against the run deadline; a hit → `unreachable`. */
function withDeadline<T>(p: Promise<T>, signal: AbortSignal, op: ZaptecOp): Promise<T> {
  // A call that settles after the deadline must not surface as unhandled.
  p.catch(() => {})
  const deadlineError = () =>
    new ZaptecError('unreachable', op, undefined, {
      cause: { name: 'TimeoutError' },
      message: `Zaptec ${op} did not finish within the sync deadline`,
    })
  if (signal.aborted) return Promise.reject(deadlineError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(deadlineError())
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

function runStats(run: SyncRun, stats: ZaptecCallStats): RunStats {
  return {
    since: run.since,
    pages: run.pages,
    sessionsSeen: run.sessionsSeen,
    upserted: run.upserted,
    voided: run.voided,
    timings: {
      authMs: Math.round(stats.authMs),
      fetchMs: Math.round(stats.fetchMs),
      importMs: Math.round(run.importMs),
      requests: stats.requests,
      retries: stats.retries,
    },
  }
}

// One alert message per active admin on a streak edge. Tier-2: a publish (or
// the admin lookup) failing is logged and never fails the run — the health
// snapshot already records the outcome.
async function alertAdmins(
  transition: HealthTransition,
  health: IntegrationHealth,
  log: Logger,
): Promise<void> {
  if (transition === 'none') return
  let admins: { email: string }[]
  try {
    admins = (await userService.listAll()).filter((u) => u.role === 'admin' && !u.deletedAt)
  } catch (error) {
    log.warn('integration sync alert publish failed', { source: SOURCE, transition, error })
    return
  }
  await Promise.all(
    admins.map((admin) =>
      queue
        .publish('email_integration_sync_alert', {
          to: admin.email,
          source: SOURCE,
          transition,
          code: health.code,
          failingSince: health.failingSince?.toISOString() ?? null,
          locale: baseLocale,
        })
        .catch((error) =>
          log.warn('integration sync alert publish failed', { source: SOURCE, transition, error }),
        ),
    ),
  )
}

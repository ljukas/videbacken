import { queue } from '~/lib/effects'
import {
  newCallStats,
  type ZaptecCallStats,
  type ZaptecClient,
  ZaptecError,
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
  durationMs: number
  authMs: number
  fetchMs: number
  importMs: number
  pages: number
  chargers: number
  sessionsSeen: number
  upserted: number
  voided: number
  /** Sessions the charging service rejected as invalid (never imported). */
  skipped: number
}

const SOURCE = 'zaptec'
/** Re-fetch window before the last success, to catch late/offline sessions. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const FIRST_RUN_SINCE = new Date('2020-01-01T00:00:00Z')
/** Per installation. More pages than this means the paging went wrong. */
const MAX_PAGES = 20

export async function runZaptecSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
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
  let attemptId: string | null = null
  let thrown: unknown

  try {
    const attempt = await beginAttempt(SOURCE, { now: startedAt })
    // Another run holds the lease (also absorbs duplicate cron deliveries).
    if (!attempt.acquired) return run
    attemptId = attempt.attemptId

    let outcome: SyncOutcome
    try {
      await fetchAndImport(client, run, stats)
      run.outcome = 'ok'
      outcome = { ok: true, stats: runStats(run, stats) }
    } catch (error) {
      if (!(error instanceof ZaptecError)) throw error
      run.outcome = 'failed'
      run.code = error.code
      outcome = {
        ok: false,
        kind: 'failed',
        code: error.code,
        message: error.message,
        stats: runStats(run, stats),
      }
    }

    const recorded = await recordOutcome(SOURCE, outcome, {
      attemptId,
      trigger: opts.trigger,
      startedAt,
      now: now(),
      log,
    })
    run.transition = recorded.transition
    await alertAdmins(recorded.transition, recorded.health, log)
    return run
  } catch (error) {
    thrown = error
    run.outcome = 'error'
    run.code = 'internal_error'
    if (attemptId !== null) {
      // Best effort: the health snapshot should show the failure, but a
      // failure to record it must not mask the original error.
      try {
        const recorded = await recordOutcome(
          SOURCE,
          {
            ok: false,
            kind: 'error',
            code: 'internal_error',
            message: error instanceof Error ? error.message : String(error),
            stats: runStats(run, stats),
          },
          { attemptId, trigger: opts.trigger, startedAt, now: now(), log },
        )
        run.transition = recorded.transition
        await alertAdmins(recorded.transition, recorded.health, log)
      } catch (recordError) {
        log.warn('integration sync outcome could not be recorded', {
          source: SOURCE,
          error: recordError,
        })
      }
    }
    throw error
  } finally {
    run.durationMs = Math.max(0, now().getTime() - startedAt.getTime())
    run.authMs = stats.authMs
    run.fetchMs = stats.fetchMs
    run.importMs = Math.round(run.importMs)
    const fields = {
      source: run.source,
      trigger: run.trigger,
      outcome: run.outcome,
      code: run.code,
      transition: run.transition,
      since: run.since,
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

// Chargers → sessions per installation, one charging-service transaction per
// page. Mutates `run` as it goes, so a failure part-way still reports what
// landed (earlier pages stay imported; only the watermark waits for success).
async function fetchAndImport(
  client: ZaptecClient,
  run: SyncRun,
  stats: ZaptecCallStats,
): Promise<void> {
  const chargers = await client.chargers({ stats })
  run.chargers = chargers.length
  await upsertChargers(chargers)

  const lastSuccessStartedAt = await getLastSuccessStartedAt(SOURCE)
  const since = lastSuccessStartedAt
    ? new Date(lastSuccessStartedAt.getTime() - LOOKBACK_MS)
    : FIRST_RUN_SINCE
  run.since = since

  const installationIds = [...new Set(chargers.map((c) => c.installationId))]
  for (const installationId of installationIds) {
    let pages = 0
    for await (const page of client.sessionsEndedSince(since, {
      installationId,
      until: run.startedAt,
      stats,
    })) {
      pages++
      if (pages > MAX_PAGES) {
        throw new ZaptecError('unexpected_response', 'sessions', undefined, {
          message: `Zaptec sessions exceeded ${MAX_PAGES} pages for one installation`,
        })
      }
      run.pages++
      run.sessionsSeen += page.length
      const importStart = performance.now()
      const result = await importSessions(page, { installationId })
      run.importMs += performance.now() - importStart
      run.upserted += result.upserted
      run.voided += result.voided
      run.skipped += result.skipped
    }
  }
}

function runStats(run: SyncRun, stats: ZaptecCallStats): RunStats {
  return {
    since: run.since,
    pages: run.pages,
    sessionsSeen: run.sessionsSeen,
    upserted: run.upserted,
    voided: run.voided,
    timings: {
      authMs: stats.authMs,
      fetchMs: stats.fetchMs,
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

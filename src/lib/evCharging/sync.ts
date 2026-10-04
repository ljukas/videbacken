import { millisecondsInDay, millisecondsInHour } from 'date-fns/constants'
import {
  newCallStats,
  type ZaptecCallStats,
  type ZaptecClient,
  ZaptecError,
  type ZaptecOp,
  zaptec,
} from '~/lib/effects/zaptec'
import type { deriveFrom } from '~/lib/houseEnergy/derive'
import { deriveAfterSync } from '~/lib/houseEnergy/deriveAfterSync'
import type { SyncTrigger } from '~/lib/integrationHealth'
import { type RunBase, runPulledSync, withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import * as evChargingService from '~/lib/services/evCharging'
import { getLastSuccessStartedAt, type RunStats } from '~/lib/services/integrationSync'
import { stockholmDayOf } from '~/lib/time/stockholm'

/**
 * The Zaptec sync run — the domain orchestrator both the hourly cron route and
 * the admin `syncNow` procedure call (ADR-0001 amendment, ADR-0019). Runs the
 * Zaptec fetch + session import inside the shared pulled-integration lifecycle
 * (`runPulledSync`: lease, outcome, alert email, one `integration sync run`
 * log line).
 *
 * `syncedUntil` is the end of the last fetch window that fully imported — the
 * next watermark; before `startedAt` when a backfill ran out of budget (or
 * failed) part-way.
 */
export type SyncRun = RunBase & {
  source: 'zaptec'
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
  /** Time spent re-deriving vehicle attribution after the import. */
  reattributeMs: number
  /** Sessions whose attribution the post-import re-match changed; 0 when skipped or failed. */
  reattributeChanged: number
  /**
   * Stockholm day of the earliest session start this run added or changed
   * (old or new start), across every page: where the energy-mix re-derive
   * starts (ADR-0023); null if none.
   */
  deriveFromDay: string | null
  /** Time spent queuing and re-deriving the energy mix; 0 when nothing changed. */
  deriveMs: number
}

const SOURCE = 'zaptec'
/** Re-fetch window before the last success, to catch late/offline sessions. */
const LOOKBACK_MS = 7 * millisecondsInDay
const FIRST_RUN_SINCE = new Date('2020-01-01T00:00:00Z')
// Session fetch windows (ADR-0019): oldest first, each finished window moves
// the watermark, and one that overflows `MAX_PAGES` is halved and retried.
/** Longest window. Must exceed `LOOKBACK_MS`, so a window ends past the previous watermark. */
const WINDOW_MS = 90 * millisecondsInDay
/** Shortest window; one this short that still overflows fails the run. */
const MIN_WINDOW_MS = millisecondsInHour
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
  deps?: { zaptec?: ZaptecClient; log?: Logger; deriveFrom?: typeof deriveFrom }
}): Promise<SyncRun> {
  const client = opts.deps?.zaptec ?? zaptec
  const stats = newCallStats()
  return runPulledSync<SyncRun>({
    source: SOURCE,
    trigger: opts.trigger,
    now: opts.now ?? (() => new Date()),
    deadlineMs: opts.deadlineMs ?? RUN_DEADLINE_MS,
    log: opts.deps?.log ?? logger,
    init: (base) => ({
      ...base,
      // Already set in `base`; restated to narrow the type to 'zaptec'.
      source: SOURCE,
      authMs: 0,
      fetchMs: 0,
      importMs: 0,
      pages: 0,
      chargers: 0,
      sessionsSeen: 0,
      upserted: 0,
      voided: 0,
      skipped: 0,
      reattributeMs: 0,
      reattributeChanged: 0,
      deriveFromDay: null,
      deriveMs: 0,
    }),
    execute: async ({ run, signal, now, log }) => {
      try {
        await fetchAndImport(client, run, stats, signal, now)
        await reattribute(run, signal, log)
      } finally {
        // ADR-0023: re-derive the energy mix from the earliest session this run
        // added or changed — also when the import failed part-way: a stored
        // change is never detected as changed again. Best effort, own budget.
        run.deriveMs = await deriveAfterSync({
          source: SOURCE,
          fromDay: run.deriveFromDay,
          log,
          derive: opts.deps?.deriveFrom,
        })
      }
    },
    toRunStats: (run) => runStats(run, stats),
    finalize: (run) => {
      run.authMs = Math.round(stats.authMs)
      run.fetchMs = Math.round(stats.fetchMs)
      run.importMs = Math.round(run.importMs)
      run.skipped += stats.rejected
    },
    logFields: (run) => ({
      authMs: run.authMs,
      fetchMs: run.fetchMs,
      importMs: run.importMs,
      pages: run.pages,
      chargers: run.chargers,
      sessionsSeen: run.sessionsSeen,
      upserted: run.upserted,
      voided: run.voided,
      skipped: run.skipped,
      reattributeMs: run.reattributeMs,
      reattributeChanged: run.reattributeChanged,
      deriveFromDay: run.deriveFromDay,
      deriveMs: run.deriveMs,
    }),
  })
}

// Attribution follows the import (ADR-0021). Health tracks Zaptec, not
// attribution, so a failure here is a warning, never a failed run.
async function reattribute(run: SyncRun, signal: AbortSignal, log: Logger): Promise<void> {
  const started = performance.now()
  try {
    if (signal.aborted) {
      log.warn('zaptec sync: vehicle re-match skipped, run deadline reached')
    } else {
      // Raced against the run deadline so a stalled re-match cannot hold the
      // run past its lease. withDeadline doesn't cancel the SQL (idempotent,
      // row-guarded; the next sync re-derives). A plain Error: it is only warned.
      const result = await withDeadline(
        evChargingService.reattributeSessions(),
        signal,
        () => new Error('vehicle re-match did not finish within the sync deadline'),
      )
      run.reattributeChanged = result.changed
    }
  } catch (error) {
    log.warn('zaptec sync: vehicle re-match failed', { error })
  } finally {
    run.reattributeMs = Math.round(performance.now() - started)
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
  const chargers = await withDeadline(
    client.chargers({ stats, signal }),
    signal,
    deadlineError('chargers'),
  )
  run.chargers = chargers.length
  await evChargingService.upsertChargers(chargers)

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
      const next = await withDeadline(iterator.next(), signal, deadlineError('sessions'))
      if (next.done) break
      const page = next.value
      pages++
      if (pages > MAX_PAGES) throw new PageCapExceeded()
      run.pages++
      run.sessionsSeen += page.length
      const importStart = performance.now()
      const result = await evChargingService.importSessions(page, { installationId })
      run.importMs += performance.now() - importStart
      run.upserted += result.upserted
      run.voided += result.voided
      run.skipped += result.skipped
      if (result.earliestChangedStartAt) {
        const day = stockholmDayOf(result.earliestChangedStartAt.getTime())
        if (run.deriveFromDay === null || day < run.deriveFromDay) run.deriveFromDay = day
      }
    }
  } finally {
    // Not awaited: a generator stuck past the deadline would never settle.
    iterator.return?.()?.catch(() => {})
  }
}

/** What a Zaptec call raced past the run deadline rejects with. */
function deadlineError(op: ZaptecOp): () => ZaptecError {
  return () =>
    new ZaptecError('unreachable', op, undefined, {
      cause: { name: 'TimeoutError' },
      message: `Zaptec ${op} did not finish within the sync deadline`,
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
      reattributeMs: run.reattributeMs,
      deriveMs: run.deriveMs,
      requests: stats.requests,
      retries: stats.retries,
    },
  }
}

import {
  type EmaldoCallStats,
  type EmaldoClient,
  EmaldoError,
  emaldo,
  newCallStats,
} from '~/lib/effects/emaldo'
import type { SyncTrigger } from '~/lib/integrationHealth'
import { type RunBase, runPulledSync, withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import { earliestCountedStartAt } from '~/lib/services/evCharging'
import { HouseEnergyDomainError, replaceDay } from '~/lib/services/houseEnergy'
import { getLastSuccessStartedAt } from '~/lib/services/integrationSync'
import { addDays, daysBetween, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'
import type { deriveFrom } from './derive'
import { deriveAfterSync } from './deriveAfterSync'

// Server-only (db, effects). Never import it from client code — and keep
// `src/lib/houseEnergy/` free of an index barrel, so the client-safe modules
// that step 3 adds beside it stay importable on their own.

/**
 * The Emaldo sync run (ADR-0019, ADR-0023), inside the shared `runPulledSync`
 * lifecycle: fetch yesterday and today, then backfill older days oldest first,
 * storing each answered Stockholm day whole. No reading ever reaches a log
 * line, an error message or a run row — only counts.
 *
 * Watermark (`run.syncedUntil` → `integration_sync.last_success_started_at`):
 * the end of the last fully stored day, a Stockholm midnight. Today is still
 * filling, so it never moves it.
 */
export type EmaldoSyncRun = RunBase & {
  source: 'emaldo'
  /** Days Emaldo answered (recent + backfill). */
  daysFetched: number
  /** Readings written (replaced days only). */
  bucketsStored: number
  /** Buckets the client dropped: partial series, outside the day, today's filling one. */
  droppedBuckets: number
  /** Stored buckets without a battery SoC (missing or out of range in Emaldo's series). */
  bucketsWithoutSoc: number
  /** Answered days without readings; what's stored is kept. */
  emptyDays: number
  /** Old days whose readings failed validation; skipped and warned. */
  rejectedDays: number
  /**
   * Summed time of every request, the five parallel series included: busy
   * time, not wall-clock latency (that is `durationMs`).
   */
  fetchMs: number
  storeMs: number
  requests: number
  /** Request retries inside the client's shared `fetchWithRetry`. */
  retries: number
  logins: number
  /** Backfill days still missing after this run. */
  backfillDaysLeft: number
  /** Earliest Stockholm day this run replaced: where the energy-mix re-derive starts. */
  earliestReplacedDay: string | null
  /** Time spent queuing and re-deriving the energy mix (ADR-0023). */
  deriveMs: number
}

const SOURCE = 'emaldo'
/** The battery pool needs a week of history before the first session it prices (spec). */
const BACKFILL_LEAD_DAYS = 7
/** Backfill days per run; ≈ 260 days in prod spread over ≈ 9 hourly runs. */
const BACKFILL_DAYS_PER_RUN = 30
/** No new backfill day starts once the run is this old; the next run continues. */
const DAY_BUDGET_MS = 120_000
/** Pause between backfill days: five requests each to an unofficial API. */
const BACKFILL_PAUSE_MS = 1_000
/**
 * Same 240 s budget as Zaptec and elpris: well under Vercel's 300 s limit, and
 * room for a ≈ 21 s shared login + discovery on top of the 120 s day budget.
 */
const RUN_DEADLINE_MS = 240_000

export type EmaldoDayPlan = {
  today: string
  yesterday: string
  /** The first day not yet fully stored; its start is the watermark floor. */
  start: string
  /** Days in [start, yesterday), oldest first, capped. */
  backfill: string[]
  /** Backfill days beyond the cap. */
  backfillLeft: number
}

/**
 * Pure: which days a run fetches besides yesterday and today. The backfill
 * starts at the later of the watermark's day and 7 days before the first
 * counted session (with neither, at yesterday: nothing to backfill). Sessions
 * imported later that start before an existing watermark are not backfilled.
 */
export function planEmaldoDays(a: {
  today: string
  watermarkDay: string | null
  firstSessionDay: string | null
  max: number
}): EmaldoDayPlan {
  const yesterday = addDays(a.today, -1)
  const lead = a.firstSessionDay ? addDays(a.firstSessionDay, -BACKFILL_LEAD_DAYS) : null
  const candidates = [a.watermarkDay, lead].filter((d): d is string => d !== null)
  let start = candidates.length > 0 ? candidates.reduce((x, y) => (x > y ? x : y)) : yesterday
  if (start > a.today) start = a.today
  const total = Math.max(0, daysBetween(start, yesterday))
  const count = Math.min(total, a.max)
  return {
    today: a.today,
    yesterday,
    start,
    backfill: Array.from({ length: count }, (_, i) => addDays(start, i)),
    backfillLeft: total - count,
  }
}

export async function runEmaldoSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
  /** Overrides the 240 s deadline (tests). */
  deadlineMs?: number
  deps?: {
    emaldo?: EmaldoClient
    log?: Logger
    sleep?: (ms: number) => Promise<void>
    deriveFrom?: typeof deriveFrom
  }
}): Promise<EmaldoSyncRun> {
  const client = opts.deps?.emaldo ?? emaldo
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const stats = newCallStats()
  return runPulledSync<EmaldoSyncRun>({
    source: SOURCE,
    trigger: opts.trigger,
    now: opts.now ?? (() => new Date()),
    deadlineMs: opts.deadlineMs ?? RUN_DEADLINE_MS,
    log: opts.deps?.log ?? logger,
    init: (base) => ({
      ...base,
      // Already set in `base`; restated to narrow the type to 'emaldo'.
      source: SOURCE,
      daysFetched: 0,
      bucketsStored: 0,
      droppedBuckets: 0,
      bucketsWithoutSoc: 0,
      emptyDays: 0,
      rejectedDays: 0,
      fetchMs: 0,
      storeMs: 0,
      requests: 0,
      retries: 0,
      logins: 0,
      backfillDaysLeft: 0,
      earliestReplacedDay: null,
      deriveMs: 0,
    }),
    execute: async ({ run, signal, now, log }) => {
      try {
        await syncDays(client, run, stats, { signal, now, sleep, log })
      } finally {
        // ADR-0023: new readings change the house mix and the pool from the
        // earliest replaced day on — also when the run then fails part-way.
        run.deriveMs = await deriveAfterSync({
          source: SOURCE,
          signal,
          fromDay: run.earliestReplacedDay,
          log,
          derive: opts.deps?.deriveFrom,
        })
      }
    },
    toRunStats: (run) => ({
      since: run.since,
      // Zaptec-era column names: pages = days fetched, sessionsSeen/upserted = readings stored.
      pages: run.daysFetched,
      sessionsSeen: run.bucketsStored,
      upserted: run.bucketsStored,
      voided: 0,
      timings: {
        fetchMs: Math.round(stats.fetchMs),
        storeMs: Math.round(run.storeMs),
        requests: stats.requests,
        retries: stats.retries,
        logins: stats.logins,
        daysFetched: run.daysFetched,
        droppedBuckets: run.droppedBuckets,
        bucketsWithoutSoc: run.bucketsWithoutSoc,
        emptyDays: run.emptyDays,
        rejectedDays: run.rejectedDays,
        backfillDaysLeft: run.backfillDaysLeft,
        deriveMs: run.deriveMs,
      },
    }),
    finalize: (run) => {
      run.fetchMs = Math.round(stats.fetchMs)
      run.storeMs = Math.round(run.storeMs)
      run.requests = stats.requests
      run.retries = stats.retries
      run.logins = stats.logins
    },
    logFields: (run) => ({
      fetchMs: run.fetchMs,
      storeMs: run.storeMs,
      requests: run.requests,
      retries: run.retries,
      logins: run.logins,
      daysFetched: run.daysFetched,
      bucketsStored: run.bucketsStored,
      droppedBuckets: run.droppedBuckets,
      bucketsWithoutSoc: run.bucketsWithoutSoc,
      emptyDays: run.emptyDays,
      rejectedDays: run.rejectedDays,
      backfillDaysLeft: run.backfillDaysLeft,
      earliestReplacedDay: run.earliestReplacedDay,
      deriveMs: run.deriveMs,
    }),
  })
}

type Ctx = {
  signal: AbortSignal
  now: () => Date
  sleep: (ms: number) => Promise<void>
  log: Logger
}

const startOf = (day: string) => new Date(stockholmDayBounds(day).startMs)
const endOf = (day: string) => new Date(stockholmDayBounds(day).endMs)

// Recent days first (they matter most, and a long backfill must never starve
// them), then the backfill oldest first. Mutates `run` as it goes, so a
// failure part-way still reports — and keeps — what landed.
async function syncDays(
  client: EmaldoClient,
  run: EmaldoSyncRun,
  stats: EmaldoCallStats,
  ctx: Ctx,
): Promise<void> {
  const { now, sleep } = ctx
  const today = stockholmDayOf(now().getTime())
  const watermark = await getLastSuccessStartedAt(SOURCE)
  const earliest = await earliestCountedStartAt()
  const plan = planEmaldoDays({
    today,
    watermarkDay: watermark ? stockholmDayOf(watermark.getTime()) : null,
    firstSessionDay: earliest ? stockholmDayOf(earliest.getTime()) : null,
    max: BACKFILL_DAYS_PER_RUN,
  })
  run.backfillDaysLeft = plan.backfill.length + plan.backfillLeft
  run.since = startOf(plan.backfill[0] ?? plan.yesterday)
  const sync = (day: string) => syncDay(client, run, stats, ctx, { day, today })

  // Only yesterday must land: it is the day the watermark waits on. Today is
  // still filling (and is yesterday tomorrow); an old day without usable
  // readings is skipped so it can't wedge the backfill.
  const yesterday = await sync(plan.yesterday)
  // The watermark floor: the plan's start is never before the stored
  // watermark, and every day before it is stored or before the lead. Set only
  // once Emaldo has answered, so a run that never got an answer (not
  // configured, auth) plants no watermark.
  run.syncedUntil = startOf(plan.start)
  await sync(plan.today)

  for (const [i, day] of plan.backfill.entries()) {
    if (now().getTime() - run.startedAt.getTime() >= DAY_BUDGET_MS) break
    if (i > 0) await sleep(BACKFILL_PAUSE_MS)
    await sync(day)
    run.backfillDaysLeft--
    run.syncedUntil = endOf(day)
  }
  // Caught up, and yesterday is complete: the watermark moves past it.
  if (run.backfillDaysLeft === 0 && yesterday.stored) {
    const end = endOf(plan.yesterday)
    if (run.syncedUntil === null || end > run.syncedUntil) run.syncedUntil = end
  }
  // After today and the backfill, so their progress still lands. An old empty
  // day is normal (before the battery existed); an empty or invalid yesterday
  // means data is missing. The watermark holds at its start, and the next run
  // retries it. Bad data from Emaldo is Emaldo's failure (`failed`, not `error`).
  if (!yesterday.stored) {
    const { invalid } = yesterday
    throw new EmaldoError(
      'unexpected_response',
      'stats',
      undefined,
      invalid
        ? {
            cause: invalid,
            // The domain message names bucket indexes and fields, never values.
            message: `Emaldo readings for ${plan.yesterday} failed validation: ${invalid.message}`,
          }
        : { message: `Emaldo returned no readings for ${plan.yesterday}` },
    )
  }
}

type DayResult = { stored: true } | { stored: false; invalid: HouseEnergyDomainError | null }

// Fetches and stores one Stockholm day. An empty answer, or readings that fail
// validation, store nothing and keep what's stored; the caller decides whether
// that fails the run.
async function syncDay(
  client: EmaldoClient,
  run: EmaldoSyncRun,
  stats: EmaldoCallStats,
  ctx: Ctx,
  a: { day: string; today: string },
): Promise<DayResult> {
  const { signal, log } = ctx
  const offset = daysBetween(a.today, a.day)
  const fetched = await withDeadline(
    client.fetchDay(offset, { signal, stats }),
    signal,
    () =>
      new EmaldoError('unreachable', 'stats', undefined, {
        cause: { name: 'TimeoutError' },
        message: 'Emaldo stats did not finish within the sync deadline',
      }),
  )
  run.daysFetched++
  run.droppedBuckets += fetched.droppedBuckets
  const { startMs, endMs } = stockholmDayBounds(a.day)
  if (fetched.dayStart.getTime() !== startMs || fetched.dayEnd.getTime() !== endMs) {
    // Our "today" and Emaldo's disagree (a run straddling midnight), or the
    // client's bounds are off. Storing it would file readings under the wrong day.
    throw new EmaldoError('unexpected_response', 'stats', undefined, {
      message: `Emaldo answered offset ${offset} with another day than ${a.day}`,
    })
  }
  // An empty answer never deletes what's stored.
  if (fetched.buckets.length === 0) {
    run.emptyDays++
    return { stored: false, invalid: null }
  }
  const started = performance.now()
  try {
    run.bucketsStored += await replaceDay(
      { dayStart: fetched.dayStart, dayEnd: fetched.dayEnd },
      fetched.buckets,
    )
  } catch (error) {
    if (!(error instanceof HouseEnergyDomainError)) throw error
    run.rejectedDays++
    // The domain message names bucket indexes and fields, never values.
    log.warn('emaldo day rejected', { day: a.day, error })
    return { stored: false, invalid: error }
  } finally {
    run.storeMs += performance.now() - started
  }
  run.bucketsWithoutSoc += fetched.buckets.filter((b) => b.batterySocPct === null).length
  if (run.earliestReplacedDay === null || a.day < run.earliestReplacedDay) {
    run.earliestReplacedDay = a.day
  }
  return { stored: true }
}

import {
  type ElprisCallStats,
  type ElprisClient,
  ElprisError,
  elpris,
  newCallStats,
} from '~/lib/effects/elpris'
import type { SyncTrigger } from '~/lib/integrationHealth'
import { type RunBase, runPulledSync, withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import { earliestCountedStartAt } from '~/lib/services/evCharging'
import { daysWithSlots, replaceDay } from '~/lib/services/spotPrice'
import { addDays, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'
import { SPOT_ZONE } from './zones'

/**
 * The elpris sync run (ADR-0019), inside the shared `runPulledSync`
 * lifecycle: fetch every missing Stockholm day of SE3 spot prices — from the
 * first counted charging session through tomorrow — and store each whole.
 *
 * No watermark: the plan is "the days not stored yet", computed from the table
 * itself, so gaps self-heal and a stored (complete, validated) day is never
 * re-fetched.
 */
export type ElprisSyncRun = RunBase & {
  source: 'elpris'
  fetchMs: number
  importMs: number
  /** Missing days planned for this run (newest first, capped). */
  days: number
  /** Days fetched and stored. */
  daysFetched: number
  /** Future days not published yet (tomorrow before ~13:00) — normal. */
  notPublished: number
  /** Older days the API has no prices for; retried next run. */
  gaps: number
  /** Slots written. */
  upserted: number
  requests: number
  retries: number
}

/** Oldest day ever planned, whatever the session history says. */
const FLOOR_DAY = '2022-11-01'
/** Days per run; a first backfill (~250 days) spreads over a few runs. */
const MAX_DAYS_PER_RUN = 120
/** No new day starts once the run is this old; the next run continues. */
const DAY_BUDGET_MS = 120_000
/** Pause between requests when backfilling, to be polite to a free API. */
const BACKFILL_PAUSE_MS = 150
/** Same 240 s budget as Zaptec: well under Vercel's 300 s function limit. */
const RUN_DEADLINE_MS = 240_000

/**
 * Pure: the missing days in `[first, tomorrow]`, newest first (recent prices
 * matter most, and an old permanent gap can never starve them), capped.
 */
export function planDays(a: {
  today: string
  first: string
  have: ReadonlySet<string>
  max: number
}): string[] {
  const out: string[] = []
  const floor = a.first < FLOOR_DAY ? FLOOR_DAY : a.first
  for (let day = addDays(a.today, 1); day >= floor && out.length < a.max; day = addDays(day, -1)) {
    if (!a.have.has(day)) out.push(day)
  }
  return out
}

export async function runElprisSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
  /** Overrides the 240 s deadline (tests). */
  deadlineMs?: number
  deps?: { elpris?: ElprisClient; log?: Logger; sleep?: (ms: number) => Promise<void> }
}): Promise<ElprisSyncRun> {
  const client = opts.deps?.elpris ?? elpris
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const stats = newCallStats()
  return runPulledSync<ElprisSyncRun>({
    source: 'elpris',
    trigger: opts.trigger,
    now: opts.now ?? (() => new Date()),
    deadlineMs: opts.deadlineMs ?? RUN_DEADLINE_MS,
    log: opts.deps?.log ?? logger,
    init: (base) => ({
      ...base,
      // Already set in `base`; restated to narrow the type to 'elpris'.
      source: 'elpris',
      fetchMs: 0,
      importMs: 0,
      days: 0,
      daysFetched: 0,
      notPublished: 0,
      gaps: 0,
      upserted: 0,
      requests: 0,
      retries: 0,
    }),
    execute: ({ run, signal, now }) => fetchMissingDays(client, run, stats, signal, now, sleep),
    toRunStats: (run) => ({
      since: run.since,
      pages: stats.requests,
      sessionsSeen: run.daysFetched,
      upserted: run.upserted,
      voided: 0,
      timings: {
        fetchMs: Math.round(stats.fetchMs),
        importMs: Math.round(run.importMs),
        requests: stats.requests,
        retries: stats.retries,
        days: run.days,
        notPublished: run.notPublished,
        gaps: run.gaps,
      },
    }),
    finalize: (run) => {
      run.fetchMs = Math.round(stats.fetchMs)
      run.importMs = Math.round(run.importMs)
      run.requests = stats.requests
      run.retries = stats.retries
    },
    logFields: (run) => ({
      fetchMs: run.fetchMs,
      importMs: run.importMs,
      days: run.days,
      daysFetched: run.daysFetched,
      notPublished: run.notPublished,
      gaps: run.gaps,
      upserted: run.upserted,
      requests: run.requests,
      retries: run.retries,
    }),
  })
}

// Newest missing day first, one request and one stored day at a time. Mutates
// `run` as it goes, so a failure part-way still reports what landed. A missing
// today/yesterday fails the run — but only after the loop, so the rest of the
// backfill still lands and the health snapshot shows "missing spot prices".
async function fetchMissingDays(
  client: ElprisClient,
  run: ElprisSyncRun,
  stats: ElprisCallStats,
  signal: AbortSignal,
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const today = stockholmDayOf(now().getTime())
  const yesterday = addDays(today, -1)
  const tomorrow = addDays(today, 1)
  const earliest = await earliestCountedStartAt()
  const first = earliest ? stockholmDayOf(earliest.getTime()) : today
  const have = await daysWithSlots(SPOT_ZONE, first < FLOOR_DAY ? FLOOR_DAY : first, tomorrow)
  const planned = planDays({ today, first, have, max: MAX_DAYS_PER_RUN })
  run.days = planned.length
  if (planned.length > 0)
    run.since = new Date(stockholmDayBounds(planned[planned.length - 1]).startMs)

  const missingRecent: string[] = []
  for (const [i, day] of planned.entries()) {
    // Always at least one day per run, so a run can never make no progress.
    if (i > 0 && now().getTime() - run.startedAt.getTime() >= DAY_BUDGET_MS) break
    if (i > 0 && planned.length > 5) await sleep(BACKFILL_PAUSE_MS)
    const slots = await withDeadline(
      client.dayPrices(day, SPOT_ZONE, { signal, stats }),
      signal,
      () =>
        new ElprisError('unreachable', 'prices', undefined, {
          cause: { name: 'TimeoutError' },
          message: 'elpris prices did not finish within the sync deadline',
        }),
    )
    if (slots === null) {
      if (day > today) run.notPublished++
      else if (day >= yesterday) missingRecent.push(day)
      else run.gaps++
      continue
    }
    const importStart = performance.now()
    const { written } = await replaceDay(SPOT_ZONE, day, slots)
    run.importMs += performance.now() - importStart
    run.daysFetched++
    run.upserted += written
  }

  if (missingRecent.length > 0) {
    throw new ElprisError('unexpected_response', 'prices', 404, {
      message: `No spot prices published for ${missingRecent.join(', ')}`,
    })
  }
}

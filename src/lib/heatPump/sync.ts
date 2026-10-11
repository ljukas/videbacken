import {
  type ComfortCloudCallStats,
  type ComfortCloudClient,
  type ComfortCloudDay,
  ComfortCloudError,
  comfortCloud,
  newCallStats,
} from '~/lib/effects/comfortCloud'
import type { SyncTrigger } from '~/lib/integrationHealth'
import { type RunBase, runPulledSync, withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import {
  type HeatPump,
  HeatPumpDomainError,
  markHistoryComplete,
  newestHour,
  oldestDay,
  replaceDay,
  setBackfillCursor,
  setRegisteredOn,
  upsertUnits,
} from '~/lib/services/heatPump'
import { getLastSuccessStartedAt } from '~/lib/services/integrationSync'
import { utcDayOf } from '~/lib/time/utc'

// Server-only (db, effects). Never import it from client code — and keep
// `src/lib/heatPump/` free of an index barrel, so the client-safe modules that
// steps 4a/4b add beside it stay importable on their own.

/**
 * The Comfort Cloud sync run (ADR-0019, ADR-0027), inside the shared
 * `runPulledSync` lifecycle: list the units, re-fetch every unit's recent UTC
 * days, then backfill each unit newest first until its `registered_on`. No
 * reading ever reaches a log line, an error message or a run row — only counts;
 * units are named, never identified by guid.
 */
export type ComfortCloudSyncRun = RunBase & {
  source: 'comfortCloud'
  /** Air conditioners Comfort Cloud listed. */
  units: number
  /** Day answers (`dayHours`), recent + backfill. */
  daysFetched: number
  /** Month answers (`monthDays`): one per backfilled month, gap months included. */
  monthsFetched: number
  /** Hourly readings written (replaced days only). */
  hoursStored: number
  /** Day answers without hours; what's stored is kept. */
  emptyDays: number
  /** Days whose hours failed validation (INVALID_READING); skipped and warned. */
  rejectedDays: number
  /** Units whose backfill reached registered_on in this run. */
  unitsCompleted: number
  /** Estimate: calendar days between registered_on and each incomplete unit's walk. */
  backfillDaysLeft: number
  /** Summed request time from the client's stats sink (busy time, not latency: that is `durationMs`). */
  fetchMs: number
  storeMs: number
  requests: number
  /** Request retries inside the client's shared `fetchWithRetry`. */
  retries: number
  logins: number
}

const SOURCE = 'comfortCloud'
/** Today and the two previous UTC days: the current hour fills in, the last days settle. */
const RECENT_DAYS = 3
/** After an outage the recent window reaches back to the last success's day, at most this far. */
const CATCH_UP_MAX_DAYS = 14
/** Backfill day calls per unit a run; ≈ 700 days each spread over ≈ 6 runs. */
const BACKFILL_DAYS_PER_UNIT = 60
/** No new backfill call once the run is this old; the next run continues. */
const DAY_BUDGET_MS = 120_000
/** Pause between backfill day calls: an unofficial API, on the owner's own account. */
const BACKFILL_PAUSE_MS = 500
/** Same 240 s as the other pulled sources: under Vercel's 300 s, room for the login. */
const RUN_DEADLINE_MS = 240_000
/**
 * A unit quiet yesterday fails the run while its newest stored hour is at most
 * this old; longer without data (a removed or long-dead unit) it only warns.
 */
const OFFLINE_ALERT_MS = 14 * 86_400_000

const DAY_MS = 86_400_000
const addUtcDays = (day: string, n: number) => utcDayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
const utcDaysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
const utcStart = (day: string) => new Date(`${day}T00:00:00Z`)

/**
 * Pure: the UTC days a run re-fetches for every unit, oldest first. Today and
 * the two days before; after an outage, back to the day the last successful
 * run started (the days since then may never have landed), at most 14 days.
 * `skipped` counts the days the cap left out (a hole the backfill won't fill).
 */
export function recentDays(
  today: string,
  lastSuccessStartedAt: Date | null,
): { days: string[]; skipped: number } {
  let from = addUtcDays(today, -(RECENT_DAYS - 1))
  let skipped = 0
  if (lastSuccessStartedAt) {
    const resume = utcDayOf(lastSuccessStartedAt.getTime())
    if (resume < from) {
      const floor = addUtcDays(today, -(CATCH_UP_MAX_DAYS - 1))
      if (resume < floor) {
        skipped = utcDaysBetween(resume, floor)
        from = floor
      } else {
        from = resume
      }
    }
  }
  return {
    days: Array.from({ length: utcDaysBetween(from, today) + 1 }, (_, i) => addUtcDays(from, i)),
    skipped,
  }
}

/** Pure: the listed days with data in [registeredOn, from], newest first. */
export function backfillCandidates(
  rows: readonly ComfortCloudDay[],
  a: { from: string; registeredOn: string },
): string[] {
  return [...new Set(rows.map((r) => r.day))]
    .filter((day) => day <= a.from && day >= a.registeredOn)
    .sort()
    .reverse()
}

export async function runComfortCloudSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
  /** Overrides the 240 s deadline (tests). */
  deadlineMs?: number
  deps?: {
    comfortCloud?: ComfortCloudClient
    log?: Logger
    sleep?: (ms: number) => Promise<void>
  }
}): Promise<ComfortCloudSyncRun> {
  const client = opts.deps?.comfortCloud ?? comfortCloud
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const stats = newCallStats()
  return runPulledSync<ComfortCloudSyncRun>({
    source: SOURCE,
    trigger: opts.trigger,
    now: opts.now ?? (() => new Date()),
    deadlineMs: opts.deadlineMs ?? RUN_DEADLINE_MS,
    log: opts.deps?.log ?? logger,
    init: (base) => ({
      ...base,
      // Already set in `base`; restated to narrow the type to 'comfortCloud'.
      source: SOURCE,
      units: 0,
      daysFetched: 0,
      monthsFetched: 0,
      hoursStored: 0,
      emptyDays: 0,
      rejectedDays: 0,
      unitsCompleted: 0,
      backfillDaysLeft: 0,
      fetchMs: 0,
      storeMs: 0,
      requests: 0,
      retries: 0,
      logins: 0,
    }),
    execute: ({ run, signal, now, log, reportProgress }) =>
      syncUnits(client, run, { signal, stats, now, sleep, log, reportProgress }),
    // Sees `run` before `finalize`: the call stats come from the sink directly.
    toRunStats: (run) => ({
      since: run.since,
      // Zaptec-era column names: pages = days fetched, sessionsSeen/upserted = hours stored.
      pages: run.daysFetched,
      sessionsSeen: run.hoursStored,
      upserted: run.hoursStored,
      voided: 0,
      timings: {
        fetchMs: Math.round(stats.fetchMs),
        requests: stats.requests,
        retries: stats.retries,
        logins: stats.logins,
        storeMs: Math.round(run.storeMs),
        units: run.units,
        daysFetched: run.daysFetched,
        monthsFetched: run.monthsFetched,
        emptyDays: run.emptyDays,
        rejectedDays: run.rejectedDays,
        unitsCompleted: run.unitsCompleted,
        backfillDaysLeft: run.backfillDaysLeft,
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
      units: run.units,
      daysFetched: run.daysFetched,
      monthsFetched: run.monthsFetched,
      hoursStored: run.hoursStored,
      emptyDays: run.emptyDays,
      rejectedDays: run.rejectedDays,
      unitsCompleted: run.unitsCompleted,
      backfillDaysLeft: run.backfillDaysLeft,
      fetchMs: run.fetchMs,
      storeMs: run.storeMs,
      requests: run.requests,
      retries: run.retries,
      logins: run.logins,
    }),
  })
}

type Ctx = {
  signal: AbortSignal
  stats: ComfortCloudCallStats
  now: () => Date
  sleep: (ms: number) => Promise<void>
  log: Logger
  reportProgress: (done: number, total: number) => Promise<void>
}

type Unit = {
  id: string
  guid: string
  name: string
  registeredOn: string | null
  complete: boolean
  /** The persisted walk position (`backfill_cursor`), or null. */
  backfillCursor: string | null
}

type Progress = { step: () => Promise<void>; shrink: (unused: number) => Promise<void> }

const toUnit = (row: HeatPump): Unit => ({
  id: row.id,
  guid: row.guid,
  name: row.name,
  registeredOn: row.registeredOn,
  complete: row.historyCompleteAt !== null,
  backfillCursor: row.backfillCursor,
})

// Recent days first, for every unit (they matter most, and a long backfill
// must never starve them), then each unit's backfill. Mutates `run` as it goes,
// so a failure part-way still reports — and keeps — what landed.
async function syncUnits(
  client: ComfortCloudClient,
  run: ComfortCloudSyncRun,
  ctx: Ctx,
): Promise<void> {
  const today = utcDayOf(ctx.now().getTime())
  const yesterday = addUtcDays(today, -1)

  const listed = await call(ctx, 'units', (o) => client.units(o))
  if (listed.length === 0) {
    // An empty list from a changed API must not read as a green sync.
    throw new ComfortCloudError('unexpected_response', 'units', undefined, {
      message: 'Comfort Cloud listed no air conditioners on the account',
    })
  }
  const rows = await upsertUnits(
    listed.map(({ guid, name, model }) => ({ guid, name, model })),
    ctx.now(),
  )
  const units = rows.map(toUnit).sort((a, b) => a.name.localeCompare(b.name, 'sv'))
  run.units = units.length

  const recent = recentDays(today, await getLastSuccessStartedAt(SOURCE))
  if (recent.skipped > 0) {
    ctx.log.warn('comfort cloud catch-up capped', { skippedDays: recent.skipped })
  }
  // The earliest day this run fetched: the recent window's first, lowered by the backfill.
  let sinceDay = recent.days[0]
  run.since = utcStart(sinceDay)
  const lowerSince = (day: string) => {
    if (day < sinceDay) {
      sinceDay = day
      run.since = utcStart(day)
    }
  }
  const initiallyIncomplete = units.filter((u) => !u.complete).length
  const progress = newProgress(
    ctx.reportProgress,
    units.length * recent.days.length + initiallyIncomplete * BACKFILL_DAYS_PER_UNIT,
  )

  // Units that answered no hours for yesterday, the newest complete UTC day (a
  // unit registered after yesterday has no yesterday to miss), and units whose
  // yesterday failed validation.
  const quiet: Unit[] = []
  const rejected: Unit[] = []
  for (const unit of units) {
    for (const day of recent.days) {
      const answer = await syncDay(client, run, ctx, unit, day)
      if (day === yesterday) {
        if (answer.rejected) rejected.push(unit)
        else if (
          answer.hours === 0 &&
          unit.registeredOn !== null &&
          unit.registeredOn <= yesterday
        ) {
          quiet.push(unit)
        }
      }
      await progress.step()
    }
  }

  // A registered_on that moved earlier reopened a complete unit (setRegisteredOn
  // cleared history_complete_at): it is backfilled in this run too.
  const backfilling = units.filter((u) => !u.complete)
  if (backfilling.length > initiallyIncomplete) {
    await progress.shrink(-(backfilling.length - initiallyIncomplete) * BACKFILL_DAYS_PER_UNIT)
  }
  // A unit whose yesterday was quiet or rejected waits: walking its history now
  // would pass over (and persist the cursor past) days a changed API or an outage
  // answers badly. It resumes on the first run with a healthy yesterday.
  const held = new Set([...quiet, ...rejected])
  for (const unit of backfilling) {
    if (held.has(unit)) {
      await progress.shrink(BACKFILL_DAYS_PER_UNIT)
      run.backfillDaysLeft += daysLeft(unit, await walkStart(unit, today))
      continue
    }
    await backfillUnit(client, run, ctx, unit, { today, progress, lowerSince })
  }

  // After the backfill, so its progress still lands. Comfort Cloud returns past
  // hours reliably, so a quiet yesterday means the unit (or its Wi-Fi adapter)
  // is offline: the run fails — Comfort Cloud's failure (`failed`), not ours —
  // every run until data returns, so an outage never reads as "recovered". A
  // unit without data for over 14 days (removed, or long dead) only warns, so it
  // stops alerting after two weeks. A rejected yesterday fails the run too, with
  // no 14-day rule (a rejection is a fresh answer, not silence): a change on
  // Panasonic's side (a unit, a range) must fail the source closed, not pile up
  // as rejected days under a green tile (ADR-0027). Older rejected days only warn.
  const offline: string[] = []
  for (const unit of quiet) {
    const newest = await newestHour(unit.id)
    const sinceMs = newest ? ctx.now().getTime() - newest.getTime() : Number.POSITIVE_INFINITY
    if (sinceMs <= OFFLINE_ALERT_MS) {
      offline.push(unit.name)
    } else {
      ctx.log.warn('comfort cloud unit without data', {
        unit: unit.name,
        daysWithoutData: newest ? Math.floor(sinceMs / DAY_MS) : null,
      })
    }
  }
  const problems: string[] = []
  if (offline.length > 0) {
    problems.push(
      `Comfort Cloud returned no hours for ${yesterday} (UTC) for ${offline.join(' and ')}: the unit or its Wi-Fi adapter may be offline`,
    )
  }
  if (rejected.length > 0) {
    // Names and the day only: never a value.
    problems.push(
      `Comfort Cloud hours for ${yesterday} (UTC) failed validation for ${rejected.map((u) => u.name).join(' and ')}`,
    )
  }
  if (problems.length > 0) {
    throw new ComfortCloudError('unexpected_response', 'history', undefined, {
      message: problems.join('; '),
    })
  }
}

// Where the unit's walk starts: the lower of the day before its oldest stored
// day (with none, the day before the recent window) and the persisted cursor.
async function walkStart(unit: Unit, today: string): Promise<string> {
  const oldest = await oldestDay(unit.id)
  const belowStored = oldest ? addUtcDays(oldest, -1) : addUtcDays(today, -RECENT_DAYS)
  // 'YYYY-MM-DD' strings compare as days.
  return unit.backfillCursor !== null && unit.backfillCursor < belowStored
    ? unit.backfillCursor
    : belowStored
}

// Estimate: calendar days from registered_on up to the walk's position.
const daysLeft = (unit: Unit, cursor: string) =>
  unit.registeredOn === null ? 0 : Math.max(0, utcDaysBetween(unit.registeredOn, cursor) + 1)

// Walks one unit's history newest first, from the lower of the day before its
// oldest stored day and the persisted walk position (`backfill_cursor`). The
// month call says which days have data, so empty days and whole empty months
// cost no day call. A walk that stops short (budget, cap, error) persists where
// it stopped, so a listed day that answered no hours or was rejected is passed
// over for good: a long such stretch can't wedge the walk run after run. Done
// once the walk passes the day before registered_on.
async function backfillUnit(
  client: ComfortCloudClient,
  run: ComfortCloudSyncRun,
  ctx: Ctx,
  unit: Unit,
  a: { today: string; progress: Progress; lowerSince: (day: string) => void },
): Promise<void> {
  const { progress } = a
  let cursor = await walkStart(unit, a.today)
  let fetched = 0
  let completed = false
  const outOfBudget = () => ctx.now().getTime() - run.startedAt.getTime() >= DAY_BUDGET_MS
  // Returns when the walk completes or stops short (cap, budget); throws on a failed call.
  const walk = async (): Promise<void> => {
    for (;;) {
      if (unit.registeredOn !== null && cursor < addUtcDays(unit.registeredOn, -1)) {
        await markHistoryComplete(unit.id, ctx.now())
        run.unitsCompleted++
        completed = true
        await progress.shrink(BACKFILL_DAYS_PER_UNIT - fetched)
        return
      }
      if (fetched >= BACKFILL_DAYS_PER_UNIT || outOfBudget()) return
      const month = cursor.slice(0, 7)
      const listedDays = await call(ctx, 'history', (o) => client.monthDays(unit.guid, month, o))
      run.monthsFetched++
      await noteRegisteredOn(unit, listedDays.registeredOn)
      // One day below registered_on: Comfort Cloud's register day may be a local
      // (Stockholm) date, so the unit's first UTC hours can fall on the day before.
      const floor = addUtcDays(unit.registeredOn ?? listedDays.registeredOn, -1)
      for (const day of backfillCandidates(listedDays.rows, {
        from: cursor,
        registeredOn: floor,
      })) {
        if (fetched >= BACKFILL_DAYS_PER_UNIT || outOfBudget()) return
        if (fetched > 0) await ctx.sleep(BACKFILL_PAUSE_MS)
        await syncDay(client, run, ctx, unit, day)
        fetched++
        cursor = addUtcDays(day, -1)
        a.lowerSince(day)
        await progress.step()
      }
      // The month is done: continue with the last day of the month before.
      cursor = addUtcDays(`${month}-01`, -1)
    }
  }

  let walkFailure: { error: unknown } | null = null
  try {
    await walk()
  } catch (error) {
    walkFailure = { error }
  }
  if (!completed) {
    run.backfillDaysLeft += daysLeft(unit, cursor)
    if (cursor !== unit.backfillCursor) {
      try {
        await setBackfillCursor(unit.id, cursor)
        unit.backfillCursor = cursor
      } catch (persistError) {
        // Never mask the walk's own error: it is the run's outcome.
        if (walkFailure === null) throw persistError
        ctx.log.warn('comfort cloud backfill cursor not saved', {
          unit: unit.name,
          error: persistError,
        })
      }
    }
  }
  if (walkFailure !== null) throw walkFailure.error
}

// Fetches and stores one UTC day for one unit; returns how many hours Comfort
// Cloud answered and whether they failed validation. An empty answer, or hours
// that fail validation, store nothing and keep what's stored.
async function syncDay(
  client: ComfortCloudClient,
  run: ComfortCloudSyncRun,
  ctx: Ctx,
  unit: Unit,
  day: string,
): Promise<{ hours: number; rejected: boolean }> {
  const answer = await call(ctx, 'history', (o) => client.dayHours(unit.guid, day, o))
  run.daysFetched++
  await noteRegisteredOn(unit, answer.registeredOn)
  // An empty answer never deletes what's stored.
  if (answer.rows.length === 0) {
    run.emptyDays++
    return { hours: 0, rejected: false }
  }
  const started = performance.now()
  try {
    run.hoursStored += (await replaceDay(unit.id, day, answer.rows)).stored
  } catch (error) {
    if (!(error instanceof HeatPumpDomainError) || error.code !== 'INVALID_READING') throw error
    run.rejectedDays++
    // The code and the day only: the domain message could name a value.
    ctx.log.warn('comfort cloud day rejected', { unit: unit.name, day, code: error.code })
    return { hours: answer.rows.length, rejected: true }
  } finally {
    run.storeMs += performance.now() - started
  }
  return { hours: answer.rows.length, rejected: false }
}

// Every history answer carries the unit's first data day; store it when it
// changes. setRegisteredOn clears history_complete_at when the day moves
// earlier (step 1a); mirror that so the unit is backfilled in this run.
async function noteRegisteredOn(unit: Unit, registeredOn: string): Promise<void> {
  if (unit.registeredOn === registeredOn) return
  const reopens = unit.complete && unit.registeredOn !== null && registeredOn < unit.registeredOn
  await setRegisteredOn(unit.id, registeredOn)
  unit.registeredOn = registeredOn
  if (reopens) unit.complete = false
}

// One remote call with the run's signal and stats sink, also raced against the
// deadline (a client that ignores the signal still can't outlive the run).
function call<T>(
  ctx: Ctx,
  op: 'units' | 'history',
  fn: (o: { signal: AbortSignal; stats: ComfortCloudCallStats }) => Promise<T>,
): Promise<T> {
  return withDeadline(
    fn({ signal: ctx.signal, stats: ctx.stats }),
    ctx.signal,
    () =>
      new ComfortCloudError('unreachable', op, undefined, {
        cause: { name: 'TimeoutError' },
        message: `Comfort Cloud ${op} did not finish within the sync deadline`,
      }),
  )
}

// Days done / days planned for the Datakällor tile. The plan counts 60 backfill
// days per incomplete unit (a reopened unit adds its 60: a negative shrink); a
// unit that completes early gives the rest back, so a finished run ends at
// done === total. A budget stop leaves it below.
function newProgress(report: Ctx['reportProgress'], initialTotal: number): Progress {
  let done = 0
  let total = initialTotal
  return {
    step: () => report(++done, total),
    shrink: (unused) => {
      total -= unused
      return report(done, total)
    },
  }
}

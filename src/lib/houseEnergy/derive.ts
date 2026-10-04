// Server-only. Derives the energy mix (ADR-0023, spec "Derivation" 5): from
// Stockholm `day` — widened back to the start day of any counted session
// overlapping it — runs the battery pool forward from the previous day's
// checkpoint to the last reading, then rewrites the mix rows of every counted
// session ending after the window's start and the pool checkpoints from it on.
// One transaction under the derive lock (energyMix.withDeriveLock): reads and
// writes alike, so a concurrent derive never writes older data over newer.
import { SlotIndex } from '~/lib/evCharging/cost'
import type { Logger } from '~/lib/logger'
import type { DeriveTx, MixRow } from '~/lib/services/energyMix'
import * as energyMixService from '~/lib/services/energyMix'
import type { SessionEnergy } from '~/lib/services/evCharging'
import * as evChargingService from '~/lib/services/evCharging'
import type { HouseReading } from '~/lib/services/houseEnergy'
import * as houseEnergyService from '~/lib/services/houseEnergy'
import * as spotPriceService from '~/lib/services/spotPrice'
import { SPOT_ZONE } from '~/lib/spotPrice/zones'
import { addDays, isStockholmDay, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'
import { type BucketHouse, deriveSessionMix } from './mix/carMix'
import { runHouseTimeline } from './mix/houseTimeline'
import { BATTERY_CAPACITY_KWH, emptyPool, type PoolState } from './mix/pool'
import { BASELINE_BUCKETS, BUCKET_MS, shapeSession } from './mix/shape'

/** Bound on widening the start back across chained sessions that span midnight. */
const MAX_WIDEN_STEPS = 10

/**
 * The derive math's version. Bump it with any change to what a derive
 * computes (shaping, supply split, pool, car mix): every checkpoint then
 * differs, so the next derive rebuilds all history by itself (ADR-0023).
 */
export const DERIVE_VERSION = 1

/** What this code's checkpoints are computed with. */
const POOL_PARAMS = { capacityKwh: BATTERY_CAPACITY_KWH, deriveVersion: DERIVE_VERSION }

/** `fromDay`: the day the derive actually started (null: no house readings). */
export type DeriveResult = {
  fromDay: string | null
  days: number
  sessions: number
  deriveMs: number
}

/**
 * A session longer than this is a glitch (a charger clock reset, a bogus
 * start): spreading it would build millions of buckets. It is skipped and
 * stays all-grid.
 */
const MAX_SESSION_MS = 31 * 24 * 3_600_000
/** A mix slot this large would fail the table's CHECK and with it the whole derive. */
const MAX_SLOT_KWH = 1000

/** A queued request this old means derives keep failing: worth a warning. */
const STALE_REQUEST_MIN = 180

type DeriveStats = {
  fromDay: string | null
  /** Widening hit MAX_WIDEN_STEPS with a session still starting before `fromDay`. */
  widenExhausted: boolean
  /** Sessions too long or too large to derive (glitches); they keep no mix rows. */
  skippedSessions: number
  /** Requests taken off the queue, and how long the oldest waited (wall clock). */
  queuedRequests: number
  queuedForMin: number | null
  days: number
  sessions: number
  rows: number
  readings: number
  readMs: number
  computeMs: number
  writeMs: number
}

/**
 * Re-derives the energy mix from Stockholm `day` (a RangeError for a malformed
 * one), or from an earlier queued request's day (`requestDerive`): it takes
 * the whole queue, so a request left by a failed derive is covered here. With
 * no house readings at all it does nothing. Logs one line with counts and
 * timings only — never readings or mix values.
 */
export async function deriveFrom(
  day: string,
  opts: { log: Logger; now?: () => Date },
): Promise<DeriveResult> {
  if (!isStockholmDay(day)) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  const started = performance.now()
  // Read inside the lock: a derive that waited across midnight uses the new day.
  const stats = await energyMixService.withDeriveLock((tx) =>
    deriveLocked(day, opts.now ?? (() => new Date()), tx),
  )
  const deriveMs = Math.round(performance.now() - started)
  if (stats.queuedForMin !== null && stats.queuedForMin > STALE_REQUEST_MIN) {
    // An earlier derive failed and none succeeded since (ADR-0023).
    opts.log.warn('energy mix derive request was stale', {
      requestedDay: day,
      queuedRequests: stats.queuedRequests,
      queuedForMin: stats.queuedForMin,
    })
  }
  if (stats.skippedSessions > 0) {
    // Counts only: which sessions is a query away (no mix rows, counted).
    opts.log.warn('energy mix derive skipped glitched sessions', {
      requestedDay: day,
      skippedSessions: stats.skippedSessions,
    })
  }
  if (stats.widenExhausted) {
    // A chain of sessions spanning midnight longer than MAX_WIDEN_STEPS: the
    // earliest of them is derived without its first part (counts only).
    opts.log.warn('energy mix derive window starts inside a session', { requestedDay: day })
  }
  if (stats.fromDay === null) {
    opts.log.debug('energy mix derive skipped: no house readings', { requestedDay: day })
  } else {
    opts.log.info('energy mix derived', { requestedDay: day, ...stats, deriveMs })
  }
  return { fromDay: stats.fromDay, days: stats.days, sessions: stats.sessions, deriveMs }
}

async function deriveLocked(day: string, clock: () => Date, tx: DeriveTx): Promise<DeriveStats> {
  const t0 = performance.now()
  const now = clock()
  const today = stockholmDayOf(now.getTime())
  const queued = await energyMixService.takeDeriveRequests(tx)
  const earliest = queued !== null && queued.fromDay < day ? queued.fromDay : day
  // Nothing after today has readings to derive; a later day (tomorrow's
  // prices, a typo) would otherwise find no checkpoint and rebuild history.
  const requested = earliest > today ? today : earliest
  const queue = {
    queuedRequests: queued?.count ?? 0,
    queuedForMin:
      queued === null
        ? null
        : Math.round((Date.now() - queued.oldestRequestedAt.getTime()) / 60_000),
  }
  const first = await houseEnergyService.firstReadingAt(tx)
  if (!first) {
    return {
      ...queue,
      fromDay: null,
      widenExhausted: false,
      skippedSessions: 0,
      days: 0,
      sessions: 0,
      rows: 0,
      readings: 0,
      readMs: 0,
      computeMs: 0,
      writeMs: 0,
    }
  }

  // One day before the requested one: D−1's checkpoint may have been written
  // before D's first reading existed, so its last bucket went uncapped (the
  // SoC cap needs the next reading). Re-deriving D−1 makes a resume equal a
  // full derive.
  // Nothing before the first reading has house data, so no window starts
  // earlier than the day before it: a session with a bogus start (epoch 0, a
  // charger clock reset) can't drag the window back decades or into days the
  // calendar helpers refuse.
  const floorDay = addDays(stockholmDayOf(first.getTime()), -1)
  let { from: fromDay, exhausted: widenExhausted } = await widenToSessions(
    maxDay(addDays(requested, -1), floorDay),
    floorDay,
    tx,
  )
  let start: PoolState = emptyPool()
  const checkpoint = await houseEnergyService.getPoolDay(addDays(fromDay, -1), tx)
  if (
    checkpoint &&
    checkpoint.capacityKwh === POOL_PARAMS.capacityKwh &&
    checkpoint.deriveVersion === POOL_PARAMS.deriveVersion
  ) {
    start = checkpoint.state
  } else if (first.getTime() < stockholmDayBounds(fromDay).startMs) {
    // History exists before `fromDay` but no usable checkpoint (none yet, or
    // computed with another C or derive version): rebuild from the first
    // reading, empty pool.
    ;({ from: fromDay, exhausted: widenExhausted } = await widenToSessions(
      stockholmDayOf(first.getTime()),
      floorDay,
      tx,
    ))
  }

  const fromMs = stockholmDayBounds(fromDay).startMs
  const toMs = Math.max(fromMs, stockholmDayBounds(today).endMs)
  // From 30 min before the window: the shaping baseline of a session starting at its midnight.
  const readings = await houseEnergyService.listReadings(
    { from: new Date(fromMs - BASELINE_BUCKETS * BUCKET_MS), to: new Date(toMs) },
    tx,
  )
  const slots = new SlotIndex(
    await spotPriceService.listSlotsOverlapping(SPOT_ZONE, [{ startMs: fromMs, endMs: toMs }], tx),
  )
  const sessions = await evChargingService.listSessionEnergy({ endsAfter: new Date(fromMs) }, tx)
  const t1 = performance.now()

  const { days, house } = runHouseTimeline({
    readings,
    fromDay,
    throughDay: today,
    start,
    spotAt: (ms) => slots.between(ms, ms + 1)[0]?.sekPerKwh ?? null,
    capacityKwh: BATTERY_CAPACITY_KWH,
  })
  let skippedSessions = 0
  const rows = sessions.flatMap((s) => {
    const sessionMix = sessionRows(s, readings, house)
    if (sessionMix === null) skippedSessions++
    return sessionMix ?? []
  })
  const t2 = performance.now()

  await energyMixService.replaceForSessions(
    sessions.map((s) => s.sessionId),
    rows,
    tx,
  )
  await energyMixService.pruneUncounted(tx)
  await houseEnergyService.replacePoolDaysFrom(fromDay, days, POOL_PARAMS, tx)
  const t3 = performance.now()

  return {
    ...queue,
    fromDay,
    widenExhausted,
    days: days.length,
    sessions: sessions.length,
    skippedSessions,
    rows: rows.length,
    readings: readings.length,
    readMs: Math.round(t1 - t0),
    computeMs: Math.round(t2 - t1),
    writeMs: Math.round(t3 - t2),
  }
}

/**
 * `day`, moved back to the start day of the earliest counted session that
 * ends after its midnight — repeatedly, since that session's own day may be
 * overlapped by an even earlier one. Every rewritten session then lies wholly
 * inside the window the pool runs over.
 */
async function widenToSessions(
  day: string,
  floorDay: string,
  tx: DeriveTx,
): Promise<{ from: string; exhausted: boolean }> {
  let from = day
  for (let step = 0; step <= MAX_WIDEN_STEPS; step++) {
    const fromMs = stockholmDayBounds(from).startMs
    const earliest = await evChargingService.earliestCountedStartEndingAfter(new Date(fromMs), tx)
    if (!earliest || earliest.getTime() >= fromMs) return { from, exhausted: false }
    // A session starting before the floor has no house data there anyway.
    if (from <= floorDay) return { from, exhausted: false }
    if (step === MAX_WIDEN_STEPS) break
    from = maxDay(stockholmDayOf(earliest.getTime()), floorDay)
  }
  return { from, exhausted: true }
}

const maxDay = (a: string, b: string) => (a > b ? a : b)

/**
 * The session's mix rows, or null for a glitched session (longer than
 * MAX_SESSION_MS, or a slot the table would refuse): it gets no rows, stays
 * all-grid, and never blocks the derive of the others.
 */
function sessionRows(
  s: SessionEnergy,
  readings: readonly HouseReading[],
  house: ReadonlyMap<number, BucketHouse>,
): MixRow[] | null {
  const startMs = Math.min(s.startAt.getTime(), ...s.stretches.map((x) => x.startMs))
  const endMs = Math.max(startMs, ...s.stretches.map((x) => x.endMs))
  if (!(endMs - startMs <= MAX_SESSION_MS)) return null
  const window = between(readings, startMs - (BASELINE_BUCKETS + 1) * BUCKET_MS, endMs)
  const car = shapeSession({
    startMs: s.startAt.getTime(),
    stretches: s.stretches,
    readings: window,
  })
  const slots = deriveSessionMix(car, house)
  if (slots.some((slot) => !(slot.kwh < MAX_SLOT_KWH))) return null
  return slots.map((slot) => ({ ...slot, sessionId: s.sessionId }))
}

/** Readings with bucketStart in [fromMs, toMs); `readings` ascending (listReadings' order). */
function between(readings: readonly HouseReading[], fromMs: number, toMs: number): HouseReading[] {
  return readings.slice(lowerBound(readings, fromMs), lowerBound(readings, toMs))
}

function lowerBound(readings: readonly HouseReading[], ms: number): number {
  let lo = 0
  let hi = readings.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (readings[mid].bucketStart.getTime() < ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

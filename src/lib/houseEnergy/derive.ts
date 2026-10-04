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

export type DeriveResult = { days: number; sessions: number; deriveMs: number }

/** A queued request this old means derives keep failing: worth a warning. */
const STALE_REQUEST_MIN = 180

type DeriveStats = {
  fromDay: string | null
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
  const now = (opts.now ?? (() => new Date()))()
  const stats = await energyMixService.withDeriveLock((tx) => deriveLocked(day, now, tx))
  const deriveMs = Math.round(performance.now() - started)
  if (stats.queuedForMin !== null && stats.queuedForMin > STALE_REQUEST_MIN) {
    // An earlier derive failed and none succeeded since (ADR-0023).
    opts.log.warn('energy mix derive request was stale', {
      requestedDay: day,
      queuedRequests: stats.queuedRequests,
      queuedForMin: stats.queuedForMin,
    })
  }
  if (stats.fromDay === null) {
    opts.log.debug('energy mix derive skipped: no house readings', { requestedDay: day })
  } else {
    opts.log.info('energy mix derived', { requestedDay: day, ...stats, deriveMs })
  }
  return { days: stats.days, sessions: stats.sessions, deriveMs }
}

async function deriveLocked(day: string, now: Date, tx: DeriveTx): Promise<DeriveStats> {
  const t0 = performance.now()
  const queued = await energyMixService.takeDeriveRequests(tx)
  const requested = queued !== null && queued.fromDay < day ? queued.fromDay : day
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
      days: 0,
      sessions: 0,
      rows: 0,
      readings: 0,
      readMs: 0,
      computeMs: 0,
      writeMs: 0,
    }
  }

  let fromDay = await widenToSessions(requested, tx)
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
    fromDay = await widenToSessions(stockholmDayOf(first.getTime()), tx)
  }

  const today = stockholmDayOf(now.getTime())
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
  const rows = sessions.flatMap((s) => sessionRows(s, readings, house))
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
    days: days.length,
    sessions: sessions.length,
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
async function widenToSessions(day: string, tx: DeriveTx): Promise<string> {
  let from = day
  for (let step = 0; step < MAX_WIDEN_STEPS; step++) {
    const fromMs = stockholmDayBounds(from).startMs
    const earliest = await evChargingService.earliestCountedStartEndingAfter(new Date(fromMs), tx)
    if (!earliest || earliest.getTime() >= fromMs) break
    from = stockholmDayOf(earliest.getTime())
  }
  return from
}

function sessionRows(
  s: SessionEnergy,
  readings: readonly HouseReading[],
  house: ReadonlyMap<number, BucketHouse>,
): MixRow[] {
  const startMs = s.startAt.getTime()
  const endMs = Math.max(startMs, ...s.stretches.map((x) => x.endMs))
  const window = between(readings, startMs - (BASELINE_BUCKETS + 1) * BUCKET_MS, endMs)
  const car = shapeSession({ startMs, stretches: s.stretches, readings: window })
  return deriveSessionMix(car, house).map((slot) => ({ ...slot, sessionId: s.sessionId }))
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

import {
  avgOre,
  type CostTotals,
  type EnergyInterval,
  emptyTotals,
  isComplete,
  mergeTotals,
  PRICING_VERSION,
  priceIntervals,
  SlotIndex,
} from '~/lib/evCharging/cost'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import { listSessionEnergy, type SessionEnergy } from '~/lib/services/evCharging'
import { firstReadingAt } from '~/lib/services/houseEnergy'
import type { SessionGeneration } from '~/lib/services/sessionCost'
import * as sessionCostService from '~/lib/services/sessionCost'
import { listSlotsOverlapping } from '~/lib/services/spotPrice'
import { SPOT_ZONE } from '~/lib/spotPrice/zones'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { loadMix, loadTariffs, timed, toIntervals } from './costInputs'

// Server-only. The cost read model (spec "PR D"): the one place that combines
// session energy, spot slots and tariff periods — each loaded through its own
// service — and runs the pure cost math over them. Kept apart from the kWh
// overview so a price/tariff problem can never blank the energy figures.
// Since ADR-0023 it prices each session's stored solar/battery mix (cash
// cost); a session without one stays all-grid, labelled as without house data.
// Since 2026-10-11 (ADR-0020 amendment) the priced totals are stored per
// session and Stockholm month (services/sessionCost): the reads sum the
// current ones and price only the stale ones here, writing them back.

/** A priced total plus what the UI needs to present it honestly. */
export type CostSummary = CostTotals & {
  /** Cash öre/kWh incl VAT per charged kWh whose cost is known (own solar at 0 kr); null when nothing bought is priced. */
  avgOre: number | null
  /** Every bought kWh is priced — otherwise the UI marks the figure partial. */
  complete: boolean
}

export type CostOverview = {
  year: number
  tiles: { thisMonth: CostSummary; thisYear: CostSummary; allTime: CostSummary }
  /** The selected year's 12 Stockholm months, zero-filled. */
  months: (CostSummary & { month: number })[]
  /**
   * The first 5-minute bucket of house data (Emaldo); solar and battery count
   * from here, earlier energy is all-grid (ADR-0023). Null before any reading.
   */
  houseDataFrom: Date | null
}

export type SessionCost = CostSummary & { sessionId: string; estimated: boolean }

/** Optional sub-timings sink (the procedure forwards it to `context.timings`). */
export type CostTimings = {
  /** The stored sums + stale ids (one statement). */
  storedMs?: number
  /** How many sessions in scope were stale and priced on read (a count, not ms). */
  staleSessions?: number
  energyMs?: number
  slotsMs?: number
  tariffMs?: number
  mixMs?: number
  houseFromMs?: number
  computeMs?: number
  writeBackMs?: number
}

export function summarize(t: CostTotals): CostSummary {
  return { ...t, avgOre: avgOre(t), complete: isComplete(t) }
}

// Loads the slots overlapping these sessions' energy — the stretches' own
// span (an interval-less session's one stretch already is its whole window),
// never the session's start/end, which could only over-fetch. It covers every
// mix piece too: a mix slot is a quarter-hour overlapping the stretches' span.
async function loadSlots(sessions: SessionEnergy[], timings?: CostTimings) {
  const ranges = sessions.map((s) => ({
    startMs: Math.min(...s.stretches.map((x) => x.startMs)),
    endMs: Math.max(...s.stretches.map((x) => x.endMs)),
  }))
  return new SlotIndex(
    await timed(timings, 'slotsMs', () => listSlotsOverlapping(SPOT_ZONE, ranges)),
  )
}

// The kWh overview buckets energy by each Zaptec interval's own start. A mix
// piece (one 15-min slot) follows the interval it starts in — or the first
// one, for the slot a session starts inside — so cost months match kWh months;
// an interval-less session's one stretch keeps it whole in its start month.
// `stretches` are ascending (listSessionEnergy orders them).
function bucketStartMs(pieceStartMs: number, stretches: readonly { startMs: number }[]): number {
  let owner = stretches[0]?.startMs ?? pieceStartMs
  for (const s of stretches) {
    if (s.startMs > pieceStartMs) break
    owner = s.startMs
  }
  return owner
}

/** One session's priced totals per Stockholm month (key: year * 100 + month). */
export type PricedSessionCost = {
  sessionId: string
  estimated: boolean
  months: Map<number, CostTotals>
}

/**
 * Prices counted sessions by id (uncounted or unknown ids are absent): each
 * piece in its owning stretch's Stockholm month (`bucketStartMs`), so cost
 * months match kWh months. Callers read the sessions' generations first.
 */
export async function priceSessions(
  sessionIds: readonly string[],
  timings?: CostTimings,
): Promise<PricedSessionCost[]> {
  if (sessionIds.length === 0) return []
  const [sessions, tariffsAsc] = await Promise.all([
    timed(timings, 'energyMs', () => listSessionEnergy({ sessionIds })),
    timed(timings, 'tariffMs', loadTariffs),
  ])
  if (sessions.length === 0) return []
  const [index, mixes] = await Promise.all([
    loadSlots(sessions, timings),
    loadMix(sessions, timings),
  ])
  const started = performance.now()
  const priced = sessions.map((s) => {
    const buckets = new Map<number, EnergyInterval[]>()
    for (const iv of toIntervals(s, mixes.get(s.sessionId))) {
      const { year, month } = stockholmYearMonth(bucketStartMs(iv.startMs, s.stretches))
      const key = year * 100 + month
      const list = buckets.get(key)
      if (list) list.push(iv)
      else buckets.set(key, [iv])
    }
    const months = new Map<number, CostTotals>()
    for (const [key, ivs] of buckets) months.set(key, priceIntervals(ivs, index, tariffsAsc))
    return { sessionId: s.sessionId, estimated: s.estimated, months }
  })
  if (timings) timings.computeMs = Math.round(performance.now() - started)
  return priced
}

/**
 * Stores priced sessions under the generations read before pricing them (see
 * `writePriced`). A session with a non-finite month total is left out (and
 * stays stale) with a warning, so one pricing bug can't fail every write-back;
 * the table's CHECK stays the backstop.
 */
export async function storePriced(
  stale: readonly SessionGeneration[],
  priced: readonly PricedSessionCost[],
  opts: { lockTimeoutMs?: number; log?: Logger } = {},
): Promise<{ written: number }> {
  const log = opts.log ?? logger
  const generation = new Map(stale.map((s) => [s.sessionId, s.generation]))
  const finite = (p: PricedSessionCost) =>
    [...p.months.values()].every((t) => Object.values(t).every(Number.isFinite))
  const notFinite = priced.filter((p) => !finite(p)).map((p) => p.sessionId)
  if (notFinite.length > 0) {
    log.warn('session costs: not stored, a month total is not finite', {
      sessionIds: notFinite,
    })
  }
  return sessionCostService.writePriced({
    pricingVersion: PRICING_VERSION,
    lockTimeoutMs: opts.lockTimeoutMs,
    sessions: priced
      .filter((p) => generation.has(p.sessionId) && finite(p))
      .map((p) => ({
        sessionId: p.sessionId,
        generation: generation.get(p.sessionId) ?? null,
        estimated: p.estimated,
        months: [...p.months].map(([key, totals]) => ({
          year: Math.floor(key / 100),
          month: key % 100,
          totals,
        })),
      })),
  })
}

/**
 * How long a read's write-back waits for a row lock: a derive can hold bumped
 * rows for seconds, and the reader already has its figures.
 */
const READ_WRITE_BACK_LOCK_TIMEOUT_MS = 200

// A read's write-back: best effort, the figures are already priced.
async function writeBack(
  stale: readonly SessionGeneration[],
  priced: readonly PricedSessionCost[],
  timings: CostTimings | undefined,
  log: Logger,
): Promise<void> {
  try {
    await timed(timings, 'writeBackMs', () =>
      storePriced(stale, priced, { lockTimeoutMs: READ_WRITE_BACK_LOCK_TIMEOUT_MS, log }),
    )
  } catch (error) {
    log.warn('session costs: write-back failed; figures priced on read', {
      sessions: priced.length,
      error,
    })
  }
}

function addTo(map: Map<number, CostTotals>, key: number, totals: CostTotals): void {
  const prev = map.get(key)
  map.set(key, prev ? mergeTotals(prev, totals) : totals)
}

/**
 * Cost per Stockholm month of `year`, plus this month / this year / all time.
 * Energy is bucketed by each stretch's own start (an overnight session splits
 * across months), exactly as the kWh overview buckets it.
 */
export async function getCostOverview(input: {
  year?: number
  now?: Date
  timings?: CostTimings
  vehicle?: VehicleScope
  /** Where a failed write-back is warned about (the request's logger). */
  log?: Logger
}): Promise<CostOverview> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const year = input.year ?? current.year

  const [stored, houseDataFrom] = await Promise.all([
    timed(input.timings, 'storedMs', () =>
      sessionCostService.readMonthSums({
        vehicle: input.vehicle,
        pricingVersion: PRICING_VERSION,
      }),
    ),
    timed(input.timings, 'houseFromMs', () => firstReadingAt()),
  ])
  if (input.timings) input.timings.staleSessions = stored.stale.length

  // year*100+month → that month's totals: the stored sums plus the stale
  // sessions priced now (and written back).
  const priced = new Map<number, CostTotals>()
  for (const m of stored.months) addTo(priced, m.year * 100 + m.month, m.totals)
  if (stored.stale.length > 0) {
    const fresh = await priceSessions(
      stored.stale.map((s) => s.sessionId),
      input.timings,
    )
    for (const p of fresh) for (const [key, totals] of p.months) addTo(priced, key, totals)
    await writeBack(stored.stale, fresh, input.timings, input.log ?? logger)
  }

  const monthTotals = (y: number, month: number) => priced.get(y * 100 + month) ?? emptyTotals()
  const yearTotals = (y: number) =>
    Array.from({ length: 12 }, (_, i) => monthTotals(y, i + 1)).reduce(mergeTotals, emptyTotals())
  const allTime = [...priced.values()].reduce(mergeTotals, emptyTotals())

  const overview: CostOverview = {
    year,
    tiles: {
      thisMonth: summarize(monthTotals(current.year, current.month)),
      thisYear: summarize(yearTotals(current.year)),
      allTime: summarize(allTime),
    },
    months: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      ...summarize(monthTotals(year, i + 1)),
    })),
    houseDataFrom,
  }
  return overview
}

/** Cost of specific sessions (the session list's current page). */
export async function getSessionCosts(input: {
  sessionIds: readonly string[]
  timings?: CostTimings
  /** Where a failed write-back is warned about (the request's logger). */
  log?: Logger
}): Promise<SessionCost[]> {
  if (input.sessionIds.length === 0) return []
  const stored = await timed(input.timings, 'storedMs', () =>
    sessionCostService.readSessionSums({
      sessionIds: input.sessionIds,
      pricingVersion: PRICING_VERSION,
    }),
  )
  if (input.timings) input.timings.staleSessions = stored.stale.length
  const costs: SessionCost[] = stored.current.map((s) => ({
    sessionId: s.sessionId,
    estimated: s.estimated,
    ...summarize(s.totals),
  }))
  if (stored.stale.length > 0) {
    const fresh = await priceSessions(
      stored.stale.map((s) => s.sessionId),
      input.timings,
    )
    for (const p of fresh) {
      costs.push({
        sessionId: p.sessionId,
        estimated: p.estimated,
        ...summarize([...p.months.values()].reduce(mergeTotals, emptyTotals())),
      })
    }
    await writeBack(stored.stale, fresh, input.timings, input.log ?? logger)
  }
  return costs
}

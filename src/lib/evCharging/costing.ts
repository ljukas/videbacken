import {
  avgOre,
  type CostTotals,
  type EnergyInterval,
  emptyTotals,
  isComplete,
  mergeTotals,
  priceIntervals,
  SlotIndex,
} from '~/lib/evCharging/cost'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { listSessionEnergy, type SessionEnergy } from '~/lib/services/evCharging'
import { firstReadingAt } from '~/lib/services/houseEnergy'
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
  energyMs?: number
  slotsMs?: number
  tariffMs?: number
  mixMs?: number
  houseFromMs?: number
  computeMs?: number
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
}): Promise<CostOverview> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const year = input.year ?? current.year

  // Tariffs and the house-data start don't depend on the sessions, so they load alongside them.
  const [sessions, tariffsAsc, houseDataFrom] = await Promise.all([
    timed(input.timings, 'energyMs', () =>
      listSessionEnergy({ all: true, vehicle: input.vehicle }),
    ),
    timed(input.timings, 'tariffMs', loadTariffs),
    timed(input.timings, 'houseFromMs', () => firstReadingAt()),
  ])
  const [index, mixes] = await Promise.all([
    loadSlots(sessions, input.timings),
    loadMix(sessions, input.timings),
  ])

  const costStart = performance.now()
  // year*100+month → that month's pieces (see `bucketStartMs`).
  const buckets = new Map<number, EnergyInterval[]>()
  for (const s of sessions) {
    for (const iv of toIntervals(s, mixes.get(s.sessionId))) {
      const { year: y, month } = stockholmYearMonth(bucketStartMs(iv.startMs, s.stretches))
      const key = y * 100 + month
      const list = buckets.get(key)
      if (list) list.push(iv)
      else buckets.set(key, [iv])
    }
  }
  const priced = new Map<number, CostTotals>()
  for (const [key, ivs] of buckets) priced.set(key, priceIntervals(ivs, index, tariffsAsc))

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
  if (input.timings) input.timings.computeMs = Math.round(performance.now() - costStart)
  return overview
}

/** Cost of specific sessions (the session list's current page). */
export async function getSessionCosts(input: {
  sessionIds: readonly string[]
  timings?: CostTimings
}): Promise<SessionCost[]> {
  if (input.sessionIds.length === 0) return []
  const [sessions, tariffsAsc] = await Promise.all([
    timed(input.timings, 'energyMs', () => listSessionEnergy({ sessionIds: input.sessionIds })),
    timed(input.timings, 'tariffMs', loadTariffs),
  ])
  if (sessions.length === 0) return []
  const [index, mixes] = await Promise.all([
    loadSlots(sessions, input.timings),
    loadMix(sessions, input.timings),
  ])
  const costStart = performance.now()
  const costs = sessions.map((s) => ({
    sessionId: s.sessionId,
    estimated: s.estimated,
    ...summarize(priceIntervals(toIntervals(s, mixes.get(s.sessionId)), index, tariffsAsc)),
  }))
  if (input.timings) input.timings.computeMs = Math.round(performance.now() - costStart)
  return costs
}

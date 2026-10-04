import {
  avgOre,
  type CostTotals,
  emptyTotals,
  isComplete,
  mergeTotals,
  priceIntervals,
  SlotIndex,
} from '~/lib/evCharging/cost'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { listSessionEnergy, type SessionEnergy } from '~/lib/services/evCharging'
import { listSlotsOverlapping } from '~/lib/services/spotPrice'
import { SPOT_ZONE } from '~/lib/spotPrice/zones'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { loadTariffs, timed, toIntervals } from './costInputs'

// Server-only. The cost read model (spec "PR D"): the one place that combines
// session energy, spot slots and tariff periods — each loaded through its own
// service — and runs the pure cost math over them. Kept apart from the kWh
// overview so a price/tariff problem can never blank the energy figures.

/** A priced total plus what the UI needs to present it honestly. */
export type CostSummary = CostTotals & {
  /** Average öre/kWh incl VAT over the priced energy; null when nothing is priced. */
  avgOre: number | null
  /** Every grid kWh is priced — otherwise the UI marks the figure partial. */
  complete: boolean
}

export type CostOverview = {
  year: number
  tiles: { thisMonth: CostSummary; thisYear: CostSummary; allTime: CostSummary }
  /** The selected year's 12 Stockholm months, zero-filled. */
  months: (CostSummary & { month: number })[]
}

export type SessionCost = CostSummary & { sessionId: string; estimated: boolean }

/** Optional sub-timings sink (the procedure forwards it to `context.timings`). */
export type CostTimings = {
  energyMs?: number
  slotsMs?: number
  tariffMs?: number
  computeMs?: number
}

function summarize(t: CostTotals): CostSummary {
  return { ...t, avgOre: avgOre(t), complete: isComplete(t) }
}

// Loads the slots overlapping these sessions' energy — the stretches' own
// span (an interval-less session's one stretch already is its whole window),
// never the session's start/end, which could only over-fetch.
async function loadSlots(sessions: SessionEnergy[], timings?: CostTimings) {
  const ranges = sessions.map((s) => ({
    startMs: Math.min(...s.stretches.map((x) => x.startMs)),
    endMs: Math.max(...s.stretches.map((x) => x.endMs)),
  }))
  return new SlotIndex(
    await timed(timings, 'slotsMs', () => listSlotsOverlapping(SPOT_ZONE, ranges)),
  )
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

  // Tariffs don't depend on the sessions, so they load alongside them.
  const [sessions, tariffsAsc] = await Promise.all([
    timed(input.timings, 'energyMs', () =>
      listSessionEnergy({ all: true, vehicle: input.vehicle }),
    ),
    timed(input.timings, 'tariffMs', loadTariffs),
  ])
  const index = await loadSlots(sessions, input.timings)

  const costStart = performance.now()
  // year*100+month → that month's intervals.
  const buckets = Map.groupBy(
    sessions.flatMap((s) => toIntervals(s)),
    (iv) => {
      const { year: y, month } = stockholmYearMonth(iv.startMs)
      return y * 100 + month
    },
  )
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
  const index = await loadSlots(sessions, input.timings)
  const costStart = performance.now()
  const costs = sessions.map((s) => ({
    sessionId: s.sessionId,
    estimated: s.estimated,
    ...summarize(priceIntervals(toIntervals(s), index, tariffsAsc)),
  }))
  if (input.timings) input.timings.computeMs = Math.round(performance.now() - costStart)
  return costs
}

import { millisecondsInHour } from 'date-fns/constants'
import { priceIntervals, SlotIndex, tariffAt, unitPrice } from '~/lib/evCharging/cost'
import {
  analyzeSession,
  averageSpotOre,
  type EconomySession,
  type EconomyStretch,
  type EconomyTotals,
  type EconomyWindow,
  economyWindow,
  type SessionEconomy,
  sumEconomy,
} from '~/lib/evCharging/economy'
import { sessionPeakKw } from '~/lib/evCharging/patterns'
import type { Vehicle, VehicleScope, VehicleSource } from '~/lib/evCharging/vehicle'
import {
  distinctCountedYears,
  getSessionEnergy,
  listSessionEnergy,
  type SessionEnergy,
} from '~/lib/services/evCharging'
import { dailyAverageSpot, listSlotsOverlapping } from '~/lib/services/spotPrice'
import { SPOT_ZONE } from '~/lib/spotPrice/zones'
import { stockholmDayOf, stockholmYearMonth } from '~/lib/time/stockholm'
import { loadMix, loadTariffs, timed, toIntervals } from './costInputs'
import { type CostSummary, summarize } from './costing'

// Server-only. The charging-economy read model (Phase 4, ADR-0020
// "Counterfactuals"): session energy, the spot slots of each plug-in window,
// per-day average spot and tariff periods — each through its own service —
// run through the pure counterfactual math. Spot timing only: the
// counterfactuals treat every kWh as grid-bought (ADR-0023 decision 8). A
// session's detail also carries its cash cost (the stored solar/battery mix),
// the page's hero.

export type EconomyTimings = {
  energyMs?: number
  tariffMs?: number
  slotsMs?: number
  dailySpotMs?: number
  yearsMs?: number
  mixMs?: number
  computeMs?: number
}

export type EconomySessionRow = SessionEconomy & {
  sessionId: string
  startAt: Date
  endAt: Date
  /** The session's `energyKwh` (as SessionList shows it); the money covers the interval sum, which can differ slightly. */
  kwh: number
  vehicle: Vehicle
}

export type EconomyOverview = {
  year: number
  /** Years with counted sessions plus the current one, newest first. */
  years: number[]
  tiles: EconomyTotals
  /** The selected year's 12 Stockholm months (by session start), zero-filled. */
  months: (EconomyTotals & { month: number })[]
  /** The selected year's counted sessions, newest first. */
  sessions: EconomySessionRow[]
}

export type SessionEconomyDetail = {
  session: {
    id: string
    startAt: Date
    endAt: Date
    kwh: number
    peakKw: number | null
    estimated: boolean
    vehicle: Vehicle
    vehicleSource: VehicleSource
  }
  window: EconomyWindow
  /** Zaptec intervals; empty when the session has none. */
  intervals: EconomyStretch[]
  /** Spot slots over the window ± 1 h, öre/kWh incl VAT; null on a day without a tariff. */
  prices: { startMs: number; endMs: number; spotOre: number | null }[]
  optimalSchedule: EconomyStretch[] | null
  /** The kW the counterfactual schedules charged at (the session's rate cap); null when excluded. */
  rateKw: number | null
  /** What the session cost in cash, solar and battery included (ADR-0023) — the hero. `economy` stays grid-only. */
  cost: CostSummary
  economy: SessionEconomy
}

/** Chart context either side of the plug-in window. */
const CONTEXT_MS = millisecondsInHour

function toEconomySession(s: SessionEnergy): EconomySession {
  return {
    startMs: s.startAt.getTime(),
    endMs: s.endAt.getTime(),
    stretches: s.stretches,
    estimated: s.estimated,
  }
}

export async function getEconomyOverview(input: {
  year?: number
  now?: Date
  timings?: EconomyTimings
  vehicle?: VehicleScope
}): Promise<EconomyOverview> {
  const t = input.timings
  const now = input.now ?? new Date()
  const currentYear = stockholmYearMonth(now.getTime()).year
  const year = input.year ?? currentYear

  const [all, tariffsAsc, years] = await Promise.all([
    timed(t, 'energyMs', () => listSessionEnergy({ all: true, vehicle: input.vehicle })),
    timed(t, 'tariffMs', loadTariffs),
    timed(t, 'yearsMs', distinctCountedYears),
  ])
  years.add(currentYear)
  const inYear = all.filter((s) => stockholmYearMonth(s.startAt.getTime()).year === year)
  const sessions = inYear.map(toEconomySession)

  const [slots, days] = await Promise.all([
    timed(t, 'slotsMs', () => listSlotsOverlapping(SPOT_ZONE, sessions.map(economyWindow))),
    timed(t, 'dailySpotMs', () => dailyAverageSpot(SPOT_ZONE, `${year}-01-01`, `${year}-12-31`)),
  ])

  const computeStart = performance.now()
  const index = new SlotIndex(slots)
  const rows: EconomySessionRow[] = inYear.map((s, i) => ({
    sessionId: s.sessionId,
    startAt: s.startAt,
    endAt: s.endAt,
    kwh: s.energyKwh,
    vehicle: s.vehicle,
    ...analyzeSession(sessions[i], index, tariffsAsc).economy,
  }))
  const rowsByMonth = Map.groupBy(rows, (r) => stockholmYearMonth(r.startAt.getTime()).month)
  const daysByMonth = Map.groupBy(days, (d) => Number(d.day.slice(5, 7)))
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    ...sumEconomy(
      rowsByMonth.get(i + 1) ?? [],
      averageSpotOre(daysByMonth.get(i + 1) ?? [], tariffsAsc),
    ),
  }))
  // The year's average sits beside the year's paid price, so it covers only the
  // months where the scope has a priced session (the spot chart's rule).
  const pricedDays = days.filter((d) => months[Number(d.day.slice(5, 7)) - 1].paidSpotOre !== null)
  const overview: EconomyOverview = {
    year,
    years: [...years].sort((a, b) => b - a),
    tiles: sumEconomy(rows, averageSpotOre(pricedDays, tariffsAsc)),
    months,
    sessions: rows.toReversed(),
  }
  if (t) t.computeMs = Math.round(performance.now() - computeStart)
  return overview
}

export async function getSessionEconomy(input: {
  sessionId: string
  timings?: EconomyTimings
}): Promise<SessionEconomyDetail> {
  const t = input.timings
  const [energy, tariffsAsc] = await Promise.all([
    timed(t, 'energyMs', () => getSessionEnergy(input.sessionId)),
    timed(t, 'tariffMs', loadTariffs),
  ])
  const session = toEconomySession(energy)
  const window = economyWindow(session)
  // The window ± 1 h (CONTEXT_MS, keep it ≥ one 15-min mix slot) covers every
  // mix slot: one starts at most 15 min before the first stretch.
  const [slots, mixes] = await Promise.all([
    timed(t, 'slotsMs', () =>
      listSlotsOverlapping(SPOT_ZONE, [
        { startMs: window.startMs - CONTEXT_MS, endMs: window.endMs + CONTEXT_MS },
      ]),
    ),
    loadMix([energy], t),
  ])

  const computeStart = performance.now()
  const index = new SlotIndex(slots)
  const { economy, optimalSchedule, rateKw } = analyzeSession(session, index, tariffsAsc)
  const cost = summarize(
    priceIntervals(toIntervals(energy, mixes.get(energy.sessionId)), index, tariffsAsc),
  )
  const intervals = energy.estimated ? [] : energy.stretches
  const detail: SessionEconomyDetail = {
    session: {
      id: energy.sessionId,
      startAt: energy.startAt,
      endAt: energy.endAt,
      kwh: energy.energyKwh,
      peakKw: sessionPeakKw(
        intervals.map((s) => ({
          startAt: new Date(s.startMs),
          endAt: new Date(s.endMs),
          energyKwh: s.kwh,
        })),
      ),
      estimated: energy.estimated,
      vehicle: energy.vehicle,
      vehicleSource: energy.vehicleSource,
    },
    window,
    intervals,
    prices: slots.map((slot) => {
      const tariff = tariffAt(tariffsAsc, stockholmDayOf(slot.startMs))
      return {
        startMs: slot.startMs,
        endMs: slot.endMs,
        spotOre: tariff ? unitPrice(slot.sekPerKwh, tariff).spotSek * 100 : null,
      }
    }),
    optimalSchedule:
      optimalSchedule?.map(({ startMs, endMs, kwh }) => ({ startMs, endMs, kwh })) ?? null,
    rateKw,
    cost,
    economy,
  }
  if (t) t.computeMs = Math.round(performance.now() - computeStart)
  return detail
}

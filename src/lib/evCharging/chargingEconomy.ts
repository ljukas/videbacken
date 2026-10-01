import { millisecondsInHour } from 'date-fns/constants'
import { SlotIndex, tariffAt, unitPrice } from '~/lib/evCharging/cost'
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
import { loadTariffs, timed } from './costInputs'

// Server-only. The charging-economy read model (Phase 4, ADR-0020
// "Counterfactuals"): session energy, the spot slots of each plug-in window,
// per-day average spot and tariff periods — each through its own service —
// run through the pure counterfactual math. Spot timing only: every kWh is
// treated as grid-bought.

export type EconomyTimings = {
  energyMs?: number
  tariffMs?: number
  slotsMs?: number
  dailySpotMs?: number
  yearsMs?: number
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
  const overview: EconomyOverview = {
    year,
    years: [...years].sort((a, b) => b - a),
    tiles: sumEconomy(rows, averageSpotOre(days, tariffsAsc)),
    months: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      ...sumEconomy(
        rowsByMonth.get(i + 1) ?? [],
        averageSpotOre(daysByMonth.get(i + 1) ?? [], tariffsAsc),
      ),
    })),
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
  const slots = await timed(t, 'slotsMs', () =>
    listSlotsOverlapping(SPOT_ZONE, [
      { startMs: window.startMs - CONTEXT_MS, endMs: window.endMs + CONTEXT_MS },
    ]),
  )

  const computeStart = performance.now()
  const { economy, optimalSchedule, rateKw } = analyzeSession(
    session,
    new SlotIndex(slots),
    tariffsAsc,
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
    economy,
  }
  if (t) t.computeMs = Math.round(performance.now() - computeStart)
  return detail
}

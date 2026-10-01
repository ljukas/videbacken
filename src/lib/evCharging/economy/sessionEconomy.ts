// Client-safe: one session's counterfactuals (ADR-0020 "Counterfactuals").
// Everything is priced by the same `priceIntervals` as the actual cost, so the
// four figures can only differ by *when* the energy is delivered.
import {
  type EnergyInterval,
  isComplete,
  priceIntervals,
  type SlotIndex,
  type TariffPeriod,
  tariffAt,
  unitPrice,
} from '~/lib/evCharging/cost'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { economyWindow, rateCapKw, schedule, sessionKwh, windowPieces } from './schedule'
import type { EconomyExclusion, EconomySession, EconomyWindow, SessionEconomy } from './types'

/**
 * The dearest − optimal gap must be at least this large (kr), and at least `SCORE_MIN_GAP_SHARE` of
 * |actual|, for the window to have offered a real choice; below it a score would grade noise
 * (amended 2026-10-01: a ≈4 öre gap scored 18 %).
 */
export const SCORE_MIN_GAP_SEK = 0.5
export const SCORE_MIN_GAP_SHARE = 0.05

/** Where `actual` sits between dearest (0) and optimal (1); null when the window offered no real choice. */
export function timingScore(
  actualSek: number,
  optimalSek: number,
  dearestSek: number,
): number | null {
  const gap = dearestSek - optimalSek
  if (gap < Math.max(SCORE_MIN_GAP_SEK, SCORE_MIN_GAP_SHARE * Math.abs(actualSek))) return null
  return Math.min(1, Math.max(0, (dearestSek - actualSek) / gap))
}

/** Time-weighted average spot over the window, öre/kWh incl each slot day's VAT; null without any. */
export function windowAvgSpotOre(
  window: EconomyWindow,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): number | null {
  let weighted = 0
  let coveredMs = 0
  for (const slot of slots.between(window.startMs, window.endMs)) {
    const overlapMs = Math.min(slot.endMs, window.endMs) - Math.max(slot.startMs, window.startMs)
    const tariff = tariffAt(tariffsAsc, stockholmDayOf(slot.startMs))
    if (overlapMs <= 0 || !tariff) continue
    weighted += unitPrice(slot.sekPerKwh, tariff).spotSek * overlapMs
    coveredMs += overlapMs
  }
  return coveredMs > 0 ? (weighted / coveredMs) * 100 : null
}

export function analyzeSession(
  session: EconomySession,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): {
  economy: SessionEconomy
  optimalSchedule: EnergyInterval[] | null
  /** The kW cap every counterfactual schedule charged at (`rateCapKw`); null when excluded. */
  rateKw: number | null
} {
  // gridShare 1: keep in sync with `toIntervals` in ../costInputs.ts (Emaldo seam).
  const actual = priceIntervals(
    session.stretches.map((s) => ({ ...s, gridShare: 1 })),
    slots,
    tariffsAsc,
  )
  const window = economyWindow(session)
  const actualComplete = isComplete(actual)
  const common = {
    actual,
    actualComplete,
    // Not over a partly priced actual: that would be the paid spot of only the priced hours.
    paidSpotOre:
      actualComplete && actual.fullKwh > 0 ? (actual.spotSek / actual.fullKwh) * 100 : null,
    windowAvgSpotOre: windowAvgSpotOre(window, slots, tariffsAsc),
  }
  const exclude = (excluded: EconomyExclusion) => ({
    economy: { ...common, excluded, counterfactual: null },
    optimalSchedule: null,
    rateKw: null,
  })

  if (session.estimated) return exclude('no_hourly')
  const pieces = windowPieces(window, slots, tariffsAsc)
  // A partly priced actual can't be compared either (e.g. a stretch past the last price).
  if (!pieces || !actualComplete) return exclude('no_price')

  const kwh = sessionKwh(session)
  const rate = rateCapKw(session, window)
  const price = (ivs: EnergyInterval[]) => priceIntervals(ivs, slots, tariffsAsc)
  const optimalSchedule = schedule('optimal', kwh, rate, pieces)
  const optimal = price(optimalSchedule)
  const immediate = price(schedule('immediate', kwh, rate, pieces))
  const dearest = price(schedule('dearest', kwh, rate, pieces))
  return {
    economy: {
      ...common,
      excluded: null,
      counterfactual: {
        immediate,
        optimal,
        dearest,
        score: timingScore(actual.totalSek, optimal.totalSek, dearest.totalSek),
        savedVsImmediateSek: immediate.totalSek - actual.totalSek,
        leftOnTableSek: Math.max(0, actual.totalSek - optimal.totalSek),
      },
    },
    optimalSchedule,
    rateKw: rate,
  }
}

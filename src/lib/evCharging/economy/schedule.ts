// Client-safe: the hypothetical schedules behind the Phase 4 counterfactuals
// (ADR-0020 "Counterfactuals"). A session's energy is re-delivered inside its
// plug-in window, at most at its rate cap, filling the window's price pieces in
// time order (immediate), cheapest first (optimal) or dearest first (dearest).
// Greedy is exactly optimal: cost is linear in kWh and each piece's capacity is
// independent (a fractional knapsack). Hand-rolled — no library fills
// capacity-limited slots by price.
import { max, sum } from 'd3-array'
import { millisecondsInHour } from 'date-fns/constants'
import {
  type EnergyInterval,
  type SlotIndex,
  type TariffPeriod,
  tariffAt,
  unitPrice,
} from '~/lib/evCharging/cost'
import { stockholmDayOf } from '~/lib/time/stockholm'
import type { EconomySession, EconomyWindow, PricedPiece, ScheduleKind } from './types'

/** Leftover energy below this is float noise, not a shortfall. */
const FILL_EPSILON_KWH = 1e-6

/**
 * Plug-in → plug-out, widened to cover every stretch: a clock quirk can put an
 * interval slightly outside the window, and the actual schedule must be one the
 * counterfactuals could have picked (`optimal ≤ actual ≤ dearest`).
 */
export function economyWindow(s: EconomySession): EconomyWindow {
  return {
    startMs: Math.min(s.startMs, ...s.stretches.map((x) => x.startMs)),
    endMs: Math.max(s.endMs, ...s.stretches.map((x) => x.endMs)),
  }
}

/** The energy to re-deliver: exactly what the actual cost prices. */
export function sessionKwh(s: EconomySession): number {
  return sum(s.stretches, (x) => x.kwh)
}

/**
 * The fastest the session may charge in a counterfactual: its highest observed
 * kW, or its energy spread over the window if that's higher (so the energy
 * always fits). Using the highest observed rate keeps the actual schedule
 * feasible.
 */
export function rateCapKw(s: EconomySession, window: EconomyWindow): number {
  const kwh = sessionKwh(s)
  if (kwh <= 0) return 0
  const observed =
    max(
      s.stretches.filter((x) => x.endMs > x.startMs),
      (x) => (x.kwh / (x.endMs - x.startMs)) * millisecondsInHour,
    ) ?? 0
  const windowHours = (window.endMs - window.startMs) / millisecondsInHour
  return Math.max(observed, windowHours > 0 ? kwh / windowHours : 0)
}

/**
 * The window split at its price slots, each piece with its full price (spot +
 * fees, incl VAT, under the tariff of the slot's Stockholm day). Null when any
 * part of the window lacks a price or a tariff — it can't be ranked, so the
 * session is excluded rather than priced as if that stretch were free.
 */
export function windowPieces(
  window: EconomyWindow,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): PricedPiece[] | null {
  if (!(window.endMs > window.startMs)) return null
  const pieces: PricedPiece[] = []
  let cursor = window.startMs
  for (const slot of slots.between(window.startMs, window.endMs)) {
    const startMs = Math.max(slot.startMs, window.startMs)
    const endMs = Math.min(slot.endMs, window.endMs)
    if (startMs > cursor) return null
    const tariff = tariffAt(tariffsAsc, stockholmDayOf(slot.startMs))
    if (!tariff) return null
    const unit = unitPrice(slot.sekPerKwh, tariff)
    pieces.push({ startMs, endMs, sekPerKwh: unit.spotSek + unit.feesSek })
    cursor = endMs
  }
  return pieces.length > 0 && cursor >= window.endMs ? pieces : null
}

/**
 * `kwh` delivered at most at `rateKw`, filling `pieces` in the kind's order;
 * a partly used piece is filled from its start. Returned in time order, all
 * grid-bought (`gridShare` 1): the counterfactuals compare spot timing as if
 * every kWh were bought (ADR-0023 decision 8).
 */
export function schedule(
  kind: ScheduleKind,
  kwh: number,
  rateKw: number,
  pieces: readonly PricedPiece[],
): EnergyInterval[] {
  if (!Number.isFinite(kwh) || kwh < 0)
    throw new RangeError('Energy must be finite and non-negative')
  if (kwh === 0) return []
  if (!Number.isFinite(rateKw) || rateKw <= 0)
    throw new RangeError('Rate cap must be finite and positive')
  const order =
    kind === 'immediate'
      ? pieces
      : pieces.toSorted(
          (a, b) =>
            (kind === 'optimal' ? a.sekPerKwh - b.sekPerKwh : b.sekPerKwh - a.sekPerKwh) ||
            a.startMs - b.startMs,
        )
  const out: EnergyInterval[] = []
  let remaining = kwh
  for (const p of order) {
    if (remaining <= FILL_EPSILON_KWH) break
    const capacity = (rateKw * (p.endMs - p.startMs)) / millisecondsInHour
    if (capacity <= 0) continue
    if (capacity <= remaining) {
      out.push({ startMs: p.startMs, endMs: p.endMs, kwh: capacity, gridShare: 1 })
      remaining -= capacity
    } else {
      const endMs = p.startMs + (remaining / rateKw) * millisecondsInHour
      out.push({ startMs: p.startMs, endMs, kwh: remaining, gridShare: 1 })
      remaining = 0
    }
  }
  if (remaining > FILL_EPSILON_KWH) {
    throw new RangeError('The window cannot take this energy at this rate')
  }
  return out.toSorted((a, b) => a.startMs - b.startMs)
}

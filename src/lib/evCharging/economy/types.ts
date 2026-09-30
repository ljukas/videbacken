// Types for the Phase 4 counterfactuals (ADR-0020 "Counterfactuals"). Client-safe.
import type { CostTotals } from '~/lib/evCharging/cost'

/** A stretch of delivered energy, as the cost math consumes it. */
export type EconomyStretch = { startMs: number; endMs: number; kwh: number }

/** A counted session as the counterfactuals need it — its own type, no import from services. */
export type EconomySession = {
  /** Plug-in. */
  startMs: number
  /** Plug-out. */
  endMs: number
  /** Zaptec intervals, or one even stretch over the window when `estimated`. */
  stretches: EconomyStretch[]
  /** No Zaptec intervals: the energy is spread evenly, so there's nothing to compare (`no_hourly`). */
  estimated: boolean
}

/** Plug-in → plug-out, widened to cover every stretch. */
export type EconomyWindow = { startMs: number; endMs: number }

export type ScheduleKind = 'immediate' | 'optimal' | 'dearest'

/** A slot's part of a window with its full price: SEK/kWh incl fees + VAT. */
export type PricedPiece = { startMs: number; endMs: number; sekPerKwh: number }

export type EconomyExclusion = 'no_hourly' | 'no_price'

export type Counterfactual = {
  immediate: CostTotals
  optimal: CostTotals
  dearest: CostTotals
  /** 0…1, or null when the window left nothing to choose between (gap < 0.01 kr). */
  score: number | null
  /** immediate − actual; negative when charging at once would have been cheaper. */
  savedVsImmediateSek: number
  /** actual − optimal, never negative. */
  leftOnTableSek: number
}

export type SessionEconomy = {
  /** Partial (priced hours only) when `actualComplete` is false — never show it as the session's cost then. */
  actual: CostTotals
  /** `isComplete(actual)`: every kWh priced. Gate any kronor figure on it (an excluded `no_price` session may be partial). */
  actualComplete: boolean
  /** Spot paid, öre/kWh incl VAT, over the session's energy; null when the actual is incomplete or empty. */
  paidSpotOre: number | null
  /** Time-weighted average spot over the window, öre/kWh incl VAT; null without prices. */
  windowAvgSpotOre: number | null
} & (
  | { excluded: null; counterfactual: Counterfactual }
  | { excluded: EconomyExclusion; counterfactual: null }
)

/**
 * Sums over a set of sessions (a month, a year). Kronor cover only the included sessions.
 * With `included === 0` the kronor sums are numeric 0, not "unknown": consumers must gate
 * kronor on `included > 0` and never render 0 kr for missing data (ADR-0020).
 */
export type EconomyTotals = {
  sessions: number
  included: number
  excluded: { noHourly: number; noPrice: number }
  /** kWh of the included sessions. */
  kwh: number
  actualSek: number
  immediateSek: number
  optimalSek: number
  dearestSek: number
  savedVsImmediateSek: number
  leftOnTableSek: number
  score: number | null
  /** Over the included sessions. */
  paidSpotOre: number | null
  /** Time-weighted average spot of the whole period incl VAT, whether or not we charged. */
  avgSpotOre: number | null
}

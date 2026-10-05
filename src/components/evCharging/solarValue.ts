import type { CostTotals } from '~/lib/evCharging/cost'
import { m } from '~/paraglide/messages'
import { formatSignedSek } from './format'

// The value of own solar used (ADR-0023 decision 7): what the solar energy the
// car used would have earned if exported, at its slot's spot (or the
// battery's stored spot), ex VAT, no fees. Shown beside the cash cost, never
// folded into it. Pure and client-safe: tiles, the chart tooltip and the
// session page share these rules.

/**
 * Solar energy below this is too little to show: it reads "0,0 kWh" wherever
 * kWh are shown, and the proportional mix leaves float crumbs. One threshold
 * for every decision, so the states agree: less solar than this in all hides
 * the line, less priced solar makes it unknown (never "minst 0 kr"), and less
 * unpriced solar doesn't make it "minst" (a month too small to show its own
 * line can't qualify a year's total without saying why).
 */
export const SOLAR_VALUE_MIN_KWH = 0.05

export type SolarValueInput = Pick<
  CostTotals,
  'solarValueSek' | 'solarPricedKwh' | 'solarUnpricedKwh'
>
export type SolarValueAmount = { kind: 'value'; sek: number; atLeast: boolean }
export type SolarValueView = { kind: 'hidden' } | { kind: 'unknown' } | SolarValueAmount

/**
 * How a total's solar value reads: hidden when no solar was used; unknown when
 * (next to) none of it had a spot price (never 0 kr, ADR-0020); otherwise the
 * value, marked as a floor ("minst") when part of the solar lacked a price.
 */
export function solarValueView(t: SolarValueInput): SolarValueView {
  const solarKwh = t.solarPricedKwh + t.solarUnpricedKwh
  // `!(x >= …)` also hides NaN: a broken total prints nothing rather than "NaN kr".
  if (!(solarKwh >= SOLAR_VALUE_MIN_KWH)) return { kind: 'hidden' }
  if (!(t.solarPricedKwh >= SOLAR_VALUE_MIN_KWH)) return { kind: 'unknown' }
  if (!Number.isFinite(t.solarValueSek)) return { kind: 'hidden' }
  return {
    kind: 'value',
    sek: t.solarValueSek,
    atLeast: t.solarUnpricedKwh >= SOLAR_VALUE_MIN_KWH,
  }
}

/**
 * "212 kr", "minst 212 kr", or "−3 kr" when spot was negative (exporting would
 * have cost money). Whole kronor by default (tiles, chart); the session page
 * passes 2.
 */
export function formatSolarValue(v: SolarValueAmount, fractionDigits = 0): string {
  const total = formatSignedSek(v.sek, fractionDigits)
  return v.atLeast ? m.charging_cost_min({ total }) : total
}

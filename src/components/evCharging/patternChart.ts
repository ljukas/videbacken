import { scaleSqrt } from 'd3-scale'
import type { Slot } from '~/lib/evCharging/patterns'
import { m } from '~/paraglide/messages'
import { formatOneDecimal } from './format'

export type PatternMetric = 'kwh' | 'plugged'

export function slotValue(slot: Slot, metric: PatternMetric): number {
  return metric === 'kwh' ? slot.kwh : slot.pluggedHours
}

// "38,4 kWh" / "2,5 h inkopplad".
export function valueLabel(value: number, metric: PatternMetric): string {
  return metric === 'kwh'
    ? m.charging_patterns_value_kwh({ value: formatOneDecimal(value) })
    : m.charging_patterns_value_plugged({ value: formatOneDecimal(value) })
}

// Value → CSS fill. sqrt so small values stay visible next to the evening peak;
// colour-mix on the theme tokens so light/dark follow the design system
// (d3-color can't read CSS variables or oklch). Zero is the muted cell colour.
export function intensity(max: number): (value: number) => string {
  const share = scaleSqrt()
    .domain([0, Math.max(max, Number.EPSILON)])
    .range([28, 100])
    .clamp(true)
  return (value) =>
    value > 0
      ? `color-mix(in oklch, var(--brand) ${Math.round(share(value))}%, var(--card))`
      : 'var(--muted)'
}

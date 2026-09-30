import { scaleSqrt } from 'd3-scale'
import type { Slot } from '~/lib/evCharging/patterns'

export type PatternMetric = 'kwh' | 'plugged'

export function slotValue(slot: Slot, metric: PatternMetric): number {
  return metric === 'kwh' ? slot.kwh : slot.pluggedHours
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

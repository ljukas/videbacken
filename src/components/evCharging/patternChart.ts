import { ascending, bisectLeft, range } from 'd3-array'
import { scaleQuantile, scaleThreshold } from 'd3-scale'
import type { DayTotal, Slot } from '~/lib/evCharging/patterns'
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

/** The empty-cell fill; empty cells also get a `var(--border)` stroke. */
export const ZERO_FILL = 'var(--muted)'
// Five clearly distinct steps of `--brand` mixed into the card (colour-mix on
// the theme tokens so light/dark follow the design system; d3-color can't read
// CSS variables).
const STEP_FILLS = [20, 40, 60, 80, 100].map(
  (share) => `color-mix(in oklab, var(--brand) ${share}%, var(--card))`,
)

export type IntensityStep = { color: string; from: number; to: number }
export type Intensity = { fill: (value: number) => string; steps: IntensityStep[] }

/**
 * Value → CSS fill, stepped by quantile over the non-zero values: each step
 * holds about a fifth of the non-empty cells, so a few big evenings can't wash
 * everything else out to one pale tint. Zero is `ZERO_FILL`.
 *
 * The quantile thresholds are snapped up to real values and deduplicated, so
 * with fewer than five distinct values there are fewer steps, never an empty
 * one; the steps then spread over the ramp and the top step is always full
 * `--brand`. `steps` (lowest first) carry the smallest and largest value each
 * step actually holds, for the legend. All-zero data has no steps.
 */
export function intensity(values: number[]): Intensity {
  const data = values.filter((v) => v > 0).sort(ascending)
  if (data.length === 0) return { fill: () => ZERO_FILL, steps: [] }
  const distinct = [...new Set(data)]
  const min = distinct[0]
  const max = distinct[distinct.length - 1]
  const snap = (q: number) => distinct[bisectLeft(distinct, q)] ?? max
  const thresholds = [
    ...new Set(
      scaleQuantile<number>().domain(data).range(range(STEP_FILLS.length)).quantiles().map(snap),
    ),
  ].filter((t) => t > min)
  const count = thresholds.length + 1
  const colors = range(count).map(
    (i) =>
      STEP_FILLS[
        count === 1
          ? STEP_FILLS.length - 1
          : Math.round((i * (STEP_FILLS.length - 1)) / (count - 1))
      ],
  )
  const scale = scaleThreshold<number, string>().domain(thresholds).range(colors)
  const bounds = [min, ...thresholds]
  const steps = bounds.map((from, i) => {
    const next = bounds[i + 1]
    const to = next === undefined ? max : distinct[bisectLeft(distinct, next) - 1]
    return { color: colors[i], from, to }
  })
  return { fill: (value) => (value > 0 ? scale(value) : ZERO_FILL), steps }
}

/** The weekday × hour heatmap's scale (shared by the chart and its legend). */
export function heatmapIntensity(grid: Slot[][], metric: PatternMetric): Intensity {
  return intensity(grid.flat().map((slot) => slotValue(slot, metric)))
}

/** The calendar's scale over daily kWh (shared by the calendar and its legend). */
export function calendarIntensity(daily: DayTotal[]): Intensity {
  return intensity(daily.map((d) => d.kwh))
}

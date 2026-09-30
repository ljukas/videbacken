import { m } from '~/paraglide/messages'
import { formatCount, formatOneDecimal } from './format'
import { type Intensity, type PatternMetric, valueLabel, ZERO_FILL } from './patternChart'

// The heatmap / calendar colour steps with the values each one holds: the
// empty-cell swatch ("0"), then one swatch per quantile step, lowest first.
// Visually the unit is printed once, after the last step; the accessible name
// spells every step out with its unit.
export function PatternLegend({ scale, metric }: { scale: Intensity; metric: PatternMetric }) {
  const zero = formatCount(0)
  const items = scale.steps.map((step, i) => {
    const from = formatOneDecimal(step.from)
    const to = formatOneDecimal(step.to)
    const withUnit =
      from === to ? valueLabel(step.to, metric) : `${from}–${valueLabel(step.to, metric)}`
    const bare = from === to ? from : `${from}–${to}`
    return {
      color: step.color,
      label: i === scale.steps.length - 1 ? withUnit : bare,
      spoken: withUnit,
    }
  })
  return (
    <div
      role="img"
      aria-label={m.charging_patterns_legend_label({
        steps: [zero, ...items.map((item) => item.spoken)].join('; '),
      })}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs"
    >
      <span aria-hidden className="flex items-center gap-1">
        <span
          data-swatch="zero"
          className="size-3 rounded-sm"
          style={{ background: ZERO_FILL, border: '1px solid var(--border)' }}
        />
        <span className="tabular-nums">{zero}</span>
      </span>
      {items.map((item) => (
        <span key={item.color} aria-hidden className="flex items-center gap-1">
          <span
            data-swatch="step"
            className="size-3 rounded-sm"
            style={{ background: item.color }}
          />
          <span className="tabular-nums">{item.label}</span>
        </span>
      ))}
    </div>
  )
}

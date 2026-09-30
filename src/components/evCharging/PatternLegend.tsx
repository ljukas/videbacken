import { m } from '~/paraglide/messages'
import { formatCount, formatOneDecimal } from './format'
import { type Intensity, type PatternMetric, valueLabel, ZERO_FILL } from './patternChart'

// "less [swatches] more" for the heatmap and calendar colour scale: the
// empty-cell swatch first, then one swatch per quantile step. No numbers for
// sighted users; the accessible name spells every step's range out.
export function PatternLegend({ scale, metric }: { scale: Intensity; metric: PatternMetric }) {
  const spoken = [
    formatCount(0),
    ...scale.steps.map((step) => {
      const from = formatOneDecimal(step.from)
      const to = formatOneDecimal(step.to)
      return from === to ? valueLabel(step.to, metric) : `${from}–${valueLabel(step.to, metric)}`
    }),
  ]
  return (
    <div
      role="img"
      aria-label={m.charging_patterns_legend_label({ steps: spoken.join('; ') })}
      className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs"
    >
      <span aria-hidden>{m.charging_patterns_legend_less()}</span>
      <span
        aria-hidden
        data-swatch="zero"
        className="size-3 rounded-[3px]"
        style={{ background: ZERO_FILL, border: '1px solid var(--border)' }}
      />
      {scale.steps.map((step) => (
        <span
          key={step.color}
          aria-hidden
          data-swatch="step"
          className="size-3 rounded-[3px]"
          style={{ background: step.color }}
        />
      ))}
      <span aria-hidden>{m.charging_patterns_legend_more()}</span>
    </div>
  )
}

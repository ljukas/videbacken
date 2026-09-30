import { m } from '~/paraglide/messages'
import { intensity } from './patternChart'

const STEPS = [0.05, 0.2, 0.45, 0.7, 1]
const fill = intensity(1)

// "less [swatches] more" for the heatmap and calendar colour scale. `maxLabel`
// names what the darkest swatch means (the calendar's "0 … 48 kWh").
export function PatternLegend({ maxLabel }: { maxLabel?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
      <span>{m.charging_patterns_legend_less()}</span>
      <span aria-hidden className="flex gap-0.5">
        {STEPS.map((step) => (
          <span key={step} className="size-3 rounded-sm" style={{ background: fill(step) }} />
        ))}
      </span>
      <span>{m.charging_patterns_legend_more()}</span>
      {maxLabel ? <span className="ml-1 tabular-nums">{maxLabel}</span> : null}
    </div>
  )
}

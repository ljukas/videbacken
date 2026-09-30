import { m } from '~/paraglide/messages'
import { intensity } from './patternChart'

const STEPS = [0, 0.05, 0.2, 0.45, 0.7, 1]
const fill = intensity(1)

// "less [swatches] more" for the heatmap and calendar colour scale. The first
// swatch is the empty-cell colour, so "less" is never darker than a zero cell.
// `maxLabel` names what the darkest swatch means (e.g. "48 kWh").
export function PatternLegend({ maxLabel }: { maxLabel?: string }) {
  const less = m.charging_patterns_legend_less()
  const more = m.charging_patterns_legend_more()
  return (
    <div
      role="img"
      aria-label={maxLabel ? `${less} … ${more}, ${maxLabel}` : `${less} … ${more}`}
      className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs"
    >
      <span aria-hidden>{less}</span>
      <span aria-hidden className="flex gap-0.5">
        {STEPS.map((step) => (
          <span key={step} className="size-3 rounded-sm" style={{ background: fill(step) }} />
        ))}
      </span>
      <span aria-hidden>{more}</span>
      {maxLabel ? (
        <span aria-hidden className="ml-1 tabular-nums">
          {maxLabel}
        </span>
      ) : null}
    </div>
  )
}

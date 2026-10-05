import { SunIcon } from 'lucide-react'
import { m } from '~/paraglide/messages'
import { formatSolarValue, type SolarValueInput, solarValueView } from './solarValue'

// One line under a cash cost: the value of own solar used (ADR-0023). Small
// muted text with a decorative sun, in the tile footer's note idiom, so it
// reads as a note on the cost and not as a second price. Nothing when no solar
// was used. An estimated session (no hourly readings) marks it "≈" like its
// cost (see Estimated), joined to the figure by a no-break space.
export function SolarValueLine({
  cost,
  fractionDigits = 0,
  estimated = false,
}: {
  cost: SolarValueInput
  fractionDigits?: number
  estimated?: boolean
}) {
  const view = solarValueView(cost)
  if (view.kind === 'hidden') return null
  const marked = estimated && view.kind === 'value'
  return (
    <p
      className="flex items-start gap-1.5 text-muted-foreground text-xs"
      title={marked ? m.charging_sessions_cost_estimated() : undefined}
    >
      <SunIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0 text-pretty">
        {view.kind === 'unknown'
          ? m.charging_solar_value_unknown()
          : m.charging_solar_value({
              value: `${marked ? '≈\u00a0' : ''}${formatSolarValue(view, fractionDigits)}`,
            })}
        {marked ? <span className="sr-only"> ({m.charging_sessions_cost_estimated()})</span> : null}
      </span>
    </p>
  )
}

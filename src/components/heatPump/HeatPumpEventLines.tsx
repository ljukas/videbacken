import type { DayEventMarker } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

// The day tooltip's event lines: "Service · Båda". The chart's marks are visual only (aria-hidden),
// so this is also what the keyboard walk announces.
export function HeatPumpEventLines({
  markers,
  units,
}: {
  markers: readonly DayEventMarker[] | undefined
  units: readonly HeatPumpUnitRef[]
}) {
  if (!markers || markers.length === 0) return null
  return markers.map((mk) => (
    <div key={mk.heatPumpId ?? 'all'} className="flex items-center gap-1.5">
      <span aria-hidden>▼</span>
      <span>
        {m.heat_pump_event_tooltip({
          kinds: mk.kinds.map(eventKindLabel).join(', '),
          unit: eventUnitLabel(mk.heatPumpId, units),
        })}
      </span>
    </div>
  ))
}

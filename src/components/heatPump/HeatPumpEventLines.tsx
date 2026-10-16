import type { DayEventMarker } from '~/lib/heatPump/events'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

// The day tooltip's event lines: "▼ Service · Båda", the ▼ in the chart mark's colour, each note under its line.
// The chart's marks are visual only (aria-hidden), so this is also what the keyboard walk announces.
export function HeatPumpEventLines({
  markers,
  units,
}: {
  markers: readonly DayEventMarker[] | undefined
  units: readonly HeatPumpUnitRef[]
}) {
  if (!markers || markers.length === 0) return null
  return markers.map((mk) => (
    <div key={mk.heatPumpId ?? 'all'} className="flex items-baseline gap-1.5">
      <span
        aria-hidden
        data-event-mark
        style={{
          color: mk.heatPumpId === null ? 'var(--foreground)' : heatPumpColor(units, mk.heatPumpId),
        }}
      >
        ▼
      </span>
      <div className="min-w-0">
        <div>
          {m.heat_pump_event_tooltip({
            kinds: mk.kinds.map(eventKindLabel).join(', '),
            unit: eventUnitLabel(mk.heatPumpId, units),
          })}
        </div>
        {mk.notes.map((note, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a note can repeat on one day and unit; the list is fixed per render
          <p key={i} className="line-clamp-2 max-w-60 break-words text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
    </div>
  ))
}

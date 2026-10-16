import type { HeatPumpEventKind } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'

/** A unit as the page knows it (name order = colour order). */
export type HeatPumpUnitRef = { id: string; name: string }

export function eventKindLabel(kind: HeatPumpEventKind): string {
  switch (kind) {
    case 'service':
      return m.heat_pump_event_kind_service()
    case 'filter':
      return m.heat_pump_event_kind_filter()
    case 'setting':
      return m.heat_pump_event_kind_setting()
    case 'other':
      return m.heat_pump_event_kind_other()
  }
}

/** The unit an event is about: its name; every unit is "Båda" with two units, "Alla" otherwise. */
export function eventUnitLabel(
  heatPumpId: string | null,
  units: readonly HeatPumpUnitRef[],
): string {
  if (heatPumpId === null) {
    return units.length === 2 ? m.heat_pump_event_unit_both() : m.heat_pump_event_unit_all()
  }
  return units.find((u) => u.id === heatPumpId)?.name ?? m.heat_pump_event_unit_unknown()
}

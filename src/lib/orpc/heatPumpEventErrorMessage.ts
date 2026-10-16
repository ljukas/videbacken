import { HEAT_PUMP_EVENT_NOTE_MAX } from '~/lib/heatPump/events'
import type { HeatPumpEventErrorCode } from '~/lib/services/heatPump'
import { m } from '~/paraglide/messages'

// The event procedures throw code-only typed errors; the client owns the copy (same pattern as
// tariffErrorMessage). Exhaustive over the event codes.
export function heatPumpEventErrorMessage(code: HeatPumpEventErrorCode): string {
  switch (code) {
    case 'UNKNOWN_HEAT_PUMP':
      return m.heat_pump_event_error_unknown_heat_pump()
    case 'FUTURE_DATE':
      return m.heat_pump_event_error_future()
    case 'EVENT_NOT_FOUND':
      return m.heat_pump_event_error_not_found()
    case 'NOTE_TOO_LONG':
      return m.heat_pump_event_error_note_too_long({ max: String(HEAT_PUMP_EVENT_NOTE_MAX) })
  }
}

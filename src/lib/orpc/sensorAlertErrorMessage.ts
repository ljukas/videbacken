import type { SensorAlertDomainErrorCode } from '~/lib/services/sensorAlert'
import { m } from '~/paraglide/messages'

// The alert procedures throw code-only typed errors; the client owns the copy (same pattern as
// heatPumpEventErrorMessage). Exhaustive over the codes.
export function sensorAlertErrorMessage(code: SensorAlertDomainErrorCode): string {
  switch (code) {
    case 'RULE_NOT_FOUND':
      return m.sensors_alert_error_rule_not_found()
    case 'UNKNOWN_SENSOR':
      return m.sensors_alert_error_unknown_sensor()
  }
}

import type { SensorDomainErrorCode } from '~/lib/services/sensor'
import { m } from '~/paraglide/messages'

// Sensor admin procedures throw code-only oRPC typed errors; the client owns the
// i18n (same pattern as userErrorMessage). Typed over the full domain union so
// the switch is exhaustive — INVALID_MAC is an ingest-only code that never
// reaches these client dialogs, but handling it keeps a missing case a compile
// error.
export function sensorErrorMessage(code: SensorDomainErrorCode): string {
  switch (code) {
    case 'DEVICE_NOT_FOUND':
      return m.sensors_error_device_not_found()
    case 'INVALID_MAC':
      return m.sensors_save_error()
  }
}

import type { TariffDomainErrorCode } from '~/lib/services/tariff'
import { m } from '~/paraglide/messages'

// Tariff procedures throw code-only oRPC typed errors; the client owns the
// i18n (same pattern as sensorErrorMessage). Exhaustive over the domain union.
export function tariffErrorMessage(code: TariffDomainErrorCode): string {
  switch (code) {
    case 'TARIFF_NOT_FOUND':
      return m.charging_tariff_error_not_found()
    case 'TARIFF_VALID_FROM_TAKEN':
      return m.charging_tariff_error_valid_from_taken()
    case 'TARIFF_INVALID_VALUE':
      return m.charging_tariff_error_invalid_value()
    case 'TARIFF_INVALID_DATE':
      return m.charging_tariff_error_invalid_date()
  }
}

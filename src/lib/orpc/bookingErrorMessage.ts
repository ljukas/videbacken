import type { BookingDomainErrorCode } from '~/lib/services/booking'
import { m } from '~/paraglide/messages'

// Booking procedures throw code-only oRPC typed errors (see
// procedures/booking.ts); the client owns booking-error i18n (ADR-0002
// amendment, folder precedent). `import type` is erased at build, so this
// pulls only the code union — no server runtime leaks into the client
// bundle. The exhaustive switch makes a missing case a compile error.
/** Localize a typed booking error code. */
export function bookingErrorMessage(code: BookingDomainErrorCode): string {
  switch (code) {
    case 'SEASON_LOCKED':
      return m.booking_error_season_locked()
    case 'NOT_LOCKED':
      return m.booking_error_not_locked()
    case 'NOT_YOUR_SHARE':
      return m.booking_error_not_your_share()
    case 'INVALID_TARGET':
      return m.booking_error_invalid_target()
  }
}

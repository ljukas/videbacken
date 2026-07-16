export type BookingDomainErrorCode =
  | 'SEASON_LOCKED'
  | 'NOT_LOCKED'
  | 'NOT_YOUR_SHARE'
  | 'INVALID_TARGET'

export class BookingDomainError extends Error {
  constructor(public readonly code: BookingDomainErrorCode) {
    super(code)
    this.name = 'BookingDomainError'
  }
}

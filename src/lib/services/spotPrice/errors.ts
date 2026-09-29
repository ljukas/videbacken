export type SpotPriceDomainErrorCode =
  // A day's slots are not a complete, contiguous, plausible price list for that
  // Stockholm day (see `validateDaySlots`). Stored days are all-or-nothing.
  'INVALID_DAY_SLOTS'

export class SpotPriceDomainError extends Error {
  constructor(
    public readonly code: SpotPriceDomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'SpotPriceDomainError'
  }
}

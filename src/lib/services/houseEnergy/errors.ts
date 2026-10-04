export type HouseEnergyDomainErrorCode =
  // The day's bounds can't be a Stockholm day: the end isn't after the start,
  // or the day is longer than 25 h.
  | 'INVALID_DAY'
  // A bucket lies outside the day or repeats a bucket start, or a kWh value is
  // not finite, negative or absurd. Stored days are all-or-nothing.
  | 'INVALID_READINGS'

export class HouseEnergyDomainError extends Error {
  constructor(
    public readonly code: HouseEnergyDomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'HouseEnergyDomainError'
  }
}

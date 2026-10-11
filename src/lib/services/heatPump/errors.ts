export type HeatPumpDomainErrorCode =
  // A reading lies outside the UTC day, is off the whole hour or repeats an hour, or a value is
  // not finite or outside the table's CHECKs. A stored day is all-or-nothing: a bad row fails
  // the day, not the run (as the Emaldo sync's rejected days).
  | 'INVALID_READING'
  // No heat_pump row has this id.
  | 'UNKNOWN_HEAT_PUMP'

export class HeatPumpDomainError extends Error {
  constructor(
    public readonly code: HeatPumpDomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'HeatPumpDomainError'
  }
}

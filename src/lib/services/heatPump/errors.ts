export type HeatPumpDomainErrorCode =
  // A reading lies outside the UTC day, is off the whole hour or repeats an hour, or a value is
  // not finite or outside the table's CHECKs. A stored day is all-or-nothing: a bad row fails
  // the day, not the run (as the Emaldo sync's rejected days).
  | 'INVALID_READING'
  // No heat_pump row has this id.
  | 'UNKNOWN_HEAT_PUMP'
  // An event's date is after today's Stockholm calendar day.
  | 'FUTURE_DATE'
  // An update/delete targeted an event id that does not exist.
  | 'EVENT_NOT_FOUND'
  // An event's note is longer than HEAT_PUMP_EVENT_NOTE_MAX characters (code points), after trimming.
  | 'NOTE_TOO_LONG'

/** The codes the event procedures can surface (`UNKNOWN_HEAT_PUMP`: the event names a unit that doesn't exist). */
export type HeatPumpEventErrorCode = Extract<
  HeatPumpDomainErrorCode,
  'UNKNOWN_HEAT_PUMP' | 'FUTURE_DATE' | 'EVENT_NOT_FOUND' | 'NOTE_TOO_LONG'
>

export class HeatPumpDomainError extends Error {
  constructor(
    public readonly code: HeatPumpDomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'HeatPumpDomainError'
  }
}

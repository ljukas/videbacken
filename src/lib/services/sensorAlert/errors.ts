export type SensorAlertDomainErrorCode =
  // An update/toggle/delete targeted a rule id that doesn't exist or isn't the caller's.
  | 'RULE_NOT_FOUND'
  // The rule names a sensor device that doesn't exist.
  | 'UNKNOWN_SENSOR'

export class SensorAlertDomainError extends Error {
  constructor(
    public readonly code: SensorAlertDomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'SensorAlertDomainError'
  }
}

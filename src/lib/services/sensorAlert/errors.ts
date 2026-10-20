export type SensorAlertDomainErrorCode =
  // An update/toggle/delete targeted a rule id that doesn't exist or isn't the caller's.
  | 'RULE_NOT_FOUND'
  // The rule names a sensor device that doesn't exist.
  | 'UNKNOWN_SENSOR'
  // The user already has ALERT_RULES_PER_SENSOR_MAX rules on that sensor.
  | 'TOO_MANY_RULES'

export class SensorAlertDomainError extends Error {
  constructor(
    public readonly code: SensorAlertDomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'SensorAlertDomainError'
  }
}

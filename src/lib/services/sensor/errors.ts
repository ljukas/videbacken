export type SensorDomainErrorCode =
  // A rename/delete targeted a device id that does not exist.
  'DEVICE_NOT_FOUND'

export class SensorDomainError extends Error {
  constructor(public readonly code: SensorDomainErrorCode) {
    super(code)
    this.name = 'SensorDomainError'
  }
}

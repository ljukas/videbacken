export type SensorDomainErrorCode =
  // A rename/delete targeted a device id that does not exist.
  | 'DEVICE_NOT_FOUND'
  // A reading arrived with a MAC that isn't a valid 12-hex device identity
  // (empty/garbage after normalization). Rejected so degenerate ids can't
  // collide into one phantom device on the unique `mac` column.
  | 'INVALID_MAC'

export class SensorDomainError extends Error {
  constructor(public readonly code: SensorDomainErrorCode) {
    super(code)
    this.name = 'SensorDomainError'
  }
}

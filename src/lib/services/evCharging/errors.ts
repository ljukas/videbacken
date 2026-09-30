export type EvChargingDomainErrorCode =
  // A session id that doesn't exist or isn't counted (noise, voided, replaced).
  'EV_SESSION_NOT_FOUND'

export class EvChargingDomainError extends Error {
  constructor(public readonly code: EvChargingDomainErrorCode) {
    super(code)
    this.name = 'EvChargingDomainError'
  }
}

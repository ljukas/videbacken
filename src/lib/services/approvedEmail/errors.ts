export type ApprovedEmailErrorCode = 'EMAIL_ALREADY_APPROVED'

export class ApprovedEmailDomainError extends Error {
  constructor(public readonly code: ApprovedEmailErrorCode) {
    super(code)
    this.name = 'ApprovedEmailDomainError'
  }
}

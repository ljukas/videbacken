export type UserDomainErrorCode =
  | 'NOT_FOUND'
  | 'TARGET_DELETED'
  | 'CANNOT_ACT_ON_SELF'
  | 'LAST_ADMIN'
  // Resend attempted on an email that already became an active user (accepted
  // by signing in) — nothing left to resend.
  | 'ALREADY_ACCEPTED'
  // Invite attempted for an email already on the approved_email allowlist
  // (whether still pending or already an active user) — the admin should
  // resend instead.
  | 'EMAIL_ALREADY_APPROVED'

export class UserDomainError extends Error {
  constructor(public readonly code: UserDomainErrorCode) {
    super(code)
    this.name = 'UserDomainError'
  }
}

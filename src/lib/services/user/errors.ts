export type UserDomainErrorCode =
  | 'NOT_FOUND'
  | 'TARGET_DELETED'
  | 'CANNOT_ACT_ON_SELF'
  | 'LAST_ADMIN'
  // Resend attempted on a user who already completed sign-in (emailVerified).
  | 'ALREADY_ACCEPTED'
  // Invite attempted for an email that already belongs to a user (active or
  // soft-deleted) — the admin should resend or restore instead.
  | 'EMAIL_TAKEN'

export class UserDomainError extends Error {
  constructor(public readonly code: UserDomainErrorCode) {
    super(code)
    this.name = 'UserDomainError'
  }
}

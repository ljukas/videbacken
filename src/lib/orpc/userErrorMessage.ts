import type { UserDomainErrorCode } from '~/lib/services/user'
import { m } from '~/paraglide/messages'

// User procedures throw code-only oRPC typed errors (see procedures/user.ts); the
// client owns user-error i18n. `import type` is erased at build, so this pulls only
// the code union — no server runtime leaks into the client bundle. The exhaustive
// switch makes a missing case a compile error.
/**
 * Localize a typed user error code. `selfAction` picks the phrasing for the single
 * contextual code `CANNOT_ACT_ON_SELF` — "can't delete yourself" in the delete
 * flow vs "can't demote yourself" in the update flow (the dialog knows which).
 */
export function userErrorMessage(
  code: UserDomainErrorCode,
  selfAction: 'delete' | 'demote' = 'demote',
): string {
  switch (code) {
    case 'NOT_FOUND':
      return m.user_error_not_found()
    case 'TARGET_DELETED':
      return m.user_error_target_deleted()
    case 'CANNOT_ACT_ON_SELF':
      return selfAction === 'delete' ? m.user_error_delete_self() : m.user_error_demote_self()
    case 'LAST_ADMIN':
      return m.user_error_last_admin()
    case 'ALREADY_ACCEPTED':
      return m.user_error_already_accepted()
    case 'EMAIL_TAKEN':
      return m.user_error_email_taken()
  }
}

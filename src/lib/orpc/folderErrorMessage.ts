import type { FolderDomainErrorCode } from '~/lib/services/folder'
import { m } from '~/paraglide/messages'

// Folder procedures throw code-only oRPC typed errors (see procedures/folder.ts);
// the client owns folder-error i18n. `import type` is erased at build, so this
// pulls only the code union — no server runtime leaks into the client bundle.
// The exhaustive switch makes a missing case a compile error.
/** Localize a typed folder error code. */
export function folderErrorMessage(code: FolderDomainErrorCode): string {
  switch (code) {
    case 'NOT_FOUND':
      return m.folder_error_not_found()
    case 'NOT_ADMIN':
      return m.common_error_admin_only()
    case 'NAME_TAKEN_IN_PARENT':
      return m.folder_error_name_taken()
    case 'INVALID_NAME':
      return m.folder_error_invalid_name()
    case 'PARENT_NOT_FOUND':
      return m.folder_error_parent_not_found()
    case 'CANNOT_MOVE_INTO_DESCENDANT':
      return m.folder_error_move_into_descendant()
    case 'ALREADY_DELETED':
      return m.folder_error_already_deleted()
    case 'NOT_DELETED':
      return m.folder_error_not_deleted()
    case 'PARENT_DELETED':
      return m.folder_error_parent_deleted()
  }
}

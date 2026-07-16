import type { DocumentDomainErrorCode } from '~/lib/services/document'
import { m } from '~/paraglide/messages'

// Document procedures throw code-only oRPC typed errors (see procedures/document.ts);
// the client owns document-error i18n. `import type` is erased at build, so this
// pulls only the code union — no server runtime leaks into the client bundle.
// The exhaustive switch makes a missing case a compile error.
/** Localize a typed document error code. */
export function documentErrorMessage(code: DocumentDomainErrorCode): string {
  switch (code) {
    case 'NOT_FOUND':
      return m.document_error_not_found()
    case 'NOT_ADMIN':
      return m.common_error_admin_only()
    case 'NOT_DELETED':
      return m.document_error_not_deleted()
    case 'CANNOT_DELETE_OTHERS_DOCUMENT':
      return m.document_error_delete_others()
    case 'CANNOT_EDIT_OTHERS_DOCUMENT':
      return m.document_error_edit_others()
    case 'FOLDER_NOT_FOUND':
      return m.folder_error_not_found()
    case 'FOLDER_DELETED':
      return m.folder_error_deleted()
  }
}

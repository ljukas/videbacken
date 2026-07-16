export type DocumentDomainErrorCode =
  | 'NOT_FOUND'
  | 'NOT_ADMIN'
  | 'NOT_DELETED'
  | 'CANNOT_DELETE_OTHERS_DOCUMENT'
  | 'CANNOT_EDIT_OTHERS_DOCUMENT'
  | 'FOLDER_NOT_FOUND'
  | 'FOLDER_DELETED'

export class DocumentDomainError extends Error {
  constructor(public readonly code: DocumentDomainErrorCode) {
    super(code)
    this.name = 'DocumentDomainError'
  }
}

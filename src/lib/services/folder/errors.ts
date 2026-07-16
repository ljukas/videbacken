export type FolderDomainErrorCode =
  | 'NOT_FOUND'
  | 'NOT_ADMIN'
  | 'NAME_TAKEN_IN_PARENT'
  | 'INVALID_NAME'
  | 'PARENT_NOT_FOUND'
  | 'CANNOT_MOVE_INTO_DESCENDANT'
  | 'ALREADY_DELETED'
  | 'NOT_DELETED'
  | 'PARENT_DELETED'

export class FolderDomainError extends Error {
  constructor(public readonly code: FolderDomainErrorCode) {
    super(code)
    this.name = 'FolderDomainError'
  }
}

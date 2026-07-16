export type FileDomainErrorCode = 'NOT_FOUND'

export class FileDomainError extends Error {
  constructor(public readonly code: FileDomainErrorCode) {
    super(code)
    this.name = 'FileDomainError'
  }
}

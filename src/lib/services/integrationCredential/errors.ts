export type IntegrationCredentialDomainErrorCode =
  // An unknown field name for the source, or a value that fails its field's validation.
  | 'INVALID_FIELD'
  // Every provided field was blank: nothing would change.
  | 'NOTHING_TO_SAVE'
  // CREDENTIALS_ENCRYPTION_KEY is unset or malformed, so nothing can be encrypted.
  | 'ENCRYPTION_KEY_MISSING'

export class IntegrationCredentialDomainError extends Error {
  constructor(
    readonly code: IntegrationCredentialDomainErrorCode,
    readonly field?: string,
  ) {
    // The field name only — never its value.
    super(code === 'INVALID_FIELD' && field ? `${code} (${field})` : code)
    this.name = 'IntegrationCredentialDomainError'
  }
}

export type IntegrationCredentialDomainErrorCode =
  // Unknown field names for the source, or values that fail their field's validation; `fields` lists them all.
  | 'INVALID_FIELD'
  // Every provided field was blank: nothing would change.
  | 'NOTHING_TO_SAVE'
  // CREDENTIALS_ENCRYPTION_KEY is unset or malformed, so nothing can be encrypted.
  | 'ENCRYPTION_KEY_MISSING'
  // The stored row can't be read and the save left fields blank (`fields`): they would
  // silently fall back to env, so every field of the source must be entered again.
  | 'REENTER_ALL_FIELDS'

export class IntegrationCredentialDomainError extends Error {
  constructor(
    readonly code: IntegrationCredentialDomainErrorCode,
    readonly fields: readonly string[] = [],
  ) {
    // Field names only — never a value.
    super(fields.length > 0 ? `${code} (${fields.join(', ')})` : code)
    this.name = 'IntegrationCredentialDomainError'
  }
}

import type { CredentialFieldName } from '~/lib/integrationCredentials'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'

/**
 * Base class for every pulled-integration client's error (ADR-0019). A sync run
 * treats any `IntegrationError` as the remote side failing — outcome `failed`
 * with this `code` — and anything else as a bug in our own code (`error`,
 * recorded as `internal_error` and rethrown).
 *
 * Subclasses keep the same message discipline as `ZaptecError`: written for an
 * admin, never carrying credentials, tokens or payload values.
 */
export abstract class IntegrationError extends Error {
  abstract readonly code: IntegrationErrorCode
  /**
   * The credential fields the vendor's answer points at (Skoda 404 -> `vin`), by name only
   * (ADR-0026); unset when it points at none. Recorded with the run as `suspect_fields`.
   */
  readonly suspectFields?: readonly CredentialFieldName[]

  constructor(
    message: string,
    options?: { cause?: unknown; suspectFields?: readonly CredentialFieldName[] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    if (options?.suspectFields?.length) this.suspectFields = options.suspectFields
  }
}

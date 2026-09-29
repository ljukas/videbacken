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
}

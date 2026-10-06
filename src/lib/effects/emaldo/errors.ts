import type { CredentialField } from '~/lib/integrationCredentials'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type EmaldoOp = 'login' | 'discover' | 'stats'

/**
 * The one error the Emaldo client throws. `status` is the HTTP status when
 * there was one; the API's own `Status` code may appear in the message.
 * Messages are written for an admin and never carry the credentials, the app
 * id or secret, the token, home or device ids, or any reading.
 */
export class EmaldoError extends IntegrationError {
  override readonly name = 'EmaldoError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: EmaldoOp,
    readonly status?: number,
    options?: {
      cause?: unknown
      message?: string
      /** The Emaldo credential fields this answer points at (names only). */
      suspectFields?: readonly CredentialField<'emaldo'>[]
    },
  ) {
    super(
      options?.message ??
        `Emaldo ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      { cause: options?.cause, suspectFields: options?.suspectFields },
    )
  }
}

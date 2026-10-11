import type { CredentialField } from '~/lib/integrationCredentials'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type ComfortCloudOp = 'login' | 'units' | 'history'

/** The credential fields a Comfort Cloud answer can point at. */
export type ComfortCloudCredentialField = CredentialField<'comfortCloud'>

/**
 * The one error the Comfort Cloud client throws. `status` is the HTTP status when there was one.
 * Messages are written for an admin and never carry the user, the password, a token or code, the
 * api key, the client id, a unit guid, raw HTML/JSON or any reading.
 */
export class ComfortCloudError extends IntegrationError {
  override readonly name = 'ComfortCloudError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: ComfortCloudOp,
    readonly status?: number,
    options?: {
      cause?: unknown
      message?: string
      suspectFields?: readonly ComfortCloudCredentialField[]
    },
  ) {
    super(
      options?.message ??
        `Comfort Cloud ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      { cause: options?.cause, suspectFields: options?.suspectFields },
    )
  }
}

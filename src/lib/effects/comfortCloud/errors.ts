import type { CredentialField } from '~/lib/integrationCredentials'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type ComfortCloudOp = 'login' | 'units' | 'history'

/** The credential fields a Comfort Cloud answer can point at. */
export type ComfortCloudCredentialField = CredentialField<'comfortCloud'>

/**
 * The error the Comfort Cloud client throws (a day's own bad rows: the `ComfortCloudDayError`
 * subclass). `status` is the HTTP status when there was one. Messages are written for an admin
 * and never carry the user, the password, a token or code, the api key, the client id, a unit
 * guid, raw HTML/JSON or any reading.
 */
export class ComfortCloudError extends IntegrationError {
  override readonly name: string = 'ComfortCloudError'

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

/**
 * A day answer whose own rows are bad: a row outside the requested UTC day, a repeated hour, a
 * row of the wrong shape. It is about that one day, so the sync rejects the day and goes on.
 * Everything else — the envelope, a body that isn't JSON, an HTTP status, the account's
 * settings — stays a plain `ComfortCloudError` and fails the run: passing over a day for an
 * account-wide failure would walk the backfill below real history.
 */
export class ComfortCloudDayError extends ComfortCloudError {
  override readonly name = 'ComfortCloudDayError'

  /** `message` follows the base rules: no value, no guid. */
  constructor(message: string) {
    super('unexpected_response', 'history', undefined, { message })
  }
}

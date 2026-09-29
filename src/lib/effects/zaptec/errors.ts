import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type ZaptecOp = 'token' | 'chargers' | 'sessions' | 'state'

/**
 * The one error the Zaptec client throws. `code` is the integration-health
 * vocabulary the sync run records; `op` says which call failed; `status` is the
 * HTTP status when there was one.
 *
 * Messages are written for an admin and never carry the password, the token,
 * the form body or any payload value. `cause` is only ever set to a network
 * error's `{ name, code }` — never the raw error, whose message may echo the
 * request.
 */
export class ZaptecError extends IntegrationError {
  override readonly name = 'ZaptecError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: ZaptecOp,
    readonly status?: number,
    options?: { cause?: unknown; message?: string },
  ) {
    super(
      options?.message ??
        `Zaptec ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
  }
}

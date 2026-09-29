import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type ElprisOp = 'prices'

/**
 * The one error the elpris client throws. `code` is the integration-health
 * vocabulary the sync run records; `status` is the HTTP status when there was
 * one.
 *
 * Messages are written for an admin and never carry a price or any other
 * payload value. `cause` is only ever a network error's `{ name, code }`.
 */
export class ElprisError extends IntegrationError {
  override readonly name = 'ElprisError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: ElprisOp,
    readonly status?: number,
    options?: { cause?: unknown; message?: string },
  ) {
    super(
      options?.message ??
        `elpris ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
  }
}

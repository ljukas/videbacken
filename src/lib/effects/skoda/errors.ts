import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type SkodaOp = 'vehicle'

/**
 * The one error the Škoda client throws. Messages are written for an admin and
 * never carry the API key, the VIN, a position or any payload value (the
 * request URL contains the VIN, so network errors keep only `networkCause`).
 */
export class SkodaError extends IntegrationError {
  override readonly name = 'SkodaError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: SkodaOp,
    readonly status?: number,
    options?: { cause?: unknown; message?: string },
  ) {
    super(
      options?.message ??
        `Škoda ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
  }
}

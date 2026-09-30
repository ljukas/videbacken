import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type EltariffOp = 'catalogue'

/**
 * The one error the Eltariff catalogue client throws. `code` is the
 * integration-health vocabulary; `status` is the HTTP status when there was
 * one. Messages never carry payload values. `cause` is only ever a network
 * error's `{ name, code }`.
 */
export class EltariffError extends IntegrationError {
  override readonly name = 'EltariffError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: EltariffOp,
    readonly status?: number,
    options?: { cause?: unknown; message?: string },
  ) {
    super(
      options?.message ??
        `eltariff ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
  }
}

export type GeocoderErrorCode =
  | 'not_configured'
  | 'rate_limited'
  | 'unreachable'
  | 'forbidden'
  | 'unexpected_response'

/**
 * The one error the geocoder throws. Messages and `cause` never carry the
 * query or a result: the address searched for is the household's. `cause` is
 * only ever a network error's `{ name, code }`.
 */
export class GeocoderError extends Error {
  override readonly name = 'GeocoderError'

  constructor(
    readonly code: GeocoderErrorCode,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(
      `geocoder search failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
  }
}

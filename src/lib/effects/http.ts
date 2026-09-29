// Small, dependency-free HTTP helpers shared by the pulled-integration clients
// (Zaptec, elpris). The retry loops themselves stay per client until a third
// consumer (Škoda) shows what they really share.

/** Keeps only a network error's `name` and `code` — its message may echo the request. */
export function networkCause(err: unknown): { name: string; code?: string } {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null
  const name = typeof e?.name === 'string' ? e.name : 'Error'
  const code =
    typeof e?.code === 'string'
      ? e.code
      : typeof e?.cause?.code === 'string'
        ? e.cause.code
        : undefined
  return code === undefined ? { name } : { name, code }
}

/** Releases an unread response body (so the connection can be reused). */
export async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // ignore — the body is unused
  }
}

/** A `Retry-After` header (seconds or HTTP date) as ms from `nowMs`; null when absent/unparseable. */
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null || header.trim() === '') return null
  const trimmed = header.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs)
}

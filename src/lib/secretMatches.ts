import { timingSafeEqual } from 'node:crypto'

/**
 * Whether a caller-provided shared secret (a webhook token, a cron bearer
 * token) equals the server's. Constant-time, so a wrong secret can't be probed
 * by timing; false when no server secret is configured (fail closed). Server
 * only.
 */
export function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || provided == null) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

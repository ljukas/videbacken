import { DrizzleQueryError } from 'drizzle-orm'

export const MAX_ERROR_MESSAGE_LENGTH = 500

// Error messages from third-party calls end up in `integration_sync` and
// `integration_sync_run` (and on the admin dashboard). Before writing: turn
// control characters into spaces (so a newline can't hide a token boundary),
// redact bearer tokens and `password=` values, and truncate to the column's
// 500-char CHECK. Truncation is by code point (Postgres `char_length`), so a
// surrogate pair is never split.
export function sanitizeErrorMessage(message: string): string {
  const cleaned = message
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/password=\S+/gi, 'password=<redacted>')
    .trim()
  const codePoints = Array.from(cleaned)
  return codePoints.length > MAX_ERROR_MESSAGE_LENGTH
    ? codePoints.slice(0, MAX_ERROR_MESSAGE_LENGTH).join('')
    : cleaned
}

// The stored message for an unexpected (non-integration) error. A failed
// drizzle query's own message is the SQL plus its bound params (session emails
// and names); the Postgres error that actually explains it is the `cause`. A
// data exception (SQLSTATE class 22, e.g. invalid input syntax) quotes the
// offending value in its message, so for those only the code is kept.
export function internalErrorMessage(error: unknown): string {
  if (error instanceof DrizzleQueryError) {
    const cause = error.cause as (Error & { code?: unknown }) | undefined
    if (!cause) return 'Database query failed'
    if (typeof cause.code !== 'string') return `Database query failed: ${cause.message}`
    if (cause.code.startsWith('22')) return `Database query failed (SQLSTATE ${cause.code})`
    return `Database query failed (SQLSTATE ${cause.code}): ${cause.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

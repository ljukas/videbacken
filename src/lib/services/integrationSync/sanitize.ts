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

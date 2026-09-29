// Validation issues rendered for logs and error messages by *where* they are,
// never by what the input held: payloads and submitted input can carry
// credentials, personal data and prices. (zod's `prettifyError` is not used for
// this — it prints each issue's message, which a custom check may fill with the
// input, and it lists every issue unbounded.)

/** Most distinct paths `summarizeIssuePaths` names before it just counts. */
const SHOWN_PATHS = 10

/**
 * A Standard Schema issue path as a dotted string (`sessions.3.energy`); `''`
 * at the root. Segments may be bare keys or `{ key }` objects.
 */
export function issuePath(path: readonly unknown[]): string {
  return path
    .map((seg) => (typeof seg === 'object' && seg !== null && 'key' in seg ? seg.key : seg))
    .map(String)
    .join('.')
}

/**
 * Distinct dotted paths (the root as `(root)`), the first 10 comma-joined,
 * then `(+N more)` — bounded however many issues a payload produced.
 */
export function summarizeIssuePaths(paths: readonly string[]): string {
  const distinct = [...new Set(paths.map((p) => p || '(root)'))]
  const shown = distinct.slice(0, SHOWN_PATHS).join(', ')
  const more = distinct.length - SHOWN_PATHS
  return more > 0 ? `${shown} (+${more} more)` : shown
}

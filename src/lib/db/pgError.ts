// Server-only. Recognises a Postgres constraint violation on one named constraint — the
// backstop a service maps to its own domain error. Drizzle wraps the node-postgres error as
// the `cause` of a `DrizzleQueryError`, so both levels are checked.
function isViolation(error: unknown, sqlState: string, constraint: string): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (pg.code === sqlState && pg.constraint === constraint) return true
    e = pg.cause
  }
  return false
}

/** A unique violation (SQLSTATE 23505): a check-first test lost a race. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, '23505', constraint)
}

/** A foreign-key violation (SQLSTATE 23503): the row points at one that doesn't exist. */
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, '23503', constraint)
}

/**
 * " (Postgres <code>, <constraint>)" from a pg error under drizzle's wrapper, or "". Never the
 * message, detail or parameters: drizzle quotes every bound value and pg's detail the failing row.
 */
export function pgErrorSummary(error: unknown): string {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof pg.code === 'string') {
      const constraint = typeof pg.constraint === 'string' ? `, ${pg.constraint}` : ''
      return ` (Postgres ${pg.code}${constraint})`
    }
    e = pg.cause
  }
  return ''
}

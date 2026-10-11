// Server-only. Recognises a Postgres unique violation (SQLSTATE 23505) on one
// named constraint — the backstop a service maps to its own domain error when
// a check-first test lost a race. Drizzle wraps the node-postgres error as the
// `cause` of a `DrizzleQueryError`, so both levels are checked.
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (pg.code === '23505' && pg.constraint === constraint) return true
    e = pg.cause
  }
  return false
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

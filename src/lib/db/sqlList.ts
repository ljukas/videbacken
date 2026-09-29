import { sql } from 'drizzle-orm'

// Renders a JS string array as a literal, comma-separated SQL `IN (...)` list,
// so each CHECK constraint's allowed values stay single-sourced with the
// exported const array (never a duplicated literal list in the DDL). Must use
// `sql.raw` (not `sql`/`sql.join`'s value interpolation): CHECK constraints are
// static DDL text, not a parameterized query — interpolating values there emits
// `$1, $2, …` placeholders with no bind values, which is invalid in a migration.
export function sqlList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', '))
}

import 'dotenv/config'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { __testClient } from '~/lib/db'

// Concatenate every migration's statements into one SQL string with `"public".`
// stripped, so `search_path` resolves all references to the per-test schema.
// drizzle-kit emits no BEGIN/COMMIT in migrations, so a single parameterless
// `query()` (simple-query protocol) runs them all in its implicit transaction.
const MIGRATIONS_SQL = readMigrationFiles({ migrationsFolder: './drizzle' })
  .flatMap((m) => m.sql)
  .map((stmt) => stmt.replace(/"public"\./g, ''))
  .join(';\n')

export function setupDatabase() {
  const url = process.env.DATABASE_URL ?? ''
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1')
  if (!isLocal && process.env.CI !== 'true') {
    throw new Error(
      `Refusing to run tests against non-local DATABASE_URL outside CI. Got: ${url || '<unset>'}. ` +
        `Tests CREATE/DROP schemas — locally they must only run against the local Postgres container. ` +
        `Run \`bun run db:up\` for local testing.`,
    )
  }
  if (!__testClient) {
    throw new Error(
      'TEST_SCHEMA env var must be set before db/index.ts loads — check vite.config.ts',
    )
  }
  const pool = __testClient

  const POOL_ID = process.env.VITEST_POOL_ID ?? String(process.pid)
  const SCHEMA_PREFIX = `test_w${POOL_ID}_`

  let counter = 0
  let currentSchema: string | null = null

  // The pool is pinned to one connection, but pg-pool discards a connection
  // whose query failed (e.g. a deliberate constraint violation) and opens a
  // new one. `search_path` is per-session, so the replacement would silently
  // run the rest of the test against `public`. pg-pool reads `pool.options`
  // for every new client, so set the startup `search_path` there (and clear it
  // in afterEach): a replacement connection starts on the test schema with no
  // extra query. Schema names are `test_w<id>_<n>`, safe unquoted in `-c`.
  const setStartupSchema = (schema: string | null) => {
    pool.options.options = schema ? `-c search_path=${schema},public` : undefined
  }

  beforeAll(async () => {
    // Drop any straggler schemas from a crashed prior run in this worker.
    const { rows: stragglers } = await pool.query<{ nspname: string }>(
      'SELECT nspname FROM pg_namespace WHERE nspname LIKE $1',
      [`${SCHEMA_PREFIX}%`],
    )
    for (const { nspname } of stragglers) {
      await pool.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`)
    }
  })

  beforeEach(async () => {
    counter += 1
    const schema = `${SCHEMA_PREFIX}${counter}`
    currentSchema = schema
    setStartupSchema(schema)
    // `public` stays on the search_path so extension objects installed there
    // resolve without each per-test schema reinstalling the extension.
    // Per-test tables/types take priority via the leading entry.
    await pool.query(
      `CREATE SCHEMA "${schema}";\nSET search_path TO "${schema}", public;\n${MIGRATIONS_SQL}`,
    )
  })

  afterEach(async () => {
    if (!currentSchema) return
    const schema = currentSchema
    currentSchema = null
    setStartupSchema(null)
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } catch {
      // Best-effort; beforeAll sweep on next run catches anything missed.
    }
  })

  afterAll(async () => {
    await pool.end()
  })
}

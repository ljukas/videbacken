import 'dotenv/config'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { __testClient } from '~/lib/db'

// Concatenate every migration's statements into one SQL string with `"public".`
// stripped, so `search_path` resolves all references to the per-test schema.
// drizzle-kit emits no BEGIN/COMMIT in migrations, so a single `unsafe()` call
// runs cleanly inside postgres-js's implicit simple-query transaction.
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
        `Run \`pnpm db:up\` for local testing.`,
    )
  }
  if (!__testClient) {
    throw new Error(
      'TEST_SCHEMA env var must be set before db/index.ts loads — check vite.config.ts',
    )
  }
  const sql = __testClient

  const POOL_ID = process.env.VITEST_POOL_ID ?? String(process.pid)
  const SCHEMA_PREFIX = `test_w${POOL_ID}_`

  let counter = 0
  let currentSchema: string | null = null

  beforeAll(async () => {
    // Drop any straggler schemas from a crashed prior run in this worker.
    const stragglers = await sql<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace WHERE nspname LIKE ${`${SCHEMA_PREFIX}%`}
    `
    for (const { nspname } of stragglers) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`)
    }
  })

  beforeEach(async () => {
    counter += 1
    const schema = `${SCHEMA_PREFIX}${counter}`
    currentSchema = schema
    // `public` stays on the search_path so pg_trgm (pinned to public — see
    // drizzle/0011_document_management.sql) resolves `gin_trgm_ops` and
    // `word_similarity` without each per-test schema reinstalling the
    // extension. Per-test tables/types take priority via the leading entry.
    await sql.unsafe(
      `CREATE SCHEMA "${schema}";\nSET search_path TO "${schema}", public;\n${MIGRATIONS_SQL}`,
    )
  })

  afterEach(async () => {
    if (!currentSchema) return
    const schema = currentSchema
    currentSchema = null
    try {
      await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
    } catch {
      // Best-effort; beforeAll sweep on next run catches anything missed.
    }
  })

  afterAll(async () => {
    await sql.end({ timeout: 5 })
  })
}

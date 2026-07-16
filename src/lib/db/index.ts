import { drizzle } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import * as schema from './schema'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set')
}

// In tests: pin to one connection so the `SET search_path` issued in
// `test/setup.ts` persists across every drizzle query and transaction. Local
// tests run against a plain Postgres container (Neon Local paused — see
// compose.yaml + vite.config.ts), so there's no pooler: connections are direct
// sessions and the single pinned connection (`max: 1`) keeps the SET alive.
const client = postgres(process.env.DATABASE_URL, {
  prepare: false,
  // In tests: silence Postgres NOTICEs (e.g. the "drop cascades to N other
  // objects" emitted by `afterEach`'s DROP SCHEMA CASCADE). Production keeps
  // postgres-js's default notice handling.
  ...(process.env.TEST_SCHEMA ? { max: 1, onnotice: () => {} } : {}),
})

export const db = drizzle({ client, schema, casing: 'snake_case' })

// Test-only handle. Undefined in production. `test/setup.ts` uses this to
// create per-test schemas on the same single connection the app's `db` uses,
// and calls `.end()` on teardown.
export const __testClient: Sql | undefined = process.env.TEST_SCHEMA ? client : undefined

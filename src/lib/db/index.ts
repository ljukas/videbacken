import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { logger } from '~/lib/logger/server'
import { resolvePooledUrl } from './connectionString'
import * as schema from './schema'

// `POSTGRES_URL` is the fallback the Supabase↔Vercel integration provisions;
// `DATABASE_URL` (local dev, CI, explicit override) wins. See connectionString.ts.
const connectionString = resolvePooledUrl()
if (!connectionString) {
  throw new Error('DATABASE_URL (or POSTGRES_URL) environment variable is not set')
}

// node-postgres, not postgres.js: postgres.js pipelines queries onto a busy
// connection, and Supabase's transaction pooler (Supavisor) drops the replies
// to pipelined queries — the query then hangs forever. /charging's SSR loader
// runs ~15 queries at once and hit it on every full page load (Vercel's 300 s
// timeout). node-postgres sends one query per connection and waits for its
// reply. Its unnamed statements are fine behind the transaction pooler.
//
// In tests: pin to one connection that never idles out, so the `SET
// search_path` issued in `test/setup.ts` persists across every drizzle query
// and transaction. Local tests run against a plain Postgres container (see
// compose.yaml + vite.config.ts), so there's no pooler: connections are direct
// sessions and the single pinned connection keeps the SET alive.
const pool = new Pool({
  connectionString,
  // Fail fast instead of waiting forever (node-postgres's default): a stalled
  // connect or pool checkout errors after 10 s, a query whose reply never
  // comes after 30 s — well inside Vercel's 300 s function timeout. Inside a
  // transaction a timed-out query leaves its client busy, so the rollback can
  // still wait; outside one the client is discarded.
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
  ...(process.env.TEST_SCHEMA ? { max: 1, idleTimeoutMillis: 0 } : {}),
})
// An idle client's socket error (the pooler closing an idle connection) is
// re-emitted on the pool; unhandled, it would crash the process. The pool has
// already discarded that client, so logging is all that's left to do.
pool.on('error', (error) => logger.warn('idle postgres client error', { error }))

// The pool's state for the `rpc timing` line (ADR-0025 §5): at a request's
// start, how many connections are open, idle, and how many checkouts wait.
// A burst that opens connections (total < 10, idle 0) and one that queues
// (waiting > 0) need different fixes. Counters only — not a query.
export const poolStats = () => ({
  poolTotal: pool.totalCount,
  poolIdle: pool.idleCount,
  poolWaiting: pool.waitingCount,
})
// Deliberately no `attachDatabasePool` (@vercel/functions): it `waitUntil`s
// idleTimeoutMillis + 100 ms (~10 s) after every query, so each ~100 ms poll
// would keep its Fluid instance billed ~100x longer (ADR-0018). Connections
// left idle on a suspended instance are closed by the pooler, as before.

export const db = drizzle({ client: pool, schema, casing: 'snake_case' })

/** A transaction handle, as `db.transaction`'s callback receives it. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** `db` or an open transaction: lets a caller compose service calls into one transaction. */
export type DbOrTx = typeof db | DbTransaction

// Test-only handle. Undefined in production. `test/setup.ts` uses this to
// create per-test schemas on the same single connection the app's `db` uses,
// and calls `.end()` on teardown.
export const __testClient: Pool | undefined = process.env.TEST_SCHEMA ? pool : undefined

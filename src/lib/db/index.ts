import { drizzle } from 'drizzle-orm/node-postgres'
import { logger } from '~/lib/logger/server'
import { resolvePooledUrl } from './connectionString'
import * as schema from './schema'
import { WarmPool, type WarmPoolConfig } from './warmPool'

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

// Connections a production instance keeps open between requests (ADR-0025 §5,
// roadmap step 8). pg's 10 s idle timeout emptied the pool before every 60 s
// poll and most navigations, and opening one costs ~17 ms alone, more inside a
// burst. 3 covers 278 of 280 measured bursts. pg-pool never closes an idle
// client while the pool holds `min` or fewer; the timeout still trims the rest.
export const POOL_WARM_MIN = 3

// A warm connection idle longer than this is discarded at checkout (WarmPool):
// held through a long suspension, it's likely dead. 5 min keeps the 60 s polls
// and a session's navigations warm, well inside the ~15 min the pooler takes to
// drop a connection whose heartbeats go unanswered.
export const POOL_MAX_IDLE_AGE_MS = 5 * 60_000

/**
 * The pool's options.
 * - Everywhere: fail fast instead of waiting forever (node-postgres's default).
 *   A stalled connect or pool checkout errors after 10 s, a query whose reply
 *   never comes after 30 s — well inside Vercel's 300 s function timeout.
 *   Inside a transaction a timed-out query leaves its client busy, so the
 *   rollback can still wait; outside one the client is discarded.
 * - Production: a warm minimum and its maximum idle age (above). Not in dev:
 *   the dev server re-creates this module's pool when a module it imports
 *   changes, and a minimum would keep every old pool's connections open.
 * - Tests: pin to one connection that never idles out, so the `SET
 *   search_path` issued in `test/setup.ts` persists across every drizzle query
 *   and transaction. Local tests run against a plain Postgres container (see
 *   compose.yaml + vite.config.ts), so there's no pooler: connections are
 *   direct sessions and the single pinned connection keeps the SET alive.
 */
export function poolOptions(
  connectionString: string,
  mode: { test: boolean; production: boolean },
): WarmPoolConfig {
  const base = { connectionString, connectionTimeoutMillis: 10_000, query_timeout: 30_000 }
  if (mode.test) return { ...base, max: 1, idleTimeoutMillis: 0 }
  return mode.production
    ? { ...base, min: POOL_WARM_MIN, maxIdleAgeMillis: POOL_MAX_IDLE_AGE_MS }
    : base
}

const pool = new WarmPool({
  ...poolOptions(connectionString, {
    test: Boolean(process.env.TEST_SCHEMA),
    production: process.env.NODE_ENV === 'production',
  }),
  onIdleCheckout: observeIdleCheckout,
})
// An idle client's socket error (the pooler closing an idle connection) is
// re-emitted on the pool; unhandled, it would crash the process. The pool has
// already discarded that client, so logging is all that's left to do.
pool.on('error', (error) => logger.warn('idle postgres client error', { error }))
// A checked-out client has no listener of its own: drizzle's transactions take
// one with `pool.connect()`, and pg emits 'error' when its socket dies. Unhandled,
// that is an uncaught exception, and Vercel retires the instance. pg has already
// failed the pending query with the same error, which its request logs, so the
// listener only keeps the event from being unhandled.
pool.on('connect', (client) => client.on('error', () => {}))

// The pool's state for the `rpc timing` line (ADR-0025 §5), at a request's
// start: open connections (connecting ones included), idle ones, and waiting
// checkouts. Counters only — not a query.
export const poolStats = () => ({
  poolTotal: pool.totalCount,
  poolIdle: pool.idleCount,
  poolWaiting: pool.waitingCount,
})

// What the pool did while a request was in flight: new physical connections
// opened, and the longest checkout queue seen. A start-of-request sample can't
// see either — a burst's requests all start before any of them queries — and
// they tell the two fixes apart: opening connections (keep them warm) vs
// queueing (pool size). Instance-wide: a request also counts its neighbours'
// activity, which is the burst it shares the pool with. The pool emits
// `release` before it hands the client to the next waiter, so a queue shows.
// Also the warm pool's checkouts (WarmPool, roadmap step 8): connections
// discarded as idle too long, and the longest a reused one had sat idle, so a
// dead-connection error can be read against how old its connection was.
type PoolWatch = { opened: number; peakWaiting: number; expired: number; reuseIdleMs: number }
const watches = new Set<PoolWatch>()
const sampleWaiting = () => {
  for (const watch of watches) watch.peakWaiting = Math.max(watch.peakWaiting, pool.waitingCount)
}
pool.on('connect', () => {
  for (const watch of watches) watch.opened += 1
  sampleWaiting()
})
pool.on('acquire', sampleWaiting)
pool.on('release', sampleWaiting)
function observeIdleCheckout(idleMs: number, expired: boolean) {
  for (const watch of watches) {
    if (expired) watch.expired += 1
    else watch.reuseIdleMs = Math.max(watch.reuseIdleMs, idleMs)
  }
}

/** Starts watching the pool; the returned function stops and reports. */
export function watchPool(): () => {
  poolOpened: number
  poolPeakWaiting: number
  poolExpired: number
  poolReuseIdleMs: number
} {
  const watch: PoolWatch = { opened: 0, peakWaiting: pool.waitingCount, expired: 0, reuseIdleMs: 0 }
  watches.add(watch)
  return () => {
    watches.delete(watch)
    return {
      poolOpened: watch.opened,
      poolPeakWaiting: watch.peakWaiting,
      poolExpired: watch.expired,
      poolReuseIdleMs: watch.reuseIdleMs,
    }
  }
}
// Deliberately no `attachDatabasePool` (@vercel/functions): it `waitUntil`s
// idleTimeoutMillis + 100 ms (~10 s) after every query, so each ~100 ms poll
// would keep its Fluid instance billed ~100x longer (ADR-0018), and it closes
// idle connections before suspension, the opposite of the warm minimum. Idle
// timers don't run on a suspended instance, so the connections idle at
// suspension stay open through it: always the POOL_WARM_MIN warm ones, plus any
// released in the 10 s before (up to `max`; bursts peak at 4). Each is a
// Supavisor client, which holds no Postgres connection in transaction mode.

export const db = drizzle({ client: pool, schema, casing: 'snake_case' })

/** A transaction handle, as `db.transaction`'s callback receives it. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** `db` or an open transaction: lets a caller compose service calls into one transaction. */
export type DbOrTx = typeof db | DbTransaction

// Test-only handle. Undefined in production. `test/setup.ts` uses this to
// create per-test schemas on the same single connection the app's `db` uses,
// and calls `.end()` on teardown.
export const __testClient: WarmPool | undefined = process.env.TEST_SCHEMA ? pool : undefined

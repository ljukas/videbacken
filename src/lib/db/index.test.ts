import { Pool, type PoolClient } from 'pg'
import { expect, test } from 'vitest'
import { __testClient, POOL_WARM_MIN, poolOptions } from '~/lib/db'

// A dropped reply or a half-open socket must fail fast, not hang the request
// until Vercel's 300 s timeout (the /charging 504s). node-postgres waits
// forever by default, both for a connection and for a query's reply.
test('the pool gives up on a stalled connection or query', () => {
  const options = __testClient?.options
  expect(options?.connectionTimeoutMillis).toBe(10_000)
  expect(options?.query_timeout).toBe(30_000)
})

const url = 'postgres://u:p@localhost:5432/db'

// Production keeps a warm minimum between requests (ADR-0025 §5, step 8): the
// polls are 60 s apart, and pg's 10 s idle timeout emptied the pool before each.
test('production keeps a warm minimum of three connections', () => {
  expect(poolOptions(url, { test: false, production: true })).toEqual({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    min: 3,
  })
  expect(POOL_WARM_MIN).toBe(3)
})

// The dev server re-creates the pool when a module db/index imports changes; a
// warm minimum would keep each old pool's connections open forever.
test('dev keeps no warm minimum', () => {
  expect(poolOptions(url, { test: false, production: false })).toEqual({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  })
})

// Tests pin one connection that never idles out, so `SET search_path` holds.
test('tests pin one connection that never idles out, whatever NODE_ENV says', () => {
  expect(poolOptions(url, { test: true, production: true })).toEqual({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    max: 1,
    idleTimeoutMillis: 0,
  })
})

// The pg-pool behaviour the warm minimum relies on: an idle client isn't closed
// while the pool holds `min` or fewer, and the idle timer re-checks the count
// when it fires, so a burst that opened 4 settles at 3. A pg-pool upgrade that
// changes this fails here. Real connections to the local Postgres.
test('a production pool settles at the warm minimum after a burst', async () => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is set for the node tests (vite.config.ts)')
  const pool = new Pool({
    ...poolOptions(connectionString, { test: false, production: true }),
    idleTimeoutMillis: 50,
  })
  try {
    const clients: PoolClient[] = await Promise.all(
      Array.from({ length: POOL_WARM_MIN + 1 }, () => pool.connect()),
    )
    for (const client of clients) client.release()
    expect(pool.totalCount).toBe(POOL_WARM_MIN + 1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(pool.totalCount).toBe(POOL_WARM_MIN)
    expect(pool.idleCount).toBe(POOL_WARM_MIN)
  } finally {
    await pool.end()
  }
})

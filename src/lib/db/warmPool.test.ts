import type { PoolClient } from 'pg'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WarmPool } from './warmPool'

// Real connections to the local Postgres; only `Date` is faked, so sockets and
// pg's own timers run as usual. A connection's backend pid tells reused from new.
const connectionString = process.env.DATABASE_URL
const maxIdleAgeMillis = 60_000
let pool: WarmPool
const onIdleCheckout = vi.fn<(idleMs: number, expired: boolean) => void>()

beforeEach(() => {
  if (!connectionString) throw new Error('DATABASE_URL is set for the node tests (vite.config.ts)')
  vi.useFakeTimers({ toFake: ['Date'] })
  onIdleCheckout.mockClear()
  pool = new WarmPool({ connectionString, min: 1, maxIdleAgeMillis, onIdleCheckout })
})

afterEach(async () => {
  vi.useRealTimers()
  await pool.end()
})

const pidQuery = 'select pg_backend_pid() as pid'
const backendPid = async (client: PoolClient | WarmPool = pool) =>
  (await client.query<{ pid: number }>(pidQuery)).rows[0].pid

// A frozen instance can't answer the pooler's heartbeats, so a connection held
// through a long suspension is likely dead. Only the wall clock sees that gap.
test('connect() discards an idle connection released longer ago than the cap', async () => {
  const first = await pool.connect()
  const stalePid = await backendPid(first)
  first.release()
  vi.setSystemTime(Date.now() + maxIdleAgeMillis + 1)

  const next = await pool.connect()
  try {
    expect(await backendPid(next)).not.toBe(stalePid)
    expect(pool.totalCount).toBe(1)
  } finally {
    next.release()
  }
})

// pg-pool's query() checks out through this.connect, as drizzle's plain queries do.
test('query() also skips an idle connection released longer ago than the cap', async () => {
  const stalePid = await backendPid()
  vi.setSystemTime(Date.now() + maxIdleAgeMillis + 1)

  expect(await backendPid()).not.toBe(stalePid)
  expect(pool.totalCount).toBe(1)
})

test('an idle connection released within the cap is reused', async () => {
  const pid = await backendPid()
  vi.setSystemTime(Date.now() + maxIdleAgeMillis)

  expect(await backendPid()).toBe(pid)
})

// The timing line counts discards and reused ages (checkpoint 8).
test('reports each checkout of an idle connection: its idle time, and whether it expired', async () => {
  await backendPid()
  expect(onIdleCheckout).not.toHaveBeenCalled()
  vi.setSystemTime(Date.now() + 500)
  await backendPid()
  expect(onIdleCheckout).toHaveBeenLastCalledWith(500, false)
  vi.setSystemTime(Date.now() + maxIdleAgeMillis + 1)
  await backendPid()
  expect(onIdleCheckout).toHaveBeenCalledWith(maxIdleAgeMillis + 1, true)
  expect(onIdleCheckout).toHaveBeenCalledTimes(2)
})

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

// A cold instance's first request opens the warm connections while its route
// modules load, so the first checkouts find them idle (server-latency row 8).
test('warmUp() opens connections up to `min` at once and leaves them idle', async () => {
  const warm = new WarmPool({ connectionString, min: 3 })
  try {
    expect(await warm.warmUp()).toBe(3)
    expect(warm.totalCount).toBe(3)
    expect(warm.idleCount).toBe(3)
  } finally {
    await warm.end()
  }
})

test('warmUp() opens only what `min` still lacks, and runs once', async () => {
  const warm = new WarmPool({ connectionString, min: 3 })
  try {
    await warm.query(pidQuery)
    expect(await warm.warmUp()).toBe(2)
    expect(warm.totalCount).toBe(3)
    expect(warm.warmUp()).toBeUndefined()
  } finally {
    await warm.end()
  }
})

test('warmUp() does nothing without `min` (dev and tests)', async () => {
  const cold = new WarmPool({ connectionString })
  try {
    expect(cold.warmUp()).toBeUndefined()
    expect(cold.totalCount).toBe(0)
  } finally {
    await cold.end()
  }
})

test('warmUp() does nothing while a warm-up is still in flight', async () => {
  const warm = new WarmPool({ connectionString, min: 2 })
  try {
    const first = warm.warmUp()
    expect(warm.warmUp()).toBeUndefined()
    expect(await first).toBe(2)
  } finally {
    await warm.end()
  }
})

test('a failed warmUp() rejects, and the next call tries again', async () => {
  // Port 1: nothing listens, so the connect is refused at once.
  const down = new WarmPool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', min: 2 })
  try {
    await expect(down.warmUp()).rejects.toThrow()
    expect(down.totalCount).toBe(0)
    await expect(down.warmUp()).rejects.toThrow()
  } finally {
    await down.end()
  }
})

// Module loading stalls the warm-up's handshakes, so a cold instance's first
// checkouts find its connections still opening. Opening more would leave the
// first request no faster and the pool twice its minimum.
test('a checkout during the warm-up waits for one of its connections', async () => {
  const warm = new WarmPool({ connectionString, min: 2 })
  try {
    const warming = warm.warmUp()
    const client = await warm.connect()
    expect(warm.totalCount).toBe(2)
    client.release()
    expect(await warming).toBe(2)
    expect(warm.totalCount).toBe(2)
  } finally {
    await warm.end()
  }
})

// A cold burst: each of its first checkouts takes a warm-up connection.
test('a burst of checkouts during the warm-up opens no more than `min`', async () => {
  const warm = new WarmPool({ connectionString, min: 3 })
  try {
    const warming = warm.warmUp()
    const clients = await Promise.all([warm.connect(), warm.connect(), warm.connect()])
    expect(warm.totalCount).toBe(3)
    for (const client of clients) client.release()
    expect(await warming).toBe(3)
  } finally {
    await warm.end()
  }
})

// More checkouts than connections: the rest take released ones or open their own.
test('a burst larger than `min` during the warm-up gets a connection each', async () => {
  const warm = new WarmPool({ connectionString, min: 3 })
  try {
    const warming = warm.warmUp()
    const clients = await Promise.all(Array.from({ length: 5 }, () => warm.connect()))
    expect(warm.totalCount).toBe(5)
    for (const client of clients) client.release()
    expect(await warming).toBe(3)
  } finally {
    await warm.end()
  }
})

// A retry after a failed warm-up can find an idle connection past its age.
test('warmUp() replaces an expired idle connection', async () => {
  const warm = new WarmPool({ connectionString, min: 3, maxIdleAgeMillis, onIdleCheckout })
  try {
    const stalePid = await backendPid(warm)
    vi.setSystemTime(Date.now() + maxIdleAgeMillis + 1)

    expect(await warm.warmUp()).toBe(2)
    expect(warm.totalCount).toBe(3)
    expect(warm.idleCount).toBe(3)
    expect(onIdleCheckout).toHaveBeenCalledWith(maxIdleAgeMillis + 1, true)
    const clients = await Promise.all([warm.connect(), warm.connect(), warm.connect()])
    try {
      const pids = await Promise.all(clients.map((client) => backendPid(client)))
      expect(pids).not.toContain(stalePid)
    } finally {
      for (const client of clients) client.release()
    }
  } finally {
    await warm.end()
  }
})

test('a checkout during a failing warm-up still tries its own connection', async () => {
  const down = new WarmPool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', min: 2 })
  try {
    // Both settled together: neither rejection may go unhandled across a tick.
    const [warming, checkout] = await Promise.allSettled([down.warmUp(), down.connect()])
    expect(warming.status).toBe('rejected')
    expect(checkout.status).toBe('rejected')
  } finally {
    await down.end()
  }
})

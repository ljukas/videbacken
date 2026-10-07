import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { __testClient, db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { poolStats, watchPool } from './index'

setupDatabase()

test('poolStats reports the pool’s connections and waiters', async () => {
  await db.select().from(user).limit(1)
  expect(poolStats()).toEqual({ poolTotal: 1, poolIdle: 1, poolWaiting: 0 })
})

// Tests pin the pool to one connection (src/lib/db), so a second checkout while
// a transaction holds it must wait: in use, not idle, one waiter.
test('poolStats tells in-use, idle and waiting connections apart', async () => {
  let duringTx: ReturnType<typeof poolStats> | undefined
  let queued: Promise<unknown> | undefined
  await db.transaction(async (tx) => {
    await tx.select().from(user).limit(1)
    queued = db.select().from(user).limit(1).execute()
    await new Promise((resolve) => setImmediate(resolve))
    duringTx = poolStats()
  })
  await queued
  expect(duringTx).toEqual({ poolTotal: 1, poolIdle: 0, poolWaiting: 1 })
  expect(poolStats()).toEqual({ poolTotal: 1, poolIdle: 1, poolWaiting: 0 })
})

// What the pool did while a request was in flight: a start-of-request sample
// can't see a queue that forms once the burst's queries begin.
test('watchPool reports the peak checkout queue during the watch', async () => {
  const stop = watchPool()
  let queued: Promise<unknown> | undefined
  await db.transaction(async (tx) => {
    await tx.select().from(user).limit(1)
    queued = db.select().from(user).limit(1).execute()
    await new Promise((resolve) => setImmediate(resolve))
  })
  await queued
  expect(stop()).toEqual({ poolOpened: 0, poolPeakWaiting: 1 })
})

test('watchPool counts connections opened during the watch, and stops counting after', async () => {
  const pool = __testClient
  if (!pool) throw new Error('tests run with the pinned test pool')
  const stop = watchPool()
  // A new physical connection is the pool's 'connect' event (a pinned test pool
  // never opens a second one, so emit it, with a stand-in client).
  pool.emit('connect', new EventEmitter())
  pool.emit('connect', new EventEmitter())
  expect(stop()).toEqual({ poolOpened: 2, poolPeakWaiting: 0 })
  const later = watchPool()
  expect(later()).toEqual({ poolOpened: 0, poolPeakWaiting: 0 })
})

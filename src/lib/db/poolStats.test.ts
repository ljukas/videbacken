import { expect, test } from 'vitest'
import { db, poolStats } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'

setupDatabase()

test('poolStats reports the pool’s connections and waiters', async () => {
  await db.select().from(user).limit(1)
  const stats = poolStats()
  expect(stats).toEqual({
    poolTotal: expect.any(Number),
    poolIdle: expect.any(Number),
    poolWaiting: expect.any(Number),
  })
  // The query above opened (and released) the pinned test connection.
  expect(stats.poolTotal).toBeGreaterThanOrEqual(1)
  expect(stats.poolWaiting).toBe(0)
})

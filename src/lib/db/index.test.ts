import { expect, test } from 'vitest'
import { __testClient } from '~/lib/db'

// A dropped reply or a half-open socket must fail fast, not hang the request
// until Vercel's 300 s timeout (the /charging 504s). node-postgres waits
// forever by default, both for a connection and for a query's reply.
test('the pool gives up on a stalled connection or query', () => {
  const options = __testClient?.options
  expect(options?.connectionTimeoutMillis).toBe(10_000)
  expect(options?.query_timeout).toBe(30_000)
})

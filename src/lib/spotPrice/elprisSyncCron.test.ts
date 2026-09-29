import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setupDatabase } from '~test/setup'

// Lets one test force an unexpected throw while the rest run the real sync
// (VITEST: the notConfigured elpris client) against the test DB.
const control = vi.hoisted(() => ({ throwFromSync: false }))
vi.mock('./sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync')>()
  return {
    ...actual,
    runElprisSync: (opts: Parameters<typeof actual.runElprisSync>[0]) =>
      control.throwFromSync
        ? Promise.reject(new Error('sync exploded'))
        : actual.runElprisSync(opts),
  }
})

import { handleElprisSyncCron } from './elprisSyncCron'

setupDatabase()

const SECRET = 'test-cron-secret'
const request = (auth?: string) =>
  new Request('http://localhost/api/cron/elpris-sync', {
    headers: auth ? { authorization: auth } : {},
  })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  control.throwFromSync = false
})
afterEach(() => {
  vi.unstubAllEnvs()
})

test('401 without the secret', async () => {
  expect((await handleElprisSyncCron(request())).status).toBe(401)
})

test('a failed run is still a 200 with its summary', async () => {
  const res = await handleElprisSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    outcome: 'failed',
    code: 'not_configured',
    daysFetched: 0,
    upserted: 0,
  })
})

test('an unexpected throw is a 500', async () => {
  control.throwFromSync = true
  expect((await handleElprisSyncCron(request(`Bearer ${SECRET}`))).status).toBe(500)
})

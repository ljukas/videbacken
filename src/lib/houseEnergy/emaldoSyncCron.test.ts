import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setupDatabase } from '~test/setup'

const control = vi.hoisted(() => ({ throwFromSync: false, okRun: false }))
vi.mock('./sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync')>()
  return {
    ...actual,
    runEmaldoSync: (opts: Parameters<typeof actual.runEmaldoSync>[0]) => {
      if (control.throwFromSync) return Promise.reject(new Error('sync exploded'))
      if (control.okRun)
        return Promise.resolve({
          outcome: 'ok',
          code: null,
          daysFetched: 32,
          bucketsStored: 9_000,
          backfillDaysLeft: 12,
        })
      return actual.runEmaldoSync(opts)
    },
  }
})

import { handleEmaldoSyncCron } from './emaldoSyncCron'

setupDatabase()

const SECRET = 'test-cron-secret'
const request = (auth?: string) =>
  new Request('http://localhost/api/cron/emaldo-sync', {
    headers: auth ? { authorization: auth } : {},
  })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  control.throwFromSync = false
  control.okRun = false
})
afterEach(() => {
  vi.unstubAllEnvs()
})

test('401 without the secret, or with a wrong one', async () => {
  expect((await handleEmaldoSyncCron(request())).status).toBe(401)
  expect((await handleEmaldoSyncCron(request('Bearer nope'))).status).toBe(401)
})

test('a not-configured run is still a 200 with its summary', async () => {
  const res = await handleEmaldoSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    outcome: 'failed',
    code: 'not_configured',
    daysFetched: 0,
    bucketsStored: 0,
    backfillDaysLeft: 0,
  })
})

test('an unexpected throw is a 500', async () => {
  control.throwFromSync = true
  expect((await handleEmaldoSyncCron(request(`Bearer ${SECRET}`))).status).toBe(500)
})

test('an ok run is a 200 with its counts', async () => {
  control.okRun = true
  const res = await handleEmaldoSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    outcome: 'ok',
    code: null,
    daysFetched: 32,
    bucketsStored: 9_000,
    backfillDaysLeft: 12,
  })
})

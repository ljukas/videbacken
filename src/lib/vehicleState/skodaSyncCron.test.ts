import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setupDatabase } from '~test/setup'

const control = vi.hoisted(() => ({ throwFromSync: false, okRun: false }))
vi.mock('./sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync')>()
  return {
    ...actual,
    runSkodaSync: (opts: Parameters<typeof actual.runSkodaSync>[0]) => {
      if (control.throwFromSync) return Promise.reject(new Error('sync exploded'))
      if (control.okRun) return Promise.resolve({ outcome: 'ok', code: null, stored: true })
      return actual.runSkodaSync(opts)
    },
  }
})

import { handleSkodaSyncCron } from './skodaSyncCron'

setupDatabase()

const SECRET = 'test-cron-secret'
const request = (auth?: string) =>
  new Request('http://localhost/api/cron/skoda-sync', {
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

test('401 without the secret', async () => {
  expect((await handleSkodaSyncCron(request())).status).toBe(401)
})

test('a not-configured run is still a 200 with its summary', async () => {
  const res = await handleSkodaSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ outcome: 'failed', code: 'not_configured', stored: false })
})

test('an unexpected throw is a 500', async () => {
  control.throwFromSync = true
  expect((await handleSkodaSyncCron(request(`Bearer ${SECRET}`))).status).toBe(500)
})

test('an ok run is a 200 with stored true', async () => {
  control.okRun = true
  const res = await handleSkodaSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ outcome: 'ok', code: null, stored: true })
})

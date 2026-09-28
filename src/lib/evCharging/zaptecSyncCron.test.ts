import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { logger } from '~/lib/logger/server'
import { setupDatabase } from '~test/setup'

// Lets one test force an unexpected throw while the rest run the real sync
// against the test DB.
const control = vi.hoisted(() => ({ throwFromSync: false }))
vi.mock('./sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync')>()
  return {
    ...actual,
    runZaptecSync: (opts: Parameters<typeof actual.runZaptecSync>[0]) =>
      control.throwFromSync
        ? Promise.reject(new Error('sync exploded'))
        : actual.runZaptecSync(opts),
  }
})

import { handleZaptecSyncCron, verifyCronSecret } from './zaptecSyncCron'

setupDatabase()

const SECRET = 'test-cron-secret'

describe('verifyCronSecret', () => {
  test('accepts the matching bearer token', () => {
    expect(verifyCronSecret(`Bearer ${SECRET}`, SECRET)).toBe(true)
  })

  test('rejects a missing header', () => {
    expect(verifyCronSecret(null, SECRET)).toBe(false)
  })

  test('rejects a wrong token of the same length', () => {
    expect(verifyCronSecret(`Bearer ${'x'.repeat(SECRET.length)}`, SECRET)).toBe(false)
  })

  test('rejects a wrong token of a different length', () => {
    expect(verifyCronSecret('Bearer nope', SECRET)).toBe(false)
  })

  test('rejects a non-Bearer scheme', () => {
    expect(verifyCronSecret(SECRET, SECRET)).toBe(false)
    expect(verifyCronSecret(`Basic ${SECRET}`, SECRET)).toBe(false)
  })

  test('fails closed when no secret is configured', () => {
    expect(verifyCronSecret('Bearer ', undefined)).toBe(false)
    expect(verifyCronSecret('Bearer ', '')).toBe(false)
    expect(verifyCronSecret(`Bearer ${SECRET}`, undefined)).toBe(false)
  })
})

describe('handleZaptecSyncCron', () => {
  const url = 'http://localhost/api/cron/zaptec-sync'
  const withAuth = (authorization?: string) =>
    new Request(url, { headers: authorization ? { authorization } : {} })

  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', SECRET)
    control.throwFromSync = false
    // The handler logs through a request child of the global logger; keep the
    // run line out of the test output.
    vi.spyOn(logger, 'child').mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test('401 without an Authorization header', async () => {
    const res = await handleZaptecSyncCron(withAuth())
    expect(res.status).toBe(401)
  })

  test('401 with a wrong secret', async () => {
    const res = await handleZaptecSyncCron(withAuth('Bearer wrong-secret'))
    expect(res.status).toBe(401)
  })

  test('401 when CRON_SECRET is unset, even with an empty bearer', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const res = await handleZaptecSyncCron(withAuth('Bearer '))
    expect(res.status).toBe(401)
  })

  test('200 with the correct secret (default notConfigured client → failed)', async () => {
    const res = await handleZaptecSyncCron(withAuth(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'failed', code: 'not_configured', upserted: 0 })
  })

  test('500 on an unexpected throw', async () => {
    control.throwFromSync = true
    const res = await handleZaptecSyncCron(withAuth(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
  })
})

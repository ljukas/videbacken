import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { handleCronRun } from './cron'
import type { RunBase } from './runPulledSync'

// `verifyCronSecret` is covered by src/lib/evCharging/zaptecSyncCron.test.ts
// (it is re-exported there); this covers the shared status mapping.

const SECRET = 'test-cron-secret'

type Run = RunBase & { upserted: number }

function fakeRun(overrides: Partial<Run>): Run {
  return {
    source: 'elpris',
    trigger: 'cron',
    outcome: 'ok',
    code: null,
    transition: 'none',
    startedAt: new Date(),
    since: null,
    syncedUntil: null,
    durationMs: 1,
    upserted: 0,
    ...overrides,
  }
}

function request(auth?: string) {
  return new Request('http://localhost/api/cron/x', {
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

test('rejects a request without the secret before running anything', async () => {
  const run = vi.fn()
  const res = await handleCronRun(request(), run)
  expect(res.status).toBe(401)
  expect(run).not.toHaveBeenCalled()
})

test('fails closed when no CRON_SECRET is configured', async () => {
  vi.stubEnv('CRON_SECRET', '')
  const run = vi.fn()
  const res = await handleCronRun(request(`Bearer ${SECRET}`), run)
  expect(res.status).toBe(401)
  expect(run).not.toHaveBeenCalled()
})

test.each([
  'ok',
  'failed',
  'skipped',
] as const)('a %s run is a 200 with its summary', async (outcome) => {
  const code = outcome === 'failed' ? 'unreachable' : null
  const res = await handleCronRun(request(`Bearer ${SECRET}`), async (log) => {
    expect(log.info).toBeTypeOf('function')
    return fakeRun({ outcome, code, upserted: 4 })
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ outcome, code, upserted: 4 })
})

test('an unexpected throw is a 500', async () => {
  const res = await handleCronRun(request(`Bearer ${SECRET}`), async () => {
    throw new Error('boom')
  })
  expect(res.status).toBe(500)
})

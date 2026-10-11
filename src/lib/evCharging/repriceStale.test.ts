import { expect, test, vi } from 'vitest'
import type { Logger } from '~/lib/logger'
import { listStale } from '~/lib/services/sessionCost'
import { insertSession as insertFixtureSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { PRICING_VERSION } from './cost'
import { repriceStale } from './repriceStale'

setupDatabase()

function fakeLog() {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  }
  return log
}

const insertSession = (startIso: string, endIso: string) =>
  insertFixtureSession({ startAt: new Date(startIso), endAt: new Date(endIso) })

test('prices every stale session and logs the run', async () => {
  await insertSession('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await insertSession('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')
  const log = fakeLog()
  const ms = await repriceStale({ trigger: 'zaptec', log })
  expect(Number.isInteger(ms)).toBe(true)
  expect(await listStale({ pricingVersion: PRICING_VERSION })).toEqual([])
  expect(log.info).toHaveBeenCalledWith('session costs repriced', {
    trigger: 'zaptec',
    stale: 2,
    written: 2,
    repriceMs: expect.any(Number),
  })
})

test('nothing stale: no log line', async () => {
  const log = fakeLog()
  await repriceStale({ trigger: 'elpris', log })
  expect(log.info).not.toHaveBeenCalled()
})

test('a failing reprice is a warning, never a throw', async () => {
  const log = fakeLog()
  await expect(
    repriceStale({
      trigger: 'tariff',
      log,
      reprice: async () => {
        throw new Error('pricing bug')
      },
    }),
  ).resolves.toBeTypeOf('number')
  expect(log.warn).toHaveBeenCalledWith('session cost reprice failed', {
    trigger: 'tariff',
    error: expect.any(Error),
  })
})

test('a reprice past its budget is given up on with a warning', async () => {
  const log = fakeLog()
  await repriceStale({ trigger: 'emaldo', log, budgetMs: 10, reprice: () => new Promise(() => {}) })
  expect(log.warn).toHaveBeenCalledWith('session cost reprice failed', {
    trigger: 'emaldo',
    error: expect.objectContaining({
      message: 'session cost reprice did not finish within its budget',
    }),
  })
})

test("skipped once the run's deadline has fired", async () => {
  await insertSession('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const log = fakeLog()
  const reprice = vi.fn(async () => ({ stale: 0, written: 0 }))
  await repriceStale({ trigger: 'zaptec', log, signal: AbortSignal.abort(), reprice })
  expect(reprice).not.toHaveBeenCalled()
  expect(log.warn).toHaveBeenCalledWith('session cost reprice skipped: run deadline reached', {
    trigger: 'zaptec',
  })
})

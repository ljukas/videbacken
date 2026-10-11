import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { evSessionCost, evSessionCostMonth } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import * as evChargingService from '~/lib/services/evCharging'
import * as sessionCostService from '~/lib/services/sessionCost'
import { bumpSessions, listStale } from '~/lib/services/sessionCost'
import { insertSession as insertFixtureSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { PRICING_VERSION } from './cost'
import { getSessionCosts } from './costing'
import { repriceStale } from './repriceStale'

setupDatabase()

afterEach(() => {
  vi.restoreAllMocks()
})

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

test('nothing stale: the run is still logged', async () => {
  const log = fakeLog()
  await repriceStale({ trigger: 'elpris', log })
  expect(log.info).toHaveBeenCalledWith('session costs repriced', {
    trigger: 'elpris',
    stale: 0,
    written: 0,
    repriceMs: expect.any(Number),
  })
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

test('a failing write-back on the real path is a warning; the session stays stale', async () => {
  await insertSession('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const spy = vi
    .spyOn(sessionCostService, 'writePriced')
    .mockRejectedValueOnce(new Error('lock timeout'))
  const log = fakeLog()
  await expect(repriceStale({ trigger: 'zaptec', log })).resolves.toBeTypeOf('number')
  // The default lock timeout: an eager reprice isn't holding up a reader.
  expect(spy.mock.calls[0][0].lockTimeoutMs).toBeUndefined()
  expect(log.warn).toHaveBeenCalledWith('session cost reprice failed', {
    trigger: 'zaptec',
    error: expect.any(Error),
  })
  expect(await listStale({ pricingVersion: PRICING_VERSION })).toHaveLength(1)
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

const monthRowsOf = (sessionId: string) =>
  db.select().from(evSessionCostMonth).where(eq(evSessionCostMonth.sessionId, sessionId))
const stateOf = async (sessionId: string) =>
  (await db.select().from(evSessionCost).where(eq(evSessionCost.sessionId, sessionId)))[0]

test('a session bumped while it is being priced stays stale; nothing is written', async () => {
  const id = await insertSession('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const real = evChargingService.listSessionEnergy
  vi.spyOn(evChargingService, 'listSessionEnergy').mockImplementation(async (input) => {
    await bumpSessions([id]) // a writer commits between the generation read and the write-back
    return real(input)
  })
  const log = fakeLog()
  await repriceStale({ trigger: 'zaptec', log })
  expect(log.info).toHaveBeenCalledWith('session costs repriced', {
    trigger: 'zaptec',
    stale: 1,
    written: 0,
    repriceMs: expect.any(Number),
  })
  expect(await listStale({ pricingVersion: PRICING_VERSION })).toEqual([
    { sessionId: id, generation: 1 },
  ])
  expect(await monthRowsOf(id)).toEqual([])
})

test('only the stale session is repriced; the current one is left as stored', async () => {
  const current = await insertSession('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await repriceStale({ trigger: 'zaptec', log: fakeLog() })
  const currentState = await stateOf(current)
  const currentMonths = await monthRowsOf(current)
  const stale = await insertFixtureSession({
    startAt: new Date('2026-09-02T10:00:00Z'),
    endAt: new Date('2026-09-02T11:00:00Z'),
    energyKwh: 7,
  })

  const log = fakeLog()
  await repriceStale({ trigger: 'zaptec', log })
  expect(log.info).toHaveBeenCalledWith('session costs repriced', {
    trigger: 'zaptec',
    stale: 1,
    written: 1,
    repriceMs: expect.any(Number),
  })
  expect(await stateOf(current)).toEqual(currentState)
  expect(await monthRowsOf(current)).toEqual(currentMonths)
  const timings: Record<string, number> = {}
  const [cost] = await getSessionCosts({ sessionIds: [stale], timings })
  expect(timings.staleSessions).toBe(0)
  expect(cost).toMatchObject({ sessionId: stale, kwh: 7, estimated: true })
})

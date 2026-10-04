import { expect, test, vi } from 'vitest'
import type { Logger } from '~/lib/logger'
import type { deriveFrom } from './derive'
import { deriveAfterSync } from './deriveAfterSync'

/** The queue (`requestDerive`) stand-in: these tests don't touch the database. */
const request = vi.fn(async (_day: string) => {})

function fakeLog() {
  const warn = vi.fn()
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => log }
  return { log, warn }
}

test('no day: nothing derived, 0 ms', async () => {
  const derive = vi.fn<typeof deriveFrom>()
  const { log } = fakeLog()
  expect(await deriveAfterSync({ source: 'zaptec', fromDay: null, log, derive, request })).toBe(0)
  expect(derive).not.toHaveBeenCalled()
})

test("derives from the day with the run's logger and returns the time spent", async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => ({
    fromDay: '2026-09-28',
    days: 1,
    sessions: 1,
    deriveMs: 1,
  }))
  const { log } = fakeLog()
  const ms = await deriveAfterSync({
    source: 'elpris',
    fromDay: '2026-09-28',
    log,
    derive,
    request,
  })
  expect(derive).toHaveBeenCalledWith('2026-09-28', { log })
  expect(Number.isInteger(ms)).toBe(true)
})

test('a failing derive is a warning, never a throw', async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => {
    throw new Error('derive bug')
  })
  const { log, warn } = fakeLog()
  await expect(
    deriveAfterSync({ source: 'emaldo', fromDay: '2026-09-28', log, derive, request }),
  ).resolves.toBeTypeOf('number')
  expect(warn).toHaveBeenCalledWith('energy mix derive failed', {
    source: 'emaldo',
    fromDay: '2026-09-28',
    error: expect.any(Error),
  })
})

test('a derive past its budget is given up on with a warning', async () => {
  const derive = vi.fn<typeof deriveFrom>(() => new Promise(() => {}))
  const { log, warn } = fakeLog()
  const ms = await deriveAfterSync({
    source: 'zaptec',
    fromDay: '2026-09-28',
    log,
    derive,
    request,
    budgetMs: 50,
  })
  expect(ms).toBeLessThan(5_000)
  expect(warn).toHaveBeenCalledWith(
    'energy mix derive failed',
    expect.objectContaining({
      source: 'zaptec',
      error: expect.objectContaining({ message: expect.stringContaining('within its budget') }),
    }),
  )
})

test('queues the day before deriving, so a failed derive is retried by the next one', async () => {
  const order: string[] = []
  const queue = vi.fn(async (day: string) => {
    order.push(`request ${day}`)
  })
  const derive = vi.fn<typeof deriveFrom>(async (day) => {
    order.push(`derive ${day}`)
    return { fromDay: day, days: 1, sessions: 0, deriveMs: 1 }
  })
  const { log } = fakeLog()
  await deriveAfterSync({ source: 'emaldo', fromDay: '2026-09-28', log, derive, request: queue })
  expect(order).toEqual(['request 2026-09-28', 'derive 2026-09-28'])
})

test('a failing request is a warning; the derive still runs', async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => ({
    fromDay: '2026-09-28',
    days: 1,
    sessions: 0,
    deriveMs: 1,
  }))
  const failing = vi.fn(async () => {
    throw new Error('db down')
  })
  const { log, warn } = fakeLog()
  await deriveAfterSync({ source: 'zaptec', fromDay: '2026-09-28', log, derive, request: failing })
  expect(derive).toHaveBeenCalled()
  expect(warn).toHaveBeenCalledWith('energy mix derive request failed', {
    source: 'zaptec',
    fromDay: '2026-09-28',
    error: expect.any(Error),
  })
})

test('no day: nothing is queued', async () => {
  const queue = vi.fn(async () => {})
  const { log } = fakeLog()
  await deriveAfterSync({
    source: 'zaptec',
    fromDay: null,
    log,
    derive: vi.fn<typeof deriveFrom>(),
    request: queue,
  })
  expect(queue).not.toHaveBeenCalled()
})

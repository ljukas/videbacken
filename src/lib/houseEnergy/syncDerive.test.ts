import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { queue } from '~/lib/effects'
import { type EmaldoClient, EmaldoError } from '~/lib/effects/emaldo'
import { createServerLogger } from '~/lib/logger/server'
import { addDays, stockholmDayBounds } from '~/lib/time/stockholm'
import { insertSession } from '~test/fixtures/evCharging'
import { syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import type { deriveFrom } from './derive'
import { runEmaldoSync } from './sync'

setupDatabase()

const NOW = new Date('2026-09-28T12:00:00Z')
const TODAY = '2026-09-28'
const log = createServerLogger({ write: () => true })

/** Synthetic Emaldo: whole days (today up to NOW); throws on call `failOnCall` (1-based) or later. */
function fakeEmaldo(opts: { failOnCall?: number } = {}): EmaldoClient {
  let calls = 0
  return {
    async fetchDay(offset) {
      calls++
      if (opts.failOnCall !== undefined && calls >= opts.failOnCall) {
        throw new EmaldoError('unreachable', 'stats', 503)
      }
      const day = addDays(TODAY, offset)
      const { startMs, endMs } = stockholmDayBounds(day)
      return {
        dayStart: new Date(startMs),
        dayEnd: new Date(endMs),
        buckets: syntheticDay(day, () => ({ loadKwh: 0.1, gridImportKwh: 0.1 })).filter(
          (b) => b.bucketStart.getTime() < NOW.getTime(),
        ),
        droppedBuckets: 0,
      }
    },
  }
}
const deriveSpy = () =>
  vi.fn<typeof deriveFrom>(async () => ({ fromDay: null, days: 1, sessions: 0, deriveMs: 1 }))
const run = (client: EmaldoClient, derive: typeof deriveFrom) =>
  runEmaldoSync({
    trigger: 'cron',
    now: () => NOW,
    deps: { emaldo: client, log, sleep: async () => {}, deriveFrom: derive },
  })

beforeEach(() => {
  vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

test('a successful run re-derives from its earliest replaced day', async () => {
  const derive = deriveSpy()
  const result = await run(fakeEmaldo(), derive)
  expect(result.outcome).toBe('ok')
  expect(result.earliestReplacedDay).not.toBeNull()
  expect(derive).toHaveBeenCalledTimes(1)
  expect(derive).toHaveBeenCalledWith(result.earliestReplacedDay, { log })
  expect(typeof result.deriveMs).toBe('number')
})

test('days stored before a failure are still derived', async () => {
  const derive = deriveSpy()
  const result = await run(fakeEmaldo({ failOnCall: 2 }), derive)
  expect(result.outcome).toBe('failed')
  expect(result.earliestReplacedDay).not.toBeNull()
  expect(derive).toHaveBeenCalledWith(result.earliestReplacedDay, { log })
})

test('a run that stored nothing does not re-derive', async () => {
  const derive = deriveSpy()
  const result = await run(fakeEmaldo({ failOnCall: 1 }), derive)
  expect(result.outcome).toBe('failed')
  expect(derive).not.toHaveBeenCalled()
  expect(result.deriveMs).toBe(0)
})

test('a failed derive never fails the Emaldo run', async () => {
  const derive = vi.fn<typeof deriveFrom>(async () => {
    throw new Error('derive bug')
  })
  expect((await run(fakeEmaldo(), derive)).outcome).toBe('ok')
})

test('derives from the exact earliest day replaced: yesterday on a plain run', async () => {
  const derive = deriveSpy()
  await run(fakeEmaldo(), derive)
  expect(derive).toHaveBeenCalledTimes(1)
  expect(derive).toHaveBeenCalledWith('2026-09-27', { log })
})

test('a backfill derives from its oldest stored day', async () => {
  // A session on 09-20 starts the backfill 7 days earlier, on 09-13.
  await insertSession({
    startAt: new Date('2026-09-20T10:00:00Z'),
    endAt: new Date('2026-09-20T12:00:00Z'),
  })
  const derive = deriveSpy()
  await run(fakeEmaldo(), derive)
  expect(derive).toHaveBeenCalledWith('2026-09-13', { log })
})

test('a failing derive is warned about with the source, and a failed run keeps its code', async () => {
  const lines: string[] = []
  const capture = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  const result = await runEmaldoSync({
    trigger: 'cron',
    now: () => NOW,
    deps: {
      emaldo: fakeEmaldo({ failOnCall: 2 }),
      log: capture,
      sleep: async () => {},
      deriveFrom: async () => {
        throw new Error('derive bug')
      },
    },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
  const entries = lines
    .flatMap((l) => l.split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  expect(entries.find((e) => e.msg === 'energy mix derive failed')).toMatchObject({
    source: 'emaldo',
  })
})

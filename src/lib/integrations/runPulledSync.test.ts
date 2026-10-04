import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { integrationSync, user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import { IntegrationError } from '~/lib/effects/integrationError'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { createServerLogger } from '~/lib/logger/server'
import * as integrationSyncService from '~/lib/services/integrationSync'
import {
  beginAttempt,
  getHealth,
  getLastSuccessStartedAt,
  listRecentRuns,
} from '~/lib/services/integrationSync'
import { setupDatabase } from '~test/setup'
import { type RunBase, runPulledSync, withDeadline } from './runPulledSync'

setupDatabase()

// The lifecycle is exercised through a synthetic source ('elpris') with its own
// counters; Zaptec's own behavior is covered by sync.test.ts. (`RunStats` keeps
// its Zaptec-era column names — `sessionsSeen` here just carries `items`.)

const T0 = new Date('2026-09-20T10:00:00Z')

class FakeRemoteError extends IntegrationError {
  override readonly name = 'FakeRemoteError'
  constructor(readonly code: IntegrationErrorCode) {
    super(`remote failed: ${code}`)
  }
}

type FakeRun = RunBase & { items: number; finalized: boolean }

function capturingLogger() {
  const lines: string[] = []
  const log = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  const entries = () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown> & { msg: string; level: number })
  const runLines = () => entries().filter((e) => e.msg === 'integration sync run')
  return { log, entries, runLines }
}

const INFO = 30
const WARN = 40
const ERROR = 50

function run(
  execute: (ctx: {
    run: FakeRun
    signal: AbortSignal
    reportProgress: (done: number, total: number) => Promise<void>
  }) => Promise<void>,
  opts: {
    log?: ReturnType<typeof capturingLogger>['log']
    deadlineMs?: number
    now?: () => Date
  } = {},
) {
  let clock = T0.getTime()
  const now = () => {
    clock += 1000
    return new Date(clock)
  }
  return runPulledSync<FakeRun>({
    source: 'elpris',
    trigger: 'cron',
    now: opts.now ?? now,
    deadlineMs: opts.deadlineMs ?? 60_000,
    log: opts.log ?? capturingLogger().log,
    init: (base) => ({ ...base, items: 0, finalized: false }),
    execute,
    toRunStats: (r) => ({
      since: r.since,
      pages: 1,
      sessionsSeen: r.items,
      upserted: r.items,
      voided: 0,
      timings: { fetchMs: 5 },
    }),
    finalize: (r) => {
      r.finalized = true
    },
    logFields: (r) => ({ items: r.items, finalized: r.finalized }),
  })
}

let publish: MockInstance<typeof queue.publish>

beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('a successful run records ok health, a run row, and one info line with the source fields', async () => {
  const { log, runLines } = capturingLogger()

  const result = await run(
    async ({ run }) => {
      run.items = 3
    },
    { log },
  )

  expect(result).toMatchObject({ source: 'elpris', outcome: 'ok', code: null, items: 3 })
  const health = await getHealth('elpris', { now: T0, includeAdminDetail: true })
  expect(health.state).toBe('ok')
  const [row] = await listRecentRuns('elpris', { limit: 5 })
  expect(row).toMatchObject({ outcome: 'ok', sessionsSeen: 3, upserted: 3 })

  const lines = runLines()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    level: INFO,
    source: 'elpris',
    outcome: 'ok',
    items: 3,
    // `finalize` runs before the line is built.
    finalized: true,
  })
  expect(lines[0].durationMs).toBeTypeOf('number')
})

test('an IntegrationError is a recorded failure: warn line, code, no throw', async () => {
  const { log, runLines } = capturingLogger()

  const result = await run(
    async ({ run }) => {
      run.items = 1
      throw new FakeRemoteError('rate_limited')
    },
    { log },
  )

  expect(result).toMatchObject({ outcome: 'failed', code: 'rate_limited', items: 1 })
  const health = await getHealth('elpris', { now: T0, includeAdminDetail: true })
  expect(health).toMatchObject({ state: 'failing', code: 'rate_limited' })
  expect(health.adminDetail?.lastErrorMessage).toBe('remote failed: rate_limited')
  expect(runLines()).toEqual([expect.objectContaining({ level: WARN, code: 'rate_limited' })])
})

test('any other error is internal_error: recorded, logged at error, and rethrown', async () => {
  const { log, runLines } = capturingLogger()
  const bug = new TypeError('our bug')

  await expect(
    run(
      async () => {
        throw bug
      },
      { log },
    ),
  ).rejects.toBe(bug)

  const health = await getHealth('elpris', { now: T0, includeAdminDetail: false })
  expect(health).toMatchObject({ state: 'failing', code: 'internal_error' })
  const lines = runLines()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ level: ERROR, outcome: 'error', code: 'internal_error' })
  expect(lines[0].error).toMatchObject({ type: 'TypeError', message: 'our bug' })
})

test('a held lease skips the run without calling execute', async () => {
  await beginAttempt('elpris', { now: T0 })
  const execute = vi.fn(async () => {})
  const { log, runLines } = capturingLogger()

  const result = await run(execute, { log })

  expect(result.outcome).toBe('skipped')
  expect(execute).not.toHaveBeenCalled()
  expect(runLines()).toEqual([expect.objectContaining({ level: INFO, outcome: 'skipped' })])
})

test('a call raced past the deadline fails the run with the factory error', async () => {
  const result = await run(
    async ({ signal }) => {
      await withDeadline(new Promise<never>(() => {}), signal, () => {
        return new FakeRemoteError('unreachable')
      })
    },
    { deadlineMs: 20 },
  )

  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
})

test('withDeadline passes a settled value through and rejects at once on an aborted signal', async () => {
  const live = new AbortController()
  await expect(
    withDeadline(Promise.resolve(7), live.signal, () => new FakeRemoteError('unreachable')),
  ).resolves.toBe(7)

  const aborted = new AbortController()
  aborted.abort()
  await expect(
    withDeadline(Promise.resolve(7), aborted.signal, () => new FakeRemoteError('unreachable')),
  ).rejects.toBeInstanceOf(FakeRemoteError)
})

test('the first failure of a streak alerts each active admin with this source', async () => {
  await db.insert(user).values([
    { name: 'A', email: 'a@example.com', role: 'admin' },
    { name: 'B', email: 'b@example.com', role: 'user' },
    { name: 'C', email: 'c@example.com', role: 'admin', deletedAt: new Date() },
  ])

  await run(async () => {
    throw new FakeRemoteError('unreachable')
  })

  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({
      to: 'a@example.com',
      source: 'elpris',
      transition: 'started_failing',
      code: 'unreachable',
    }),
  )
})

test('only an error line carries the error key', async () => {
  const { log, runLines } = capturingLogger()
  await run(async () => {}, { log })
  await run(
    async () => {
      throw new FakeRemoteError('unreachable')
    },
    { log },
  )
  const [ok, failed] = runLines()
  expect(ok).not.toHaveProperty('error')
  expect(failed).not.toHaveProperty('error')
})

test('success moves the watermark to startedAt; a failure keeps its partial syncedUntil', async () => {
  const partial = new Date('2026-06-01T00:00:00Z')

  const failed = await run(async ({ run }) => {
    run.syncedUntil = partial
    throw new FakeRemoteError('unreachable')
  })
  expect(failed.outcome).toBe('failed')
  expect(await getLastSuccessStartedAt('elpris')).toEqual(partial)

  const ok = await run(async () => {})
  expect(await getLastSuccessStartedAt('elpris')).toEqual(ok.startedAt)
})

test('toRunStats sees the run before finalize', async () => {
  const toRunStats = vi.fn((r: FakeRun) => ({
    since: null,
    pages: 0,
    sessionsSeen: r.finalized ? 1 : 0,
    upserted: 0,
    voided: 0,
    timings: {},
  }))
  const result = await runPulledSync<FakeRun>({
    source: 'elpris',
    trigger: 'admin',
    now: () => T0,
    deadlineMs: 60_000,
    log: capturingLogger().log,
    init: (base) => ({ ...base, items: 0, finalized: false }),
    execute: async () => {},
    toRunStats,
    finalize: (r) => {
      r.finalized = true
    },
    logFields: () => ({}),
  })
  expect(result.finalized).toBe(true)
  expect(toRunStats).toHaveBeenCalledOnce()
  const [row] = await listRecentRuns('elpris', { limit: 1 })
  expect(row.sessionsSeen).toBe(0)
})

test('a failed outcome write on a non-error run surfaces the write error', async () => {
  const writeError = new Error('connection reset')
  vi.spyOn(integrationSyncService, 'recordOutcome').mockRejectedValueOnce(writeError)
  const { log, runLines } = capturingLogger()

  await expect(run(async () => {}, { log })).rejects.toBe(writeError)

  expect(runLines()).toEqual([expect.objectContaining({ level: ERROR, outcome: 'error' })])
})

test('a failed outcome write on an error run is only warned; the original bug is rethrown', async () => {
  vi.spyOn(integrationSyncService, 'recordOutcome').mockRejectedValueOnce(new Error('db down'))
  const { log, entries } = capturingLogger()
  const bug = new TypeError('our bug')

  await expect(
    run(
      async () => {
        throw bug
      },
      { log },
    ),
  ).rejects.toBe(bug)

  expect(entries()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        level: WARN,
        msg: 'integration sync outcome could not be recorded',
      }),
      expect.objectContaining({ level: ERROR, msg: 'integration sync run', outcome: 'error' }),
    ]),
  )
})

const stepClock = (stepMs: number) => {
  let clock = T0.getTime()
  return () => {
    clock += stepMs
    return new Date(clock)
  }
}
const progressCalls = (spy: MockInstance<typeof integrationSyncService.reportProgress>) =>
  spy.mock.calls.map(([, , p]) => p)

test('reportProgress writes under the run’s lease and the outcome clears it', async () => {
  const seen: unknown[] = []
  await run(async ({ reportProgress }) => {
    await reportProgress(1, 3)
    seen.push(
      (await getHealth('elpris', { now: new Date(T0.getTime() + 5000), includeAdminDetail: false }))
        .progress,
    )
  })
  expect(seen).toEqual([{ done: 1, total: 3 }])
  const [row] = await db.select().from(integrationSync).where(eq(integrationSync.source, 'elpris'))
  expect(row.progressDone).toBeNull()
  expect(row.progressTotal).toBeNull()
})

test('reportProgress normalizes: no write for total ≤ 0, done clamped to [0, total]', async () => {
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  await run(async ({ reportProgress }) => {
    await reportProgress(0, 0)
    await reportProgress(Number.NaN, 4)
    await reportProgress(1, Number.POSITIVE_INFINITY)
    await reportProgress(-2, 4)
    await reportProgress(9, 4)
    await reportProgress(1.9, 4.7)
  })
  expect(progressCalls(spy)).toEqual([
    { done: 0, total: 4 },
    { done: 4, total: 4 },
    { done: 1, total: 4 },
  ])
})

test('reportProgress throttles to one write per second, but always writes done = total', async () => {
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  const cap = capturingLogger()
  await run(
    async ({ reportProgress }) => {
      for (let done = 1; done <= 5; done++) await reportProgress(done, 5)
    },
    { now: stepClock(400), log: cap.log },
  )
  // The clock steps 400 ms per now() call (startedAt is the first); a write needs ≥ 1 000 ms since the last.
  expect(progressCalls(spy)).toEqual([
    { done: 1, total: 5 },
    { done: 4, total: 5 },
    { done: 5, total: 5 },
  ])
  expect(cap.runLines()[0]).toMatchObject({ progressWrites: 3 })
})

test('a write exactly one interval after the last is not throttled', async () => {
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  await run(
    async ({ reportProgress }) => {
      for (let done = 1; done <= 3; done++) await reportProgress(done, 5)
    },
    { now: stepClock(1000) },
  )
  expect(progressCalls(spy)).toEqual([
    { done: 1, total: 5 },
    { done: 2, total: 5 },
    { done: 3, total: 5 },
  ])
})

test('a failing progress write is logged and never fails the run', async () => {
  vi.spyOn(integrationSyncService, 'reportProgress').mockRejectedValue(new Error('db blip'))
  const cap = capturingLogger()
  const result = await run(
    async ({ run: r, reportProgress }) => {
      await reportProgress(1, 2)
      r.items = 1
    },
    { log: cap.log },
  )
  expect(result.outcome).toBe('ok')
  const warn = cap.entries().find((e) => e.msg === 'integration sync progress write failed')
  expect(warn).toMatchObject({ level: WARN, source: 'elpris' })
  expect(cap.runLines()[0]).toMatchObject({ outcome: 'ok', progressWrites: 0 })
})

test('the run line counts progress writes', async () => {
  const cap = capturingLogger()
  await run(
    async ({ reportProgress }) => {
      await reportProgress(1, 2)
      await reportProgress(2, 2)
    },
    { log: cap.log },
  )
  expect(cap.runLines()[0]).toMatchObject({ progressWrites: 2 })
})

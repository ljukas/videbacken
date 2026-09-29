import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import { IntegrationError } from '~/lib/effects/integrationError'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { createServerLogger } from '~/lib/logger/server'
import { beginAttempt, getHealth, listRecentRuns } from '~/lib/services/integrationSync'
import { setupDatabase } from '~test/setup'
import { type RunBase, runPulledSync, withDeadline } from './runPulledSync'

setupDatabase()

// The lifecycle is exercised through a synthetic source ('elpris', so nothing
// here is Zaptec-shaped); Zaptec's own behavior is covered by sync.test.ts.

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
  execute: (ctx: { run: FakeRun; signal: AbortSignal }) => Promise<void>,
  opts: { log?: ReturnType<typeof capturingLogger>['log']; deadlineMs?: number } = {},
) {
  let clock = T0.getTime()
  const now = () => {
    clock += 1000
    return new Date(clock)
  }
  return runPulledSync<FakeRun>({
    source: 'elpris',
    trigger: 'cron',
    now,
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
  await beginAttempt('elpris', { now: new Date() })
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

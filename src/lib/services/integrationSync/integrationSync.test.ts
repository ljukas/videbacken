import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { integrationSync, integrationSyncRun } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { setupDatabase } from '~test/setup'
import {
  beginAttempt,
  getHealth,
  getLastSuccessStartedAt,
  listRecentRuns,
  recordOutcome,
} from './integrationSync'
import type { RunStats, SyncOutcome } from './transition'

setupDatabase()

const DAY_MS = 24 * 60 * 60 * 1000
const T0 = new Date('2026-09-28T10:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

const stats: RunStats = {
  since: new Date('2026-09-21T10:00:00.000Z'),
  pages: 2,
  sessionsSeen: 7,
  upserted: 5,
  voided: 1,
  timings: { fetchMs: 120, importMs: 30 },
}
const ok: SyncOutcome = { ok: true, stats }
const failed: SyncOutcome = {
  ok: false,
  kind: 'failed',
  code: 'unreachable',
  message: 'connect ECONNREFUSED',
  stats,
}

function captureLog() {
  const warnings: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
    child: () => log,
  }
  return { log, warnings }
}

async function acquire(now: Date): Promise<string> {
  const lease = await beginAttempt('zaptec', { now })
  if (!lease.acquired) throw new Error('expected to acquire the lease')
  return lease.attemptId
}

test('beginAttempt creates the row lazily and acquires the lease', async () => {
  const lease = await beginAttempt('zaptec', { now: T0 })
  expect(lease.acquired).toBe(true)
  const [row] = await db.select().from(integrationSync)
  expect(row.source).toBe('zaptec')
  expect(row.runningSince).toEqual(T0)
  expect(row.leaseUntil).toEqual(at(5 * 60 * 1000))
  expect(lease.acquired && row.leaseToken).toBe(lease.acquired && lease.attemptId)
  const health = await getHealth('zaptec', { now: at(1000), includeAdminDetail: false })
  expect(health.running).toBe(true)
  expect(health.state).toBe('never_synced')
})

test('a second beginAttempt while the lease is held is not acquired', async () => {
  await acquire(T0)
  const second = await beginAttempt('zaptec', { now: at(60_000) })
  expect(second).toEqual({ acquired: false, runningSince: T0 })
})

test('an expired lease is taken over and the old attempt’s outcome is ignored', async () => {
  const stale = await acquire(T0)
  const fresh = await acquire(at(6 * 60 * 1000))
  expect(fresh).not.toBe(stale)

  const { log, warnings } = captureLog()
  const late = await recordOutcome('zaptec', failed, {
    attemptId: stale,
    trigger: 'cron',
    startedAt: T0,
    now: at(7 * 60 * 1000),
    log,
  })
  expect(late.transition).toBe('none')
  expect(warnings).toEqual(['integration sync lease lost; outcome discarded'])
  expect(await db.select().from(integrationSyncRun)).toHaveLength(0)
  const [row] = await db.select().from(integrationSync)
  expect(row.leaseToken).toBe(fresh)
  expect(row.consecutiveFailures).toBe(0)
  expect(row.lastAttemptAt).toBeNull()
})

test('two concurrent failures for one attempt produce exactly one started_failing', async () => {
  const attemptId = await acquire(T0)
  const { log, warnings } = captureLog()
  const opts = { attemptId, trigger: 'cron' as const, startedAt: T0, now: at(1000), log }
  const results = await Promise.all([
    recordOutcome('zaptec', failed, opts),
    recordOutcome('zaptec', failed, opts),
  ])
  expect(results.map((r) => r.transition).sort()).toEqual(['none', 'started_failing'])
  expect(warnings).toHaveLength(1)
  expect(await db.select().from(integrationSyncRun)).toHaveLength(1)
  const [row] = await db.select().from(integrationSync)
  expect(row.consecutiveFailures).toBe(1)
  expect(row.leaseToken).toBeNull()
  expect(row.runningSince).toBeNull()
  expect(row.leaseUntil).toBeNull()
})

test('recordOutcome writes the run row with stats and updates health', async () => {
  const attemptId = await acquire(T0)
  const { transition, health } = await recordOutcome('zaptec', ok, {
    attemptId,
    trigger: 'admin',
    startedAt: T0,
    now: at(2500),
  })
  expect(transition).toBe('none')
  expect(health).toMatchObject({
    source: 'zaptec',
    state: 'ok',
    running: false,
    lastAttemptAt: at(2500),
    lastSuccessAt: at(2500),
    consecutiveFailures: 0,
    code: null,
  })

  const [run] = await db.select().from(integrationSyncRun)
  expect(run).toMatchObject({
    source: 'zaptec',
    trigger: 'admin',
    startedAt: T0,
    finishedAt: at(2500),
    durationMs: 2500,
    outcome: 'ok',
    errorCode: null,
    errorMessage: null,
    since: stats.since,
    pages: 2,
    sessionsSeen: 7,
    upserted: 5,
    voided: 1,
    timings: { fetchMs: 120, importMs: 30 },
  })

  const runs = await listRecentRuns('zaptec', { limit: 10 })
  expect(runs).toEqual([
    {
      id: run.id,
      trigger: 'admin',
      startedAt: T0,
      finishedAt: at(2500),
      durationMs: 2500,
      outcome: 'ok',
      errorCode: null,
      errorMessage: null,
      upserted: 5,
      sessionsSeen: 7,
      pages: 2,
    },
  ])
})

test('failure then recovery reports the streak edges and a failed run row', async () => {
  const a1 = await acquire(T0)
  const r1 = await recordOutcome('zaptec', failed, {
    attemptId: a1,
    trigger: 'cron',
    startedAt: T0,
    now: at(1000),
  })
  expect(r1.transition).toBe('started_failing')
  expect(r1.health).toMatchObject({
    state: 'failing',
    code: 'unreachable',
    failingSince: at(1000),
    consecutiveFailures: 1,
  })

  const a2 = await acquire(at(DAY_MS / 24))
  const r2 = await recordOutcome('zaptec', ok, {
    attemptId: a2,
    trigger: 'cron',
    startedAt: at(DAY_MS / 24),
    now: at(DAY_MS / 24 + 1000),
  })
  expect(r2.transition).toBe('recovered')

  const runs = await listRecentRuns('zaptec', { limit: 10 })
  expect(runs.map((r) => r.outcome)).toEqual(['ok', 'failed'])
  expect(runs[1]).toMatchObject({ errorCode: 'unreachable', errorMessage: 'connect ECONNREFUSED' })
  expect(await listRecentRuns('zaptec', { limit: 1 })).toHaveLength(1)
})

test('recordOutcome prunes runs older than 90 days and keeps newer ones', async () => {
  const now = at(1000)
  const oldRun = {
    source: 'zaptec',
    trigger: 'cron',
    finishedAt: T0,
    durationMs: 1,
    outcome: 'ok',
  } as const
  await db.insert(integrationSyncRun).values([
    { ...oldRun, startedAt: new Date(now.getTime() - 91 * DAY_MS) },
    { ...oldRun, startedAt: new Date(now.getTime() - 89 * DAY_MS) },
  ])
  const attemptId = await acquire(T0)
  await recordOutcome('zaptec', ok, { attemptId, trigger: 'cron', startedAt: T0, now })

  const kept = await db
    .select({ startedAt: integrationSyncRun.startedAt })
    .from(integrationSyncRun)
    .where(eq(integrationSyncRun.source, 'zaptec'))
  expect(kept.map((r) => r.startedAt.getTime()).sort()).toEqual(
    [now.getTime() - 89 * DAY_MS, T0.getTime()].sort(),
  )
})

test('a 2 KB message with a Bearer token is stored redacted and truncated', async () => {
  const attemptId = await acquire(T0)
  const message = `401 from Zaptec: Authorization: Bearer eyJhbGciOi.secret.sig ${'x'.repeat(2048)}`
  await recordOutcome(
    'zaptec',
    { ok: false, kind: 'failed', code: 'auth_failed', message, stats },
    { attemptId, trigger: 'cron', startedAt: T0, now: at(1000) },
  )
  const [row] = await db.select().from(integrationSync)
  const [run] = await db.select().from(integrationSyncRun)
  for (const stored of [row.lastErrorMessage, run.errorMessage]) {
    expect(stored).not.toContain('eyJhbGciOi')
    expect(stored).toContain('Bearer <redacted>')
    expect(stored).toHaveLength(500)
  }

  const admin = await getHealth('zaptec', { now: at(2000), includeAdminDetail: true })
  expect(admin.adminDetail).toEqual({ lastErrorMessage: row.lastErrorMessage })
  const member = await getHealth('zaptec', { now: at(2000), includeAdminDetail: false })
  expect(member.adminDetail).toBeNull()
  expect(member.code).toBe('auth_failed')
})

test('getHealth for a source with no row is never_synced', async () => {
  expect(await getHealth('elpris', { now: T0, includeAdminDetail: true })).toEqual({
    source: 'elpris',
    state: 'never_synced',
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    failingSince: null,
    consecutiveFailures: 0,
    code: null,
    adminDetail: { lastErrorMessage: null },
  })
})

test('getLastSuccessStartedAt returns the start of the last successful run', async () => {
  expect(await getLastSuccessStartedAt('zaptec')).toBeNull()
  const a1 = await acquire(T0)
  await recordOutcome('zaptec', ok, {
    attemptId: a1,
    trigger: 'cron',
    startedAt: T0,
    now: at(9000),
  })
  const a2 = await acquire(at(DAY_MS))
  await recordOutcome('zaptec', failed, {
    attemptId: a2,
    trigger: 'cron',
    startedAt: at(DAY_MS),
    now: at(DAY_MS + 1000),
  })
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(T0)
})

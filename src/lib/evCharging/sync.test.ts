import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evChargeSession, user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import { type CallOpts, type ZaptecClient, ZaptecError } from '~/lib/effects/zaptec'
import type { ZaptecCharger, ZaptecSession } from '~/lib/evCharging/types'
import { createServerLogger, logger } from '~/lib/logger/server'
import { beginAttempt, getHealth, getLastSuccessStartedAt } from '~/lib/services/integrationSync'
import { setupDatabase } from '~test/setup'
import { runZaptecSync } from './sync'

setupDatabase()

const INSTALLATION = 'inst-1'
const CHARGERS: ZaptecCharger[] = [
  { id: 'chg-1', name: 'Garage vänster', installationId: INSTALLATION, isOnline: true },
  { id: 'chg-2', name: 'Garage höger', installationId: INSTALLATION, isOnline: true },
]
const T1 = new Date('2026-09-20T10:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const FIRST_RUN_SINCE = new Date('2020-01-01T00:00:00Z')

function session(id: string, endAt: Date, overrides: Partial<ZaptecSession> = {}): ZaptecSession {
  const startAt = new Date(endAt.getTime() - 2 * HOUR)
  return {
    id,
    chargerId: 'chg-1',
    startAt,
    endAt,
    energyKwh: 4,
    intervals: [
      { startAt, endAt: new Date(startAt.getTime() + HOUR), energyKwh: 2 },
      { startAt: new Date(startAt.getTime() + HOUR), endAt, energyKwh: 2 },
    ],
    authorizedUser: null,
    tokenName: null,
    voided: false,
    replacedBySessionId: null,
    offline: false,
    reliableClock: true,
    ...overrides,
  }
}

type SessionsCall = { since: Date; until: Date | undefined; installationId: string }

// In-memory Zaptec: filters sessions by end time in `[since, until)` for the
// installation's chargers and yields pages of 2, like the real cursor paging.
function fakeZaptec(initial: ZaptecSession[] = []) {
  const state = {
    chargers: [...CHARGERS],
    sessions: [...initial],
    chargersError: null as Error | null,
    failOnPage: null as number | null,
    calls: { chargers: 0, sessions: [] as SessionsCall[], liveState: 0 },
  }
  const client: ZaptecClient = {
    async chargers(o?: CallOpts) {
      state.calls.chargers++
      if (o?.stats) o.stats.authMs += 3
      if (state.chargersError) throw state.chargersError
      return state.chargers
    },
    async *sessionsEndedSince(since, o) {
      state.calls.sessions.push({ since, until: o.until, installationId: o.installationId })
      const chargerIds = new Set(
        state.chargers.filter((c) => c.installationId === o.installationId).map((c) => c.id),
      )
      const until = o.until ?? new Date()
      const matching = state.sessions
        .filter((s) => chargerIds.has(s.chargerId) && s.endAt >= since && s.endAt < until)
        .sort((a, b) => a.endAt.getTime() - b.endAt.getTime())
      let page = 0
      for (let i = 0; i < Math.max(matching.length, 1); i += 2) {
        page++
        if (state.failOnPage === page) throw new ZaptecError('unreachable', 'sessions', 503)
        if (o.stats) {
          o.stats.pages++
          o.stats.fetchMs += 5
        }
        yield matching.slice(i, i + 2)
      }
    },
    async liveState() {
      state.calls.liveState++
      throw new Error('liveState is not used by the sync run')
    },
  }
  return { client, state }
}

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

let publish: MockInstance<typeof queue.publish>

beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function sessionRows() {
  return db
    .select({
      zaptecSessionId: evChargeSession.zaptecSessionId,
      voided: evChargeSession.voided,
    })
    .from(evChargeSession)
    .orderBy(evChargeSession.zaptecSessionId)
}

async function insertUser(email: string, role: string, deletedAt: Date | null = null) {
  await db.insert(user).values({ name: email, email, role, deletedAt })
}

test('2-page backfill imports every session and records the watermark', async () => {
  const { client, state } = fakeZaptec([
    session('s1', new Date('2026-09-01T12:00:00Z')),
    session('s2', new Date('2026-09-02T12:00:00Z')),
    session('s3', new Date('2026-09-03T12:00:00Z'), { chargerId: 'chg-2' }),
  ])
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  expect(run).toMatchObject({
    source: 'zaptec',
    trigger: 'cron',
    outcome: 'ok',
    code: null,
    transition: 'none',
    startedAt: T1,
    since: FIRST_RUN_SINCE,
    pages: 2,
    chargers: 2,
    sessionsSeen: 3,
    upserted: 3,
    voided: 0,
    skipped: 0,
    authMs: 3,
    fetchMs: 10,
  })
  // One installation shared by both chargers → one sessions iteration.
  expect(state.calls.sessions).toEqual([
    { since: FIRST_RUN_SINCE, until: T1, installationId: INSTALLATION },
  ])
  expect((await sessionRows()).map((r) => r.zaptecSessionId)).toEqual(['s1', 's2', 's3'])
  expect(await db.select().from(evChargeInterval)).toHaveLength(6)
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(T1)

  const lines = runLines()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    level: INFO,
    source: 'zaptec',
    trigger: 'cron',
    outcome: 'ok',
    code: null,
    transition: 'none',
    since: FIRST_RUN_SINCE.toISOString(),
    pages: 2,
    chargers: 2,
    sessionsSeen: 3,
    upserted: 3,
    voided: 0,
    skipped: 0,
  })
  expect(lines[0]).toHaveProperty('durationMs')
  expect(lines[0]).toHaveProperty('importMs')
  expect(publish).not.toHaveBeenCalled()
})

test('a rerun is idempotent and fetches from the watermark minus 7 days', async () => {
  const { client, state } = fakeZaptec([
    session('s1', new Date('2026-09-18T12:00:00Z')),
    session('s2', new Date('2026-09-19T12:00:00Z')),
  ])
  const { log, runLines } = capturingLogger()
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  const T2 = new Date(T1.getTime() + HOUR)
  const run = await runZaptecSync({
    trigger: 'admin',
    now: () => T2,
    deps: { zaptec: client, log },
  })

  expect(run).toMatchObject({ outcome: 'ok', since: new Date(T1.getTime() - 7 * DAY), upserted: 2 })
  expect(state.calls.sessions[1]).toEqual({
    since: new Date(T1.getTime() - 7 * DAY),
    until: T2,
    installationId: INSTALLATION,
  })
  expect((await sessionRows()).map((r) => r.zaptecSessionId)).toEqual(['s1', 's2'])
  expect(await db.select().from(evChargeInterval)).toHaveLength(4)
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(T2)
  expect(runLines()).toHaveLength(2)
})

test('a late session (ended before the last success started, within 7 days) is picked up', async () => {
  const { client, state } = fakeZaptec([session('s1', new Date(T1.getTime() - 2 * DAY))])
  const { log, runLines } = capturingLogger()
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  // An offline charger uploads a session that ended a day before run 1 started.
  state.sessions.push(session('late', new Date(T1.getTime() - DAY)))
  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => new Date(T1.getTime() + HOUR),
    deps: { zaptec: client, log },
  })

  expect(run.outcome).toBe('ok')
  expect((await sessionRows()).map((r) => r.zaptecSessionId)).toEqual(['late', 's1'])
  expect(runLines()).toHaveLength(2)
})

test('a session flipped to voided is updated in place', async () => {
  const { client, state } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  const { log, runLines } = capturingLogger()
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })
  expect(await sessionRows()).toEqual([{ zaptecSessionId: 's1', voided: false }])

  state.sessions = [
    session('s1', new Date(T1.getTime() - DAY), { voided: true, replacedBySessionId: 's1b' }),
  ]
  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => new Date(T1.getTime() + HOUR),
    deps: { zaptec: client, log },
  })

  expect(run).toMatchObject({ outcome: 'ok', upserted: 1, voided: 1 })
  expect(await sessionRows()).toEqual([{ zaptecSessionId: 's1', voided: true }])
  expect(runLines()).toHaveLength(2)
})

test('invalid sessions are counted as skipped on the run and in the log line', async () => {
  // The charging service warns per skipped session on the global logger.
  const serviceWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const { client } = fakeZaptec([
    session('ok', new Date(T1.getTime() - DAY)),
    session('bad', new Date(T1.getTime() - DAY), { energyKwh: -1 }),
  ])
  const { log, runLines } = capturingLogger()
  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  expect(run).toMatchObject({ outcome: 'ok', sessionsSeen: 2, upserted: 1, skipped: 1 })
  expect(runLines()).toHaveLength(1)
  expect(runLines()[0]).toMatchObject({ sessionsSeen: 2, upserted: 1, skipped: 1 })
  expect(serviceWarn).toHaveBeenCalledOnce()
})

test('auth_failed twice → one alert per active admin; success → one recovered alert per admin', async () => {
  await insertUser('admin-a@example.com', 'admin')
  await insertUser('admin-b@example.com', 'admin')
  await insertUser('member@example.com', 'user')
  await insertUser('gone-admin@example.com', 'admin', new Date('2026-01-01T00:00:00Z'))

  const { client, state } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  state.chargersError = new ZaptecError('auth_failed', 'token', 401)
  const { log, runLines } = capturingLogger()

  const first = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deps: { zaptec: client, log },
  })
  expect(first).toMatchObject({
    outcome: 'failed',
    code: 'auth_failed',
    transition: 'started_failing',
  })
  expect(publish).toHaveBeenCalledTimes(2)
  for (const to of ['admin-a@example.com', 'admin-b@example.com']) {
    expect(publish).toHaveBeenCalledWith('email_integration_sync_alert', {
      to,
      source: 'zaptec',
      transition: 'started_failing',
      code: 'auth_failed',
      failingSince: T1.toISOString(),
      locale: 'sv',
    })
  }

  const T2 = new Date(T1.getTime() + HOUR)
  const second = await runZaptecSync({
    trigger: 'cron',
    now: () => T2,
    deps: { zaptec: client, log },
  })
  expect(second).toMatchObject({ outcome: 'failed', code: 'auth_failed', transition: 'none' })
  expect(publish).toHaveBeenCalledTimes(2)
  expect(await getLastSuccessStartedAt('zaptec')).toBeNull()

  state.chargersError = null
  publish.mockClear()
  const T3 = new Date(T2.getTime() + HOUR)
  const third = await runZaptecSync({
    trigger: 'cron',
    now: () => T3,
    deps: { zaptec: client, log },
  })
  expect(third).toMatchObject({ outcome: 'ok', code: null, transition: 'recovered' })
  expect(publish).toHaveBeenCalledTimes(2)
  for (const to of ['admin-a@example.com', 'admin-b@example.com']) {
    expect(publish).toHaveBeenCalledWith('email_integration_sync_alert', {
      to,
      source: 'zaptec',
      transition: 'recovered',
      code: null,
      failingSince: null,
      locale: 'sv',
    })
  }

  const lines = runLines()
  expect(lines.map((l) => [l.level, l.outcome, l.code, l.transition])).toEqual([
    [WARN, 'failed', 'auth_failed', 'started_failing'],
    [WARN, 'failed', 'auth_failed', 'none'],
    [INFO, 'ok', null, 'recovered'],
  ])
  // The run line never carries the Zaptec error message or admin detail.
  for (const line of lines) {
    expect(line).not.toHaveProperty('error')
    expect(line).not.toHaveProperty('adminDetail')
  }
})

test('a failed alert publish is logged as a warning and does not fail the run', async () => {
  await insertUser('admin-a@example.com', 'admin')
  publish.mockRejectedValue(new Error('queue down'))
  const { client, state } = fakeZaptec()
  state.chargersError = new ZaptecError('unreachable', 'chargers', 503)
  const { log, entries, runLines } = capturingLogger()

  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  expect(run).toMatchObject({
    outcome: 'failed',
    code: 'unreachable',
    transition: 'started_failing',
  })
  const warning = entries().find((e) => e.msg === 'integration sync alert publish failed')
  expect(warning).toMatchObject({ level: WARN, source: 'zaptec', transition: 'started_failing' })
  expect(runLines()).toHaveLength(1)
})

test('a page-2 failure keeps page 1 and does not advance the watermark', async () => {
  const { client, state } = fakeZaptec([session('s0', new Date(T1.getTime() - 3 * DAY))])
  const { log, runLines } = capturingLogger()
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  state.sessions.push(
    session('s1', new Date(T1.getTime() - 2 * DAY)),
    session('s2', new Date(T1.getTime() - DAY)),
  )
  state.failOnPage = 2
  const T2 = new Date(T1.getTime() + HOUR)
  const run = await runZaptecSync({ trigger: 'cron', now: () => T2, deps: { zaptec: client, log } })

  expect(run).toMatchObject({ outcome: 'failed', code: 'unreachable', pages: 1, upserted: 2 })
  // Page 1 (s0, s1) landed; page 2 (s2) never arrived.
  expect((await sessionRows()).map((r) => r.zaptecSessionId)).toEqual(['s0', 's1'])
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(T1)
  expect(runLines()).toHaveLength(2)
  expect(runLines()[1]).toMatchObject({ level: WARN, outcome: 'failed', code: 'unreachable' })
})

test('more than 20 pages fails as unexpected_response', async () => {
  const sessions = Array.from({ length: 42 }, (_, i) =>
    session(`s${String(i).padStart(2, '0')}`, new Date(T1.getTime() - (i + 1) * HOUR)),
  )
  const { client } = fakeZaptec(sessions)
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  expect(run).toMatchObject({ outcome: 'failed', code: 'unexpected_response', pages: 20 })
  expect(await sessionRows()).toHaveLength(40)
  expect(await getLastSuccessStartedAt('zaptec')).toBeNull()
  expect(runLines()).toHaveLength(1)
})

test('a Zaptec call that never settles fails as unreachable at the deadline, with one run line', async () => {
  const signals: (AbortSignal | undefined)[] = []
  const client: ZaptecClient = {
    chargers: (o) => {
      signals.push(o?.signal)
      return new Promise(() => {})
    },
    sessionsEndedSince: () => {
      throw new Error('not reached')
    },
    liveState: () => Promise.reject(new Error('not used')),
  }
  const { log, runLines } = capturingLogger()
  const started = performance.now()

  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deadlineMs: 50,
    deps: { zaptec: client, log },
  })

  expect(performance.now() - started).toBeLessThan(5_000)
  expect(run).toMatchObject({ outcome: 'failed', code: 'unreachable' })
  expect(signals[0]).toBeInstanceOf(AbortSignal)
  expect(signals[0]?.aborted).toBe(true)
  const health = await getHealth('zaptec', { now: T1, includeAdminDetail: false })
  expect(health).toMatchObject({ state: 'failing', code: 'unreachable', running: false })
  const lines = runLines()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ level: WARN, outcome: 'failed', code: 'unreachable' })
})

test('a sessions page that never arrives fails at the deadline and keeps earlier pages', async () => {
  let sessionsSignal: AbortSignal | undefined
  const client: ZaptecClient = {
    chargers: async () => CHARGERS,
    async *sessionsEndedSince(_since, o) {
      sessionsSignal = o.signal
      yield [session('s1', new Date(T1.getTime() - DAY))]
      await new Promise(() => {})
    },
    liveState: () => Promise.reject(new Error('not used')),
  }
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deadlineMs: 50,
    deps: { zaptec: client, log },
  })

  expect(run).toMatchObject({ outcome: 'failed', code: 'unreachable', pages: 1, upserted: 1 })
  expect(sessionsSignal?.aborted).toBe(true)
  expect((await sessionRows()).map((r) => r.zaptecSessionId)).toEqual(['s1'])
  expect(await getLastSuccessStartedAt('zaptec')).toBeNull()
  expect(runLines()).toHaveLength(1)
})

test('run-line timings are integers', async () => {
  const { client } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  const fractional: ZaptecClient = {
    ...client,
    async chargers(o) {
      if (o?.stats) o.stats.authMs += 1.7
      return client.chargers(o)
    },
  }
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deps: { zaptec: fractional, log },
  })

  expect(run.authMs).toBe(5)
  for (const key of ['authMs', 'fetchMs', 'importMs'] as const) {
    expect(Number.isInteger(run[key])).toBe(true)
    expect(Number.isInteger(runLines()[0][key])).toBe(true)
  }
})

test('a held lease → skipped, with zero Zaptec calls', async () => {
  await beginAttempt('zaptec', { now: new Date(T1.getTime() - 60_000) })
  const { client, state } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({
    trigger: 'admin',
    now: () => T1,
    deps: { zaptec: client, log },
  })

  expect(run).toMatchObject({ outcome: 'skipped', code: null, transition: 'none', since: null })
  expect(state.calls).toEqual({ chargers: 0, sessions: [], liveState: 0 })
  expect(await sessionRows()).toEqual([])
  const lines = runLines()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ level: INFO, outcome: 'skipped', trigger: 'admin' })
})

test('an expired lease is taken over', async () => {
  await beginAttempt('zaptec', { now: new Date(T1.getTime() - 10 * 60_000) })
  const { client } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  expect(run).toMatchObject({ outcome: 'ok', upserted: 1 })
  expect(runLines()).toHaveLength(1)
})

test('an unknown error is rethrown, recorded as internal_error and logged at error', async () => {
  const { client, state } = fakeZaptec()
  state.chargersError = new TypeError('boom')
  const { log, runLines } = capturingLogger()

  await expect(
    runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } }),
  ).rejects.toThrow('boom')

  const health = await getHealth('zaptec', { now: T1, includeAdminDetail: false })
  expect(health).toMatchObject({ state: 'failing', code: 'internal_error', running: false })
  const lines = runLines()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ level: ERROR, outcome: 'error', code: 'internal_error' })
  expect(lines[0].error).toMatchObject({ type: 'TypeError', message: 'boom' })
})

test('default client in tests is notConfigured → failed / not_configured, no alert', async () => {
  await insertUser('admin-a@example.com', 'admin')
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { log } })

  expect(run).toMatchObject({ outcome: 'failed', code: 'not_configured', transition: 'none' })
  expect(publish).not.toHaveBeenCalled()
  expect(runLines()).toHaveLength(1)
  expect(await sessionRows()).toEqual([])
})

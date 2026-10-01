import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evChargeSession, integrationSyncRun, user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import { type CallOpts, type ZaptecClient, ZaptecError } from '~/lib/effects/zaptec'
import type { ZaptecCharger, ZaptecSession } from '~/lib/evCharging/types'
import { createServerLogger, logger } from '~/lib/logger/server'
import * as evChargingService from '~/lib/services/evCharging'
import * as integrationSyncService from '~/lib/services/integrationSync'
import { beginAttempt, getHealth, getLastSuccessStartedAt } from '~/lib/services/integrationSync'
import { insertVehicleRecord } from '~test/fixtures/evCharging'
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
const WINDOW = 90 * DAY

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
    /** Every sessions call whose window starts at or after this fails. */
    failFrom: null as Date | null,
    /** Added to the stats sink per page, like the real client's parser rejects. */
    rejectedPerPage: 0,
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
      if (state.failFrom && since >= state.failFrom) {
        throw new ZaptecError('unreachable', 'sessions', 503)
      }
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
          o.stats.rejected += state.rejectedPerPage
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

// The sessions calls of one run: contiguous windows of at most 90 days.
function expectContiguousWindows(calls: SessionsCall[], since: Date, until: Date) {
  expect(calls[0].since).toEqual(since)
  expect(calls.at(-1)?.until).toEqual(until)
  for (const [i, call] of calls.entries()) {
    expect(call.until?.getTime()).toBeGreaterThan(call.since.getTime())
    expect((call.until?.getTime() ?? 0) - call.since.getTime()).toBeLessThanOrEqual(WINDOW)
    if (i > 0) expect(call.since).toEqual(calls[i - 1].until)
  }
}

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

test('the first run backfills from 2020 in 90-day windows and records the watermark', async () => {
  const { client, state } = fakeZaptec([
    session('s1', new Date('2026-09-01T12:00:00Z')),
    session('s2', new Date('2026-09-02T12:00:00Z')),
    session('s3', new Date('2026-09-03T12:00:00Z'), { chargerId: 'chg-2' }),
  ])
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  // One installation shared by both chargers → one sessions iteration per window.
  const calls = state.calls.sessions
  expect(calls.length).toBe(Math.ceil((T1.getTime() - FIRST_RUN_SINCE.getTime()) / WINDOW))
  expectContiguousWindows(calls, FIRST_RUN_SINCE, T1)
  expect(new Set(calls.map((c) => c.installationId))).toEqual(new Set([INSTALLATION]))
  // Every window yields one (maybe empty) page; the one holding s1–s3 yields two.
  const pages = calls.length + 1
  expect(run).toMatchObject({
    source: 'zaptec',
    trigger: 'cron',
    outcome: 'ok',
    code: null,
    transition: 'none',
    startedAt: T1,
    since: FIRST_RUN_SINCE,
    syncedUntil: T1,
    pages,
    chargers: 2,
    sessionsSeen: 3,
    upserted: 3,
    voided: 0,
    skipped: 0,
    authMs: 3,
    fetchMs: pages * 5,
  })
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
    syncedUntil: T1.toISOString(),
    pages,
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

test('a backfill that outlasts the window budget checkpoints, and the next run continues', async () => {
  const { client, state } = fakeZaptec([
    session('old', new Date('2020-02-01T12:00:00Z')),
    session('new', new Date(T1.getTime() - DAY)),
  ])
  const { log } = capturingLogger()
  // Each clock read is 50 s later: windows start at 50 s and 100 s of run
  // time, then the 150 s read is past the 120 s budget.
  let clock = T1.getTime()
  const now = () => {
    const at = new Date(clock)
    clock += 50_000
    return at
  }

  const first = await runZaptecSync({ trigger: 'cron', now, deps: { zaptec: client, log } })

  const firstUntil = new Date(FIRST_RUN_SINCE.getTime() + 2 * WINDOW)
  expect(first).toMatchObject({ outcome: 'ok', syncedUntil: firstUntil, upserted: 1 })
  expect(state.calls.sessions).toHaveLength(2)
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(firstUntil)
  expect((await sessionRows()).map((r) => r.zaptecSessionId)).toEqual(['old'])

  // A run with time to spare picks up 7 days before the checkpoint.
  state.calls.sessions = []
  const T2 = new Date(T1.getTime() + HOUR)
  const second = await runZaptecSync({
    trigger: 'cron',
    now: () => T2,
    deps: { zaptec: client, log },
  })

  expect(second).toMatchObject({ outcome: 'ok', syncedUntil: T2 })
  expectContiguousWindows(state.calls.sessions, new Date(firstUntil.getTime() - 7 * DAY), T2)
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(T2)
  expect((await sessionRows()).map((r) => r.zaptecSessionId)).toEqual(['new', 'old'])
})

test('a backfill that fails part-way keeps the windows it finished', async () => {
  const { client, state } = fakeZaptec([session('early', new Date('2020-02-01T12:00:00Z'))])
  state.failFrom = new Date('2021-01-01T00:00:00Z')
  const { log } = capturingLogger()

  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  // Windows start every 90 days from 2020-01-01; the sixth (2021-03-26) fails.
  const kept = new Date(FIRST_RUN_SINCE.getTime() + 5 * WINDOW)
  expect(run).toMatchObject({ outcome: 'failed', code: 'unreachable', syncedUntil: kept })
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(kept)
  const health = await getHealth('zaptec', { now: T1, includeAdminDetail: false })
  expect(health).toMatchObject({ state: 'failing', code: 'unreachable', lastSuccessAt: null })

  // The next run resumes 7 days before the kept watermark, not from 2020.
  state.failFrom = null
  state.calls.sessions = []
  await runZaptecSync({
    trigger: 'cron',
    now: () => new Date(T1.getTime() + HOUR),
    deps: { zaptec: client, log },
  })
  expect(state.calls.sessions[0].since).toEqual(new Date(kept.getTime() - 7 * DAY))
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
  expect(state.calls.sessions.at(-1)).toEqual({
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

test('sessions the Zaptec parser rejected are counted as skipped too', async () => {
  const { client, state } = fakeZaptec([session('ok', new Date(T1.getTime() - DAY))])
  // Seed a watermark so the run is a single window (one page).
  await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deps: { zaptec: client, log: capturingLogger().log },
  })
  state.rejectedPerPage = 2
  const { log, runLines } = capturingLogger()

  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => new Date(T1.getTime() + HOUR),
    deps: { zaptec: client, log },
  })

  expect(run).toMatchObject({ outcome: 'ok', upserted: 1, skipped: 2 })
  expect(runLines()[0]).toMatchObject({ skipped: 2 })
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

async function attributionRows() {
  return db
    .select({
      zaptecSessionId: evChargeSession.zaptecSessionId,
      vehicle: evChargeSession.vehicle,
      vehicleSource: evChargeSession.vehicleSource,
    })
    .from(evChargeSession)
    .orderBy(evChargeSession.zaptecSessionId)
}

test('a successful sync re-derives attribution and keeps admin tags', async () => {
  await insertVehicleRecord({
    startAt: new Date(T1.getTime() - 10 * DAY),
    endAt: new Date(T1.getTime() - 10 * DAY + HOUR),
  })
  await insertVehicleRecord({
    startAt: new Date(T1.getTime() - HOUR),
    endAt: new Date(T1.getTime()),
  })
  const { client } = fakeZaptec([session('s0', new Date(T1.getTime() - 3 * DAY))])
  const { log, runLines } = capturingLogger()
  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })
  expect(run.outcome).toBe('ok')
  expect(run.reattributeChanged).toBe(1)
  const [row] = await attributionRows()
  // s0 overlaps no record but sits inside coverage, so it is a guest.
  expect(row).toMatchObject({ zaptecSessionId: 's0', vehicle: 'other', vehicleSource: 'skoda' })
  expect(typeof runLines()[0].reattributeMs).toBe('number')
  expect(runLines()[0].reattributeChanged).toBe(1)

  await db.update(evChargeSession).set({ vehicle: 'ours', vehicleSource: 'admin' })
  const second = await runZaptecSync({
    trigger: 'cron',
    now: () => new Date(T1.getTime() + HOUR),
    deps: { zaptec: client, log },
  })
  expect(second).toMatchObject({ outcome: 'ok' })
  expect(second.upserted).toBeGreaterThanOrEqual(1)
  expect((await attributionRows())[0]).toMatchObject({ vehicle: 'ours', vehicleSource: 'admin' })
})

test('a failed re-match is logged as a warning and does not fail the run', async () => {
  vi.spyOn(evChargingService, 'reattributeSessions').mockRejectedValueOnce(new Error('db hiccup'))
  const { client } = fakeZaptec([session('s0', new Date(T1.getTime() - DAY))])
  const { log, entries } = capturingLogger()
  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })
  expect(run.outcome).toBe('ok')
  expect(entries().find((e) => e.msg === 'zaptec sync: vehicle re-match failed')).toMatchObject({
    level: WARN,
    error: expect.anything(),
  })
  expect(typeof run.reattributeMs).toBe('number')
  expect(run.reattributeChanged).toBe(0)
})

test('a re-match that never settles is cut off by the run deadline without failing the run', async () => {
  vi.spyOn(evChargingService, 'reattributeSessions').mockReturnValueOnce(new Promise(() => {}))
  const { client } = fakeZaptec([session('s0', new Date(T1.getTime() - DAY))])
  const { log, entries } = capturingLogger()
  const started = performance.now()
  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deadlineMs: 2_000,
    deps: { zaptec: client, log },
  })
  expect(performance.now() - started).toBeLessThan(8_000)
  expect(run.outcome).toBe('ok')
  expect(entries().find((e) => e.msg === 'zaptec sync: vehicle re-match failed')).toMatchObject({
    level: WARN,
  })
})

test('a re-match is skipped when the run deadline passed before it', async () => {
  // The watermark lookup is not raced against the deadline, so it can outlast
  // it and return normally. A watermark past `now` leaves no fetch window, so the
  // run reaches the re-match with the signal already aborted.
  vi.spyOn(integrationSyncService, 'getLastSuccessStartedAt').mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    return new Date(T1.getTime() + 30 * DAY)
  })
  const rematch = vi.spyOn(evChargingService, 'reattributeSessions')
  const { client } = fakeZaptec([session('s0', new Date(T1.getTime() - DAY))])
  const { log, entries } = capturingLogger()
  const run = await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deadlineMs: 1_000,
    deps: { zaptec: client, log },
  })
  expect(run.outcome).toBe('ok')
  expect(rematch).not.toHaveBeenCalled()
  expect(
    entries().find((e) => e.msg === 'zaptec sync: vehicle re-match skipped, run deadline reached'),
  ).toMatchObject({ level: WARN })
})

test('a failed fetch never triggers a re-match', async () => {
  const rematch = vi.spyOn(evChargingService, 'reattributeSessions')
  const { client, state } = fakeZaptec()
  state.chargersError = new ZaptecError('unreachable', 'chargers', 503)
  const { log } = capturingLogger()
  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })
  expect(run.outcome).toBe('failed')
  expect(rematch).not.toHaveBeenCalled()
})

test('the run row records an integer reattributeMs timing', async () => {
  const { client } = fakeZaptec([session('s0', new Date(T1.getTime() - DAY))])
  const { log } = capturingLogger()
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })
  const [row] = await db.select({ timings: integrationSyncRun.timings }).from(integrationSyncRun)
  expect(Number.isInteger(row.timings.reattributeMs)).toBe(true)
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

test('a window over 20 pages is halved and retried until it fits', async () => {
  const { client, state } = fakeZaptec()
  const { log } = capturingLogger()
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  // 42 sessions an hour apart: 21 pages at 2 per page, one over the cap.
  const T2 = new Date(T1.getTime() + HOUR)
  state.sessions = Array.from({ length: 42 }, (_, i) =>
    session(`s${String(i).padStart(2, '0')}`, new Date(T2.getTime() - (i + 1) * HOUR)),
  )
  state.calls.sessions = []
  const run = await runZaptecSync({ trigger: 'cron', now: () => T2, deps: { zaptec: client, log } })

  expect(run).toMatchObject({ outcome: 'ok', syncedUntil: T2 })
  expect(await sessionRows()).toHaveLength(42)
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(T2)
  // The first attempt covered the whole 7-day lookback; the retries are narrower.
  const spans = state.calls.sessions.map((c) => (c.until?.getTime() ?? 0) - c.since.getTime())
  expect(spans[0]).toBe(7 * DAY + HOUR)
  expect(Math.min(...spans)).toBeLessThan(spans[0])
})

test('more than 20 pages within one hour fails as unexpected_response', async () => {
  const { client, state } = fakeZaptec()
  const { log, runLines } = capturingLogger()
  await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })

  // 82 sessions within 10 minutes: however a window of an hour or more splits
  // them, one side keeps 41+ (21+ pages at 2 per page).
  const T2 = new Date(T1.getTime() + HOUR)
  state.sessions = Array.from({ length: 82 }, (_, i) =>
    session(`s${String(i).padStart(2, '0')}`, new Date(T2.getTime() - 60_000 - i * 7_000)),
  )
  const run = await runZaptecSync({ trigger: 'cron', now: () => T2, deps: { zaptec: client, log } })

  expect(run).toMatchObject({ outcome: 'failed', code: 'unexpected_response' })
  // The narrowed windows before the cluster finished; the watermark stops short of it.
  const firstInCluster = Math.min(...state.sessions.map((x) => x.endAt.getTime()))
  expect(run.syncedUntil?.getTime()).toBeGreaterThan(T1.getTime())
  expect(run.syncedUntil?.getTime()).toBeLessThanOrEqual(firstInCluster)
  expect(await getLastSuccessStartedAt('zaptec')).toEqual(run.syncedUntil)
  expect(runLines()).toHaveLength(2)
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
  for (const key of ['authMs', 'fetchMs', 'importMs', 'reattributeMs'] as const) {
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

test('a failed query is recorded by its Postgres error, never its SQL or params', async () => {
  const { client, state } = fakeZaptec()
  await runZaptecSync({
    trigger: 'cron',
    now: () => T1,
    deps: { zaptec: client, log: capturingLogger().log },
  })
  // The same session twice in one page: the upsert can't touch a row twice.
  const owner = { email: 'owner@example.com', name: 'Owner Name' }
  state.sessions = [
    session('dup', new Date(T1.getTime() - DAY), { authorizedUser: owner }),
    session('dup', new Date(T1.getTime() - DAY), { authorizedUser: owner }),
  ]
  const { log } = capturingLogger()

  await expect(
    runZaptecSync({
      trigger: 'cron',
      now: () => new Date(T1.getTime() + HOUR),
      deps: { zaptec: client, log },
    }),
  ).rejects.toThrow()

  const health = await getHealth('zaptec', { now: T1, includeAdminDetail: true })
  const message = health.adminDetail?.lastErrorMessage ?? ''
  expect(health.code).toBe('internal_error')
  expect(message).toMatch(/^Database query failed \(SQLSTATE 21000\): ON CONFLICT DO UPDATE/)
  for (const leak of ['insert into', 'params', owner.email, owner.name]) {
    expect(message.toLowerCase()).not.toContain(leak.toLowerCase())
  }
})

test('a failure writing a successful outcome is not recorded again as internal_error', async () => {
  await insertUser('admin-a@example.com', 'admin')
  const { client } = fakeZaptec([session('s1', new Date(T1.getTime() - DAY))])
  const recordOutcome = vi
    .spyOn(integrationSyncService, 'recordOutcome')
    .mockRejectedValueOnce(new Error('connection reset'))
  const { log, entries, runLines } = capturingLogger()

  await expect(
    runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } }),
  ).rejects.toThrow('connection reset')

  // One write attempt (the success), no internal_error retry, no alert.
  expect(recordOutcome).toHaveBeenCalledOnce()
  expect(recordOutcome.mock.calls[0][1]).toMatchObject({ ok: true })
  expect(publish).not.toHaveBeenCalled()
  const health = await getHealth('zaptec', { now: T1, includeAdminDetail: false })
  expect(health).toMatchObject({ state: 'never_synced', code: null, running: true })
  expect(entries().some((e) => e.msg === 'integration sync outcome could not be recorded')).toBe(
    false,
  )
  expect(runLines()).toHaveLength(1)
  expect(runLines()[0]).toMatchObject({ level: ERROR, outcome: 'error' })
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

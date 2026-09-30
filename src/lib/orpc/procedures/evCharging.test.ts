import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession, user } from '~/lib/db/schema'
import { type FakeRoute, fakeFetch, jsonResponse } from '~/lib/effects/testing/fakeFetch'
import { createZaptecClient, zaptec } from '~/lib/effects/zaptec'
import {
  CHARGER_ID,
  chargingStateBody,
  INSTALLATION_ID,
  TEST_CREDS,
  tokenBody,
} from '~/lib/effects/zaptec/fixtures'
import type { Logger } from '~/lib/logger'
import * as integrationSyncService from '~/lib/services/integrationSync'
import { replaceDay } from '~/lib/services/spotPrice'
import * as tariffService from '~/lib/services/tariff'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { setupDatabase } from '~test/setup'
import { evChargingRouter } from './evCharging'

setupDatabase()

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog
  },
}

const baseContext = () => ({ headers: new Headers(), log: noopLog, requestId: 'test-request' })

function mockSession(row: { id: string; email: string; role: 'user' | 'admin' }) {
  vi.spyOn(auth.api, 'getSession').mockResolvedValue({
    session: {
      id: 'session-id',
      userId: row.id,
      token: 'token',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: row.id,
      email: row.email,
      name: 'Test',
      role: row.role,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function signIn(role: 'user' | 'admin') {
  const [row] = await db
    .insert(user)
    .values({ name: role, email: `${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role })
  return row
}

test('overview rejects an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.overview, {}, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('overview returns zero totals for a signed-in user with no data', async () => {
  await signIn('user')
  const result = await call(evChargingRouter.overview, {}, { context: baseContext() })
  expect(result.tiles.allTime).toEqual({ kwh: 0, sessions: 0 })
  expect(result.months).toHaveLength(12)
})

test('sessions rejects an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.sessions, { limit: 20 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('sessions returns an empty page for a signed-in user with no data', async () => {
  await signIn('user')
  const result = await call(evChargingRouter.sessions, { limit: 20 }, { context: baseContext() })
  expect(result).toEqual({ sessions: [], hasMore: false })
})

test('sessions rejects an out-of-range limit', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.sessions, { limit: 0 }, { context: baseContext() }),
  ).rejects.toBeDefined()
  await expect(
    call(evChargingRouter.sessions, { limit: 501 }, { context: baseContext() }),
  ).rejects.toBeDefined()
})

test('syncStatus rejects an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.syncStatus, undefined, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('syncStatus hides adminDetail for a non-admin user', async () => {
  await signIn('user')
  const health = await call(evChargingRouter.syncStatus, undefined, { context: baseContext() })
  expect(health.adminDetail).toBeNull()
})

test('syncStatus exposes adminDetail for an admin', async () => {
  await signIn('admin')
  const health = await call(evChargingRouter.syncStatus, undefined, { context: baseContext() })
  expect(health.adminDetail).toEqual({ lastErrorMessage: null })
})

test('liveStatus rejects an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.liveStatus, undefined, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('liveStatus returns null when there is no known charger', async () => {
  await signIn('user')
  const result = await call(evChargingRouter.liveStatus, undefined, { context: baseContext() })
  expect(result).toBeNull()
})

test('liveStatus returns null under the notConfigured zaptec client (VITEST)', async () => {
  await db
    .insert(evCharger)
    .values({ id: 'charger-1', name: 'Charger 1', installationId: 'inst-1' })
  await signIn('user')
  const result = await call(evChargingRouter.liveStatus, undefined, { context: baseContext() })
  expect(result).toBeNull()
})

test('liveStatus bounds the Zaptec wait with an abort signal', async () => {
  await db
    .insert(evCharger)
    .values({ id: 'charger-1', name: 'Charger 1', installationId: 'inst-1' })
  await signIn('user')
  const spy = vi.spyOn(zaptec, 'liveState')
  await call(evChargingRouter.liveStatus, undefined, { context: baseContext() })
  expect(spy).toHaveBeenCalledWith('charger-1', {
    signal: expect.any(AbortSignal),
    stats: expect.any(Object),
  })
})

// Routes the `zaptec` facade (notConfigured under VITEST) to a real HTTP
// client over a fake fetch, so the procedure sees the client's own stats.
async function withLiveClient(routes: Record<string, FakeRoute>) {
  await db
    .insert(evCharger)
    .values({ id: CHARGER_ID, name: 'Garage', installationId: INSTALLATION_ID })
  const client = createZaptecClient({ fetch: fakeFetch(routes).fetch, creds: TEST_CREDS })
  vi.spyOn(zaptec, 'liveState').mockImplementation((id, o) => client.liveState(id, o))
}

const TOKEN_ROUTE = 'POST /oauth/token'
const STATE_ROUTE = `GET /api/chargers/${CHARGER_ID}/state`

test('liveStatus records the Zaptec auth/fetch split and request count', async () => {
  await withLiveClient({
    // A slow login (cold instance) must show up as auth time, not fetch time.
    [TOKEN_ROUTE]: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return jsonResponse(tokenBody())
    },
    [STATE_ROUTE]: () => jsonResponse(chargingStateBody()),
  })
  await signIn('user')

  const timings: Record<string, number> = {}
  const result = await call(evChargingRouter.liveStatus, undefined, {
    context: { ...baseContext(), timings },
  })
  expect(result).toMatchObject({ mode: 'charging' })
  expect(timings).toMatchObject({
    zaptecLiveMs: expect.any(Number),
    zaptecAuthMs: expect.any(Number),
    zaptecFetchMs: expect.any(Number),
    zaptecRequests: 2, // token + state
    zaptecRetries: 0,
  })
  expect(timings.zaptecAuthMs).toBeGreaterThanOrEqual(20)
  expect(Number.isInteger(timings.zaptecAuthMs)).toBe(true)
  expect(Number.isInteger(timings.zaptecFetchMs)).toBe(true)
  expect(timings).not.toHaveProperty('zaptecLiveFailed')

  // Warm: token and state both cached → no HTTP at all.
  const warm: Record<string, number> = {}
  await call(evChargingRouter.liveStatus, undefined, {
    context: { ...baseContext(), timings: warm },
  })
  expect(warm).toMatchObject({
    zaptecAuthMs: 0,
    zaptecFetchMs: 0,
    zaptecRequests: 0,
    zaptecRetries: 0,
  })
})

test('liveStatus flags a failed Zaptec read in its timings', async () => {
  await withLiveClient({
    [TOKEN_ROUTE]: () => jsonResponse(tokenBody()),
    [STATE_ROUTE]: () => new Response(null, { status: 503 }),
  })
  await signIn('user')

  const timings: Record<string, number> = {}
  const result = await call(evChargingRouter.liveStatus, undefined, {
    context: { ...baseContext(), timings },
  })
  expect(result).toBeNull()
  expect(timings).toMatchObject({ zaptecLiveFailed: 1, zaptecRequests: 2 })
})

test('liveStatus counts a retried login', async () => {
  await withLiveClient({
    [TOKEN_ROUTE]: (_req, n) =>
      n === 0 ? new Response(null, { status: 503 }) : jsonResponse(tokenBody()),
    [STATE_ROUTE]: () => jsonResponse(chargingStateBody()),
  })
  await signIn('user')

  const timings: Record<string, number> = {}
  await call(evChargingRouter.liveStatus, undefined, { context: { ...baseContext(), timings } })
  expect(timings).toMatchObject({ zaptecRequests: 3, zaptecRetries: 1 })
  expect(timings).not.toHaveProperty('zaptecLiveFailed')
})

// Known limitation, pinned so it stays visible: the shared login runs without
// the caller's signal, and an attempt is timed only when it settles. A login
// that outlives the budget therefore reads as auth 0 with 1 request started —
// the whole `zaptecLiveMs` is unattributed waiting.
test('liveStatus attributes nothing to auth when the login outlives the budget', async () => {
  // Shrink only the procedure's 6 s budget (the client's own per-attempt
  // timeouts are 5 s / 10 s and keep their real value). If the budget constant
  // changes, the login completes in 300 ms and the `null` assertion fails.
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(ms === 6_000 ? 50 : ms))
  await withLiveClient({
    [TOKEN_ROUTE]: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return jsonResponse(tokenBody())
    },
    [STATE_ROUTE]: () => jsonResponse(chargingStateBody()),
  })
  await signIn('user')

  const timings: Record<string, number> = {}
  const result = await call(evChargingRouter.liveStatus, undefined, {
    context: { ...baseContext(), timings },
  })
  expect(result).toBeNull()
  expect(timings).toMatchObject({
    zaptecLiveFailed: 1,
    zaptecAuthMs: 0,
    zaptecFetchMs: 0,
    zaptecRequests: 1,
  })
  expect(timings.zaptecLiveMs).toBeGreaterThanOrEqual(40)
})

test('recentRuns rejects an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.recentRuns, { limit: 20 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('recentRuns is forbidden for a non-admin user', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.recentRuns, { limit: 20 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

test('recentRuns returns the (empty) run history for an admin', async () => {
  await signIn('admin')
  const runs = await call(evChargingRouter.recentRuns, {}, { context: baseContext() })
  expect(runs).toEqual([])
})

test('syncNow rejects an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.syncNow, undefined, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('syncNow is forbidden for a non-admin user', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.syncNow, undefined, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

test('syncNow reports a failed/not_configured outcome under the notConfigured zaptec client (VITEST)', async () => {
  await signIn('admin')
  const result = await call(evChargingRouter.syncNow, undefined, { context: baseContext() })
  expect(result).toEqual({ outcome: 'failed', code: 'not_configured', upserted: 0 })
})

test('syncNow with source elpris runs only the price sync', async () => {
  await signIn('admin')
  const result = await call(
    evChargingRouter.syncNow,
    { source: 'elpris' },
    { context: baseContext() },
  )
  expect(result).toEqual({ outcome: 'failed', code: 'not_configured', upserted: 0 })
  const zaptec = await integrationSyncService.getHealth('zaptec', {
    now: new Date(),
    includeAdminDetail: false,
  })
  expect(zaptec.state).toBe('never_synced')
})

test('syncStatus and recentRuns take a source', async () => {
  await signIn('admin')
  await call(evChargingRouter.syncNow, { source: 'elpris' }, { context: baseContext() })

  const elpris = await call(
    evChargingRouter.syncStatus,
    { source: 'elpris' },
    { context: baseContext() },
  )
  const zaptecDefault = await call(evChargingRouter.syncStatus, undefined, {
    context: baseContext(),
  })
  expect(elpris.source).toBe('elpris')
  expect(zaptecDefault.source).toBe('zaptec')

  const runs = await call(
    evChargingRouter.recentRuns,
    { source: 'elpris' },
    { context: baseContext() },
  )
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ trigger: 'admin', errorCode: 'not_configured' })
  // Only the price sync ran, so Zaptec's history (the default source) is empty.
  expect(await call(evChargingRouter.recentRuns, {}, { context: baseContext() })).toHaveLength(0)
})

test('syncStatus rejects an unknown source', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.syncStatus, { source: 'skoda' as never }, { context: baseContext() }),
  ).rejects.toThrow()
})

test('syncNow records zaptec timing sub-timings when context.timings is present', async () => {
  await signIn('admin')
  const timings: Record<string, number> = {}
  await call(evChargingRouter.syncNow, undefined, { context: { ...baseContext(), timings } })
  expect(timings.zaptecSyncMs).toBeGreaterThanOrEqual(0)
  expect(timings.zaptecFetchMs).toBeGreaterThanOrEqual(0)
  expect(timings.zaptecImportMs).toBeGreaterThanOrEqual(0)

  const priceTimings: Record<string, number> = {}
  await call(
    evChargingRouter.syncNow,
    { source: 'elpris' },
    { context: { ...baseContext(), timings: priceTimings } },
  )
  expect(priceTimings.elprisSyncMs).toBeGreaterThanOrEqual(0)
  expect(priceTimings.elprisFetchMs).toBeGreaterThanOrEqual(0)
})

test('patterns and timeline reject an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.patterns, {}, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(
    call(evChargingRouter.timeline, {}, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('patterns returns zero grids for a signed-in user with no data', async () => {
  await signIn('user')
  const result = await call(evChargingRouter.patterns, {}, { context: baseContext() })
  expect(result.weekdayHour).toHaveLength(7)
  expect(result.hourOfDay).toHaveLength(24)
})

test('timeline returns an empty month for a signed-in user with no data', async () => {
  await signIn('user')
  const result = await call(
    evChargingRouter.timeline,
    { year: 2026, month: 3 },
    { context: baseContext() },
  )
  expect(result).toMatchObject({ year: 2026, month: 3, months: [], sessions: [] })
})

test('patterns and timeline reject out-of-range input as BAD_REQUEST', async () => {
  await signIn('user')
  // oRPC turns a failed input schema into ORPCError('BAD_REQUEST').
  await expect(
    call(evChargingRouter.patterns, { year: 2019 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(
    call(evChargingRouter.timeline, { year: 2026, month: 0 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(
    call(evChargingRouter.timeline, { year: 2026, month: 13 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('patterns records its sub-timings', async () => {
  await signIn('user')
  const timings: Record<string, number> = {}
  await call(evChargingRouter.patterns, {}, { context: { ...baseContext(), timings } })
  expect(timings).toMatchObject({
    patternsFetchMs: expect.any(Number),
    patternsAggregateMs: expect.any(Number),
  })
})

test('timeline records its sub-timings', async () => {
  await signIn('user')
  const timings: Record<string, number> = {}
  await call(
    evChargingRouter.timeline,
    { year: 2026, month: 9 },
    { context: { ...baseContext(), timings } },
  )
  expect(timings).toMatchObject({
    timelineFetchMs: expect.any(Number),
    timelineAggregateMs: expect.any(Number),
  })
})

test('economy and session reject an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.economy, {}, { context: baseContext() }),
  ).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
  await expect(
    call(
      evChargingRouter.session,
      { sessionId: '00000000-0000-4000-8000-000000000000' },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('economy returns 12 empty months for a signed-in user with no data', async () => {
  await signIn('user')
  const result = await call(evChargingRouter.economy, {}, { context: baseContext() })
  expect(result.months).toHaveLength(12)
  expect(result.tiles).toMatchObject({ sessions: 0, included: 0, score: null })
})

test('economy rejects an out-of-range year as BAD_REQUEST', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.economy, { year: 2019 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('session maps an unknown id to EV_SESSION_NOT_FOUND (404) and a malformed one to BAD_REQUEST', async () => {
  await signIn('user')
  await expect(
    call(
      evChargingRouter.session,
      { sessionId: '00000000-0000-4000-8000-000000000000' },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'EV_SESSION_NOT_FOUND', status: 404, defined: true })
  await expect(
    call(evChargingRouter.session, { sessionId: 'nope' }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('economy records its sub-timings', async () => {
  await signIn('user')
  const timings: Record<string, number> = {}
  await call(evChargingRouter.economy, {}, { context: { ...baseContext(), timings } })
  expect(timings).toMatchObject({
    economyEnergyMs: expect.any(Number),
    economyTariffMs: expect.any(Number),
    economySlotsMs: expect.any(Number),
    economyDailySpotMs: expect.any(Number),
    economyYearsMs: expect.any(Number),
    economyComputeMs: expect.any(Number),
  })
})

test('session records its sub-timings even when it fails', async () => {
  await signIn('user')
  const timings: Record<string, number> = {}
  await call(
    evChargingRouter.session,
    { sessionId: '00000000-0000-4000-8000-000000000000' },
    { context: { ...baseContext(), timings } },
  ).catch(() => {})
  expect(timings).toMatchObject({ economyEnergyMs: expect.any(Number) })
})

test('session returns one counted session with its economy for a signed-in user', async () => {
  await signIn('user')
  await tariffService.create({
    validFrom: '2026-01-01',
    retailMarkupOre: 5.331,
    gridTransferOre: 35.6,
    energyTaxOre: 36,
    vatPercent: 25,
  })
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, (i) => (i >= 40 && i < 44 ? 3 : 1)),
  )
  await db
    .insert(evCharger)
    .values({ id: 'charger-econ', name: 'Charger', installationId: 'install-econ' })
  const [row] = await db
    .insert(evChargeSession)
    .values({
      zaptecSessionId: 'zap-econ-1',
      chargerId: 'charger-econ',
      startAt: new Date('2026-09-28T08:00:00Z'),
      endAt: new Date('2026-09-28T10:00:00Z'),
      energyKwh: 10,
    })
    .returning({ id: evChargeSession.id })
  await db.insert(evChargeInterval).values({
    sessionId: row.id,
    startAt: new Date('2026-09-28T08:00:00Z'),
    endAt: new Date('2026-09-28T09:00:00Z'),
    energyKwh: 10,
  })

  const result = await call(
    evChargingRouter.session,
    { sessionId: row.id },
    { context: baseContext() },
  )
  expect(result.session.id).toBe(row.id)
  expect(result.economy).toBeDefined()
  expect(result.economy.excluded).toBeNull()
  expect(result.economy.actualComplete).toBe(true)
})

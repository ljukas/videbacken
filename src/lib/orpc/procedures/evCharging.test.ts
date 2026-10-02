import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import {
  evChargeInterval,
  evCharger,
  evChargeSession,
  user,
  vehicleChargeRecord,
} from '~/lib/db/schema'
import { type FakeRoute, fakeFetch, jsonResponse } from '~/lib/effects/testing/fakeFetch'
import { createZaptecClient, zaptec } from '~/lib/effects/zaptec'
import {
  CHARGER_ID,
  chargingStateBody,
  INSTALLATION_ID,
  TEST_CREDS,
  tokenBody,
} from '~/lib/effects/zaptec/fixtures'
import { MAX_IMPORT_ROWS } from '~/lib/evCharging/vehicle'
import type { Logger } from '~/lib/logger'
import * as evChargingService from '~/lib/services/evCharging'
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

test('syncNow with source skoda runs only the car poll (not configured under VITEST)', async () => {
  await signIn('admin')
  const result = await call(
    evChargingRouter.syncNow,
    { source: 'skoda' },
    { context: baseContext() },
  )
  expect(result).toEqual({ outcome: 'failed', code: 'not_configured', upserted: 0 })
  const zaptec = await integrationSyncService.getHealth('zaptec', {
    now: new Date(),
    includeAdminDetail: false,
  })
  expect(zaptec.state).toBe('never_synced')
})

test('vehicleStateLatest is admin-only and null before any poll', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.vehicleStateLatest, undefined, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await signIn('admin')
  expect(
    await call(evChargingRouter.vehicleStateLatest, undefined, { context: baseContext() }),
  ).toBeNull()
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
    call(evChargingRouter.syncStatus, { source: 'nonsense' as never }, { context: baseContext() }),
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

// --- Vehicle attribution (ADR-0021) ---

let sessionSeq = 0
async function insertSession(
  over: Partial<typeof evChargeSession.$inferInsert> = {},
): Promise<string> {
  sessionSeq += 1
  await db
    .insert(evCharger)
    .values({ id: 'charger-veh', name: 'Charger', installationId: 'install-veh' })
    .onConflictDoNothing()
  const [row] = await db
    .insert(evChargeSession)
    .values({
      zaptecSessionId: `zap-veh-${sessionSeq}`,
      chargerId: 'charger-veh',
      startAt: new Date('2026-03-01T10:00:00Z'),
      endAt: new Date('2026-03-01T11:00:00Z'),
      energyKwh: 5,
      ...over,
    })
    .returning({ id: evChargeSession.id })
  return row.id
}

const importRow = (id: string, start = '2026-02-01T10:00:00Z', end = '2026-02-01T11:00:00Z') => ({
  sourceSessionId: id,
  startAt: new Date(start),
  endAt: new Date(end),
  energyKwh: 5,
  startSocPercent: 20,
  endSocPercent: 40,
  isPublic: false,
})

test('reads take a vehicle scope and default to all', async () => {
  await signIn('user')
  await insertSession({
    startAt: new Date('2026-03-01T10:00:00Z'),
    endAt: new Date('2026-03-01T11:00:00Z'),
  })
  await insertSession({
    startAt: new Date('2026-03-02T10:00:00Z'),
    endAt: new Date('2026-03-02T11:00:00Z'),
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const all = await call(evChargingRouter.sessions, { limit: 10 }, { context: baseContext() })
  const guests = await call(
    evChargingRouter.sessions,
    { limit: 10, vehicle: 'other' },
    { context: baseContext() },
  )
  expect(all.sessions).toHaveLength(2)
  expect(guests.sessions.map((s) => s.vehicle)).toEqual(['other'])
  await expect(
    call(
      evChargingRouter.sessions,
      { limit: 10, vehicle: 'x' as never },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('the attribution mutations and coverage are admin-only', async () => {
  await signIn('user')
  const id = await insertSession()
  for (const [proc, input] of [
    [evChargingRouter.setSessionVehicle, { sessionId: id, vehicle: 'other' }],
    [evChargingRouter.importVehicleRecords, { rows: [importRow('a')] }],
    [evChargingRouter.vehicleRecordCoverage, undefined],
  ] as const) {
    await expect(
      call(proc as never, input as never, { context: baseContext() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
})

test('importVehicleRecords stores rows, re-matches, and is idempotent', async () => {
  await signIn('admin')
  const id = await insertSession({
    startAt: new Date('2026-02-10T10:00:00Z'),
    endAt: new Date('2026-02-10T12:00:00Z'),
  })
  const rows = [importRow('a', '2026-02-10T09:30:00Z', '2026-02-10T13:00:00Z')]
  expect(
    await call(evChargingRouter.importVehicleRecords, { rows }, { context: baseContext() }),
  ).toEqual({ inserted: 1, unchanged: 0, ours: 1, other: 0 })
  expect(
    await call(evChargingRouter.importVehicleRecords, { rows }, { context: baseContext() }),
  ).toEqual({ inserted: 0, unchanged: 1, ours: 1, other: 0 })
  expect(
    await call(evChargingRouter.vehicleRecordCoverage, undefined, { context: baseContext() }),
  ).toMatchObject({ count: 1 })
  expect(
    await call(
      evChargingRouter.setSessionVehicle,
      { sessionId: id, vehicle: 'other' },
      { context: baseContext() },
    ),
  ).toEqual({ vehicle: 'other', vehicleSource: 'admin' })
})

test('importVehicleRecords records its sub-timings', async () => {
  await signIn('admin')
  const timings: Record<string, number> = {}
  await call(
    evChargingRouter.importVehicleRecords,
    { rows: [importRow('a')] },
    { context: { ...baseContext(), timings } },
  )
  expect(timings).toMatchObject({
    vehicleImportMs: expect.any(Number),
    vehicleReattributeMs: expect.any(Number),
  })
})

test('setSessionVehicle records its sub-timing, also on the reset path', async () => {
  await signIn('admin')
  const id = await insertSession()
  for (const vehicle of ['other', null] as const) {
    const timings: Record<string, number> = {}
    await call(
      evChargingRouter.setSessionVehicle,
      { sessionId: id, vehicle },
      { context: { ...baseContext(), timings } },
    )
    expect(timings).toMatchObject({ vehicleTagMs: expect.any(Number) })
  }
})

test('importVehicleRecords rejects an empty, oversized or inverted import', async () => {
  await signIn('admin')
  for (const rows of [
    [],
    Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => importRow(`r${i}`)),
    [importRow('a', '2026-02-10T12:00:00Z', '2026-02-10T11:00:00Z')],
  ]) {
    await expect(
      call(evChargingRouter.importVehicleRecords, { rows }, { context: baseContext() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
})

test('setSessionVehicle maps an unknown session to EV_SESSION_NOT_FOUND (404)', async () => {
  await signIn('admin')
  await expect(
    call(
      evChargingRouter.setSessionVehicle,
      { sessionId: '00000000-0000-4000-8000-000000000000', vehicle: null },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'EV_SESSION_NOT_FOUND', status: 404, defined: true })
})

test('every scoped read passes the vehicle through to its read model', async () => {
  await signIn('user')
  await insertSession({
    startAt: new Date('2026-03-01T10:00:00Z'),
    endAt: new Date('2026-03-01T11:00:00Z'),
    energyKwh: 5,
  })
  await insertSession({
    startAt: new Date('2026-04-01T10:00:00Z'),
    endAt: new Date('2026-04-01T11:00:00Z'),
    energyKwh: 7,
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const ctx = { context: baseContext() }
  const input = { year: 2026 }

  const overview = (v: 'all' | 'other') =>
    call(evChargingRouter.overview, { ...input, vehicle: v }, ctx)
  expect((await overview('all')).tiles.allTime.sessions).toBe(2)
  expect((await overview('other')).tiles.allTime.sessions).toBe(1)

  const cost = (v: 'all' | 'other') =>
    call(evChargingRouter.costOverview, { ...input, vehicle: v }, ctx)
  expect((await cost('all')).tiles.allTime.kwh).toBe(12)
  expect((await cost('other')).tiles.allTime.kwh).toBe(7)

  const patternHours = async (v: 'all' | 'other') =>
    (await call(evChargingRouter.patterns, { ...input, vehicle: v }, ctx)).weekdayHour
      .flat()
      .reduce((sum, c) => sum + c.pluggedHours, 0)
  expect(await patternHours('all')).toBeCloseTo(2)
  expect(await patternHours('other')).toBeCloseTo(1)

  const timeline = (v: 'all' | 'other') =>
    call(evChargingRouter.timeline, { ...input, vehicle: v }, ctx)
  expect((await timeline('all')).months).toEqual([3, 4])
  expect((await timeline('other')).months).toEqual([4])

  const economy = (v: 'all' | 'other') =>
    call(evChargingRouter.economy, { ...input, vehicle: v }, ctx)
  expect((await economy('all')).tiles.sessions).toBe(2)
  expect((await economy('other')).tiles.sessions).toBe(1)
})

test('a re-import with nothing inserted still re-matches a stale attribution', async () => {
  await signIn('admin')
  const id = await insertSession({
    startAt: new Date('2026-02-10T10:00:00Z'),
    endAt: new Date('2026-02-10T12:00:00Z'),
  })
  const rows = [importRow('a', '2026-02-10T09:30:00Z', '2026-02-10T13:00:00Z')]
  await call(evChargingRouter.importVehicleRecords, { rows }, { context: baseContext() })
  await db
    .update(evChargeSession)
    .set({ vehicle: 'other', vehicleSource: 'skoda' })
    .where(eq(evChargeSession.id, id))
  const again = await call(
    evChargingRouter.importVehicleRecords,
    { rows },
    { context: baseContext() },
  )
  expect(again).toMatchObject({ inserted: 0, unchanged: 1, ours: 1 })
  const [after] = await db
    .select({ vehicle: evChargeSession.vehicle, vehicleSource: evChargeSession.vehicleSource })
    .from(evChargeSession)
    .where(eq(evChargeSession.id, id))
  expect(after).toEqual({ vehicle: 'ours', vehicleSource: 'skoda' })
})

test('importVehicleRecords still reports its import timing when the re-match fails', async () => {
  await signIn('admin')
  vi.spyOn(evChargingService, 'reattributeSessions').mockRejectedValue(new Error('boom'))
  const timings: Record<string, number> = {}
  await expect(
    call(
      evChargingRouter.importVehicleRecords,
      { rows: [importRow('a')] },
      { context: { ...baseContext(), timings } },
    ),
  ).rejects.toBeDefined()
  expect(timings).toHaveProperty('vehicleImportMs')
  const stored = await db.select().from(vehicleChargeRecord)
  expect(stored).toHaveLength(1)
})

test('the attribution procedures reject an unauthenticated caller', async () => {
  for (const [proc, input] of [
    [
      evChargingRouter.setSessionVehicle,
      { sessionId: '00000000-0000-4000-8000-000000000000', vehicle: 'other' },
    ],
    [evChargingRouter.importVehicleRecords, { rows: [importRow('a')] }],
    [evChargingRouter.vehicleRecordCoverage, undefined],
  ] as const) {
    await expect(
      call(proc as never, input as never, { context: baseContext() }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  }
})

test('importVehicleRecords rejects an extra key and an out-of-range timestamp', async () => {
  await signIn('admin')
  for (const row of [
    { ...importRow('a'), locationName: 'Home' },
    importRow('a', '1969-12-31T00:00:00Z', '2026-02-01T11:00:00Z'),
    importRow('a', '2026-02-01T10:00:00Z', '2200-01-01T00:00:00Z'),
  ]) {
    await expect(
      call(evChargingRouter.importVehicleRecords, { rows: [row] }, { context: baseContext() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
})

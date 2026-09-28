import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { evCharger, user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
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

test('syncNow records zaptec timing sub-timings when context.timings is present', async () => {
  await signIn('admin')
  const timings: Record<string, number> = {}
  await call(evChargingRouter.syncNow, undefined, { context: { ...baseContext(), timings } })
  expect(timings.zaptecSyncMs).toBeGreaterThanOrEqual(0)
  expect(timings.zaptecFetchMs).toBeGreaterThanOrEqual(0)
  expect(timings.zaptecImportMs).toBeGreaterThanOrEqual(0)
})

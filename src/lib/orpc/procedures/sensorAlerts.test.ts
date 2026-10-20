import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { sensorDevice, user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { setupDatabase } from '~test/setup'
import { appRouter } from '../router'
import { sensorRouter } from './sensor'

setupDatabase()

const alerts = sensorRouter.alerts
const MISSING = '00000000-0000-4000-8000-000000000000'
const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog
  },
}
const ctx = () => ({ headers: new Headers(), log: noopLog, requestId: 'test-request' })

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
async function signIn(name: string) {
  const [row] = await db
    .insert(user)
    .values({ name, email: `${name}@test.videbacken.local`, role: 'user' })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role: 'user' })
  return row
}
async function device() {
  const [d] = await db
    .insert(sensorDevice)
    .values({ mac: 'aaaaaaaaaaaa' })
    .returning({ id: sensorDevice.id })
  return d.id
}

const temp = (deviceId: string) => ({
  kind: 'temperature' as const,
  deviceId,
  direction: 'below' as const,
  threshold: 17.5,
  count: 3,
})

test('the alerts router is registered under sensor', () => {
  expect(appRouter.sensor.alerts).toBe(sensorRouter.alerts)
})

test('list rejects anonymous callers', async () => {
  await expect(call(alerts.list, undefined, { context: ctx() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
})

test('a user-role caller manages its own rule end to end', async () => {
  await signIn('a')
  const d = await device()
  const rule = await call(alerts.create, temp(d), { context: ctx() })
  expect(rule).toMatchObject({ deviceId: d, kind: 'temperature', enabled: true })

  const listed = await call(alerts.list, undefined, { context: ctx() })
  expect(listed.rules).toEqual([rule])
  expect(listed.typicalGapMinutes).toHaveProperty(d)

  const updated = await call(
    alerts.update,
    { ...temp(d), id: rule.id, threshold: 15, count: 4 },
    { context: ctx() },
  )
  expect(updated).toMatchObject({ id: rule.id, threshold: 15, count: 4 })

  const off = await call(alerts.setEnabled, { id: rule.id, enabled: false }, { context: ctx() })
  expect(off.enabled).toBe(false)

  await call(alerts.delete, { id: rule.id }, { context: ctx() })
  expect((await call(alerts.list, undefined, { context: ctx() })).rules).toEqual([])
})

test("another user can't see or touch a rule", async () => {
  const a = await signIn('a')
  const d = await device()
  const rule = await call(alerts.create, temp(d), { context: ctx() })

  await signIn('b')
  expect((await call(alerts.list, undefined, { context: ctx() })).rules).toEqual([])
  const notFound = { code: 'RULE_NOT_FOUND', status: 404 }
  await expect(
    call(alerts.update, { ...temp(d), id: rule.id, threshold: 10 }, { context: ctx() }),
  ).rejects.toMatchObject(notFound)
  await expect(
    call(alerts.setEnabled, { id: rule.id, enabled: false }, { context: ctx() }),
  ).rejects.toMatchObject(notFound)
  await expect(call(alerts.delete, { id: rule.id }, { context: ctx() })).rejects.toMatchObject(
    notFound,
  )

  mockSession({ id: a.id, email: a.email, role: 'user' })
  expect((await call(alerts.list, undefined, { context: ctx() })).rules).toEqual([rule])
})

test('an unknown device is UNKNOWN_SENSOR; a count of 1 is a bad request', async () => {
  await signIn('a')
  await expect(call(alerts.create, temp(MISSING), { context: ctx() })).rejects.toMatchObject({
    code: 'UNKNOWN_SENSOR',
    status: 422,
  })
  const d = await device()
  await expect(
    call(alerts.create, { ...temp(d), count: 1 }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 })
})

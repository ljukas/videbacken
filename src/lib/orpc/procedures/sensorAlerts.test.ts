import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { sensorAlertEvent, sensorDevice, user } from '~/lib/db/schema'
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
  expect(listed.rules).toEqual([{ ...rule, firingSince: null }])
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
  expect((await call(alerts.list, undefined, { context: ctx() })).rules).toEqual([
    { ...rule, firingSince: null },
  ])
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

test('update of an owned rule with a missing device is UNKNOWN_SENSOR', async () => {
  await signIn('a')
  const d = await device()
  const rule = await call(alerts.create, temp(d), { context: ctx() })
  await expect(
    call(alerts.update, { ...temp(MISSING), id: rule.id }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_SENSOR', status: 422 })
})

test("another user's update with a missing device is RULE_NOT_FOUND, not UNKNOWN_SENSOR", async () => {
  await signIn('a')
  const d = await device()
  const rule = await call(alerts.create, temp(d), { context: ctx() })
  await signIn('b')
  await expect(
    call(alerts.update, { ...temp(MISSING), id: rule.id }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'RULE_NOT_FOUND', status: 404 })
})

test('a kind-changing update returns the unused fields as null', async () => {
  await signIn('a')
  const d = await device()
  const rule = await call(alerts.create, temp(d), { context: ctx() })
  const updated = await call(
    alerts.update,
    { kind: 'silence', deviceId: d, silenceHours: 6, id: rule.id },
    { context: ctx() },
  )
  expect(updated).toMatchObject({
    id: rule.id,
    kind: 'silence',
    silenceHours: 6,
    direction: null,
    threshold: null,
    count: null,
  })
})

test('list records the rules and hints timings', async () => {
  await signIn('a')
  const timings: Record<string, number> = {}
  await call(alerts.list, undefined, { context: { ...ctx(), timings } })
  expect(timings).toHaveProperty('alertRulesMs')
  expect(timings).toHaveProperty('alertHintsMs')
})

test('create, update, setEnabled and delete reject anonymous callers', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const unauthorized = { code: 'UNAUTHORIZED' }
  await expect(call(alerts.create, temp(MISSING), { context: ctx() })).rejects.toMatchObject(
    unauthorized,
  )
  await expect(
    call(alerts.update, { ...temp(MISSING), id }, { context: ctx() }),
  ).rejects.toMatchObject(unauthorized)
  await expect(
    call(alerts.setEnabled, { id, enabled: false }, { context: ctx() }),
  ).rejects.toMatchObject(unauthorized)
  await expect(call(alerts.delete, { id }, { context: ctx() })).rejects.toMatchObject(unauthorized)
})

const BASE = new Date('2026-01-01T00:00:00Z').getTime()
const eventRow = (
  userId: string,
  deviceId: string,
  minute: number,
  ruleId: string | null = null,
) => ({
  ruleId,
  userId,
  deviceId,
  kind: 'temperature' as const,
  direction: 'below' as const,
  threshold: 5,
  count: 2,
  startedAt: new Date(BASE + minute * 60_000),
  endedAt: new Date(BASE + minute * 60_000 + 1000),
  endReason: 'recovered' as const,
})

test('list returns firingSince for the rule with an open alert', async () => {
  const u = await signIn('a')
  const d = await device()
  const rule = await call(alerts.create, temp(d), { context: ctx() })
  const started = new Date(BASE)
  await db.insert(sensorAlertEvent).values({
    ...eventRow(u.id, d, 0, rule.id),
    startedAt: started,
    endedAt: null,
    endReason: null,
  })
  const listed = await call(alerts.list, undefined, { context: ctx() })
  expect(listed.rules).toEqual([{ ...rule, firingSince: started }])
})

test("history returns only the caller's entries for the device and pages with before", async () => {
  const a = await signIn('a')
  const d = await device()
  const [other] = await db
    .insert(sensorDevice)
    .values({ mac: 'bbbbbbbbbbbb' })
    .returning({ id: sensorDevice.id })
  const [b] = await db
    .insert(user)
    .values({ name: 'b', email: 'b@test.videbacken.local', role: 'user' })
    .returning({ id: user.id })
  await db
    .insert(sensorAlertEvent)
    .values([
      ...Array.from({ length: 12 }, (_, i) => eventRow(a.id, d, i)),
      eventRow(b.id, d, 50),
      eventRow(a.id, other.id, 60),
    ])

  const timings: Record<string, number> = {}
  const first = await call(alerts.history, { deviceId: d }, { context: { ...ctx(), timings } })
  expect(timings).toHaveProperty('alertHistoryMs')
  expect(first.entries.map((e) => e.startedAt.getTime())).toEqual(
    Array.from({ length: 10 }, (_, i) => BASE + (11 - i) * 60_000),
  )
  expect(first.next).not.toBeNull()
  const second = await call(
    alerts.history,
    { deviceId: d, before: first.next ?? undefined },
    { context: ctx() },
  )
  expect(second.entries.map((e) => e.startedAt.getTime())).toEqual([BASE + 60_000, BASE])
  expect(second.next).toBeNull()
})

test('history rejects anonymous callers', async () => {
  await expect(
    call(alerts.history, { deviceId: MISSING }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('the 21st rule on a sensor is TOO_MANY_RULES (409)', async () => {
  await signIn('a')
  const d = await device()
  for (let i = 0; i < 20; i++) {
    await call(alerts.create, { ...temp(d), threshold: i }, { context: ctx() })
  }
  await expect(call(alerts.create, temp(d), { context: ctx() })).rejects.toMatchObject({
    code: 'TOO_MANY_RULES',
    status: 409,
  })
})

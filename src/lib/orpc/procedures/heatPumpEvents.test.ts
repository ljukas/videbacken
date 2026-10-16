import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { heatPumpEvent, user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import * as heatPumpService from '~/lib/services/heatPump'
import { HeatPumpDomainError } from '~/lib/services/heatPump'
import { addDays, stockholmDayOf } from '~/lib/time/stockholm'
import { setupDatabase } from '~test/setup'
import { appRouter } from '../router'
import { heatPumpRouter } from './heatPump'

setupDatabase()

const events = heatPumpRouter.events
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
async function signIn(role: 'user' | 'admin') {
  const [row] = await db
    .insert(user)
    .values({ name: role, email: `${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role })
  return row
}

// A past day, whatever the real clock says.
const SERVICE = {
  occurredOn: '2026-10-08',
  heatPumpId: null,
  kind: 'service' as const,
  note: 'Årlig service',
}

test('the events router is registered under heatPump', () => {
  expect(appRouter.heatPump.events).toBe(heatPumpRouter.events)
})

test('list rejects anonymous callers and is readable by any signed-in user', async () => {
  await expect(call(events.list, undefined, { context: ctx() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
  await signIn('user')
  expect(await call(events.list, undefined, { context: ctx() })).toEqual([])
})

test.each([
  'create',
  'update',
  'delete',
] as const)('%s is forbidden for a non-admin', async (name) => {
  await signIn('user')
  const input =
    name === 'create' ? SERVICE : name === 'update' ? { ...SERVICE, id: MISSING } : { id: MISSING }
  await expect(
    // biome-ignore lint/suspicious/noExplicitAny: one table-driven gate test over three procedures
    call(events[name] as any, input, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await db.select().from(heatPumpEvent)).toEqual([])
})

test('an admin creates, updates and deletes; the author is the session user', async () => {
  const me = await signIn('admin')
  const created = await call(events.create, SERVICE, { context: ctx() })
  expect(created).toMatchObject(SERVICE)
  const [row] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, created.id))
  expect(row.createdBy).toBe(me.id)

  const updated = await call(
    events.update,
    { ...SERVICE, id: created.id, kind: 'filter', note: null },
    { context: ctx() },
  )
  expect(updated).toMatchObject({ id: created.id, kind: 'filter', note: null })
  expect(await call(events.list, undefined, { context: ctx() })).toEqual([updated])

  await call(events.delete, { id: created.id }, { context: ctx() })
  expect(await call(events.list, undefined, { context: ctx() })).toEqual([])
})

test('every event domain error surfaces as its typed code and status', async () => {
  await signIn('admin')
  const tomorrow = addDays(stockholmDayOf(Date.now()), 1)
  await expect(
    call(events.create, { ...SERVICE, occurredOn: tomorrow }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'FUTURE_DATE', status: 422 })
  await expect(
    call(events.create, { ...SERVICE, note: 'x'.repeat(501) }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'NOTE_TOO_LONG', status: 422 })
  await expect(
    call(events.create, { ...SERVICE, heatPumpId: MISSING }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_HEAT_PUMP', status: 422 })
  await expect(
    call(events.update, { ...SERVICE, id: MISSING }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 })
  await expect(call(events.delete, { id: MISSING }, { context: ctx() })).rejects.toMatchObject({
    code: 'EVENT_NOT_FOUND',
    status: 404,
  })
})

// Review Focus 2.
test('a 500-character note with an emoji passes the input boundary', async () => {
  await signIn('admin')
  const note = `${'å'.repeat(499)}🙂`
  expect((await call(events.create, { ...SERVICE, note }, { context: ctx() })).note).toBe(note)
})

test.each([
  ['a day that does not exist', { occurredOn: '2026-02-30' }],
  ['a day in another format', { occurredOn: '8/10/2026' }],
  ['an unknown kind', { kind: 'repair' }],
  ['a heat pump id that is not a uuid', { heatPumpId: 'matsal' }],
  ['an absurdly long note', { note: 'x'.repeat(2001) }],
])('%s is BAD_REQUEST', async (_, override) => {
  await signIn('admin')
  await expect(
    call(events.create, { ...SERVICE, ...override } as never, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('a non-event domain error or an unexpected error propagates untyped', async () => {
  await signIn('admin')
  vi.spyOn(heatPumpService, 'createEvent').mockRejectedValueOnce(
    new HeatPumpDomainError('INVALID_READING'),
  )
  const domain = await call(events.create, SERVICE, { context: ctx() }).catch((e: unknown) => e)
  expect(domain).not.toHaveProperty('defined', true)
  vi.spyOn(heatPumpService, 'deleteEvent').mockRejectedValueOnce(new Error('db down'))
  await expect(call(events.delete, { id: MISSING }, { context: ctx() })).rejects.toThrow('db down')
})

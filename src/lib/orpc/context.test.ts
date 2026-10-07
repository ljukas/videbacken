import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import * as userService from '~/lib/services/user'
import { setupDatabase } from '~test/setup'
import {
  adminProcedure,
  authMemoFor,
  createAuthMemo,
  memoFoundActiveUser,
  protectedProcedure,
} from './context'

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

// The base (initial) context every procedure is called with — mirrors what
// src/routes/api/rpc/$.ts hands the RPC handler per request.
const baseContext = () => ({
  headers: new Headers(),
  log: noopLog,
  requestId: 'test-request',
})

// Simulate the session Better Auth mints/serves for a user whose row still
// exists: the exact state a *revoked* user lands in after re-authenticating via
// Google (the create.before gate never fires — the row already exists), and
// also the up-to-5-min cookieCache window where a stale session is served after
// revokeUserSessions. The session is present and valid; only the DB row's
// deletedAt says the user is gone.
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

const echo = protectedProcedure.handler(() => 'ok')
const adminEcho = adminProcedure.handler(() => 'ok')

test('protectedProcedure rejects a soft-deleted (revoked) user even with a valid session', async () => {
  const [row] = await db
    .insert(user)
    .values({
      name: 'Revoked',
      email: 'revoked@test.videbacken.local',
      role: 'admin',
      deletedAt: new Date(),
    })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role: 'admin' })

  await expect(call(echo, undefined, { context: baseContext() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
})

test('adminProcedure rejects a soft-deleted admin even with role=admin in the session', async () => {
  const [row] = await db
    .insert(user)
    .values({
      name: 'Revoked Admin',
      email: 'revoked-admin@test.videbacken.local',
      role: 'admin',
      deletedAt: new Date(),
    })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role: 'admin' })

  // requireAuth runs before requireAdmin, so the revoked admin is rejected as
  // UNAUTHORIZED (not FORBIDDEN) before the role check is ever reached.
  await expect(call(adminEcho, undefined, { context: baseContext() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
})

test('protectedProcedure allows an active user', async () => {
  const [row] = await db
    .insert(user)
    .values({ name: 'Active', email: 'active@test.videbacken.local', role: 'user' })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role: 'user' })

  await expect(call(echo, undefined, { context: baseContext() })).resolves.toBe('ok')
})

async function activeUser(role: 'user' | 'admin' = 'user') {
  const [row] = await db
    .insert(user)
    .values({ name: 'Memo', email: `memo-${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role })
  return row
}

test('one HTTP request looks the session and the user up once, however many calls it makes', async () => {
  await activeUser()
  const getSession = vi.mocked(auth.api.getSession)
  const findActiveById = vi.spyOn(userService, 'findActiveById')
  const authMemo = createAuthMemo()
  await call(echo, undefined, { context: { ...baseContext(), authMemo } })
  await call(adminEcho, undefined, { context: { ...baseContext(), authMemo } }).catch(() => {})
  await call(echo, undefined, { context: { ...baseContext(), authMemo } })
  expect(getSession).toHaveBeenCalledTimes(1)
  expect(findActiveById).toHaveBeenCalledTimes(1)
  // The next request looks both up again.
  await call(echo, undefined, { context: { ...baseContext(), authMemo: createAuthMemo() } })
  expect(getSession).toHaveBeenCalledTimes(2)
  expect(findActiveById).toHaveBeenCalledTimes(2)
})

test('a user revoked between two requests is rejected on the second', async () => {
  const row = await activeUser()
  await expect(
    call(echo, undefined, { context: { ...baseContext(), authMemo: createAuthMemo() } }),
  ).resolves.toBe('ok')
  await db.update(user).set({ deletedAt: new Date() }).where(eq(user.id, row.id))
  await expect(
    call(echo, undefined, { context: { ...baseContext(), authMemo: createAuthMemo() } }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('a failed session lookup fails every call of that request, and the next request retries', async () => {
  await activeUser()
  vi.mocked(auth.api.getSession).mockRejectedValueOnce(new Error('auth down'))
  const authMemo = createAuthMemo()
  await expect(call(echo, undefined, { context: { ...baseContext(), authMemo } })).rejects.toThrow()
  await expect(call(echo, undefined, { context: { ...baseContext(), authMemo } })).rejects.toThrow()
  await expect(
    call(echo, undefined, { context: { ...baseContext(), authMemo: createAuthMemo() } }),
  ).resolves.toBe('ok')
})

test('without a memo every call looks up (tests, scripts)', async () => {
  await activeUser()
  const findActiveById = vi.spyOn(userService, 'findActiveById')
  await call(echo, undefined, { context: baseContext() })
  await call(echo, undefined, { context: baseContext() })
  expect(findActiveById).toHaveBeenCalledTimes(2)
})

test('only the call that ran a lookup records its timing', async () => {
  await activeUser()
  const authMemo = createAuthMemo()
  const first: Record<string, number> = {}
  const second: Record<string, number> = {}
  await call(echo, undefined, { context: { ...baseContext(), authMemo, timings: first } })
  await call(echo, undefined, { context: { ...baseContext(), authMemo, timings: second } })
  expect(first).toMatchObject({
    getSessionMs: expect.any(Number),
    findActiveByIdMs: expect.any(Number),
  })
  expect(second).toEqual({})
})

test('authMemoFor gives every call of one SSR request the same memo', () => {
  const a = new Request('http://localhost/charging')
  const b = new Request('http://localhost/charging')
  expect(authMemoFor(a)).toBe(authMemoFor(a))
  expect(authMemoFor(a)).not.toBe(authMemoFor(b))
})

test('concurrent calls of one request share the one in-flight lookup', async () => {
  await activeUser()
  const getSession = vi.mocked(auth.api.getSession)
  const findActiveById = vi.spyOn(userService, 'findActiveById')
  const authMemo = createAuthMemo()
  await Promise.all(
    [1, 2, 3].map(() => call(echo, undefined, { context: { ...baseContext(), authMemo } })),
  )
  expect(getSession).toHaveBeenCalledTimes(1)
  expect(findActiveById).toHaveBeenCalledTimes(1)
})

test('a memo never answers for other headers: a different cookie looks up again', async () => {
  await activeUser()
  const getSession = vi.mocked(auth.api.getSession)
  const authMemo = createAuthMemo()
  const withCookie = (cookie: string) => ({
    ...baseContext(),
    headers: new Headers({ cookie }),
    authMemo,
  })
  await call(echo, undefined, { context: withCookie('session=a') })
  await call(echo, undefined, { context: withCookie('session=b') })
  expect(getSession).toHaveBeenCalledTimes(2)
  // The same cookie again is the memo's request: no new lookup.
  await call(echo, undefined, { context: withCookie('session=a') })
  expect(getSession).toHaveBeenCalledTimes(2)
})

test('memoFoundActiveUser: only a request whose lookup found an active user counts as signed in', async () => {
  const signedIn = createAuthMemo()
  const row = await activeUser()
  await call(echo, undefined, { context: { ...baseContext(), authMemo: signedIn } })
  expect(await memoFoundActiveUser(signedIn)).toBe(true)

  // Revoked: the session cookie is still accepted, the user row is not.
  await db.update(user).set({ deletedAt: new Date() }).where(eq(user.id, row.id))
  const revoked = createAuthMemo()
  await call(echo, undefined, { context: { ...baseContext(), authMemo: revoked } }).catch(() => {})
  expect(await memoFoundActiveUser(revoked)).toBe(false)

  // No lookup at all (a public procedure, an unknown path).
  expect(await memoFoundActiveUser(createAuthMemo())).toBe(false)
})

test('memoFoundActiveUser is false when the lookup failed', async () => {
  await activeUser()
  vi.spyOn(userService, 'findActiveById').mockRejectedValueOnce(new Error('db down'))
  const authMemo = createAuthMemo()
  await call(echo, undefined, { context: { ...baseContext(), authMemo } }).catch(() => {})
  expect(await memoFoundActiveUser(authMemo)).toBe(false)
})

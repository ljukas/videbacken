import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { setupDatabase } from '~test/setup'
import { adminProcedure, protectedProcedure } from './context'

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

import { randomBytes } from 'node:crypto'
import { call, ORPCError } from '@orpc/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { CREDENTIAL_FIELDS, CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import type { Logger } from '~/lib/logger'
import { readStored } from '~/lib/services/integrationCredential'
import { setupDatabase } from '~test/setup'
import { credentialsRouter, setCredentialsInput } from './credentials'

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

async function signIn(role: 'user' | 'admin') {
  const [row] = await db
    .insert(user)
    .values({ name: role, email: `${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role })
  return row
}

beforeEach(() => {
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function capturingLog() {
  const lines: unknown[][] = []
  const log: Logger = {
    debug: (...a) => lines.push(a),
    info: (...a) => lines.push(a),
    warn: (...a) => lines.push(a),
    error: (...a) => lines.push(a),
    child: () => log,
  }
  return { log, text: () => JSON.stringify(lines) }
}

const SECRET = 'sk-super-secret-value-123'

test.each([
  ['status', undefined],
  ['set', { source: 'zaptec', fields: { password: SECRET } }],
  ['clear', { source: 'zaptec' }],
] as const)('%s is forbidden for a member and rejects anonymous callers', async (name, input) => {
  await expect(
    call(credentialsRouter[name] as never, input as never, { context: baseContext() }),
  ).rejects.toThrow()
  await signIn('user')
  await expect(
    call(credentialsRouter[name] as never, input as never, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await readStored('zaptec')).toBeNull()
})

test('the input schema allows exactly each source’s own fields', () => {
  for (const source of CREDENTIAL_SOURCES) {
    const option = setCredentialsInput.options.find((o) => o.shape.source.value === source)
    expect(Object.keys(option?.shape.fields.shape ?? {})).toEqual([...CREDENTIAL_FIELDS[source]])
  }
})

test('set stores, returns names only, and logs names only', async () => {
  await signIn('admin')
  const { log, text } = capturingLog()
  const result = await call(
    credentialsRouter.set,
    { source: 'zaptec', fields: { username: 'me@example.com', password: SECRET } },
    { context: { ...baseContext(), log } },
  )
  expect(result.fieldsSet).toEqual(['username', 'password'])
  expect(JSON.stringify(result)).not.toContain(SECRET)
  expect(await readStored('zaptec')).toEqual({ username: 'me@example.com', password: SECRET })
  expect(text()).toContain('admin set integration credentials')
  expect(text()).not.toContain(SECRET)
  expect(text()).not.toContain('me@example.com')
})

test('set maps INVALID_FIELD with every field name and no value', async () => {
  await signIn('admin')
  const err = await call(
    credentialsRouter.set,
    { source: 'skoda', fields: { vin: 'bad-vin-value', homeCoordinates: 'nowhere-value' } },
    { context: baseContext() },
  ).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ORPCError)
  expect(err).toMatchObject({
    code: 'INVALID_FIELD',
    defined: true,
    data: { fields: ['vin', 'homeCoordinates'] },
  })
  expect(JSON.stringify(err)).not.toContain('bad-vin-value')
})

test('set maps REENTER_ALL_FIELDS with the blank fields', async () => {
  await signIn('admin')
  await call(
    credentialsRouter.set,
    { source: 'zaptec', fields: { username: 'u', password: 'p' } },
    {
      context: baseContext(),
    },
  )
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
  await expect(
    call(
      credentialsRouter.set,
      { source: 'zaptec', fields: { username: 'u2' } },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({
    code: 'REENTER_ALL_FIELDS',
    defined: true,
    data: { fields: ['password'] },
  })
})

test.each([
  ['NOTHING_TO_SAVE', { password: '   ' }, undefined],
  ['ENCRYPTION_KEY_MISSING', { password: SECRET }, ''],
] as const)('set maps %s', async (code, fields, key) => {
  await signIn('admin')
  if (key !== undefined) vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', key)
  await expect(
    call(credentialsRouter.set, { source: 'zaptec', fields }, { context: baseContext() }),
  ).rejects.toMatchObject({ code, defined: true })
})

test('set rejects a field of another source at input, storing nothing', async () => {
  await signIn('admin')
  await expect(
    call(credentialsRouter.set, { source: 'skoda', fields: { username: SECRET } } as never, {
      context: baseContext(),
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(await readStored('skoda')).toBeNull()
})

test('status reports origins without values; clear removes the row and logs the source', async () => {
  await signIn('admin')
  await call(
    credentialsRouter.set,
    { source: 'zaptec', fields: { password: SECRET } },
    {
      context: baseContext(),
    },
  )
  const status = await call(credentialsRouter.status, undefined, { context: baseContext() })
  expect(status.sources.zaptec.fields.password.origin).toBe('stored')
  expect(JSON.stringify(status)).not.toContain(SECRET)

  const { log, text } = capturingLog()
  expect(
    await call(
      credentialsRouter.clear,
      { source: 'zaptec' },
      { context: { ...baseContext(), log } },
    ),
  ).toEqual({ cleared: true })
  expect(await readStored('zaptec')).toBeNull()
  expect(text()).toContain('admin cleared integration credentials')
  expect(
    await call(credentialsRouter.clear, { source: 'zaptec' }, { context: baseContext() }),
  ).toEqual({ cleared: false })
})

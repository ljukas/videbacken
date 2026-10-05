import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '~/lib/db'
import { integrationCredential, user } from '~/lib/db/schema'
import * as integrationCredentialService from '~/lib/services/integrationCredential'
import { setupDatabase } from '~test/setup'
import { invalidateCredentials } from './cache'
import { CredentialsUnreadableError, encrypt } from './crypto'
import { resolveCredentials } from './resolve'

setupDatabase()

const ZAPTEC_ENV = ['ZAPTEC_USERNAME', 'ZAPTEC_PASSWORD'] as const

beforeEach(() => {
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
  for (const name of ZAPTEC_ENV) vi.stubEnv(name, '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function insertUser() {
  const [row] = await db
    .insert(user)
    .values({ name: 'a', email: 'admin@example.com', role: 'admin' })
    .returning({ id: user.id })
  return row.id
}

/** Writes a raw zaptec row, bypassing the service (and so its cache invalidation). */
async function writeRaw(values: Record<string, string>) {
  const ciphertext = encrypt('zaptec', JSON.stringify(values))
  await db
    .insert(integrationCredential)
    .values({ source: 'zaptec', ciphertext, fieldsSet: Object.keys(values) })
    .onConflictDoUpdate({
      target: integrationCredential.source,
      set: { ciphertext, fieldsSet: Object.keys(values) },
    })
}

describe('resolveCredentials precedence', () => {
  it('uses env when there is no row', async () => {
    vi.stubEnv('ZAPTEC_USERNAME', 'env-user')
    vi.stubEnv('ZAPTEC_PASSWORD', 'env-pass')
    const { values } = await resolveCredentials('zaptec')
    expect(values).toEqual({ username: 'env-user', password: 'env-pass' })
  })

  it('lets a stored field beat its env var while other fields stay on env', async () => {
    vi.stubEnv('ZAPTEC_USERNAME', 'env-user')
    vi.stubEnv('ZAPTEC_PASSWORD', 'env-pass')
    await writeRaw({ username: 'stored-user' })
    const { values } = await resolveCredentials('zaptec')
    expect(values).toEqual({ username: 'stored-user', password: 'env-pass' })
  })

  it('leaves a field absent (not empty) when neither has it', async () => {
    vi.stubEnv('ZAPTEC_USERNAME', 'env-user')
    const { values } = await resolveCredentials('zaptec')
    expect(values).toEqual({ username: 'env-user' })
    expect('password' in values).toBe(false)
  })

  it('treats a whitespace-only env var as absent', async () => {
    vi.stubEnv('ZAPTEC_USERNAME', '   ')
    const { values } = await resolveCredentials('zaptec')
    expect(values).toEqual({})
  })
})

describe('resolveCredentials key handling', () => {
  it('resolves from env without error when there is no key and no row', async () => {
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', '')
    vi.stubEnv('ZAPTEC_USERNAME', 'env-user')
    const { values } = await resolveCredentials('zaptec')
    expect(values).toEqual({ username: 'env-user' })
  })

  it('throws CredentialsUnreadableError when there is a row but no key', async () => {
    await writeRaw({ username: 'stored-user' })
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', '')
    vi.stubEnv('ZAPTEC_USERNAME', 'env-user')
    await expect(resolveCredentials('zaptec')).rejects.toBeInstanceOf(CredentialsUnreadableError)
  })
})

describe('resolveCredentials cache', () => {
  it('does not see a direct row change, but sees a service save at once', async () => {
    await writeRaw({ username: 'first' })
    expect((await resolveCredentials('zaptec')).values.username).toBe('first')

    await db
      .update(integrationCredential)
      .set({ ciphertext: encrypt('zaptec', JSON.stringify({ username: 'second' })) })
      .where(eq(integrationCredential.source, 'zaptec'))
    expect((await resolveCredentials('zaptec')).values.username).toBe('first')

    const userId = await insertUser()
    await integrationCredentialService.set('zaptec', { username: 'third' }, userId)
    expect((await resolveCredentials('zaptec')).values.username).toBe('third')
  })

  it('sees a direct row change once the 60 s TTL has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'))
    await writeRaw({ username: 'first' })
    expect((await resolveCredentials('zaptec')).values.username).toBe('first')

    await db
      .update(integrationCredential)
      .set({ ciphertext: encrypt('zaptec', JSON.stringify({ username: 'second' })) })
      .where(eq(integrationCredential.source, 'zaptec'))

    vi.setSystemTime(new Date('2026-10-05T12:00:59Z'))
    expect((await resolveCredentials('zaptec')).values.username).toBe('first')
    vi.setSystemTime(new Date('2026-10-05T12:01:01Z'))
    expect((await resolveCredentials('zaptec')).values.username).toBe('second')
  })
})

describe('resolveCredentials fingerprint', () => {
  it('is equal for equal values regardless of origin and differs when a value changes', async () => {
    vi.stubEnv('ZAPTEC_USERNAME', 'same-user')
    vi.stubEnv('ZAPTEC_PASSWORD', 'same-pass')
    const fromEnv = await resolveCredentials('zaptec')

    await writeRaw({ username: 'same-user', password: 'same-pass' })
    vi.stubEnv('ZAPTEC_USERNAME', '')
    vi.stubEnv('ZAPTEC_PASSWORD', '')
    invalidateCredentials()
    const fromStored = await resolveCredentials('zaptec')
    expect(fromStored.fingerprint).toBe(fromEnv.fingerprint)

    await writeRaw({ username: 'same-user', password: 'other-pass' })
    invalidateCredentials()
    const changed = await resolveCredentials('zaptec')
    expect(changed.fingerprint).not.toBe(fromEnv.fingerprint)
  })

  it('is 64 hex chars and contains no value', async () => {
    vi.stubEnv('ZAPTEC_USERNAME', 'secret-user')
    vi.stubEnv('ZAPTEC_PASSWORD', 'secret-pass')
    const { fingerprint } = await resolveCredentials('zaptec')
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint).not.toContain('secret')
  })
})

import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialsUnreadableError, encrypt } from '~/lib/credentials/crypto'
import { db } from '~/lib/db'
import { integrationCredential, user } from '~/lib/db/schema'
import { logger } from '~/lib/logger/server'
import { setupDatabase } from '~test/setup'
import { IntegrationCredentialDomainError } from './errors'
import { clear, readStored, set, status } from './integrationCredential'

setupDatabase()

const newKey = () => randomBytes(32).toString('base64')
let KEY = newKey()

beforeEach(() => {
  KEY = newKey()
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function insertUser(email = 'admin@example.com') {
  const [row] = await db
    .insert(user)
    .values({ name: email, email, role: 'admin' })
    .returning({ id: user.id })
  return row.id
}

const rows = () => db.select().from(integrationCredential)

/** Writes a raw envelope of `plaintext` for `source`, bypassing the service. */
async function insertRaw(source: 'skoda' | 'zaptec', plaintext: string) {
  await db
    .insert(integrationCredential)
    .values({ source, ciphertext: encrypt(source, plaintext), fieldsSet: ['apiKey'] })
}

async function domainError(fn: () => Promise<unknown>): Promise<IntegrationCredentialDomainError> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(IntegrationCredentialDomainError)
    return err as IntegrationCredentialDomainError
  }
  throw new Error('expected an IntegrationCredentialDomainError')
}

describe('set', () => {
  it('merges per field and upper-cases the VIN', async () => {
    const userId = await insertUser()
    await set('skoda', { apiKey: 'k1' }, userId)
    const result = await set('skoda', { vin: 'tmbjr7ny0pz123456' }, userId)
    expect(result.fieldsSet).toEqual(['apiKey', 'vin'])
    expect(result.updatedAt).toBeInstanceOf(Date)
    expect(await readStored('skoda')).toEqual({ apiKey: 'k1', vin: 'TMBJR7NY0PZ123456' })
    const [row] = await rows()
    expect(row.updatedBy).toBe(userId)
  })

  it('keeps the stored value for blank and whitespace fields, and trims', async () => {
    await set('emaldo', { user: 'u1', password: 'p1' }, null)
    await set('emaldo', { user: '', password: '   ', appId: ' k2 ' }, null)
    expect(await readStored('emaldo')).toEqual({ user: 'u1', password: 'p1', appId: 'k2' })
  })

  it('writes fields_set in vocabulary order', async () => {
    await set('emaldo', { appSecret: 's', user: 'u' }, null)
    await set('emaldo', { password: 'p' }, null)
    const [row] = await rows()
    expect(row.fieldsSet).toEqual(['user', 'password', 'appSecret'])
  })

  it('stores home coordinates and a facility ID that pass their parsers', async () => {
    await set('skoda', { homeCoordinates: ' 59.3293, 18.0686 ' }, null)
    await set('gridTariff', { facilityId: '735999123456789012' }, null)
    expect(await readStored('skoda')).toEqual({ homeCoordinates: '59.3293, 18.0686' })
    expect(await readStored('gridTariff')).toEqual({ facilityId: '735999123456789012' })
  })

  describe('INVALID_FIELD', () => {
    const cases: [string, 'skoda' | 'zaptec' | 'gridTariff', Record<string, string>, string][] = [
      ['an unknown field', 'skoda', { token: 'x-secret-token' }, 'token'],
      ['a malformed VIN', 'skoda', { vin: 'not-a-vin' }, 'vin'],
      ['an 18-char VIN', 'skoda', { vin: 'TMBJR7NY0PZ1234567' }, 'vin'],
      ['a VIN with I', 'skoda', { vin: 'TMBJR7NY0PZ12345I' }, 'vin'],
      ['a VIN with O', 'skoda', { vin: 'TMBJR7NY0PZ12345O' }, 'vin'],
      ['a VIN with Q', 'skoda', { vin: 'TMBJR7NY0PZ12345Q' }, 'vin'],
      ['bad home coordinates', 'skoda', { homeCoordinates: 'home' }, 'homeCoordinates'],
      ['a short facility ID', 'gridTariff', { facilityId: '12345' }, 'facilityId'],
      ['a 513-char password', 'zaptec', { password: 'p'.repeat(513) }, 'password'],
    ]
    for (const [name, source, fields, field] of cases) {
      it(`rejects ${name} without echoing the value or writing a row`, async () => {
        const err = await domainError(() => set(source, fields, null))
        expect(err.code).toBe('INVALID_FIELD')
        expect(err.field).toBe(field)
        // Exact: the message names the field and carries no part of the value.
        expect(err.message).toBe(`INVALID_FIELD (${field})`)
        expect(await rows()).toEqual([])
      })
    }

    it('accepts a 512-char password', async () => {
      await set('zaptec', { password: 'p'.repeat(512) }, null)
      expect((await readStored('zaptec'))?.password).toHaveLength(512)
    })

    it('rejects an unknown field even next to valid ones', async () => {
      const err = await domainError(() => set('zaptec', { username: 'u', token: 'x' }, null))
      expect(err.field).toBe('token')
      expect(await rows()).toEqual([])
    })
  })

  it('NOTHING_TO_SAVE for no fields or only blank ones', async () => {
    expect((await domainError(() => set('skoda', {}, null))).code).toBe('NOTHING_TO_SAVE')
    expect((await domainError(() => set('skoda', { apiKey: '  ' }, null))).code).toBe(
      'NOTHING_TO_SAVE',
    )
    expect(await rows()).toEqual([])
  })

  it('ENCRYPTION_KEY_MISSING without a key, writing nothing', async () => {
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', '')
    const err = await domainError(() => set('skoda', { apiKey: 'k' }, null))
    expect(err.code).toBe('ENCRYPTION_KEY_MISSING')
    expect(err.message).toBe('ENCRYPTION_KEY_MISSING')
    expect(await rows()).toEqual([])
  })

  it('replaces an unreadable row and logs only the source', async () => {
    await set('skoda', { vin: 'TMBJR7NY0PZ123456', apiKey: 'old' }, null)
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const result = await set('skoda', { apiKey: 'k' }, null)
    expect(result.fieldsSet).toEqual(['apiKey'])
    expect(await readStored('skoda')).toEqual({ apiKey: 'k' })
    expect(warn).toHaveBeenCalledWith('integration credentials replaced unreadable row', {
      source: 'skoda',
    })
  })

  it('keeps plaintext out of the ciphertext column; fields_set holds names only', async () => {
    await set('zaptec', { username: 'plain-user-value', password: 'plain-pass-value' }, null)
    const [row] = await rows()
    expect(row.ciphertext).not.toContain('plain-user-value')
    expect(row.ciphertext).not.toContain('plain-pass-value')
    expect(row.ciphertext).toMatch(/^v1\./)
    expect(row.fieldsSet).toEqual(['username', 'password'])
  })

  it('keeps both fields of two concurrent first saves', async () => {
    await Promise.all([set('emaldo', { user: 'u' }, null), set('emaldo', { password: 'p' }, null)])
    expect(await readStored('emaldo')).toEqual({ user: 'u', password: 'p' })
  })

  it('sets updatedBy null when that user is deleted', async () => {
    const userId = await insertUser()
    await set('zaptec', { username: 'u' }, userId)
    await db.delete(user).where(eq(user.id, userId))
    const [row] = await rows()
    expect(row.updatedBy).toBeNull()
  })
})

describe('readStored', () => {
  it('is null without a row', async () => {
    expect(await readStored('skoda')).toBeNull()
  })

  it('throws CredentialsUnreadableError under a wrong key and a missing key', async () => {
    await set('skoda', { apiKey: 'k' }, null)
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    await expect(readStored('skoda')).rejects.toMatchObject({
      name: 'CredentialsUnreadableError',
      reason: 'invalid',
    })
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', '')
    await expect(readStored('skoda')).rejects.toMatchObject({
      name: 'CredentialsUnreadableError',
      reason: 'key_missing',
    })
  })

  for (const plaintext of [
    '[1]',
    '{"apiKey":7}',
    '{"bogus":"x"}',
    '{"apiKey":""}',
    'null',
    '"k"',
    'not json',
  ]) {
    it(`treats a decrypted ${plaintext} as unreadable`, async () => {
      await insertRaw('skoda', plaintext)
      const err = await readStored('skoda').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CredentialsUnreadableError)
      expect(err).toMatchObject({ source: 'skoda', reason: 'invalid' })
    })
  }
})

describe('status', () => {
  it('reports stored / env / missing per field without any value', async () => {
    await set('skoda', { apiKey: 'stored-api-key' }, null)
    vi.stubEnv('SKODA_VIN', 'ENVVIN0000000000X')
    vi.stubEnv('SKODA_HOME_COORDINATES', '  ')
    vi.stubEnv('ZAPTEC_PASSWORD', 'env-zaptec-password')
    const result = await status()
    expect(result.encryptionKeyConfigured).toBe(true)
    expect(result.sources.skoda.fields).toEqual({
      apiKey: { origin: 'stored' },
      vin: { origin: 'env' },
      homeCoordinates: { origin: 'missing' },
    })
    expect(result.sources.skoda.unreadable).toBe(false)
    expect(result.sources.skoda.updatedAt).toBeInstanceOf(Date)
    expect(result.sources.zaptec).toEqual({
      fields: { username: { origin: 'missing' }, password: { origin: 'env' } },
      updatedAt: null,
      unreadable: false,
    })
    const json = JSON.stringify(result)
    for (const value of ['stored-api-key', 'ENVVIN0000000000X', 'env-zaptec-password', KEY]) {
      expect(json).not.toContain(value)
    }
  })

  it('flags a wrong-key row unreadable while its fields stay stored', async () => {
    await set('zaptec', { username: 'u', password: 'p' }, null)
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const result = await status()
    expect(result.sources.zaptec.unreadable).toBe(true)
    expect(result.sources.zaptec.fields).toEqual({
      username: { origin: 'stored' },
      password: { origin: 'stored' },
    })
  })

  it('encryptionKeyConfigured follows the key', async () => {
    expect((await status()).encryptionKeyConfigured).toBe(true)
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', '')
    expect((await status()).encryptionKeyConfigured).toBe(false)
  })
})

describe('clear', () => {
  it('deletes the row, then is idempotent', async () => {
    await set('gridTariff', { facilityId: '735999123456789012' }, null)
    expect(await clear('gridTariff')).toBe(true)
    expect(await readStored('gridTariff')).toBeNull()
    expect(await clear('gridTariff')).toBe(false)
  })
})

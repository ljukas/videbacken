import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedStored } from '~/lib/credentials/cache'
import { CredentialsUnreadableError, encrypt } from '~/lib/credentials/crypto'
import { db } from '~/lib/db'
import { integrationCredential, user } from '~/lib/db/schema'
import { logger } from '~/lib/logger/server'
import { setupDatabase } from '~test/setup'
import { IntegrationCredentialDomainError } from './errors'
import { clear, homePosition, readStored, set, status } from './integrationCredential'

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
        expect(err.fields).toEqual([field])
        // Exact: the message names the field and carries no part of the value.
        expect(err.message).toBe(`INVALID_FIELD (${field})`)
        expect(await rows()).toEqual([])
      })
    }

    it('accepts a 512-char password', async () => {
      await set('zaptec', { password: 'p'.repeat(512) }, null)
      expect((await readStored('zaptec'))?.password).toHaveLength(512)
    })

    it('lists every invalid field at once, unknown names first and deduplicated', async () => {
      const err = await domainError(() =>
        set(
          'skoda',
          { 'x-1': 'a', 'y-2': 'b', apiKey: 'fine', vin: 'short', homeCoordinates: 'nowhere' },
          null,
        ),
      )
      expect(err.code).toBe('INVALID_FIELD')
      expect(err.fields).toEqual(['unknown', 'vin', 'homeCoordinates'])
      expect(err.message).toBe('INVALID_FIELD (unknown, vin, homeCoordinates)')
      expect(await rows()).toEqual([])
    })

    it('rejects an unknown field even next to valid ones', async () => {
      const err = await domainError(() => set('zaptec', { username: 'u', token: 'x' }, null))
      expect(err.fields).toEqual(['token'])
      expect(await rows()).toEqual([])
    })

    it("names an unknown field 'unknown' unless it looks like a field name", async () => {
      for (const key of ['x-secret-token', 'a'.repeat(33), 'tok3n', '']) {
        const err = await domainError(() => set('skoda', { [key]: 'v' }, null))
        expect(err.code).toBe('INVALID_FIELD')
        expect(err.fields).toEqual(['unknown'])
        expect(err.message).toBe('INVALID_FIELD (unknown)')
      }
      const err = await domainError(() => set('skoda', { ['a'.repeat(32)]: 'v' }, null))
      expect(err.fields).toEqual(['a'.repeat(32)])
    })

    it('rejects control characters inside a value', async () => {
      for (const value of ['a\u0000b', 'p\nq', 'x\u007fy', 'tab\there']) {
        const err = await domainError(() => set('zaptec', { password: value }, null))
        expect(err.code).toBe('INVALID_FIELD')
        expect(err.fields).toEqual(['password'])
      }
      expect(await rows()).toEqual([])
    })

    it('rejects a value that is not well-formed UTF-16 (lone surrogates)', async () => {
      // 512 lone high surrogates: within the length limit, but JSON escapes each as six
      // characters, so four such Emaldo fields would overflow the ciphertext CHECK.
      const err = await domainError(() => set('emaldo', { password: '\ud800'.repeat(512) }, null))
      expect(err.code).toBe('INVALID_FIELD')
      expect(err.fields).toEqual(['password'])
      for (const value of ['a\udc00b', 'x\ud83d']) {
        expect((await domainError(() => set('emaldo', { user: value }, null))).fields).toEqual([
          'user',
        ])
      }
      expect(await rows()).toEqual([])
      // A well-formed surrogate pair (an emoji) is still a valid value.
      await set('emaldo', { user: 'u😀' }, null)
      expect(await readStored('emaldo')).toEqual({ user: 'u😀' })
    })

    it('rejects a non-string value', async () => {
      const err = await domainError(() => set('skoda', { apiKey: 7 as never }, null))
      expect(err.code).toBe('INVALID_FIELD')
      expect(err.fields).toEqual(['apiKey'])
    })

    it('leaves an existing row unchanged', async () => {
      await set('skoda', { apiKey: 'good' }, null)
      const [before] = await rows()
      const err = await domainError(() => set('skoda', { apiKey: 'new', vin: 'bad' }, null))
      expect(err.fields).toEqual(['vin'])
      expect(await readStored('skoda')).toEqual({ apiKey: 'good' })
      expect(await rows()).toEqual([before])
    })
  })

  it('NOTHING_TO_SAVE for no fields or only blank ones', async () => {
    expect((await domainError(() => set('skoda', {}, null))).code).toBe('NOTHING_TO_SAVE')
    expect((await domainError(() => set('skoda', { apiKey: '  ' }, null))).code).toBe(
      'NOTHING_TO_SAVE',
    )
    expect(await rows()).toEqual([])
  })

  it('NOTHING_TO_SAVE leaves an existing row unchanged', async () => {
    await set('skoda', { apiKey: 'good' }, null)
    const [before] = await rows()
    const err = await domainError(() => set('skoda', { apiKey: ' ', vin: '' }, null))
    expect(err.code).toBe('NOTHING_TO_SAVE')
    expect(await rows()).toEqual([before])
  })

  for (const [name, key] of [
    ['without a key', ''],
    ['with a malformed key', 'abc'],
  ]) {
    it(`ENCRYPTION_KEY_MISSING ${name}, writing nothing`, async () => {
      vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', key)
      const err = await domainError(() => set('skoda', { apiKey: 'k' }, null))
      expect(err.code).toBe('ENCRYPTION_KEY_MISSING')
      expect(err.message).toBe('ENCRYPTION_KEY_MISSING')
      expect(await rows()).toEqual([])
    })
  }

  it('replaces an unreadable row when every field is sent, and logs only the source', async () => {
    await set('skoda', { apiKey: 'old-key' }, null)
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const result = await set(
      'skoda',
      { apiKey: 'new-key', vin: 'TMBJR7NY0PZ123456', homeCoordinates: '59.3293,18.0686' },
      null,
    )
    expect(result.fieldsSet).toEqual(['apiKey', 'vin', 'homeCoordinates'])
    expect(await readStored('skoda')).toEqual({
      apiKey: 'new-key',
      vin: 'TMBJR7NY0PZ123456',
      homeCoordinates: '59.3293,18.0686',
    })
    expect(warn).toHaveBeenCalledWith('integration credentials replaced unreadable row', {
      source: 'skoda',
    })
  })

  it('REENTER_ALL_FIELDS over an unreadable row with a field left blank writes nothing', async () => {
    await set('zaptec', { username: 'u', password: 'p' }, null)
    const [before] = await rows()
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const err = await domainError(() =>
      set('zaptec', { username: 'new-user', password: '  ' }, null),
    )
    expect(err.code).toBe('REENTER_ALL_FIELDS')
    expect(err.fields).toEqual(['password'])
    expect(err.message).toBe('REENTER_ALL_FIELDS (password)')
    const [after] = await rows()
    expect(after.ciphertext).toBe(before.ciphertext)
  })

  describe('check order over an unreadable row', () => {
    const unreadableZaptec = async () => {
      await set('zaptec', { username: 'u', password: 'p' }, null)
      const [before] = await rows()
      vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
      return before
    }

    it('INVALID_FIELD wins over REENTER_ALL_FIELDS and writes nothing', async () => {
      const before = await unreadableZaptec()
      const err = await domainError(() => set('zaptec', { username: 'x'.repeat(513) }, null))
      expect(err.code).toBe('INVALID_FIELD')
      expect(err.fields).toEqual(['username'])
      expect((await rows())[0].ciphertext).toBe(before.ciphertext)
    })

    it('NOTHING_TO_SAVE wins over REENTER_ALL_FIELDS', async () => {
      await unreadableZaptec()
      const err = await domainError(() => set('zaptec', { username: ' ', password: '' }, null))
      expect(err.code).toBe('NOTHING_TO_SAVE')
      expect(err.fields).toEqual([])
    })

    it('ENCRYPTION_KEY_MISSING wins over REENTER_ALL_FIELDS', async () => {
      await set('skoda', { apiKey: 'old' }, null)
      vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', '')
      const err = await domainError(() => set('skoda', { apiKey: 'k' }, null))
      expect(err.code).toBe('ENCRYPTION_KEY_MISSING')
      expect(err.fields).toEqual([])
    })
  })

  it('INVALID_FIELD lists non-string values with the rest, without any value', async () => {
    const err = await domainError(() =>
      set('skoda', { apiKey: 7 as never, vin: 'short', homeCoordinates: 99 as never }, null),
    )
    expect(err.code).toBe('INVALID_FIELD')
    expect(err.fields).toEqual(['apiKey', 'vin', 'homeCoordinates'])
    expect(err.message).toBe('INVALID_FIELD (apiKey, vin, homeCoordinates)')
  })

  it('REENTER_ALL_FIELDS lists every blank field, in vocabulary order', async () => {
    await set('skoda', { apiKey: 'old' }, null)
    const [before] = await rows()
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const err = await domainError(() => set('skoda', { vin: 'TMBJR7NY0PZ123456' }, null))
    expect(err.code).toBe('REENTER_ALL_FIELDS')
    expect(err.fields).toEqual(['apiKey', 'homeCoordinates'])
    expect((await rows())[0].ciphertext).toBe(before.ciphertext)
  })

  it('REENTER_ALL_FIELDS over a malformed-shape row', async () => {
    await insertRaw('skoda', '{"bogus":"x"}')
    const err = await domainError(() => set('skoda', { apiKey: 'k' }, null))
    expect(err.code).toBe('REENTER_ALL_FIELDS')
    expect(err.fields).toEqual(['vin', 'homeCoordinates'])
  })

  it('over a readable row a blank field still keeps its stored value', async () => {
    await set('zaptec', { username: 'u', password: 'p' }, null)
    await set('zaptec', { username: 'u2', password: '' }, null)
    expect(await readStored('zaptec')).toEqual({ username: 'u2', password: 'p' })
  })

  it('keeps plaintext out of the ciphertext column; fields_set holds names only', async () => {
    await set('zaptec', { username: 'plain-user-value', password: 'plain-pass-value' }, null)
    const [row] = await rows()
    expect(row.ciphertext).not.toContain('plain-user-value')
    expect(row.ciphertext).not.toContain('plain-pass-value')
    expect(row.ciphertext).toMatch(/^v1\./)
    expect(row.fieldsSet).toEqual(['username', 'password'])
  })

  it('waits on the per-source lock, so a concurrent first save is merged, not dropped', async () => {
    // The test pool has one connection, so a second save on it would just queue
    // at checkout. A separate connection on this test's schema holds the lock
    // while its own first save is still uncommitted.
    const {
      rows: [{ schema }],
    } = await db.execute<{ schema: string }>(sql`SELECT current_schema() AS schema`)
    const other = new Client({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema},public`,
    })
    await other.connect()
    let pending: Promise<unknown> | undefined
    try {
      await other.query('BEGIN')
      await other.query(
        "SELECT pg_advisory_xact_lock(hashtext('videbacken.integration_credential:emaldo'))",
      )
      await other.query(
        'INSERT INTO integration_credential (source, ciphertext, fields_set) VALUES ($1, $2, $3)',
        ['emaldo', encrypt('emaldo', '{"password":"p"}'), ['password']],
      )

      const saving = set('emaldo', { user: 'u' }, null)
      pending = saving
      const PENDING = Symbol('pending')
      const first = await Promise.race([
        saving,
        new Promise((resolve) => setTimeout(() => resolve(PENDING), 150)),
      ])
      expect(first).toBe(PENDING)

      await other.query('COMMIT')
      await saving
      expect(await readStored('emaldo')).toEqual({ user: 'u', password: 'p' })
    } finally {
      // Ending the connection rolls back and releases the lock, so a failed
      // assertion never leaves `set` blocked on the single pool connection.
      await other.end()
      await pending?.catch(() => {})
    }
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
    vi.stubEnv('SKODA_API_KEY', '')
    vi.stubEnv('SKODA_VIN', 'ENVVIN0000000000X')
    vi.stubEnv('SKODA_HOME_COORDINATES', '  ')
    vi.stubEnv('ZAPTEC_PASSWORD', 'env-zaptec-password')
    // test/setup.ts loads .env, so pin every field asserted `missing`.
    vi.stubEnv('ZAPTEC_USERNAME', '')
    const result = await status()
    expect(result.encryptionKeyConfigured).toBe(true)
    expect(result.sources.skoda.fields).toEqual({
      apiKey: { origin: 'stored', envSet: false },
      vin: { origin: 'env', envSet: true },
      homeCoordinates: { origin: 'missing', envSet: false },
    })
    expect(result.sources.skoda.unreadable).toBe(false)
    expect(result.sources.skoda.updatedAt).toBeInstanceOf(Date)
    expect(result.sources.zaptec).toEqual({
      fields: {
        username: { origin: 'missing', envSet: false },
        password: { origin: 'env', envSet: true },
      },
      updatedAt: null,
      unreadable: false,
    })
    const json = JSON.stringify(result)
    for (const value of ['stored-api-key', 'ENVVIN0000000000X', 'env-zaptec-password', KEY]) {
      expect(json).not.toContain(value)
    }
  })

  it('envSet says whether an env var exists, even behind a stored value', async () => {
    vi.stubEnv('SKODA_API_KEY', 'env-key')
    vi.stubEnv('SKODA_VIN', '  ')
    vi.stubEnv('SKODA_HOME_COORDINATES', '')
    await set('skoda', { apiKey: 'stored-key', vin: 'TMBJJ7NE8L0123456' }, null)
    const { sources } = await status()
    expect(sources.skoda.fields.apiKey).toEqual({ origin: 'stored', envSet: true })
    expect(sources.skoda.fields.vin).toEqual({ origin: 'stored', envSet: false })
    expect(sources.skoda.fields.homeCoordinates.envSet).toBe(false)
  })

  it('flags a wrong-key row unreadable while its fields stay stored', async () => {
    await set('zaptec', { username: 'u', password: 'p' }, null)
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    vi.stubEnv('ZAPTEC_USERNAME', '')
    vi.stubEnv('ZAPTEC_PASSWORD', 'env-zaptec-password')
    const result = await status()
    expect(result.sources.zaptec.unreadable).toBe(true)
    expect(result.sources.zaptec.fields).toEqual({
      username: { origin: 'stored', envSet: false },
      password: { origin: 'stored', envSet: true },
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

describe('cache invalidation', () => {
  // One fixed `now`: the TTL never expires, so only invalidation can refresh a read.
  const NOW = 1_000
  const cachedSkoda = () => cachedStored('skoda', () => readStored('skoda'), NOW)

  it('set invalidates the cached stored read', async () => {
    expect(await cachedSkoda()).toBeNull()
    await set('skoda', { apiKey: 'k' }, null)
    expect(await cachedSkoda()).toEqual({ apiKey: 'k' })
  })

  it('clear invalidates the cached stored read', async () => {
    await set('skoda', { apiKey: 'k' }, null)
    expect(await cachedSkoda()).toEqual({ apiKey: 'k' })
    await clear('skoda')
    expect(await cachedSkoda()).toBeNull()
  })

  it('a set rejected with REENTER_ALL_FIELDS inside the transaction still invalidates', async () => {
    await set('skoda', { apiKey: 'old' }, null)
    expect(await cachedSkoda()).toEqual({ apiKey: 'old' })
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const err = await domainError(() => set('skoda', { apiKey: 'k' }, null))
    expect(err.code).toBe('REENTER_ALL_FIELDS')
    // The cached value was dropped: the fresh read hits the now-unreadable row.
    await expect(cachedSkoda()).rejects.toBeInstanceOf(CredentialsUnreadableError)
  })

  it('a set rejected by validation does not invalidate', async () => {
    expect(await cachedSkoda()).toBeNull()
    await domainError(() => set('skoda', { vin: 'bad' }, null))
    await insertRaw('skoda', '{"apiKey":"raw"}')
    expect(await cachedSkoda()).toBeNull()
  })
})

describe('homePosition', () => {
  const HOME = '59.3293,18.0686' // central Stockholm, not a real home

  it('a stored value wins over env', async () => {
    vi.stubEnv('SKODA_HOME_COORDINATES', '57.7,11.97')
    await set('skoda', { homeCoordinates: HOME }, await insertUser())
    expect(await homePosition()).toEqual({ latitude: 59.3293, longitude: 18.0686 })
  })

  it('env fills in when the stored row has no home position', async () => {
    vi.stubEnv('SKODA_HOME_COORDINATES', ' 57.7 , 11.97 ')
    await set('skoda', { apiKey: 'k1' }, await insertUser())
    expect(await homePosition()).toEqual({ latitude: 57.7, longitude: 11.97 })
  })

  it('null when unset or unparseable', async () => {
    vi.stubEnv('SKODA_HOME_COORDINATES', '')
    expect(await homePosition()).toBeNull()
    vi.stubEnv('SKODA_HOME_COORDINATES', 'hemma')
    expect(await homePosition()).toBeNull()
  })

  it('an unreadable row is UNREADABLE, never the env value', async () => {
    vi.stubEnv('SKODA_HOME_COORDINATES', '57.7,11.97')
    await set('skoda', { homeCoordinates: HOME }, await insertUser())
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const error = await domainError(() => homePosition())
    expect(error.code).toBe('UNREADABLE')
    expect(error.message).not.toContain('57.7')
  })
})

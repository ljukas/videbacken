import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CredentialsUnreadableError,
  decrypt,
  encrypt,
  encryptionKey,
  isEncryptionKeyConfigured,
} from './crypto'

const newKey = () => randomBytes(32).toString('base64')
const env = { CREDENTIALS_ENCRYPTION_KEY: newKey() }
const PLAIN = '{"apiKey":"super-secret-plaintext"}'

const unreadable = (fn: () => unknown, reason: 'invalid' | 'key_missing') => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(CredentialsUnreadableError)
    expect((err as CredentialsUnreadableError).reason).toBe(reason)
    return err as CredentialsUnreadableError
  }
  throw new Error('expected decrypt to throw')
}

describe('credential crypto', () => {
  it('round-trips', () => {
    expect(decrypt('skoda', encrypt('skoda', PLAIN, env), env)).toBe(PLAIN)
  })

  it('emits a versioned envelope without plaintext that satisfies the DB CHECK', () => {
    const envelope = encrypt('skoda', PLAIN, env)
    expect(envelope).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(envelope).toMatch(/^v[1-9][0-9]*[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/)
    expect(envelope).not.toContain('super-secret-plaintext')
  })

  it('uses a fresh IV per encryption', () => {
    expect(encrypt('skoda', PLAIN, env)).not.toBe(encrypt('skoda', PLAIN, env))
  })

  describe('rejects as invalid', () => {
    const good = encrypt('zaptec', PLAIN, env)
    const [v, iv, tag, ct] = good.split('.')

    it('a wrong key', () => {
      unreadable(() => decrypt('zaptec', good, { CREDENTIALS_ENCRYPTION_KEY: newKey() }), 'invalid')
    })
    it('an envelope bound to another source (AAD)', () => {
      unreadable(() => decrypt('emaldo', good, env), 'invalid')
    })
    it('a flipped tag byte', () => {
      const t = Buffer.from(tag, 'base64url')
      t[0] ^= 1
      unreadable(
        () => decrypt('zaptec', [v, iv, t.toString('base64url'), ct].join('.'), env),
        'invalid',
      )
    })
    it('a truncated ciphertext', () => {
      unreadable(() => decrypt('zaptec', [v, iv, tag, ct.slice(0, -4)].join('.'), env), 'invalid')
    })
    it('a v2 prefix', () => {
      unreadable(() => decrypt('zaptec', ['v2', iv, tag, ct].join('.'), env), 'invalid')
    })
    it('three parts', () => {
      unreadable(() => decrypt('zaptec', [v, iv, tag].join('.'), env), 'invalid')
    })
  })

  it('decrypt without a key is key_missing; encrypt without a key is a plain Error', () => {
    const envelope = encrypt('skoda', PLAIN, env)
    unreadable(() => decrypt('skoda', envelope, {}), 'key_missing')
    expect(() => encrypt('skoda', PLAIN, {})).toThrow(Error)
    expect(() => encrypt('skoda', PLAIN, {})).not.toThrow(CredentialsUnreadableError)
  })

  it('parses the key strictly', () => {
    expect(encryptionKey({})).toBeNull()
    expect(encryptionKey({ CREDENTIALS_ENCRYPTION_KEY: '' })).toBeNull()
    expect(
      encryptionKey({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(16).toString('base64') }),
    ).toBeNull()
    expect(
      encryptionKey({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(33).toString('base64') }),
    ).toBeNull()
    expect(encryptionKey({ CREDENTIALS_ENCRYPTION_KEY: 'not base64 at all!!' })).toBeNull()
    const k = newKey()
    expect(encryptionKey({ CREDENTIALS_ENCRYPTION_KEY: `  ${k}\n` })?.length).toBe(32)
    expect(isEncryptionKeyConfigured({ CREDENTIALS_ENCRYPTION_KEY: k })).toBe(true)
    expect(isEncryptionKeyConfigured({})).toBe(false)
  })

  it('leaks neither plaintext nor key in error message or stack', () => {
    const key = newKey()
    const e = { CREDENTIALS_ENCRYPTION_KEY: key }
    const envelope = encrypt('skoda', PLAIN, e)
    const err = unreadable(() => decrypt('emaldo', envelope, e), 'invalid')
    let noKey: Error | undefined
    try {
      encrypt('skoda', PLAIN, {})
    } catch (x) {
      noKey = x as Error
    }
    expect(noKey).toBeDefined()
    for (const x of [err, noKey as Error]) {
      for (const s of [x.message, x.stack ?? '']) {
        expect(s).not.toContain('super-secret-plaintext')
        expect(s).not.toContain(key)
        expect(s).not.toContain(envelope.split('.')[3])
      }
    }
    expect(err.message).toBe('stored emaldo credentials are unreadable (invalid)')
  })
})

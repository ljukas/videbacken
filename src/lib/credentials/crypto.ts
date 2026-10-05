// Server-only AES-256-GCM envelope for stored integration credentials (ADR-0026).
//
// Not an effect (ADR-0001): it is pure, deterministic given a key, touches no
// external system and has a prod/dev/test-identical implementation, so there is
// nothing to swap per environment. The key is a dedicated
// CREDENTIALS_ENCRYPTION_KEY and deliberately NOT derived from
// BETTER_AUTH_SECRET: rotating the session secret must not make every stored
// credential unreadable, and the two secrets must be revocable independently.
//
// Envelope: `v1.<iv>.<tag>.<ciphertext>`, each part base64url without padding.
// The credential source is bound as AAD, so a row copied into another source's
// row fails authentication. Errors never carry plaintext, key, IV or ciphertext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CredentialSource } from '~/lib/integrationCredentials'

type Env = Record<string, string | undefined>

const ALGO = 'aes-256-gcm'
const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/

export class CredentialsUnreadableError extends Error {
  constructor(
    readonly source: CredentialSource,
    readonly reason: 'key_missing' | 'invalid',
  ) {
    super(`stored ${source} credentials are unreadable (${reason})`)
    this.name = 'CredentialsUnreadableError'
  }
}

/** The 32-byte key, or null when unset/malformed. Read from `env` on every call. */
export function encryptionKey(env: Env = process.env): Buffer | null {
  const raw = env.CREDENTIALS_ENCRYPTION_KEY?.trim()
  if (!raw || !KEY_PATTERN.test(raw)) return null
  const key = Buffer.from(raw, 'base64')
  return key.length === 32 ? key : null
}

export function isEncryptionKeyConfigured(env: Env = process.env): boolean {
  return encryptionKey(env) !== null
}

export function encrypt(
  source: CredentialSource,
  plaintext: string,
  env: Env = process.env,
): string {
  const key = encryptionKey(env)
  if (!key) throw new Error('CREDENTIALS_ENCRYPTION_KEY is missing or not 32 bytes of base64')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(source, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.')
}

export function decrypt(
  source: CredentialSource,
  envelope: string,
  env: Env = process.env,
): string {
  const key = encryptionKey(env)
  if (!key) throw new CredentialsUnreadableError(source, 'key_missing')
  const parts = envelope.split('.')
  try {
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('envelope')
    const [iv, tag, ct] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'))
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('envelope')
    const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(source, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    // No `cause`: nothing about the failure is worth carrying near a secret.
    throw new CredentialsUnreadableError(source, 'invalid')
  }
}

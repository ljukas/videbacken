// Server-only: the effective credentials for an integration (ADR-0026). Each
// field is `stored → env → absent`; a blank env var counts as absent.
//
// Only the *stored* read is cached (60 s, see cache.ts): it costs a DB round
// trip plus a decrypt. Env is free to read, so it is merged on every call —
// which also keeps env stubs in tests live without any cache invalidation.
import { createHash } from 'node:crypto'
import {
  CREDENTIAL_FIELDS,
  type CredentialSource,
  type CredentialValues,
} from '~/lib/integrationCredentials'
import * as integrationCredentialService from '~/lib/services/integrationCredential'
import { cachedStored } from './cache'
import { envCredential } from './env'

export type ResolvedCredentials<S extends CredentialSource> = {
  values: CredentialValues<S>
  /**
   * sha256 hex over the effective values; changes exactly when a value does. An
   * unsalted hash of low-entropy values, so an in-memory cache key only: never
   * log it, return it outside effects, or put it in an error.
   */
  fingerprint: string
}

/** Throws `CredentialsUnreadableError` when a stored row can't be decrypted — never falls back to env. */
export async function resolveCredentials<S extends CredentialSource>(
  source: S,
): Promise<ResolvedCredentials<S>> {
  const stored = await cachedStored(source, () => integrationCredentialService.readStored(source))
  const fields: readonly string[] = CREDENTIAL_FIELDS[source]
  const values: Record<string, string> = {}
  for (const field of fields) {
    const value =
      (stored as Record<string, string> | null)?.[field] ?? envCredential(source, field as never)
    if (value !== undefined) values[field] = value
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(fields.map((f) => [f, values[f] ?? null])))
    .digest('hex')
  return { values: values as CredentialValues<S>, fingerprint }
}

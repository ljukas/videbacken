// Server-only, process-local cache of the stored-credential read (ADR-0026).
// Only the decrypted *stored* row is cached (60 s); the resolver merges env on
// every call. A save or clear on this instance invalidates its source at once;
// another warm instance picks the change up within STORED_TTL_MS.
import type { CredentialSource } from '~/lib/integrationCredentials'

export const STORED_TTL_MS = 60_000

type Entry = { promise: Promise<unknown>; expiresAt: number }

const entries = new Map<CredentialSource, Entry>()

/**
 * `load()`'s result for `source`, shared by every caller until it expires. Two
 * callers during one in-flight load share it; a rejected load is dropped, not
 * cached, so the next call retries.
 */
export function cachedStored<T>(
  source: CredentialSource,
  load: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const hit = entries.get(source)
  if (hit && now < hit.expiresAt) return hit.promise as Promise<T>
  // The async wrapper turns a synchronous throw into a rejection.
  const promise = (async () => load())()
  const entry: Entry = { promise, expiresAt: now + STORED_TTL_MS }
  entries.set(source, entry)
  promise.catch(() => {
    if (entries.get(source) === entry) entries.delete(source)
  })
  return promise
}

/** Drops `source`'s cached read, or every source's with no argument. */
export function invalidateCredentials(source?: CredentialSource): void {
  if (source) entries.delete(source)
  else entries.clear()
}

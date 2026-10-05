// Server-only. The credentialed-integration counterpart of `lazy()` (ADR-0026):
// the Zaptec, Škoda and Emaldo facades resolve their credentials on every call
// (stored → env per field, the stored read cached 60 s) and rebuild the client
// only when the effective values change.
//
// Reuse matters: the Zaptec and Emaldo clients keep their token/session in the
// client's closure, so a rebuilt client logs in again — and an Emaldo login
// ends that account's other sessions. Hence one cached client per fingerprint.
//
// The fingerprint is an unsalted hash of low-entropy values: it is an in-memory
// cache key only. Never log it, return it or put it in an error.
import { CredentialsUnreadableError } from '~/lib/credentials/crypto'
import type { ResolvedCredentials } from '~/lib/credentials/resolve'
import type { CredentialSource, CredentialValues } from '~/lib/integrationCredentials'

export type UnavailableCode = 'not_configured' | 'credentials_unreadable'

type Env = Record<string, string | undefined>

// Imported on first use, not at module init: keeps the facades free of `db`
// until a real (non-Vitest) call needs the stored credentials.
const resolveCredentials = async <S extends CredentialSource>(source: S) =>
  (await import('~/lib/credentials/resolve')).resolveCredentials(source)

export function keyedAdapter<S extends CredentialSource, T>(opts: {
  source: S
  /** Builds a client for these values; may itself return the not-configured adapter. */
  build: (values: CredentialValues<S>) => Promise<T>
  /** A client whose every method throws the source's IntegrationError with this code. */
  unavailable: (code: UnavailableCode) => Promise<T>
  resolve?: (source: S) => Promise<ResolvedCredentials<S>>
  /** Read on every call (default `process.env`), so a test's VITEST stub applies. */
  env?: Env
}): () => Promise<T> {
  const resolve = opts.resolve ?? resolveCredentials
  let cached: { fingerprint: string; client: Promise<T> } | null = null

  return async () => {
    const env = opts.env ?? process.env
    // Tests never reach the DB or a remote: every facade fails closed as not configured.
    if (env.VITEST === 'true') return opts.unavailable('not_configured')

    let resolved: ResolvedCredentials<S>
    try {
      resolved = await resolve(opts.source)
    } catch (err) {
      // Fail closed as the source's own IntegrationError, never fall back to env.
      if (err instanceof CredentialsUnreadableError)
        return opts.unavailable('credentials_unreadable')
      throw err
    }

    // Checked and set with no await in between, so concurrent callers share one build.
    if (cached?.fingerprint === resolved.fingerprint) return cached.client
    const entry = { fingerprint: resolved.fingerprint, client: opts.build(resolved.values) }
    // Known race (accepted): a resolve begun before a save can land last and replace the newer entry,
    // costing one extra rebuild (for Emaldo one extra login); the next call settles it.
    cached = entry
    // A failed build must not stick: drop it, unless a newer entry already replaced it.
    entry.client.catch(() => {
      if (cached === entry) cached = null
    })
    return entry.client
  }
}

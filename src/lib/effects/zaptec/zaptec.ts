import type { ZaptecCharger, ZaptecLiveState, ZaptecSession } from '~/lib/evCharging/types'
import type { CredentialValues } from '~/lib/integrationCredentials'
import { keyedAdapter } from '../keyedAdapter'

/**
 * Zaptec EV-charger API, backed by one of three adapters:
 *   - `http` — the real REST client (`createZaptecClient` in `./client`).
 *     Selected when a username and password resolve.
 *   - `fake` — synthetic chargers/sessions/state for local UI work. Selected
 *     by `ZAPTEC_ADAPTER=fake`, which is ignored in production.
 *   - `notConfigured` — throws `ZaptecError('not_configured')` from every
 *     method. Used in tests (VITEST short-circuit) and whenever credentials
 *     are missing. Deliberately **no devLog adapter**: a silent no-op would
 *     read as a healthy sync.
 *
 * Credentials come from the resolver (ADR-0026: stored under Inställningar,
 * else the ZAPTEC_* env vars), checked on every call; the client — and with
 * it the cached token — is rebuilt only when they change. An unreadable
 * stored row fails every call as `credentials_unreadable`.
 *
 * The client never logs. Callers pass a `stats` sink and log it themselves;
 * errors surface as `ZaptecError` with an integration-health `code`.
 */

/** Mutable sink the client fills in; the caller logs it. */
export interface ZaptecCallStats {
  authMs: number
  fetchMs: number
  requests: number
  retries: number
  pages: number
  /** Sessions dropped because they didn't match the expected shape. */
  rejected: number
}

export function newCallStats(): ZaptecCallStats {
  return { authMs: 0, fetchMs: 0, requests: 0, retries: 0, pages: 0, rejected: 0 }
}

export interface CallOpts {
  signal?: AbortSignal
  stats?: ZaptecCallStats
}

export interface ZaptecClient {
  chargers(o?: CallOpts): Promise<ZaptecCharger[]>
  /**
   * Sessions whose **end** time is in `[since, until)` (`until` defaults to
   * now), one yield per API page.
   */
  sessionsEndedSince(
    since: Date,
    o: CallOpts & { installationId: string; until?: Date },
  ): AsyncIterable<ZaptecSession[]>
  liveState(chargerId: string, o?: CallOpts): Promise<ZaptecLiveState>
}

type Env = Record<string, string | undefined>

/**
 * Which adapter the resolved credentials select. `env` only carries the
 * `ZAPTEC_ADAPTER=fake` dev-only escape hatch and the production guard: in
 * production `fake` is ignored (silently) and selection falls through to the
 * real credentials check, so a stray env var can never fake prod data.
 */
export function selectZaptecAdapter(
  values: CredentialValues<'zaptec'>,
  env: Env,
): 'notConfigured' | 'fake' | 'http' {
  const production = env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production'
  if (env.ZAPTEC_ADAPTER === 'fake' && !production) return 'fake'
  if (values.username && values.password) return 'http'
  return 'notConfigured'
}

const getAdapter = keyedAdapter({
  source: 'zaptec',
  unavailable: async (code) => (await import('./adapters/notConfigured')).unavailable(code),
  build: async (values): Promise<ZaptecClient> => {
    const kind = selectZaptecAdapter(values, process.env)
    if (kind === 'fake') return (await import('./adapters/fake')).fake
    const { username, password } = values
    if (kind === 'http' && username && password) {
      const { createZaptecClient } = await import('./client')
      return createZaptecClient({ fetch: globalThis.fetch, creds: { username, password } })
    }
    return (await import('./adapters/notConfigured')).notConfigured
  },
})

export const zaptec: ZaptecClient = {
  async chargers(o) {
    return (await getAdapter()).chargers(o)
  },
  async *sessionsEndedSince(since, o) {
    yield* (await getAdapter()).sessionsEndedSince(since, o)
  },
  async liveState(chargerId, o) {
    return (await getAdapter()).liveState(chargerId, o)
  },
}

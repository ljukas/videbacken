import type { ZaptecCharger, ZaptecLiveState, ZaptecSession } from '~/lib/evCharging/types'
import { lazy } from '../lazy'

/**
 * Zaptec EV-charger API, backed by one of three adapters:
 *   - `http` — the real REST client (`createZaptecClient` in `./client`).
 *     Selected when `ZAPTEC_USERNAME` + `ZAPTEC_PASSWORD` are set.
 *   - `fake` — synthetic chargers/sessions/state for local UI work. Selected
 *     by `ZAPTEC_ADAPTER=fake`.
 *   - `notConfigured` — throws `ZaptecError('not_configured')` from every
 *     method. Used in tests (VITEST short-circuit) and whenever credentials
 *     are missing. Deliberately **no devLog adapter**: a silent no-op would
 *     read as a healthy sync.
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
}

export function newCallStats(): ZaptecCallStats {
  return { authMs: 0, fetchMs: 0, requests: 0, retries: 0, pages: 0 }
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

const getAdapter = lazy(async (): Promise<ZaptecClient> => {
  if (process.env.VITEST === 'true') return (await import('./adapters/notConfigured')).notConfigured
  if (process.env.ZAPTEC_ADAPTER === 'fake') return (await import('./adapters/fake')).fake
  const username = process.env.ZAPTEC_USERNAME
  const password = process.env.ZAPTEC_PASSWORD
  if (username && password) {
    const { createZaptecClient } = await import('./client')
    return createZaptecClient({ fetch: globalThis.fetch, creds: { username, password } })
  }
  return (await import('./adapters/notConfigured')).notConfigured
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

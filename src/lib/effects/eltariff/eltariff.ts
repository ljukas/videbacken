import { lazy } from '../lazy'

/**
 * The Eltariff-API tariff catalogue (eltariff.se, RISE; free, keyless): which
 * grid companies publish machine-readable tariffs, and for which metering-point
 * ID ranges. Backed by one of two adapters:
 *   - `http` — the real client (`createEltariffClient` in `./client`). The
 *     default everywhere: the catalogue needs no credentials.
 *   - `notConfigured` — throws `EltariffError('not_configured')`. Selected only
 *     under VITEST, so no test can reach the network by accident (tests inject
 *     their own client). No devLog adapter (ADR-0019): an empty catalogue would
 *     read as "not covered yet" forever.
 *
 * Only the whole catalogue is ever fetched — never the `lookup/{mpid}`
 * endpoint — so our facility ID never leaves the app. The client never logs;
 * callers pass a `stats` sink and log it themselves.
 */

/** One grid company's registration. IDs are 18-digit strings (beyond `Number`). */
export interface CatalogueEntry {
  companyName: string
  meteringPointIdFrom: string
  meteringPointIdTo: string
  apiUrl: string
}

export interface Catalogue {
  entries: CatalogueEntry[]
  /** Entries dropped because they didn't match the expected shape. */
  invalidEntries: number
}

/** Mutable sink the client fills in; the caller logs it. */
export interface EltariffCallStats {
  fetchMs: number
  requests: number
  retries: number
}

export function newCallStats(): EltariffCallStats {
  return { fetchMs: 0, requests: 0, retries: 0 }
}

export interface CallOpts {
  signal?: AbortSignal
  stats?: EltariffCallStats
}

export interface EltariffClient {
  /** The full catalogue. Throws `EltariffError` when it can't be read. */
  catalogue(o?: CallOpts): Promise<Catalogue>
}

type Env = Record<string, string | undefined>

export function selectEltariffAdapter(env: Env): 'notConfigured' | 'http' {
  return env.VITEST === 'true' ? 'notConfigured' : 'http'
}

const getAdapter = lazy(async (): Promise<EltariffClient> => {
  if (selectEltariffAdapter(process.env) === 'http') {
    const { createEltariffClient } = await import('./client')
    return createEltariffClient({ fetch: globalThis.fetch })
  }
  return (await import('./adapters/notConfigured')).notConfigured
})

export const eltariff: EltariffClient = {
  async catalogue(o) {
    return (await getAdapter()).catalogue(o)
  },
}

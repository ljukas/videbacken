# Charging settings step 3c-2 — home-position map picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Škoda credentials dialog, "Välj på kartan" / "Ändra på kartan" opens a map picker for "Laddboxens
position". It opens on the saved pin and has address search, a draggable, keyboard-movable pin, click-to-move, and
"Använd min position". The form value stays the same `"lat,lon"` string, so the server's save rules don't change.

**Architecture:**
- **Server.**
  - A new keyless effect, `effects/geocoder` (Nominatim, shaped like `effects/eltariff`). It throttles to 1 req/s
    per instance, caches results for 10 min, and fails closed.
  - Two `adminProcedure`s:
    - `credentials.homePosition` reads the resolved home point through a new service function. The service owns the
      read (ADR-0002). An unreadable row is the domain code `UNREADABLE`.
    - `credentials.searchAddress` proxies the search.
- **Client.**
  - `HomePositionPicker` is light and lives in the dialog chunk. It holds the search, the hits, "Använd min position",
    the live region, the fallbacks, and the bound "lat,lon" input it receives as `children`.
  - It lazy-loads `HomePositionMap`, the only module that imports `maplibre-gl` and `@vis.gl/react-maplibre`, inside
    `<ClientOnly>`, an error boundary and `<Suspense>`.
  - Browser tests mock `HomePositionMap` and the WebGL2 check.

**Tech Stack:**
- `maplibre-gl` 6 and `@vis.gl/react-maplibre` 8, with OpenFreeMap's `liberty` style.
- Nominatim, through `ky` via `effects/http.ts`.
- oRPC + TanStack Query, `@tanstack/react-form` (`useAppForm`), shadcn/Radix, Paraglide.
- Vitest: node, and browser via Playwright Chromium. bun.

**Spec:** `docs/superpowers/specs/2026-10-05-charging-settings-design.md` § "Step 3c" → "3c-2 — the home-position map
picker".
- ADR-0026, and its 2026-10-06 amendment ("the home position is shown to admins").
- Roadmap `docs/superpowers/roadmaps/2026-10-05-charging-settings.md`.
- Mockup https://claude.ai/artifact/UyTQkEAKAemBHbAThriaoM (the 3c artboards).
- **Owner decision this session (2026-10-06):** a *missing* home position starts **closed**, with badge
  "Inte angiven" and a "Välj på kartan" button, like `env`. The map loads only when asked for. It doesn't open
  directly the way other missing fields do.

## Global Constraints

- **The home position is the only credential value the server returns.** `homePosition` is `adminProcedure`, and the
  client fetches it only while the picker is mounted (an open, enabled field). It is never fetched in a loader or
  dehydrated into the HTML; it uses `gcTime: 0` and is never logged, and timing lines carry no value. Every other
  field stays write-only.
- **An unreadable Škoda row gives `UNREADABLE`, never the env value** (ADR-0026 decision 4).
- **Address search runs on submit only**: "Sök", or Enter in the search box. Never as the admin types: Nominatim's
  policy forbids autocomplete.
- **The geocoder** sends `countrycodes=se`, `accept-language=sv`, `limit=5`, `format=jsonv2`, and a distinctive
  `User-Agent` starting with `videbacken/`. It is throttled to 1 request/s per instance and keeps a 10-min in-memory
  cache. **The query and the results are never logged, never in an error message and never in a `cause`.** Log lines
  carry only the outcome, the hit count, the cached flag and the timings.
- **Nominatim failures** become `GEOCODER_UNAVAILABLE` (status 503). Other `searchAddress` errors stay as they are.
- **The form value is the string `"lat,lon"`** (no space), with 5 decimals (about 1 m) for every point the picker
  sets. The server's `parseHomePoint` validation is unchanged.
- **`maplibre-gl` and `@vis.gl/react-maplibre` are imported only by `src/components/evCharging/HomePositionMap.tsx`**,
  and that module only through `React.lazy`. `/charging/settings`' initial JS must not grow by the map (check with
  `bun run bundle:measure`).
- **Client code** may only `import type` from services and effects. Shared helpers go in client-safe modules.
- **Every string** goes in `messages/sv.json` (the source of truth) and `messages/en.json` (key-complete). Run
  `bun run i18n:compile` after editing them.
- **Forms use `useAppForm`.** The coordinates are the form field `homeCoordinates`. The search box is not a form
  field (nothing is submitted from it): it is an uncontrolled input read through a ref.
- **Red is for errors only.** Touch targets are 44 px on coarse pointers (`pointer-coarse:h-11`). Phones keep
  ADR-0013's bottom sheet (issue #107 is out of scope).
- **Never `console.*`.** The browser logs through `logger` from `~/lib/logger/browser`.
- **Commits:** conventional, ≤72 characters, one hat per commit. Trailer:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Vitest:** never two processes at once, and reviewers never run vitest.
  - Node: `bunx vitest run <path>`.
  - Browser, one-shot: `bunx vitest run --project browser <path>`.
  - Never `test:components` (it watches).
  - Tests need `bun run db:up && bun run db:migrate`.

## Copy (verbatim, sv / en)

| key | sv | en |
|---|---|---|
| `charging_credentials_hint_home` (changed) | Används för att se om bilen står hemma. Sök en adress, klicka på kartan eller dra nålen. | Used to tell whether the car is at home. Search for an address, click the map or drag the pin. |
| `charging_home_coordinates_hint` | Latitud,longitud med punkt som decimaltecken, t.ex. 59.3293,18.0686. | Latitude,longitude with a decimal point, e.g. 59.3293,18.0686. |
| `charging_home_search_label` | Sök adress | Search for an address |
| `charging_home_search` | Sök | Search |
| `charging_home_search_hits` | Träffar | Matches |
| `charging_home_search_empty` | Inga träffar. Prova en annan stavning eller lägg till orten. | No matches. Try another spelling or add the town. |
| `charging_home_search_unavailable` | Adressökningen fungerar inte just nu. Klicka på kartan eller skriv koordinaterna. | Address search isn't working right now. Click the map or type the coordinates. |
| `charging_home_search_attribution` | Adresser från OpenStreetMap | Addresses from OpenStreetMap |
| `charging_home_use_location` | Använd min position | Use my location |
| `charging_home_location_denied` | Appen fick inte använda din position. Tillåt det i webbläsaren, eller välj på kartan. | The app wasn't allowed to use your location. Allow it in the browser, or choose on the map. |
| `charging_home_location_unavailable` | Din position gick inte att hämta. Välj på kartan i stället. | Your location couldn't be found. Choose on the map instead. |
| `charging_home_no_map` | Kartan kan inte visas här. Sök en adress eller skriv koordinaterna. | The map can't be shown here. Search for an address or type the coordinates. |
| `charging_home_map_label` | Karta. Klicka för att flytta nålen. | Map. Click to move the pin. |
| `charging_home_pin_label` | Laddboxens position. Flytta med piltangenterna. | The charger's position. Move it with the arrow keys. |
| `charging_home_chosen` | Vald position: {lat}, {lon} | Chosen position: {lat}, {lon} |

## Review Focus

1. **Enter in the search box must search, never submit the credentials form.** A save from there would store a
   half-edited dialog. This is pinned in Task 6, step 1, test "Enter searches and never submits the form".
2. **The saved pin arriving after the admin has already picked must not overwrite the pick.** On a slow phone, the
   `homePosition` fetch can resolve after the first tap. Task 6: "a pick before the saved pin arrives is kept".
3. **A burst of searches** (a double tap, or two admins) must fail fast as `rate_limited`, not queue for many
   seconds inside one function invocation. Task 1: "a search that would wait more than 3 s fails without a request".
4. **The home position is never fetched while the field is closed or disabled.** The value must stay out of the
   client cache unless the picker is showing. Task 6: "disabled shows only the coordinates and fetches nothing";
   Task 7: "a closed home field never fetches the saved pin".
5. **A garbage geocoder answer** (an empty `lat`, a missing `display_name`, a non-array) must give fewer hits or
   `GEOCODER_UNAVAILABLE`, never a pin at 0,0 or a 500. Task 1: "drops entries it can't use" and "non-JSON and
   non-array answers are unexpected_response".

## File structure

| File | Responsibility |
|---|---|
| `src/lib/effects/geocoder/geocoder.ts` (new) | Interface, stats, adapter selection, `geocoder` facade |
| `src/lib/effects/geocoder/client.ts` (new) | Nominatim client: request, throttle, cache, parse |
| `src/lib/effects/geocoder/errors.ts` (new) | `GeocoderError` |
| `src/lib/effects/geocoder/adapters/notConfigured.ts` (new) | VITEST default, fails closed |
| `src/lib/effects/geocoder/index.ts` (new) | Barrel |
| `src/lib/effects/geocoder/geocoder.test.ts` (new) | Client tests with `fakeFetch` |
| `src/lib/effects/index.ts` | Registers `geocoder` |
| `src/lib/services/integrationCredential/{errors,integrationCredential,integrationCredential.test}.ts` | `homePosition()`, `UNREADABLE` |
| `src/lib/orpc/procedures/credentials.ts` (+ `.test.ts`) | `homePosition`, `searchAddress` |
| `src/lib/vehicleState/geofence.ts` (+ `.test.ts`) | `formatHomePoint` (client-safe, beside `parseHomePoint`) |
| `src/lib/integrationCredentials.ts` | Kind `'position'` for the home field |
| `src/lib/evCharging/clientSafe.browser.test.tsx` | The kind and geofence helpers load in a browser |
| `src/components/evCharging/HomePositionMap.tsx` (new) | The real map (lazy chunk only) |
| `src/components/evCharging/mapSupport.ts` (new) | `supportsWebGL2()`, `SWEDEN_VIEW`, zoom constants (mockable) |
| `src/components/evCharging/HomePositionPicker.tsx` (+ `.browser.test.tsx`) | The picker shell |
| `src/components/evCharging/CredentialFieldRow.tsx` | `isClosableField`, the map reveal by kind |
| `src/components/evCharging/CredentialsDialog.tsx` (+ `.browser.test.tsx`) | Picker in the home field |
| `messages/{sv,en}.json` | Copy |
| `vite.config.ts`, `package.json`, `scripts/measureBundle.ts` | Permissions-Policy, optimizeDeps, dependencies, watched packages |
| `docs/adr/0026-…`, spec, roadmap, `CLAUDE.md` | As built |

---

### Task 0: Check main still matches the spec

**Files:** none (read only).

- [ ] **Step 1: Confirm the assumptions**

```bash
git log --oneline -1 origin/main                     # 174bc30 or later (#110 merged)
grep -n "homePosition\|searchAddress" src/lib/orpc/procedures/credentials.ts   # expect: nothing
grep -n "geolocation" vite.config.ts                 # expect: geolocation=()
grep -n "credentialFieldKind" src/lib/integrationCredentials.ts
grep -rn "maplibre" package.json src                 # expect: nothing
```
If any of these differs (for example, a `homePosition` already exists), stop and reconcile with the spec before
building.

---

### Task 1: Geocoder effect (Nominatim)

**Files:**
- Create: `src/lib/effects/geocoder/{geocoder.ts,client.ts,errors.ts,index.ts,adapters/notConfigured.ts,geocoder.test.ts}`
- Modify: `src/lib/effects/index.ts` (add `export { geocoder } from './geocoder'` after `eltariff`)

**Interfaces:**
- Consumes: `fetchWithRetry`, `discard`, `networkCause` from `../http`; `lazy` from `../lazy`;
  `fakeFetch`/`jsonResponse` from `~/lib/effects/testing/fakeFetch`.
- Produces (from `~/lib/effects/geocoder`):
  ```ts
  export interface GeocoderHit { label: string; latitude: number; longitude: number }
  export interface GeocoderCallStats { fetchMs: number; requests: number; retries: number; cached: boolean }
  export function newGeocoderStats(): GeocoderCallStats
  export interface GeocoderCallOpts { signal?: AbortSignal; stats?: GeocoderCallStats }
  export interface GeocoderClient { search(query: string, o?: GeocoderCallOpts): Promise<GeocoderHit[]> }
  export const geocoder: GeocoderClient
  export function selectGeocoderAdapter(env: Record<string, string | undefined>): 'notConfigured' | 'nominatim'
  export function createNominatimClient(deps: { fetch: typeof fetch }): GeocoderClient
  export type GeocoderErrorCode = 'not_configured' | 'rate_limited' | 'unreachable' | 'forbidden' | 'unexpected_response'
  export class GeocoderError extends Error { code: GeocoderErrorCode; status?: number }
  ```

- [ ] **Step 1: Write the failing tests** (`src/lib/effects/geocoder/geocoder.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch, jsonResponse } from '~/lib/effects/testing/fakeFetch'
import { CACHE_TTL_MS, createNominatimClient } from './client'
import { GeocoderError } from './errors'
import { geocoder, newGeocoderStats, selectGeocoderAdapter } from './geocoder'

const ROUTE = 'GET /search'
// Synthetic places in Nominatim's jsonv2 shape (never a real home).
const place = (name: string, lat: string, lon: string) => ({
  place_id: 1,
  display_name: name,
  lat,
  lon,
  category: 'place',
  type: 'house',
})
const QUERY = 'Storgatan 1, Exempelby'

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-06T10:00:00Z') })
  vi.setTimerTickMode('nextTimerAsync')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function client(routes: Record<string, FakeRoute>) {
  const fake = fakeFetch(routes)
  const sentAt: number[] = []
  const c = createNominatimClient({
    fetch: (input, init) => {
      sentAt.push(Date.now())
      return fake.fetch(input, init)
    },
  })
  const waits = () => sentAt.slice(1).map((at, i) => at - sentAt[i])
  return { c, fake, waits }
}

async function rejection(p: Promise<unknown>): Promise<GeocoderError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(GeocoderError)
  return error as GeocoderError
}

describe('search', () => {
  test('sends the fixed parameters and an identifying User-Agent, and maps the hits', async () => {
    const { c, fake } = client({
      [ROUTE]: () => jsonResponse([place('Storgatan 1, Exempelby, Sverige', '57.7', '11.97')]),
    })
    const stats = newGeocoderStats()

    const hits = await c.search(`  ${QUERY}  `, { stats })

    expect(hits).toEqual([
      { label: 'Storgatan 1, Exempelby, Sverige', latitude: 57.7, longitude: 11.97 },
    ])
    const url = new URL(fake.calls[0].url)
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: QUERY,
      format: 'jsonv2',
      countrycodes: 'se',
      'accept-language': 'sv',
      limit: '5',
      addressdetails: '0',
    })
    expect(fake.calls[0].headers.get('User-Agent')).toMatch(/^videbacken\//)
    expect(stats).toMatchObject({ requests: 1, retries: 0, cached: false })
  })

  test('drops entries it can’t use and keeps at most five', async () => {
    const good = (n: number) => place(`Plats ${n}`, `5${n}.1`, `1${n}.2`)
    const { c } = client({
      [ROUTE]: () =>
        jsonResponse([
          place('Tom latitud', '', '11.97'),
          { lat: '57.7', lon: '11.97' }, // no display_name
          place('Utanför', '91', '11.97'),
          place('Hex', '0x1A', '11.97'),
          good(1),
          good(2),
          good(3),
          good(4),
          good(5),
          good(6),
        ]),
    })

    const hits = await c.search(QUERY)

    expect(hits.map((h) => h.label)).toEqual(['Plats 1', 'Plats 2', 'Plats 3', 'Plats 4', 'Plats 5'])
  })

  test('caches by the normalized query for ten minutes', async () => {
    const { c, fake } = client({ [ROUTE]: () => jsonResponse([place('A', '57.7', '11.97')]) })
    await c.search('Storgatan 1')
    const stats = newGeocoderStats()

    const again = await c.search('  storgatan   1 ', { stats })

    expect(again).toEqual([{ label: 'A', latitude: 57.7, longitude: 11.97 }])
    expect(fake.calls).toHaveLength(1)
    expect(stats).toMatchObject({ requests: 0, cached: true })
    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1)
    await c.search('Storgatan 1')
    expect(fake.calls).toHaveLength(2)
  })

  test('spaces requests at least one second apart', async () => {
    const { c, waits } = client({ [ROUTE]: () => jsonResponse([]) })
    await Promise.all([c.search('Ett'), c.search('Två'), c.search('Tre')])
    expect(waits().every((w) => w >= 1000)).toBe(true)
    expect(waits()).toHaveLength(2)
  })

  test('a search that would wait more than 3 s fails without a request', async () => {
    const { c, fake } = client({ [ROUTE]: () => jsonResponse([]) })
    const results = await Promise.allSettled(
      ['A1', 'B2', 'C3', 'D4', 'E5'].map((q) => c.search(q)),
    )
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
    ])
    const last = results[4] as PromiseRejectedResult
    expect(last.reason).toBeInstanceOf(GeocoderError)
    expect(last.reason.code).toBe('rate_limited')
    expect(fake.calls).toHaveLength(4)
  })

  test('a 429 is rate_limited at once; a 503 is retried once, then unreachable', async () => {
    const limited = client({ [ROUTE]: () => new Response('slow down', { status: 429 }) })
    expect((await rejection(limited.c.search(QUERY))).code).toBe('rate_limited')
    expect(limited.fake.calls).toHaveLength(1)

    const down = client({ [ROUTE]: () => new Response('', { status: 503 }) })
    expect((await rejection(down.c.search(QUERY))).code).toBe('unreachable')
    expect(down.fake.calls).toHaveLength(2)

    const blocked = client({ [ROUTE]: () => new Response('', { status: 403 }) })
    expect((await rejection(blocked.c.search(QUERY))).code).toBe('forbidden')
  })

  test('non-JSON and non-array answers are unexpected_response', async () => {
    const html = client({ [ROUTE]: () => new Response('<html>', { status: 200 }) })
    expect((await rejection(html.c.search(QUERY))).code).toBe('unexpected_response')
    const object = client({ [ROUTE]: () => jsonResponse({ error: 'x' }) })
    expect((await rejection(object.c.search(QUERY))).code).toBe('unexpected_response')
  })

  test('a network failure is unreachable, and no error carries the query', async () => {
    const { c } = client({
      [ROUTE]: () => {
        throw Object.assign(new TypeError(`fetch failed for ${QUERY}`), { code: 'ECONNRESET' })
      },
    })
    const error = await rejection(c.search(QUERY))
    expect(error.code).toBe('unreachable')
    expect(error.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
    expect(`${error.message} ${JSON.stringify(error.cause)}`).not.toContain('Storgatan')
  })
})

describe('adapter selection', () => {
  test('uses Nominatim outside tests and fails closed under VITEST', () => {
    expect(selectGeocoderAdapter({})).toBe('nominatim')
    expect(selectGeocoderAdapter({ VITEST: 'true' })).toBe('notConfigured')
  })

  test('the default client under VITEST throws not_configured', async () => {
    expect((await rejection(geocoder.search(QUERY))).code).toBe('not_configured')
  })
})
```

- [ ] **Step 2: Run, confirm it fails**

Run: `bunx vitest run src/lib/effects/geocoder`
Expected: FAIL (module `./client` not found).

- [ ] **Step 3: Implement**

`src/lib/effects/geocoder/errors.ts`:
```ts
export type GeocoderErrorCode =
  | 'not_configured'
  | 'rate_limited'
  | 'unreachable'
  | 'forbidden'
  | 'unexpected_response'

/**
 * The one error the geocoder throws. Messages and `cause` never carry the
 * query or a result: the address searched for is the household's. `cause` is
 * only ever a network error's `{ name, code }`.
 */
export class GeocoderError extends Error {
  override readonly name = 'GeocoderError'

  constructor(
    readonly code: GeocoderErrorCode,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(
      `geocoder search failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
  }
}
```

`src/lib/effects/geocoder/geocoder.ts`:
```ts
import { lazy } from '../lazy'

/**
 * Address search for the Škoda home-position picker (ADR-0026, step 3c-2):
 * Nominatim (OpenStreetMap), keyless, proxied by our server so the admin's IP
 * and browser never reach it. Backed by one of two adapters:
 *   - `nominatim` — the real client (`createNominatimClient` in `./client`),
 *     throttled to Nominatim's 1 request/s and cached for 10 minutes, per
 *     instance. The default everywhere.
 *   - `notConfigured` — throws `GeocoderError('not_configured')`. Selected only
 *     under VITEST, so no test reaches the network (tests inject a client).
 *
 * The client never logs: the query and the results are the household's
 * address. Callers log the outcome and the `stats` only.
 */

export interface GeocoderHit {
  label: string
  latitude: number
  longitude: number
}

/** Mutable sink the client fills in; the caller logs it. */
export interface GeocoderCallStats {
  fetchMs: number
  requests: number
  retries: number
  /** Answered from the in-memory cache, without a request. */
  cached: boolean
}

export function newGeocoderStats(): GeocoderCallStats {
  return { fetchMs: 0, requests: 0, retries: 0, cached: false }
}

export interface GeocoderCallOpts {
  signal?: AbortSignal
  stats?: GeocoderCallStats
}

export interface GeocoderClient {
  /** Up to five places in Sweden for `query`. Throws `GeocoderError` when the search can't run. */
  search(query: string, o?: GeocoderCallOpts): Promise<GeocoderHit[]>
}

type Env = Record<string, string | undefined>

export function selectGeocoderAdapter(env: Env): 'notConfigured' | 'nominatim' {
  return env.VITEST === 'true' ? 'notConfigured' : 'nominatim'
}

// One client per process: the throttle and the cache are per instance.
const getAdapter = lazy(async (): Promise<GeocoderClient> => {
  if (selectGeocoderAdapter(process.env) === 'nominatim') {
    const { createNominatimClient } = await import('./client')
    return createNominatimClient({ fetch: globalThis.fetch })
  }
  return (await import('./adapters/notConfigured')).notConfigured
})

export const geocoder: GeocoderClient = {
  async search(query, o) {
    return (await getAdapter()).search(query, o)
  },
}
```

`src/lib/effects/geocoder/client.ts`:
```ts
import { z } from 'zod'
import { discard, fetchWithRetry, networkCause } from '../http'
import { GeocoderError } from './errors'
import {
  type GeocoderCallOpts,
  type GeocoderClient,
  type GeocoderHit,
  newGeocoderStats,
} from './geocoder'

const SEARCH_URL = 'https://nominatim.openstreetmap.org/search'
// Nominatim's policy asks for an identifying User-Agent.
const USER_AGENT = 'videbacken/1.0 (private home dashboard; home-position address search)'

// Interactive: a short timeout and one retry on a gateway hiccup. Never on 429:
// the policy is one request per second, so back off rather than retry.
const TIMEOUT_MS = 5_000
const RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const RETRY_LIMIT = 1

/** Nominatim's usage policy: at most one request per second (here per instance). */
export const MIN_INTERVAL_MS = 1_000
/** A search that would wait longer than this for its slot fails as `rate_limited` instead. */
export const MAX_QUEUE_WAIT_MS = 3_000
export const CACHE_TTL_MS = 10 * 60_000
const CACHE_MAX_ENTRIES = 100
const MAX_HITS = 5

const DECIMAL = /^[+-]?\d+(\.\d+)?$/
const nominatimPlace = z.object({
  display_name: z.string().trim().min(1),
  lat: z.string().regex(DECIMAL),
  lon: z.string().regex(DECIMAL),
})

/** Trimmed, inner whitespace collapsed: what is sent. */
const tidy = (query: string) => query.trim().replace(/\s+/g, ' ')

/**
 * Real Nominatim client. Does not log — it fills the caller's `stats` and
 * throws `GeocoderError`. See `./geocoder.ts` for the interface and selection.
 */
export function createNominatimClient(deps: { fetch: typeof fetch }): GeocoderClient {
  const cache = new Map<string, { hits: GeocoderHit[]; expiresAt: number }>()
  let nextSlotAt = 0

  // Reserves the next free one-second slot; a burst beyond MAX_QUEUE_WAIT_MS fails fast
  // rather than holding a function invocation open.
  async function waitForSlot(signal: AbortSignal | undefined): Promise<void> {
    const now = Date.now()
    const slot = Math.max(now, nextSlotAt)
    if (slot - now > MAX_QUEUE_WAIT_MS) throw new GeocoderError('rate_limited')
    nextSlotAt = slot + MIN_INTERVAL_MS
    if (slot > now) {
      try {
        await sleep(slot - now, signal)
      } catch (err) {
        throw new GeocoderError('unreachable', undefined, { cause: networkCause(err) })
      }
    }
  }

  return {
    async search(query: string, o: GeocoderCallOpts = {}): Promise<GeocoderHit[]> {
      const stats = o.stats ?? newGeocoderStats()
      const q = tidy(query)
      const key = q.toLowerCase()
      const cached = cache.get(key)
      if (cached && cached.expiresAt > Date.now()) {
        stats.cached = true
        return cached.hits
      }

      await waitForSlot(o.signal)
      const url = new URL(SEARCH_URL)
      url.search = new URLSearchParams({
        q,
        format: 'jsonv2',
        countrycodes: 'se',
        'accept-language': 'sv',
        limit: String(MAX_HITS),
        addressdetails: '0',
      }).toString()

      let res: Response
      try {
        res = await fetchWithRetry(
          url.toString(),
          { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
          {
            fetch: deps.fetch,
            timeoutMs: TIMEOUT_MS,
            retryStatuses: RETRY_STATUSES,
            retryLimit: RETRY_LIMIT,
            signal: o.signal,
            stats,
            onTiming: (ms) => {
              stats.fetchMs += ms
            },
          },
        )
      } catch (err) {
        throw new GeocoderError('unreachable', undefined, { cause: networkCause(err) })
      }
      if (!res.ok) {
        await discard(res)
        throw statusError(res.status)
      }
      const hits = parseHits(await res.text(), res.status)

      cache.delete(key)
      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(key, { hits, expiresAt: Date.now() + CACHE_TTL_MS })
      return hits
    },
  }
}

function statusError(status: number): GeocoderError {
  // A keyless API: a 403 is a block (usually the User-Agent or the policy).
  if (status === 403) return new GeocoderError('forbidden', status)
  if (status === 429) return new GeocoderError('rate_limited', status)
  if (status >= 500) return new GeocoderError('unreachable', status)
  return new GeocoderError('unexpected_response', status)
}

function parseHits(body: string, status: number): GeocoderHit[] {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new GeocoderError('unexpected_response', status) // never echo the body
  }
  if (!Array.isArray(json)) throw new GeocoderError('unexpected_response', status)
  const hits: GeocoderHit[] = []
  for (const item of json) {
    const parsed = nominatimPlace.safeParse(item)
    if (!parsed.success) continue
    const latitude = Number(parsed.data.lat)
    const longitude = Number(parsed.data.lon)
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue
    hits.push({ label: parsed.data.display_name, latitude, longitude })
    if (hits.length === MAX_HITS) break
  }
  return hits
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
```

`src/lib/effects/geocoder/adapters/notConfigured.ts`:
```ts
import { GeocoderError } from '../errors'
import type { GeocoderClient } from '../geocoder'

// Test-only default (VITEST): fails closed so nothing reaches the network.
export const notConfigured: GeocoderClient = {
  async search() {
    throw new GeocoderError('not_configured')
  },
}
```

`src/lib/effects/geocoder/index.ts`:
```ts
export { createNominatimClient } from './client'
export { GeocoderError, type GeocoderErrorCode } from './errors'
export {
  type GeocoderCallOpts,
  type GeocoderCallStats,
  type GeocoderClient,
  type GeocoderHit,
  geocoder,
  newGeocoderStats,
  selectGeocoderAdapter,
} from './geocoder'
```

`src/lib/effects/index.ts`: add `export { geocoder } from './geocoder'` after the `eltariff` line.

- [ ] **Step 4: Run, confirm it passes**

Run: `bunx vitest run src/lib/effects/geocoder`
Expected: PASS (10 tests). If the throttle test sees one wait of 999 ms (fake-timer rounding), check that the slot
uses one `Date.now()` per call (as above); don't loosen the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/lib/effects/geocoder src/lib/effects/index.ts
git commit -m "feat(geocoder): add a throttled, cached Nominatim address search"
```
Reviewers: `code-reviewer` + `test-completeness`.

---

### Task 2: Service — `homePosition()` and `UNREADABLE`

**Files:**
- Modify: `src/lib/services/integrationCredential/errors.ts`, `integrationCredential.ts`, `integrationCredential.test.ts`

**Interfaces:**
- Consumes: `readStored` (same module), `envCredential` (`~/lib/credentials/env`), `CredentialsUnreadableError`
  (`~/lib/credentials/crypto`), `parseHomePoint` (`~/lib/vehicleState/geofence`), `LatLon` (`~/lib/effects/skoda`, type).
- Produces: `export async function homePosition(): Promise<LatLon | null>` (re-exported through the service barrel),
  plus `'UNREADABLE'` in `IntegrationCredentialDomainErrorCode`.

- [ ] **Step 1: Write the failing tests** (a new `describe('homePosition')` block in `integrationCredential.test.ts`; import `homePosition`
  next to `set`).

```ts
describe('homePosition', () => {
  const HOME = '59.3293,18.0686' // central Stockholm, not a real home

  test('a stored value wins over env', async () => {
    vi.stubEnv('SKODA_HOME_COORDINATES', '57.7,11.97')
    await set('skoda', { homeCoordinates: HOME }, await insertUser())
    expect(await homePosition()).toEqual({ latitude: 59.3293, longitude: 18.0686 })
  })

  test('env fills in when the stored row has no home position', async () => {
    vi.stubEnv('SKODA_HOME_COORDINATES', ' 57.7 , 11.97 ')
    await set('skoda', { apiKey: 'k1' }, await insertUser())
    expect(await homePosition()).toEqual({ latitude: 57.7, longitude: 11.97 })
  })

  test('null when unset or unparseable', async () => {
    vi.stubEnv('SKODA_HOME_COORDINATES', '')
    expect(await homePosition()).toBeNull()
    vi.stubEnv('SKODA_HOME_COORDINATES', 'hemma')
    expect(await homePosition()).toBeNull()
  })

  test('an unreadable row is UNREADABLE, never the env value', async () => {
    vi.stubEnv('SKODA_HOME_COORDINATES', '57.7,11.97')
    await set('skoda', { homeCoordinates: HOME }, await insertUser())
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const error = await domainError(() => homePosition())
    expect(error.code).toBe('UNREADABLE')
    expect(error.message).not.toContain('57.7')
  })
})
```
(`insertUser`, `newKey` and `domainError` already exist in this file. If `newKey` is named differently, use the
file's helper that returns a fresh base64 key.)

- [ ] **Step 2: Run, confirm it fails**

Run: `bunx vitest run src/lib/services/integrationCredential`
Expected: FAIL (`homePosition` is not exported).

- [ ] **Step 3: Implement**

`errors.ts`: add to the union:
```ts
  // The stored row can't be read (key missing or wrong, tampered): a read that must not
  // fall back to env (ADR-0026 decision 4) refuses instead.
  | 'UNREADABLE'
```

`integrationCredential.ts`: add `import type { LatLon } from '~/lib/effects/skoda'`, then append after `status()`:
```ts
/**
 * The Škoda home point as the geofence would use it: the stored value, else
 * `SKODA_HOME_COORDINATES`, parsed; null when neither parses. The one
 * credential value that leaves this module for a client (ADR-0026, 2026-10-06
 * amendment), for admins only. An unreadable row is `UNREADABLE`, never the
 * env value. Uncached: an admin opening the picker reads the current row.
 */
export async function homePosition(): Promise<LatLon | null> {
  let stored: CredentialValues<'skoda'> | null
  try {
    stored = await readStored('skoda')
  } catch (err) {
    if (err instanceof CredentialsUnreadableError) {
      throw new IntegrationCredentialDomainError('UNREADABLE')
    }
    throw err
  }
  return parseHomePoint(stored?.homeCoordinates ?? envCredential('skoda', 'homeCoordinates'))
}
```

- [ ] **Step 4: Run, confirm it passes**

Before running, add the new code to `credentialErrors` in `src/lib/orpc/procedures/credentials.ts`. Its
`satisfies Record<IntegrationCredentialDomainErrorCode, …>` now requires it, and Task 3 uses it for `homePosition`:
```ts
  // homePosition only: the stored Škoda row can't be read (never falls back to env).
  UNREADABLE: { status: 409 },
```

Run: `bunx vitest run src/lib/services/integrationCredential && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/integrationCredential src/lib/orpc/procedures/credentials.ts
git commit -m "feat(credentials): read the resolved home position for admins"
```
Reviewers: `code-reviewer` + `test-completeness`.

---

### Task 3: Procedures — `credentials.homePosition` and `credentials.searchAddress`

**Files:**
- Modify: `src/lib/orpc/procedures/credentials.ts`, `credentials.test.ts`

**Interfaces:**
- Consumes: `credentialService.homePosition()` (Task 2); `geocoder`, `GeocoderError`, `newGeocoderStats`,
  `createNominatimClient` (Task 1).
- Produces (client-visible through `RouterOutputs['credentials']`):
  - `homePosition: () => { latitude: number; longitude: number } | null`. Error `UNREADABLE` (409).
  - `searchAddress: ({ query: string }) => { label: string; latitude: number; longitude: number }[]`. The query is
    trimmed and 2–200 characters. Error `GEOCODER_UNAVAILABLE` (503).

- [ ] **Step 1: Write the failing tests** (append to `credentials.test.ts`; extend the FORBIDDEN table)

Extend the `test.each` table at the top:
```ts
  ['homePosition', undefined],
  ['searchAddress', { query: 'Storgatan 1' }],
```

Add imports: `import { createNominatimClient, geocoder, GeocoderError } from '~/lib/effects/geocoder'` and
`import { fakeFetch, jsonResponse } from '~/lib/effects/testing/fakeFetch'`. Then:
```ts
const HOME = '59.3293,18.0686' // central Stockholm, not a real home

test('homePosition returns the saved point to an admin and never logs it', async () => {
  await signIn('admin')
  await call(credentialsRouter.set, { source: 'skoda', fields: { homeCoordinates: HOME } }, {
    context: baseContext(),
  })
  const { log, text } = capturingLog()
  const timings: Record<string, number> = {}

  const point = await call(credentialsRouter.homePosition, undefined, {
    context: { ...baseContext(), log, timings },
  })

  expect(point).toEqual({ latitude: 59.3293, longitude: 18.0686 })
  expect(text()).not.toContain('59.3293')
  expect(JSON.stringify(timings)).not.toContain('59.3293')
  expect(timings.homePositionMs).toBeGreaterThanOrEqual(0)
})

test('homePosition is null with nothing set, and UNREADABLE for an unreadable row', async () => {
  await signIn('admin')
  vi.stubEnv('SKODA_HOME_COORDINATES', '')
  expect(await call(credentialsRouter.homePosition, undefined, { context: baseContext() })).toBeNull()

  vi.stubEnv('SKODA_HOME_COORDINATES', '57.7,11.97')
  await call(credentialsRouter.set, { source: 'skoda', fields: { homeCoordinates: HOME } }, {
    context: baseContext(),
  })
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
  const error = await call(credentialsRouter.homePosition, undefined, {
    context: baseContext(),
  }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ORPCError)
  expect(error).toMatchObject({ code: 'UNREADABLE', status: 409, defined: true })
  expect(JSON.stringify(error)).not.toContain('57.7')
})

test('searchAddress returns the hits and logs neither the query nor the results', async () => {
  await signIn('admin')
  const client = createNominatimClient({
    fetch: fakeFetch({
      'GET /search': () =>
        jsonResponse([{ display_name: 'Storgatan 1, Exempelby', lat: '57.7', lon: '11.97' }]),
    }).fetch,
  })
  vi.spyOn(geocoder, 'search').mockImplementation((q, o) => client.search(q, o))
  const { log, text } = capturingLog()
  const timings: Record<string, number> = {}

  const hits = await call(credentialsRouter.searchAddress, { query: 'Storgatan 1' }, {
    context: { ...baseContext(), log, timings },
  })

  expect(hits).toEqual([{ label: 'Storgatan 1, Exempelby', latitude: 57.7, longitude: 11.97 }])
  expect(text()).not.toMatch(/Storgatan|Exempelby|57\.7/)
  expect(timings).toMatchObject({ addressSearchRequests: 1, addressSearchCached: 0 })
  expect(timings.addressSearchMs).toBeGreaterThanOrEqual(0)
})

test('searchAddress maps any geocoder failure to GEOCODER_UNAVAILABLE', async () => {
  await signIn('admin')
  // Under VITEST the default adapter is notConfigured.
  const error = await call(credentialsRouter.searchAddress, { query: 'Storgatan 1' }, {
    context: baseContext(),
  }).catch((e: unknown) => e)
  expect(error).toMatchObject({ code: 'GEOCODER_UNAVAILABLE', status: 503, defined: true })

  vi.spyOn(geocoder, 'search').mockRejectedValue(new GeocoderError('rate_limited', 429))
  await expect(
    call(credentialsRouter.searchAddress, { query: 'Storgatan 1' }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'GEOCODER_UNAVAILABLE' })
})

test('searchAddress rejects a query too short or too long before searching', async () => {
  await signIn('admin')
  const search = vi.spyOn(geocoder, 'search')
  for (const query of ['a', ' b ', 'x'.repeat(201)]) {
    await expect(
      call(credentialsRouter.searchAddress, { query }, { context: baseContext() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
  expect(search).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run, confirm it fails**

Run: `bunx vitest run src/lib/orpc/procedures/credentials.test.ts`
Expected: FAIL (`homePosition` / `searchAddress` are undefined on the router).

- [ ] **Step 3: Implement** in `credentials.ts`

Add imports:
```ts
import { GeocoderError, geocoder, newGeocoderStats } from '~/lib/effects/geocoder'
```
Ensure `credentialErrors` has `UNREADABLE: { status: 409 },` (Task 2 may already have added it). Then add to
`credentialsRouter`:
```ts
  // The one credential value an admin can read back (ADR-0026, 2026-10-06 amendment):
  // fetched only while the picker is open, never in a loader. Never logged.
  homePosition: adminProcedure
    .errors({ UNREADABLE: credentialErrors.UNREADABLE })
    .handler(async ({ context, errors }) => {
      const started = performance.now()
      try {
        return await credentialService.homePosition()
      } catch (err) {
        if (err instanceof IntegrationCredentialDomainError && err.code === 'UNREADABLE') {
          throw errors.UNREADABLE()
        }
        throw err
      } finally {
        if (context.timings)
          context.timings.homePositionMs = Math.round(performance.now() - started)
      }
    }),

  // Address search for the picker, proxied so the admin's IP and browser stay
  // private (the text itself still reaches OpenStreetMap). Neither the query nor
  // a result is logged: only the hit count, the cache flag and timings.
  searchAddress: adminProcedure
    .errors({ GEOCODER_UNAVAILABLE: { status: 503 } })
    .input(z.object({ query: z.string().trim().min(2).max(200) }))
    .handler(async ({ input, context, errors }) => {
      const stats = newGeocoderStats()
      const started = performance.now()
      try {
        const hits = await geocoder.search(input.query, {
          stats,
          signal: AbortSignal.timeout(8_000),
        })
        context.log.debug('credentials: address search', { hits: hits.length, cached: stats.cached })
        return hits
      } catch (err) {
        if (err instanceof GeocoderError) {
          context.log.info('credentials: address search unavailable', { code: err.code })
          throw errors.GEOCODER_UNAVAILABLE()
        }
        throw err
      } finally {
        if (context.timings) {
          context.timings.addressSearchMs = Math.round(performance.now() - started)
          context.timings.addressSearchRequests = stats.requests
          context.timings.addressSearchCached = stats.cached ? 1 : 0
        }
      }
    }),
```
Zod's `too_small`/`too_big` messages carry the limit, never the value, so `logRpcError`'s warn line can't echo the
address.

- [ ] **Step 4: Run, confirm it passes**

Run: `bunx vitest run src/lib/orpc/procedures/credentials.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/orpc/procedures/credentials.ts src/lib/orpc/procedures/credentials.test.ts
git commit -m "feat(credentials): serve the home position and address search to admins"
```
Reviewers: `code-reviewer` + a reviewer loading `better-auth-security-best-practices` (the permission boundary: what
a member, anonymous caller or log line can see).

---

### Task 4: Client vocabulary, helpers and copy

**Files:**
- Modify: `src/lib/integrationCredentials.ts`, `src/lib/vehicleState/geofence.ts`, `src/lib/vehicleState/geofence.test.ts`,
  `src/lib/evCharging/clientSafe.browser.test.tsx`, `messages/sv.json`, `messages/en.json`
- Create: `src/components/evCharging/mapSupport.ts`

**Interfaces:**
- Produces:
  - `credentialFieldKind(source, field): 'secret' | 'text' | 'position'` (`homeCoordinates` → `'position'`).
  - `formatHomePoint(p: LatLon): string`, giving `"59.32930,18.06860"`: `toFixed(5)` each, no space.
  - From `mapSupport.ts`:
    - `supportsWebGL2(): boolean`;
    - `type MapView = { center: LatLon; zoom: number }`;
    - `SWEDEN_VIEW: MapView` (`{ center: { latitude: 62.0, longitude: 15.0 }, zoom: 3.6 }`);
    - `PIN_ZOOM = 16`, `PICK_ZOOM = 17`.
  - Copy keys from the table above.

- [ ] **Step 1: Write the failing tests**

`geofence.test.ts`, add:
```ts
test('formatHomePoint rounds to five decimals and round-trips through parseHomePoint', () => {
  expect(formatHomePoint({ latitude: 57.123456789, longitude: 11.987654321 })).toBe(
    '57.12346,11.98765',
  )
  expect(formatHomePoint({ latitude: -0.000001, longitude: 180 })).toBe('-0.00000,180.00000')
  expect(parseHomePoint(formatHomePoint(HOME))).toEqual(HOME)
})
```
(Import `formatHomePoint` beside `parseHomePoint`.)

`clientSafe.browser.test.tsx`: in "the credential vocabulary…" add
`expect(mod.credentialFieldKind('skoda', 'homeCoordinates')).toBe('position')`, and add:
```ts
test('the home-point helpers are importable client-side', async () => {
  const mod = await import('~/lib/vehicleState/geofence')
  expect(mod.formatHomePoint({ latitude: 59.3293, longitude: 18.0686 })).toBe('59.32930,18.06860')
})
```

- [ ] **Step 2: Run, confirm it fails**

Run: `bunx vitest run src/lib/vehicleState/geofence.test.ts`
Expected: FAIL (`formatHomePoint` is not exported).

- [ ] **Step 3: Implement**

`geofence.ts` (after `parseHomePoint`):
```ts
/** Five decimals (about 1 m): the form value the home-position picker writes, readable by `parseHomePoint`. */
export function formatHomePoint(p: LatLon): string {
  return `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`
}
```

`integrationCredentials.ts`:
```ts
/**
 * secret → password input; text → plain input; position → the map picker (with a plain "lat,lon"
 * input). Values are never pre-filled, except the position, which admins may read back (ADR-0026).
 */
export const credentialFieldKind = (
  source: CredentialSource,
  field: string,
): 'secret' | 'text' | 'position' =>
  source === 'skoda' && field === 'vin'
    ? 'text'
    : source === 'skoda' && field === 'homeCoordinates'
      ? 'position'
      : 'secret'
```

`src/components/evCharging/mapSupport.ts`:
```ts
import type { LatLon } from '~/lib/effects/skoda'

// Kept out of HomePositionMap (the lazy chunk) so the picker can decide without
// loading it, and so browser tests can mock the check.

export type MapView = { center: LatLon; zoom: number }

/** No saved pin: Sweden at country zoom. */
export const SWEDEN_VIEW: MapView = { center: { latitude: 62.0, longitude: 15.0 }, zoom: 3.6 }
/** Opening on a saved pin. */
export const PIN_ZOOM = 16
/** After a search hit or "Använd min position". */
export const PICK_ZOOM = 17

let webgl2: boolean | undefined

/** MapLibre 6 needs WebGL2; without it its constructor throws. Checked once per page. */
export function supportsWebGL2(): boolean {
  if (webgl2 === undefined) {
    try {
      webgl2 = document.createElement('canvas').getContext('webgl2') !== null
    } catch {
      webgl2 = false
    }
  }
  return webgl2
}
```

`messages/sv.json` / `en.json`: add the keys from the Copy table and change `charging_credentials_hint_home`. Then
run `bun run i18n:compile`.

- [ ] **Step 4: Run, confirm it passes**

Run: `bunx vitest run src/lib/vehicleState/geofence.test.ts && bunx vitest run --project browser src/lib/evCharging/clientSafe.browser.test.tsx && bun run typecheck`
Expected: PASS. In `CredentialsDialog.tsx`, `secret = kind === 'secret'` keeps working: the home field becomes a
plain text input. The dialog's "secrets are password inputs" test stays green, because it only checks the API key and VIN.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrationCredentials.ts src/lib/vehicleState src/lib/evCharging/clientSafe.browser.test.tsx src/components/evCharging/mapSupport.ts messages
git commit -m "feat(credentials): add the home-position vocabulary and copy"
```
Reviewers: `code-reviewer` + `test-completeness`.

---

### Task 5: The map module (`HomePositionMap`) and its build config

**Files:**
- Modify: `package.json` (deps), `vite.config.ts`, `scripts/measureBundle.ts`
- Create: `src/components/evCharging/HomePositionMap.tsx`

**Interfaces:**
- Consumes: `MapView` (Task 4).
- Produces:
  ```ts
  export type HomePositionMapProps = {
    /** The pin; none until a point is chosen. */
    point: LatLon | null
    /** The first view (not reactive). */
    initialView: MapView
    /** A camera request: each new object moves the view there. */
    camera: MapView | null
    onPick: (point: LatLon) => void
  }
  export function HomePositionMap(props: HomePositionMapProps): JSX.Element
  ```

- [ ] **Step 1: Add the dependencies and measure the baseline**

```bash
bun run bundle:measure > /tmp/claude-bundle-before.txt 2>&1   # before: settings page KB
bun add maplibre-gl@^6.12.0 @vis.gl/react-maplibre@^8.1.3
ls node_modules/maplibre-gl/dist/ | grep -E 'worker|\.css'      # expect maplibre-gl-worker.mjs and maplibre-gl.css
```
Licenses: maplibre-gl is BSD-3-Clause, @vis.gl/react-maplibre is MIT. If `maplibre-gl-worker.mjs` doesn't exist in
this version, read `node_modules/maplibre-gl/README.md` / `docs` for the v6 worker entry and use that path below.

Add `'maplibre-gl', '@vis.gl/react-maplibre'` to `WATCHED` in `scripts/measureBundle.ts`.

- [ ] **Step 2: Config**

In `vite.config.ts`:
- `'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',` with the comment
  `// geolocation=(self): "Använd min position" in the home-position picker (ADR-0026).`
- Top level (beside `resolve`):
  ```ts
  // maplibre-gl's worker is loaded by URL (setWorkerUrl in HomePositionMap); esbuild's
  // dep pre-bundling would rewrite it. Only the lazy map chunk imports it.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  ```
  If dev then fails to resolve `@vis.gl/react-maplibre`'s import of `maplibre-gl` (a CJS/ESM interop error in the
  browser console), drop the exclude and confirm the map still renders in dev. The maplibre docs say dev works either
  way; the exclude is the spec's guard. Record which one held in the spec's "as built".

- [ ] **Step 3: Implement `HomePositionMap.tsx`**

```tsx
import { AttributionControl, Map as MapLibre, type MapRef, Marker } from '@vis.gl/react-maplibre'
import { setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { MapPinIcon } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import type { LatLon } from '~/lib/effects/skoda'
import { logger } from '~/lib/logger/browser'
import { m } from '~/paraglide/messages'
import type { MapView } from './mapSupport'

// The only module that imports maplibre (ADR-0026, step 3c-2). The picker loads
// it with React.lazy inside <ClientOnly>, so the settings page never ships it.
// `?worker&url` (not `?url`): the dist worker imports a sibling chunk that only
// Vite's worker pipeline bundles in.
setWorkerUrl(workerUrl)

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
/** Pixels per arrow press; Shift moves five times as far. */
const KEY_STEP_PX = 10

export type HomePositionMapProps = {
  point: LatLon | null
  initialView: MapView
  camera: MapView | null
  onPick: (point: LatLon) => void
}

let warned = false

export function HomePositionMap({ point, initialView, camera, onPick }: HomePositionMapProps) {
  const mapRef = useRef<MapRef>(null)
  // Read once at mount: one finger scrolls the bottom sheet, two move the map.
  const coarse = useRef(window.matchMedia('(pointer: coarse)').matches).current

  useEffect(() => {
    if (!camera) return
    // Not `essential`: with prefers-reduced-motion MapLibre jumps instead of flying.
    mapRef.current?.flyTo({
      center: [camera.center.longitude, camera.center.latitude],
      zoom: camera.zoom,
    })
  }, [camera])

  const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = (event.shiftKey ? 5 : 1) * KEY_STEP_PX
    const delta = {
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    }[event.key]
    const map = mapRef.current
    if (!delta || !map || !point) return
    event.preventDefault()
    event.stopPropagation() // the map's own keyboard handler would pan instead
    const at = map.project([point.longitude, point.latitude])
    const next = map.unproject([at.x + delta[0], at.y + delta[1]])
    onPick({ latitude: next.lat, longitude: next.lng })
  }

  return (
    <div
      className="h-[260px] w-full overflow-hidden rounded-md border bg-muted"
      role="group"
      aria-label={m.charging_home_map_label()}
    >
      <MapLibre
        ref={mapRef}
        initialViewState={{
          longitude: initialView.center.longitude,
          latitude: initialView.center.latitude,
          zoom: initialView.zoom,
        }}
        mapStyle={STYLE_URL}
        cooperativeGestures={coarse}
        attributionControl={false}
        onClick={(e) => onPick({ latitude: e.lngLat.lat, longitude: e.lngLat.lng })}
        // Tiles or style failing leaves the pin on a blank map (the text input still works).
        // One warning per page, never the coordinates.
        onError={(e) => {
          if (warned) return
          warned = true
          logger.warn('home-position map error', { error: e.error })
        }}
      >
        <AttributionControl compact position="bottom-right" />
        {point ? (
          <Marker
            longitude={point.longitude}
            latitude={point.latitude}
            anchor="bottom"
            draggable
            onDragEnd={(e) => onPick({ latitude: e.lngLat.lat, longitude: e.lngLat.lng })}
          >
            <button
              type="button"
              aria-label={m.charging_home_pin_label()}
              onKeyDown={nudge}
              className="grid size-11 place-items-center rounded-full text-brand focus-visible:outline-2 focus-visible:outline-ring"
            >
              <MapPinIcon aria-hidden className="size-9 fill-background drop-shadow" />
            </button>
          </Marker>
        ) : null}
      </MapLibre>
    </div>
  )
}
```
If `@vis.gl/react-maplibre`'s `onError` event type has no `error` field, use the shape its `ErrorEvent` type declares
(check `node_modules/@vis.gl/react-maplibre/dist/types/events.d.ts`). If TypeScript lacks a declaration for
`?worker&url`, check `vite/client` is in `tsconfig.json` `types`; it declares `*?worker&url`. If `text-brand` isn't a
utility in `src/styles/app.css`, use the class that applies `--brand` there (grep `--brand`).

- [ ] **Step 4: Verify the build**

```bash
bun run typecheck
bun run build 2>&1 | tail -30
ls .output/public/assets | grep -iE 'worker|HomePositionMap'   # a worker chunk and a HomePositionMap chunk exist
grep -l "maplibregl-map" .output/public/assets/*.css             # maplibre's CSS made it into a chunk's CSS
```
Expected: the build passes, a separate worker asset exists, and maplibre's CSS is present.
- **If the CSS was tree-shaken away:** Vite normally keeps CSS imports. Check that `package.json` `sideEffects` doesn't
  drop it; if it does, add `"src/components/evCharging/HomePositionMap.tsx"` to `sideEffects`.
- **If SSR fails on `maplibre-gl`** (CJS entry on the server): add `ssr: { noExternal: ['maplibre-gl'] }`, per the
  maplibre docs.

Nothing renders the map yet; it is checked live in Task 7.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock vite.config.ts scripts/measureBundle.ts src/components/evCharging/HomePositionMap.tsx
git commit -m "feat(charging): add the lazy MapLibre map for the home position"
```
Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

---

### Task 6: The picker (`HomePositionPicker`)

**Files:**
- Create: `src/components/evCharging/HomePositionPicker.tsx`, `src/components/evCharging/HomePositionPicker.browser.test.tsx`

**Interfaces:**
- Consumes:
  - `HomePositionMap` and `HomePositionMapProps` (Task 5, lazy and type-only);
  - `supportsWebGL2`, `SWEDEN_VIEW`, `PIN_ZOOM`, `PICK_ZOOM`, `MapView` (Task 4);
  - `formatHomePoint`, `parseHomePoint` (Task 4 / geofence);
  - `orpc.credentials.homePosition.queryOptions`, `orpc.credentials.searchAddress.queryOptions` (Task 3).
- Produces:
  ```ts
  export type HomePositionPickerProps = {
    /** The form value ("lat,lon" or ""). */
    value: string
    /** Sets the form value (field.handleChange). */
    onChange: (value: string) => void
    /** Disabled (encryption key missing): only `children` render, nothing is fetched. */
    disabled: boolean
    /** Field hints shown first, described by `headerId`. */
    header: ReactNode
    headerId: string
    /** Prefix for the picker's own ids (`${idBase}-search` is the search input, focused on reveal). */
    idBase: string
    /** The bound "lat,lon" input (field.TextField). */
    children: ReactNode
  }
  export const homeSearchId = (idBase: string) => `${idBase}-search`
  ```

- [ ] **Step 1: Write the failing tests** (`HomePositionPicker.browser.test.tsx`)

```tsx
import { ORPCError } from '@orpc/client'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import type { HomePositionMapProps } from './HomePositionMap'
import { HomePositionPicker } from './HomePositionPicker'

const { homePositionFn, searchFn, webgl, mapState } = vi.hoisted(() => ({
  homePositionFn: vi.fn(),
  searchFn: vi.fn(),
  webgl: { ok: true },
  mapState: { throws: false, last: null as null | Record<string, unknown> },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    credentials: {
      homePosition: {
        queryOptions: (o: Record<string, unknown> = {}) => ({
          ...o,
          queryKey: ['credentials', 'homePosition'],
          queryFn: homePositionFn,
        }),
      },
      searchAddress: {
        queryOptions: (o: { input: { query: string } } & Record<string, unknown>) => ({
          ...o,
          queryKey: ['credentials', 'searchAddress', o.input],
          queryFn: () => searchFn(o.input),
        }),
      },
    },
  },
}))
vi.mock('./mapSupport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mapSupport')>()),
  supportsWebGL2: () => webgl.ok,
}))
// The real map needs WebGL and tiles: a stand-in that shows its props and can pick.
vi.mock('./HomePositionMap', () => ({
  HomePositionMap: (props: HomePositionMapProps) => {
    if (mapState.throws) throw new Error('GPU init failed')
    mapState.last = props as unknown as Record<string, unknown>
    return (
      <div data-testid="map" data-point={JSON.stringify(props.point)}>
        <button
          type="button"
          onClick={() => props.onPick({ latitude: 57.123456789, longitude: 11.987654321 })}
        >
          fake map click
        </button>
      </div>
    )
  },
}))

const submitted = vi.fn()
function Harness({ initial = '', disabled = false }: { initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submitted()
      }}
    >
      <HomePositionPicker
        value={value}
        onChange={setValue}
        disabled={disabled}
        header={<span>hints</span>}
        headerId="home-header"
        idBase="home"
      >
        <input aria-label="coords" value={value} onChange={(e) => setValue(e.target.value)} />
      </HomePositionPicker>
    </form>
  )
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  homePositionFn.mockReset().mockResolvedValue(null)
  searchFn.mockReset().mockResolvedValue([])
  submitted.mockReset()
  webgl.ok = true
  mapState.throws = false
  mapState.last = null
})
afterEach(() => vi.restoreAllMocks())

test('opens on the saved pin', async () => {
  homePositionFn.mockResolvedValue({ latitude: 59.3293, longitude: 18.0686 })
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByLabelText('coords')).toHaveValue('59.32930,18.06860')
  await expect
    .element(screen.getByTestId('map'))
    .toHaveAttribute('data-point', JSON.stringify({ latitude: 59.3293, longitude: 18.0686 }))
  expect(mapState.last?.camera).toEqual({
    center: { latitude: 59.3293, longitude: 18.0686 },
    zoom: 16,
  })
})

test('a pick before the saved pin arrives is kept', async () => {
  const saved = deferred<{ latitude: number; longitude: number }>()
  homePositionFn.mockReturnValue(saved.promise)
  const { screen } = await renderWithProviders(<Harness />)
  await screen.getByRole('button', { name: 'fake map click' }).click()
  saved.resolve({ latitude: 59.3293, longitude: 18.0686 })
  await vi.waitFor(() => expect(homePositionFn).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 50))
  await expect.element(screen.getByLabelText('coords')).toHaveValue('57.12346,11.98765')
})

test('without a saved pin, or with an unreadable one, the map opens on Sweden and nothing is set', async () => {
  homePositionFn.mockRejectedValue(new ORPCError('UNREADABLE', { defined: true }))
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByTestId('map')).toBeVisible()
  expect(mapState.last?.initialView).toEqual({
    center: { latitude: 62.0, longitude: 15.0 },
    zoom: 3.6,
  })
  await expect.element(screen.getByLabelText('coords')).toHaveValue('')
})

test('a map pick is rounded to five decimals and announced', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  await screen.getByRole('button', { name: 'fake map click' }).click()
  await expect.element(screen.getByLabelText('coords')).toHaveValue('57.12346,11.98765')
  await expect
    .element(screen.getByText(m.charging_home_chosen({ lat: '57.12346', lon: '11.98765' })))
    .toBeInTheDocument()
})

test('typed coordinates move the pin', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  await screen.getByLabelText('coords').fill('58.5,13.25')
  await expect
    .element(screen.getByTestId('map'))
    .toHaveAttribute('data-point', JSON.stringify({ latitude: 58.5, longitude: 13.25 }))
})

test('Enter searches and never submits the form; picking a hit moves the pin', async () => {
  searchFn.mockResolvedValue([
    { label: 'Storgatan 1, Exempelby', latitude: 57.7, longitude: 11.97 },
    { label: 'Storgatan 1, Annanstad', latitude: 59.1, longitude: 17.2 },
  ])
  const { screen } = await renderWithProviders(<Harness />)
  const search = screen.getByLabelText(m.charging_home_search_label())
  await search.fill('Storgatan 1')
  await userEventEnter(search.element() as HTMLInputElement)
  await vi.waitFor(() => expect(searchFn).toHaveBeenCalledWith({ query: 'Storgatan 1' }))
  expect(submitted).not.toHaveBeenCalled()
  await screen.getByRole('button', { name: 'Storgatan 1, Exempelby' }).click()
  await expect.element(screen.getByLabelText('coords')).toHaveValue('57.70000,11.97000')
  expect(mapState.last?.camera).toEqual({ center: { latitude: 57.7, longitude: 11.97 }, zoom: 17 })
  await expect
    .element(screen.getByRole('button', { name: 'Storgatan 1, Annanstad' }))
    .not.toBeInTheDocument()
  await expect.element(search).toHaveFocus()
})

test('Sök with fewer than two characters does nothing', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  await screen.getByLabelText(m.charging_home_search_label()).fill(' a ')
  await screen.getByRole('button', { name: m.charging_home_search(), exact: true }).click()
  await new Promise((r) => setTimeout(r, 50))
  expect(searchFn).not.toHaveBeenCalled()
})

test('no hits and a failed search each say so; the map stays', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  const search = screen.getByLabelText(m.charging_home_search_label())
  await search.fill('Ingenstans')
  await screen.getByRole('button', { name: m.charging_home_search(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_home_search_empty())).toBeVisible()

  searchFn.mockRejectedValue(new ORPCError('GEOCODER_UNAVAILABLE', { defined: true }))
  await search.fill('Någonstans')
  await screen.getByRole('button', { name: m.charging_home_search(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_home_search_unavailable())).toBeVisible()
  await expect.element(screen.getByTestId('map')).toBeVisible()
})

test('Använd min position moves the pin there; a refusal says so', async () => {
  const geo = vi.spyOn(navigator.geolocation, 'getCurrentPosition')
  geo.mockImplementation((ok) =>
    ok({ coords: { latitude: 58.4, longitude: 15.6 } } as GeolocationPosition),
  )
  const { screen } = await renderWithProviders(<Harness />)
  const locate = screen.getByRole('button', { name: m.charging_home_use_location() })
  await locate.click()
  await expect.element(screen.getByLabelText('coords')).toHaveValue('58.40000,15.60000')
  expect(mapState.last?.camera).toEqual({ center: { latitude: 58.4, longitude: 15.6 }, zoom: 17 })

  geo.mockImplementation((_ok, fail) =>
    fail?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError),
  )
  await locate.click()
  await expect.element(screen.getByText(m.charging_home_location_denied())).toBeVisible()
  geo.mockImplementation((_ok, fail) =>
    fail?.({ code: 3, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError),
  )
  await locate.click()
  await expect.element(screen.getByText(m.charging_home_location_unavailable())).toBeVisible()
})

test('without WebGL2 a note replaces the map; search and coordinates remain', async () => {
  webgl.ok = false
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText(m.charging_home_no_map())).toBeVisible()
  expect(screen.getByTestId('map').elements()).toHaveLength(0)
  await expect.element(screen.getByLabelText(m.charging_home_search_label())).toBeVisible()
  await expect.element(screen.getByLabelText('coords')).toBeVisible()
})

test('a map that fails to start shows the same note', async () => {
  mapState.throws = true
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText(m.charging_home_no_map())).toBeVisible()
  await expect.element(screen.getByLabelText('coords')).toBeVisible()
})

test('disabled shows only the coordinates and fetches nothing', async () => {
  const { screen } = await renderWithProviders(<Harness disabled />)
  await expect.element(screen.getByLabelText('coords')).toBeVisible()
  expect(screen.getByLabelText(m.charging_home_search_label()).elements()).toHaveLength(0)
  expect(screen.getByTestId('map').elements()).toHaveLength(0)
  await new Promise((r) => setTimeout(r, 50))
  expect(homePositionFn).not.toHaveBeenCalled()
})

async function userEventEnter(input: HTMLInputElement) {
  const { userEvent } = await import('vitest/browser')
  input.focus()
  await userEvent.keyboard('{Enter}')
}
```
Check the browser-test import for `userEvent` in an existing test (`grep -rn "userEvent" src --include=*.browser.test.tsx | head -3`)
and use that module path. The vitest 5 path may be `vitest/browser` or `@vitest/browser/context`.

- [ ] **Step 2: Run, confirm it fails**

Run: `bunx vitest run --project browser src/components/evCharging/HomePositionPicker.browser.test.tsx`
Expected: FAIL (module `./HomePositionPicker` not found).

- [ ] **Step 3: Implement `HomePositionPicker.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query'
import { ClientOnly } from '@tanstack/react-router'
import { LocateFixedIcon, MapPinIcon, SearchIcon } from 'lucide-react'
import { Component, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import type { LatLon } from '~/lib/effects/skoda'
import { orpc } from '~/lib/orpc/client'
import { formatHomePoint, parseHomePoint } from '~/lib/vehicleState/geofence'
import { m } from '~/paraglide/messages'
import { type MapView, PICK_ZOOM, PIN_ZOOM, SWEDEN_VIEW, supportsWebGL2 } from './mapSupport'

// The map chunk (maplibre, ~250 kB gz) loads only when a picker shows a map.
const HomePositionMap = lazy(() =>
  import('./HomePositionMap').then((mod) => ({ default: mod.HomePositionMap })),
)

export const homeSearchId = (idBase: string) => `${idBase}-search`

type Props = {
  value: string
  onChange: (value: string) => void
  disabled: boolean
  header: ReactNode
  headerId: string
  idBase: string
  children: ReactNode
}

type LocationError = 'denied' | 'unavailable'

// The Škoda home position (ADR-0026, step 3c-2): address search through our
// server, a map with a draggable pin, "Använd min position", and the bound
// "lat,lon" input (`children`) as the keyboard and screen-reader path. The form
// value stays that string; every point set here is rounded to 5 decimals.
export function HomePositionPicker({
  value,
  onChange,
  disabled,
  header,
  headerId,
  idBase,
  children,
}: Props) {
  if (disabled) {
    return (
      <div className="flex flex-col gap-3">
        <div id={headerId} className="flex flex-col gap-1 text-muted-foreground text-sm">
          {header}
        </div>
        {children}
      </div>
    )
  }
  return (
    <EnabledPicker value={value} onChange={onChange} header={header} headerId={headerId} idBase={idBase}>
      {children}
    </EnabledPicker>
  )
}

function EnabledPicker({ value, onChange, header, headerId, idBase, children }: Omit<Props, 'disabled'>) {
  // The saved pin: read only while the picker shows, dropped once it closes (gcTime 0),
  // never in a loader or the dehydrated cache (ADR-0026).
  const saved = useQuery(
    orpc.credentials.homePosition.queryOptions({
      gcTime: 0,
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    }),
  )
  const [camera, setCamera] = useState<MapView | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<LocationError | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // The form value at mount decides the first view; later moves go through `camera`.
  const [initialView] = useState<MapView>(() => {
    const p = parseHomePoint(value)
    return p ? { center: p, zoom: PIN_ZOOM } : SWEDEN_VIEW
  })

  // Seed once with the saved pin, unless the admin has already chosen a point.
  const seeded = useRef(false)
  const valueRef = useRef(value)
  valueRef.current = value
  useEffect(() => {
    if (seeded.current || !saved.data) return
    seeded.current = true
    if (valueRef.current.trim() !== '') return
    onChange(formatHomePoint(saved.data))
    setCamera({ center: saved.data, zoom: PIN_ZOOM })
  }, [saved.data, onChange])

  const pick = (point: LatLon, zoom?: number) => {
    const text = formatHomePoint(point)
    onChange(text)
    const [lat, lon] = text.split(',')
    setAnnouncement(m.charging_home_chosen({ lat, lon }))
    if (zoom !== undefined) setCamera({ center: point, zoom })
  }

  // Search runs on submit only (Nominatim's policy forbids autocomplete).
  const hits = useQuery({
    ...orpc.credentials.searchAddress.queryOptions({ input: { query: query ?? '' } }),
    enabled: query !== null,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const runSearch = () => {
    const q = searchRef.current?.value.trim() ?? ''
    if (q.length < 2) return
    setQuery(q)
  }
  const pickHit = (hit: { latitude: number; longitude: number }) => {
    pick({ latitude: hit.latitude, longitude: hit.longitude }, PICK_ZOOM)
    setQuery(null)
    searchRef.current?.focus()
  }

  const locate = () => {
    setLocationError(null)
    if (!('geolocation' in navigator)) {
      setLocationError('unavailable')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        pick({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }, PICK_ZOOM)
      },
      (err) => {
        setLocating(false)
        setLocationError(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable')
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  }

  const point = parseHomePoint(value)
  const searchId = homeSearchId(idBase)
  const noMap = <p className="text-muted-foreground text-sm">{m.charging_home_no_map()}</p>

  return (
    <div className="flex flex-col gap-3">
      <div id={headerId} className="flex flex-col gap-1 text-muted-foreground text-sm">
        {header}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={searchId}>{m.charging_home_search_label()}</Label>
        <div className="flex gap-2">
          <Input
            id={searchId}
            ref={searchRef}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            className="pointer-coarse:h-11"
            onKeyDown={(e) => {
              // Enter searches; it must never submit the credentials form.
              if (e.key === 'Enter') {
                e.preventDefault()
                runSearch()
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0 pointer-coarse:h-11"
            onClick={runSearch}
            disabled={hits.isFetching}
          >
            <SearchIcon aria-hidden />
            {m.charging_home_search()}
          </Button>
        </div>
        {query !== null && hits.isError ? (
          <p className="text-muted-foreground text-sm">{m.charging_home_search_unavailable()}</p>
        ) : query !== null && hits.data?.length === 0 ? (
          <p className="text-muted-foreground text-sm">{m.charging_home_search_empty()}</p>
        ) : query !== null && hits.data ? (
          <div className="flex flex-col gap-1">
            <ul aria-label={m.charging_home_search_hits()} className="flex flex-col">
              {hits.data.map((hit) => (
                <li key={`${hit.latitude},${hit.longitude},${hit.label}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-9 w-full justify-start whitespace-normal py-1.5 text-left pointer-coarse:min-h-11"
                    onClick={() => pickHit(hit)}
                  >
                    <MapPinIcon aria-hidden className="shrink-0" />
                    {hit.label}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">{m.charging_home_search_attribution()}</p>
          </div>
        ) : null}
      </div>
      {supportsWebGL2() ? (
        <ClientOnly fallback={<MapPlaceholder />}>
          <MapBoundary fallback={noMap}>
            <Suspense fallback={<MapPlaceholder />}>
              <HomePositionMap
                point={point}
                initialView={initialView}
                camera={camera}
                onPick={(p) => pick(p)}
              />
            </Suspense>
          </MapBoundary>
        </ClientOnly>
      ) : (
        noMap
      )}
      <div className="flex flex-col items-start gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={locate}
          disabled={locating}
        >
          <LocateFixedIcon aria-hidden />
          {m.charging_home_use_location()}
        </Button>
        {locationError ? (
          <p className="text-muted-foreground text-sm">
            {locationError === 'denied'
              ? m.charging_home_location_denied()
              : m.charging_home_location_unavailable()}
          </p>
        ) : null}
      </div>
      {children}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

function MapPlaceholder() {
  return <div aria-hidden className="h-[260px] w-full animate-pulse rounded-md border bg-muted" />
}

// A chunk that fails to load, or a map that can't start (MapLibre throws
// GPUInitializationError without WebGL2), falls back to the note: search and
// the coordinates input still work.
class MapBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
```
Notes:
- `onChange` comes from `field.handleChange` in the dialog, which is a stable reference. The seed effect depends on
  it; if a reference change ever re-ran the seed, the `seeded` ref still guards it.
- The search shows only the latest submitted query's state. Picking a hit clears it (`setQuery(null)`), so the list
  closes.

- [ ] **Step 4: Run, confirm it passes**

Run: `bunx vitest run --project browser src/components/evCharging/HomePositionPicker.browser.test.tsx`
Expected: PASS (12 tests). If the boundary test logs React's "uncaught error" to the console, that is expected and
not a failure.

- [ ] **Step 5: Commit**

```bash
git add src/components/evCharging/HomePositionPicker.tsx src/components/evCharging/HomePositionPicker.browser.test.tsx
git commit -m "feat(charging): add the home-position picker with search and location"
```
Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

---

### Task 7: The picker in the credentials dialog

**Files:**
- Modify: `src/components/evCharging/CredentialFieldRow.tsx`, `CredentialsDialog.tsx`, `CredentialsDialog.browser.test.tsx`

**Interfaces:**
- Consumes: `HomePositionPicker`, `homeSearchId` (Task 6); `credentialFieldKind` → `'position'` (Task 4).
- Produces:
  - `isClosableField(source, field, state)` replaces `isClosableState` in the open-set logic.
  - `hasCredentialValue(state)`: `stored` or `env`, the old `isClosableState` renamed. It is used for the
    "keeps current" hint.

- [ ] **Step 1: Update and add the failing tests** (`CredentialsDialog.browser.test.tsx`)

Add to the file's mocks:
- `homePosition` and `searchAddress` in the `vi.mock('~/lib/orpc/client', …)` `credentials` object, exactly as in
  Task 6's test file (with `homePositionFn` and `searchFn` in the `vi.hoisted` block);
- the `./mapSupport` and `./HomePositionMap` mocks from Task 6, with `webgl` and `mapState` hoisted;
- in `beforeEach`: `homePositionFn.mockReset().mockResolvedValue(null); searchFn.mockReset().mockResolvedValue([])`.

Add a helper after `closeName`:
```ts
const CHOOSE_HOME = actionName(m.charging_credentials_choose_on_map(), HOME)
type Screen = Awaited<ReturnType<typeof renderWithProviders>>['screen']
/** The home field starts closed even when missing: open it on the map. */
async function openHome(screen: Screen) {
  await screen.getByRole('button', { name: CHOOSE_HOME }).click()
}
```

Change these existing tests:
- **"stored and env fields start closed…":** replace the last block (from `// Missing: the input is shown directly`) with:
  ```ts
  // A missing home position starts closed too: the map loads only on request.
  await expect
    .element(screen.getByText(m.charging_credentials_badge_missing(), { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toBeVisible()
  expect(screen.getByLabelText(HOME, { exact: true }).elements()).toHaveLength(0)
  ```
- **"a stored home position is changed on the map (the input, until 3c-2)":** rename it to "a stored home position
  is changed on the map". After `await change.click()`, assert:
  ```ts
  await expect.element(screen.getByLabelText(m.charging_home_search_label())).toHaveFocus()
  await expect.element(screen.getByTestId('map')).toBeVisible()
  const coords = screen.getByLabelText(HOME, { exact: true })
  expect(coords.element().getAttribute('type')).toBe('text')
  ```
- **"a missing field has no Avbryt link":** render `dialog({ source: 'zaptec' })` and assert the username input (label
  `credentialFieldLabel('zaptec','username')`) is visible with no close button. Then add a new test:
  ```ts
  test('a missing home position opened on the map can be closed again', async () => {
    const { screen } = await renderWithProviders(dialog())
    await openHome(screen)
    await expect.element(screen.getByLabelText(HOME, { exact: true })).toBeVisible()
    await screen.getByRole('button', { name: closeName(HOME) }).click()
    await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toHaveFocus()
  })
  ```
- **Every other test that fills or reads `HOME` without opening it first** (the "Avbryt clears…" ending, "a server
  error opens the field it names", and the tests near the old lines 252, 368-390, 439, 583, 606): add
  `await openHome(screen)` before the first `getByLabelText(HOME…)`.
  - Where a test only needed some open field to fill (the server-error test), keep `HOME` with `openHome`. Its
    expectations stay as they are.
  - A test that checked autofocus on `HOME` now expects focus on the first reveal button
    (`REPLACE_API_KEY`), because every Škoda field starts closed in the default status.

Add:
```ts
test('a closed home field never fetches the saved pin', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toBeVisible()
  await new Promise((r) => setTimeout(r, 50))
  expect(homePositionFn).not.toHaveBeenCalled()
  await openHome(screen)
  await vi.waitFor(() => expect(homePositionFn).toHaveBeenCalledTimes(1))
})

test('a pin picked on the map is what Spara sends', async () => {
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  await screen.getByRole('button', { name: 'fake map click' }).click()
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(setFn).toHaveBeenCalled())
  expect(setFn.mock.calls[0][0]).toEqual({
    source: 'skoda',
    fields: { homeCoordinates: '57.12346,11.98765' },
  })
})

test('an unreadable source opens the picker with the other fields', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({}, { unreadable: true }) }))
  await expect.element(screen.getByLabelText(m.charging_home_search_label())).toBeVisible()
  await expect.element(screen.getByLabelText(HOME, { exact: true })).toBeVisible()
})

test('with the encryption key missing the home field cannot be opened', async () => {
  const { screen } = await renderWithProviders(
    dialog({ status: status({ encryptionKeyConfigured: false }) }),
  )
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toBeDisabled()
  expect(homePositionFn).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run, confirm the new and changed tests fail**

Run: `bunx vitest run --project browser src/components/evCharging/CredentialsDialog.browser.test.tsx`
Expected: FAIL (the missing home position still opens directly; no map).

- [ ] **Step 3: Implement**

`CredentialFieldRow.tsx`:
```ts
/** A field with a value: its input stays closed until replaced, and saving keeps the current value. */
export const hasCredentialValue = (state: CredentialFieldState) =>
  state === 'stored' || state === 'env'

/**
 * Whether a field may stay closed (and be closed again): one with a value, and
 * the home position even when missing — its map loads only when asked for (3c-2).
 */
export const isClosableField = (
  source: CredentialSource,
  field: string,
  state: CredentialFieldState,
) =>
  hasCredentialValue(state) ||
  (state === 'missing' && credentialFieldKind(source, field) === 'position')
```
- Remove `isClosableState`.
- Replace `const onMap = source === 'skoda' && field === 'homeCoordinates'` and its 3c-1 comment with
  `const onMap = credentialFieldKind(source, field) === 'position'`.
- Import `credentialFieldKind`.

`CredentialsDialog.tsx`:
- Imports: `isClosableField`, `hasCredentialValue` (drop `isClosableState`); `HomePositionPicker`, `homeSearchId` from
  `./HomePositionPicker`.
- Line ~149 (autofocus): `fields.every((f) => isClosableField(source, f, fieldState(sourceStatus, f)))`.
- Lines ~253-258: replace `isClosableState(states[f])` with `isClosableField(source, f, states[f])` (three places).
- `openField`: focus the search box for the position field:
  ```ts
  setFocusTarget(
    credentialFieldKind(source, f) === 'position' ? homeSearchId(inputId(source, f)) : inputId(source, f),
  )
  ```
- In the field loop:
  ```ts
  const closable = isClosableField(source, f, state)
  const hasValue = hasCredentialValue(state)
  ```
  - The description uses `hasValue` where it used `closable` (both `hint || hasValue` and the `keeps_current` line).
    A missing position has no current value to keep.
  - `onClose={closable ? () => closeField(f) : undefined}` is unchanged.
- Replace the `children` of `form.AppField` with:
  ```tsx
  children={(field) => {
    const kind = credentialFieldKind(source, f)
    if (kind !== 'position') {
      return (
        <field.TextField
          labelledBy={credentialLabelId(source, f)}
          type={kind === 'secret' ? 'password' : 'text'}
          autoComplete={kind === 'secret' ? 'new-password' : 'off'}
          inputId={inputId(source, f)}
          inputData={NO_PASSWORD_MANAGER}
          autoFocus={f === autoFocusField && !keyMissing}
          disabled={keyMissing}
          describedBy={describedBy}
          description={description}
          descriptionPlacement="above"
        />
      )
    }
    // The home position: the picker shows the field's hints first, then
    // search, map and location, then this "lat,lon" input as the keyboard path.
    const headerId = `${inputId(source, f)}-header`
    return (
      <HomePositionPicker
        value={field.state.value}
        onChange={field.handleChange}
        disabled={keyMissing}
        header={description}
        headerId={headerId}
        idBase={inputId(source, f)}
      >
        <field.TextField
          labelledBy={credentialLabelId(source, f)}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          inputId={inputId(source, f)}
          inputData={NO_PASSWORD_MANAGER}
          disabled={keyMissing}
          describedBy={[describedBy, headerId].filter(Boolean).join(' ')}
          description={m.charging_home_coordinates_hint()}
          descriptionPlacement="above"
        />
      </HomePositionPicker>
    )
  }}
  ```
  Remove the old `secret` const. The home input gets no `autoFocus`: the reveal focuses the search box, and an
  unreadable source focuses its first field (the API key).
  - `inputMode="decimal"`: check that iOS's decimal pad has a comma key. If it doesn't, use `inputMode="text"`; the
    value needs a comma between lat and lon.

- [ ] **Step 4: Run, confirm it passes**

Run: `bunx vitest run --project browser src/components/evCharging && bun run typecheck`
Expected: PASS for the dialog, picker, and every other evCharging browser test.

- [ ] **Step 5: Live check** (Phase 6 preview; the full check is in Task 8)

Start the worktree app on :14610 (memory: `live-ui-check-playwright`; `BETTER_AUTH_URL` override, Mailpit magic
link). As admin on `/charging/settings`, open the Škoda key dialog, then "Välj på kartan":
- the map renders the liberty style, and clicking moves the pin;
- dragging moves it; arrow keys on the focused pin move it;
- the search finds a known public address (e.g. "Drottninggatan 1, Stockholm") and picking it flies there;
- the attribution shows;
- check at 1280, 820 and 390 px wide. At 390 px it's the bottom sheet: one finger scrolls the sheet, two fingers pan
  the map (or the cooperative-gestures hint shows).

Don't save a real position in the local DB unless it's a public landmark.

- [ ] **Step 6: Commit**

```bash
git add src/components/evCharging
git commit -m "feat(charging): pick the charger's position on a map"
```
Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

---

### Task 8: Docs, branch review, verification and the PR

**Files:**
- Modify: `docs/adr/0026-integration-credential-store.md`, `docs/superpowers/specs/2026-10-05-charging-settings-design.md`,
  `docs/superpowers/roadmaps/2026-10-05-charging-settings.md`, `CLAUDE.md`

- [ ] **Step 1: ADR-0026.** Replace the amendment's last bullet ("The `Permissions-Policy` change … join this ADR
  when 3c-2 lands") with a new section, `## Amendment (2026-10-06): as built in step 3c-2`:
  - `credentials.homePosition` returns `{ latitude, longitude } | null`, the shape the geofence uses.
    - The service reads the stored row, else env (not the resolver's 60 s cache). An unreadable row is the domain
      code `UNREADABLE` (409).
    - The client fetches it only while the picker is open and enabled, with `gcTime: 0`.
  - The picker seeds the form value with the saved pin, rounded to 5 decimals. "Spara" with the picker open re-saves
    that point; for an env pin, that moves it into the app. Accepted: the hint says a saved value overrides env.
  - Address search is `credentials.searchAddress` → `effects/geocoder` (Nominatim).
    - It is throttled to 1 request/s per instance; a burst that would wait more than 3 s fails as `rate_limited`.
    - Results are cached in memory for 10 min (at most 100 queries).
    - It retries once on 502/503/504, never on 429.
    - Any failure is `GEOCODER_UNAVAILABLE` (503).
    - The query and the results are never logged; only the hit count, the cached flag and the timings are.
  - `Permissions-Policy: geolocation=(self)`, for "Använd min position".
  - The map (`maplibre-gl` 6, `@vis.gl/react-maplibre`, OpenFreeMap `liberty`) is one lazy chunk. Without WebGL2,
    or if the chunk fails to load, a note replaces it, and search plus the coordinates input remain.
  - Owner, 2026-10-06: a missing home position starts closed behind "Välj på kartan".

- [ ] **Step 2: Spec.** Under "3c-2", add an "As built (3c-2)" block with the same points as the ADR, plus:
  - the return shape is `{ latitude, longitude }`, not `{ lat, lon }`;
  - the fetch happens when the picker opens, not when the dialog opens;
  - which `optimizeDeps` setting held (Task 5);
  - the search is a query run on submit, not a mutation, so it doesn't count as a pending credentials save.

- [ ] **Step 3: Roadmap.** Row 3c-1 → `merged`. Row 3c-2 gets the plan link, the PR link (after Step 8) and
  `PR open`.

- [ ] **Step 4: CLAUDE.md.**
  - Code map `effects/` line: add "geocoder (keyless Nominatim address search for the home-position picker:
    proxied, 1 req/s, 10-min cache, ADR-0026)".
  - The `_authenticated/` line's settings description: add "(home-position map picker)".

- [ ] **Step 5: Commit the docs**

```bash
git add docs CLAUDE.md
git commit -m "docs(charging): record step 3c-2 as built"
```

- [ ] **Step 6: Branch review** (feature-workflow Phase 5). Dispatch in parallel:
  - `code-reviewer`;
  - `test-completeness` (a service, an effect and `errors.ts` changed);
  - a security pass over the permission boundary and the home position's exposure (loading
    `better-auth-security-best-practices`).

  No schema change, so no migration-guard. Fix or rule on every finding in this PR.

- [ ] **Step 7: Pre-PR gate and live check** (`docs/feature-workflow.md` → Pre-PR gate)

```bash
bun run check && bun run check:ci
bun run build
bun run db:up && bun run db:migrate
bun run test
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
bun run bundle:measure   # compare with /tmp/claude-bundle-before.txt
```
- **Bundle:** `/charging/settings` must not list `maplibre-gl` among its watched packages. Its KB beyond entry and
  shell may grow only by the picker shell (a few kB).
- **Headers:** `curl -sI http://localhost:14610/ | grep -i permissions-policy` shows `geolocation=(self)`.
- **Live check:** repeat Task 7's live check against the production build (`bun run build` +
  preview/`node .output/server/index.mjs` on the worktree port), at desktop, tablet and mobile widths. That
  confirms the worker and the CSS load from the built assets.

- [ ] **Step 8: PR.** Push with `git push -u origin feat/charging-home-picker`.
  - Title: `feat(charging): pick the charger's position on a map`.
  - Body per `.github/PULL_REQUEST_TEMPLATE.md`: why, the ADR-0026 link, the verification output, and the bundle
    numbers.
  - Then update the roadmap row's PR link (one more docs commit + push).
  - The real-world check is checkpoint 4 (on a phone, after merge and deploy).

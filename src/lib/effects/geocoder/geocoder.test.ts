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

    expect(hits.map((h) => h.label)).toEqual([
      'Plats 1',
      'Plats 2',
      'Plats 3',
      'Plats 4',
      'Plats 5',
    ])
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
    const results = await Promise.allSettled(['A1', 'B2', 'C3', 'D4', 'E5'].map((q) => c.search(q)))
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

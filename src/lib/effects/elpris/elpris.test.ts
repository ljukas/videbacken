import { describe, expect, test } from 'vitest'
import { type FakeRoute, fakeFetch, jsonResponse } from '~/lib/effects/testing/fakeFetch'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { createElprisClient } from './client'
import { elpris, newCallStats, selectElprisAdapter } from './elpris'
import { ElprisError } from './errors'

const DAY = '2026-09-28'
const ROUTE = 'GET /api/v1/prices/2026/09-28_SE3.json'
const EXR = 11.3

// Synthetic day in the API's shape (never real captured data).
function apiDay(day = DAY, price: (i: number) => number = (i) => 0.1 + i / 1000) {
  return daySlots(day, 15, price).map((s) => ({
    SEK_per_kWh: s.sekPerKwh,
    EUR_per_kWh: s.sekPerKwh / EXR,
    EXR,
    time_start: new Date(s.startMs).toISOString(),
    time_end: new Date(s.endMs).toISOString(),
  }))
}

function client(routes: Record<string, FakeRoute>) {
  const fake = fakeFetch(routes)
  const sleeps: number[] = []
  const c = createElprisClient({
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
    now: () => new Date('2026-09-28T12:00:00Z'),
  })
  return { c, fake, sleeps }
}

async function rejection(p: Promise<unknown>): Promise<ElprisError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ElprisError)
  return error as ElprisError
}

describe('dayPrices', () => {
  test('fetches the day’s file and returns validated slots', async () => {
    const { c, fake } = client({ [ROUTE]: () => jsonResponse(apiDay()) })
    const stats = newCallStats()

    const slots = await c.dayPrices(DAY, 'SE3', { stats })

    expect(slots).toHaveLength(96)
    expect(slots?.[0]).toEqual({
      startMs: Date.parse('2026-09-27T22:00:00Z'),
      endMs: Date.parse('2026-09-27T22:15:00Z'),
      sekPerKwh: 0.1,
    })
    expect(fake.calls[0].url).toBe(
      'https://www.elprisetjustnu.se/api/v1/prices/2026/09-28_SE3.json',
    )
    expect(fake.calls[0].headers.get('User-Agent')).toMatch(/^videbacken\//)
    expect(stats).toMatchObject({ requests: 1, retries: 0 })
  })

  test('parses the API’s local-offset timestamps', async () => {
    const rows = apiDay().map((r, i) => {
      const local = (ms: number) =>
        `${new Date(ms + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`
      return i === 0
        ? {
            ...r,
            time_start: local(Date.parse(r.time_start)),
            time_end: local(Date.parse(r.time_end)),
          }
        : r
    })
    expect(rows[0].time_start).toBe('2026-09-28T00:00:00+02:00')
    const { c } = client({ [ROUTE]: () => jsonResponse(rows) })
    expect((await c.dayPrices(DAY, 'SE3'))?.[0].startMs).toBe(Date.parse('2026-09-27T22:00:00Z'))
  })

  test('a 404 (not published yet) is null, not an error, and is not retried', async () => {
    const { c, fake } = client({ [ROUTE]: () => new Response('Not found', { status: 404 }) })
    expect(await c.dayPrices(DAY, 'SE3')).toBeNull()
    expect(fake.calls).toHaveLength(1)
  })

  test('retries a 429 and a 503, then succeeds', async () => {
    const { c, sleeps } = client({
      [ROUTE]: (_req, call) =>
        call === 0
          ? new Response(null, { status: 429 })
          : call === 1
            ? new Response(null, { status: 503 })
            : jsonResponse(apiDay()),
    })
    const stats = newCallStats()
    expect(await c.dayPrices(DAY, 'SE3', { stats })).toHaveLength(96)
    expect(stats).toMatchObject({ requests: 3, retries: 2 })
    expect(sleeps).toEqual([500, 1500])
  })

  test('honors a short Retry-After', async () => {
    const { c, sleeps } = client({
      [ROUTE]: (_req, call) =>
        call === 0
          ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
          : jsonResponse(apiDay()),
    })
    expect(await c.dayPrices(DAY, 'SE3')).toHaveLength(96)
    expect(sleeps).toEqual([2000])
  })

  test('a Retry-After beyond 10 s fails as rate_limited without waiting', async () => {
    const { c, sleeps } = client({
      [ROUTE]: () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    })
    expect((await rejection(c.dayPrices(DAY, 'SE3'))).code).toBe('rate_limited')
    expect(sleeps).toEqual([])
  })

  test('persistent 5xx is unreachable after two retries', async () => {
    const { c, fake } = client({ [ROUTE]: () => new Response(null, { status: 502 }) })
    const error = await rejection(c.dayPrices(DAY, 'SE3'))
    expect(error).toMatchObject({ code: 'unreachable', status: 502 })
    expect(fake.calls).toHaveLength(3)
  })

  test('a network failure is retried, then unreachable with only name/code as cause', async () => {
    const { c, fake } = client({
      [ROUTE]: () => {
        throw Object.assign(new TypeError('fetch failed: GET https://secret'), {
          cause: { code: 'ECONNRESET' },
        })
      },
    })
    const error = await rejection(c.dayPrices(DAY, 'SE3'))
    expect(error.code).toBe('unreachable')
    expect(error.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
    expect(fake.calls).toHaveLength(3)
  })

  test('a caller abort is final — no retry', async () => {
    const controller = new AbortController()
    const { c, fake } = client({
      [ROUTE]: () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      },
    })
    const error = await rejection(c.dayPrices(DAY, 'SE3', { signal: controller.signal }))
    expect(error.code).toBe('unreachable')
    expect(fake.calls).toHaveLength(1)
  })

  test('another 4xx is unexpected_response', async () => {
    const { c } = client({ [ROUTE]: () => new Response(null, { status: 400 }) })
    expect(await rejection(c.dayPrices(DAY, 'SE3'))).toMatchObject({
      code: 'unexpected_response',
      status: 400,
    })
  })

  test('a non-JSON body is unexpected_response', async () => {
    const { c } = client({ [ROUTE]: () => new Response('<html>oops</html>', { status: 200 }) })
    expect((await rejection(c.dayPrices(DAY, 'SE3'))).code).toBe('unexpected_response')
  })

  test.each([
    ['an empty day', []],
    ['a missing SEK field', apiDay().map(({ SEK_per_kWh: _sek, ...rest }) => rest)],
    [
      'a timestamp without offset',
      apiDay().map((r) => ({ ...r, time_start: '2026-09-28T00:00:00' })),
    ],
    ['a non-array body', { prices: apiDay() }],
  ])('shape drift (%s) is unexpected_response naming paths, never values', async (_, body) => {
    const { c } = client({ [ROUTE]: () => jsonResponse(body) })
    const error = await rejection(c.dayPrices(DAY, 'SE3'))
    expect(error.code).toBe('unexpected_response')
    expect(error.message).not.toMatch(/0\.1\d/)
  })

  test('a SEK price that no longer matches EUR × EXR is unexpected_response', async () => {
    // öre in the SEK field: 100× too large.
    const rows = apiDay().map((r) => ({ ...r, SEK_per_kWh: r.SEK_per_kWh * 100 }))
    const { c } = client({ [ROUTE]: () => jsonResponse(rows) })
    const error = await rejection(c.dayPrices(DAY, 'SE3'))
    expect(error.code).toBe('unexpected_response')
    expect(error.message).toContain('slot 0: SEK price does not match EUR × EXR')
  })

  test('an incomplete day (a missing slot) is unexpected_response without prices', async () => {
    const rows = apiDay().filter((_, i) => i !== 50)
    const { c } = client({ [ROUTE]: () => jsonResponse(rows) })
    const error = await rejection(c.dayPrices(DAY, 'SE3'))
    expect(error.code).toBe('unexpected_response')
    expect(error.message).toContain('slot 50 does not start where slot 49 ends')
  })

  test('a malformed day argument is a programming error, not a remote failure', async () => {
    const { c, fake } = client({})
    await expect(c.dayPrices('2026-9-28', 'SE3')).rejects.toBeInstanceOf(RangeError)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('adapter selection', () => {
  test('tests get notConfigured; everything else the keyless http client', () => {
    expect(selectElprisAdapter({ VITEST: 'true' })).toBe('notConfigured')
    expect(selectElprisAdapter({ NODE_ENV: 'production' })).toBe('http')
    expect(selectElprisAdapter({})).toBe('http')
  })

  test('the facade fails closed under vitest', async () => {
    expect((await rejection(elpris.dayPrices(DAY, 'SE3'))).code).toBe('not_configured')
  })
})

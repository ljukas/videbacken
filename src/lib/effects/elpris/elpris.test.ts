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

// The API's real format: local wall-clock time with the Stockholm offset
// (e.g. 2026-09-28T00:00:00+02:00).
function localIso(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  )
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute)
  const offsetMin = Math.round((wall - ms) / 60_000)
  const sign = offsetMin >= 0 ? '+' : '-'
  const hh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0')
  const mi = String(Math.abs(offsetMin) % 60).padStart(2, '0')
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mi}`
}

// A day exactly as elprisetjustnu.se publishes it — including its fall-back
// bug: the slot ending at the switch has `time_end` one hour too late
// (2025-10-26: 02:45+02:00 → "03:00+01:00").
function realFormatDay(day: string, lengthMin: 15 | 60) {
  return daySlots(day, lengthMin, (i) => 0.5 + i / 1000).map((s) => {
    const switchesBack =
      localIso(s.endMs).endsWith('+01:00') && localIso(s.startMs).endsWith('+02:00')
    return {
      SEK_per_kWh: s.sekPerKwh,
      EUR_per_kWh: s.sekPerKwh / EXR,
      EXR,
      time_start: localIso(s.startMs),
      time_end: localIso(switchesBack ? s.endMs + 3_600_000 : s.endMs),
    }
  })
}

function client(routes: Record<string, FakeRoute>) {
  const fake = fakeFetch(routes)
  const sleeps: number[] = []
  const c = createElprisClient({
    fetch: fake.fetch,
    timeoutMs: 50,
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

  test.each([
    ['2025-10-26', 15, 100],
    ['2024-10-27', 60, 25],
    ['2026-03-29', 15, 92],
  ] as const)('accepts %s in the API’s real format (%i-min, %i slots)', async (day, len, count) => {
    const rows = realFormatDay(day, len)
    const [yyyy, rest] = [day.slice(0, 4), day.slice(5)]
    const { c } = client({
      [`GET /api/v1/prices/${yyyy}/${rest}_SE3.json`]: () => jsonResponse(rows),
    })

    const slots = await c.dayPrices(day, 'SE3')

    expect(slots).toHaveLength(count)
    for (const [i, slot] of (slots ?? []).entries()) {
      expect(slot.endMs - slot.startMs).toBe(len * 60_000)
      if (i > 0) expect(slot.startMs).toBe(slots?.[i - 1].endMs)
    }
  })

  test('time_end that disagrees on more than the one fall-back slot is drift', async () => {
    const rows = apiDay().map((r, i) =>
      i === 3 || i === 40 ? { ...r, time_end: r.time_start } : r,
    )
    const { c } = client({ [ROUTE]: () => jsonResponse(rows) })
    const error = await rejection(c.dayPrices(DAY, 'SE3'))
    expect(error.message).toContain('time_end disagrees')
  })

  test('the fall-back fixture really carries the API’s bad time_end', () => {
    const rows = realFormatDay('2025-10-26', 15)
    expect(rows[11]).toMatchObject({
      time_start: '2025-10-26T02:45:00+02:00',
      time_end: '2025-10-26T03:00:00+01:00',
    })
    expect(rows[12].time_start).toBe('2025-10-26T02:00:00+01:00')
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

  test('a body that stalls past the timeout is retried, then unreachable', async () => {
    // Like real fetch, the body stream errors when the request's signal aborts.
    const stalled = (req: Request) =>
      new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode('['))
            req.signal.addEventListener('abort', () => c.error(req.signal.reason), { once: true })
          },
        }),
        { status: 200 },
      )
    const { c, fake } = client({ [ROUTE]: stalled })
    const error = await rejection(c.dayPrices(DAY, 'SE3'))
    expect(error.code).toBe('unreachable')
    expect(error.cause).toEqual({ name: 'TimeoutError' })
    expect(fake.calls).toHaveLength(3)
  })

  test('a connection dropped mid-body is retried and can recover', async () => {
    const dropped = () =>
      new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode('[{"SEK'))
            c.error(
              Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }),
            )
          },
        }),
        { status: 200 },
      )
    const { c } = client({
      [ROUTE]: (_req, call) => (call === 0 ? dropped() : jsonResponse(apiDay())),
    })
    expect(await c.dayPrices(DAY, 'SE3')).toHaveLength(96)
  })

  test('an already-aborted signal fails without a request', async () => {
    const controller = new AbortController()
    controller.abort()
    const { c, fake } = client({ [ROUTE]: () => jsonResponse(apiDay()) })
    expect((await rejection(c.dayPrices(DAY, 'SE3', { signal: controller.signal }))).code).toBe(
      'unreachable',
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('a Retry-After in HTTP-date form is honored', async () => {
    const { c, sleeps } = client({
      [ROUTE]: (_req, call) =>
        call === 0
          ? new Response(null, {
              status: 503,
              headers: { 'Retry-After': new Date('2026-09-28T12:00:03Z').toUTCString() },
            })
          : jsonResponse(apiDay()),
    })
    expect(await c.dayPrices(DAY, 'SE3')).toHaveLength(96)
    expect(sleeps).toEqual([3000])
  })

  test('a 503 with a long Retry-After is unreachable without waiting', async () => {
    const { c, sleeps } = client({
      [ROUTE]: () => new Response(null, { status: 503, headers: { 'Retry-After': '120' } }),
    })
    expect(await rejection(c.dayPrices(DAY, 'SE3'))).toMatchObject({
      code: 'unreachable',
      status: 503,
    })
    expect(sleeps).toEqual([])
  })

  test('a 429 on the last attempt is rate_limited', async () => {
    const { c, fake } = client({ [ROUTE]: () => new Response(null, { status: 429 }) })
    expect(await rejection(c.dayPrices(DAY, 'SE3'))).toMatchObject({
      code: 'rate_limited',
      status: 429,
    })
    expect(fake.calls).toHaveLength(3)
  })

  test('a 403 (CDN/bot block) is forbidden', async () => {
    const { c } = client({ [ROUTE]: () => new Response(null, { status: 403 }) })
    expect(await rejection(c.dayPrices(DAY, 'SE3'))).toMatchObject({
      code: 'forbidden',
      status: 403,
    })
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
    // No price value from the payload ever reaches the message.
    for (const row of apiDay()) expect(error.message).not.toContain(String(row.SEK_per_kWh))
  })

  // Date.parse rolls these over (Feb 30 → Mar 2, 24:00 → next midnight), and a
  // single odd `time_end` is otherwise tolerated as the fall-back slot.
  test.each([
    ['an impossible calendar day', 5, '2026-02-30T00:00:00+01:00'],
    ['hour 24', 95, '2026-09-28T24:00:00+02:00'],
  ])('an impossible instant (%s) is unexpected_response', async (_, index, timeEnd) => {
    const rows = apiDay().map((r, i) => (i === index ? { ...r, time_end: timeEnd } : r))
    const { c } = client({ [ROUTE]: () => jsonResponse(rows) })
    const error = await rejection(c.dayPrices(DAY, 'SE3'))
    expect(error.code).toBe('unexpected_response')
    expect(error.message).toContain(`${index}.time_end`)
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
    // Ends are derived from the next start, so the hole shows as a 30-min slot 49.
    expect(error.message).toContain('slot 49 differs in length from slot 0')
  })

  test.each([
    '2026-9-28',
    '2026-13-45',
    '2026-02-30',
  ])('a malformed day argument (%s) is a programming error, not a remote failure', async (day) => {
    const { c, fake } = client({})
    await expect(c.dayPrices(day, 'SE3')).rejects.toBeInstanceOf(RangeError)
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

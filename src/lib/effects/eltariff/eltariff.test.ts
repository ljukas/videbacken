import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch, jsonResponse } from '~/lib/effects/testing/fakeFetch'
import { createEltariffClient } from './client'
import { eltariff, newCallStats, selectEltariffAdapter } from './eltariff'
import { EltariffError } from './errors'

const ROUTE = 'GET /tariffcatalogue/all'

// Synthetic entries in the catalogue's shape (never real captured data).
function apiEntry(n: number) {
  return {
    id: `00000000-0000-0000-0000-00000000000${n}`,
    meteringPointIdFrom: `7359991${n}0000000000`,
    meteringPointIdTo: `7359991${n}9999999999`,
    companyName: `Nät ${n} AB`,
    companyOrgNo: '556000-0000',
    apiUrl: `https://grid${n}.example/tariffs`,
    userDocUrlOrEmail: '',
  }
}

// ky waits on real timers: fake them, jumping straight to the next one.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-01T06:00:00Z') })
  vi.setTimerTickMode('nextTimerAsync')
  vi.spyOn(Math, 'random').mockReturnValue(0.5) // jitter factor exactly 1.0
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function client(routes: Record<string, FakeRoute>) {
  const fake = fakeFetch(routes)
  const sentAt: number[] = []
  const c = createEltariffClient({
    fetch: (input, init) => {
      sentAt.push(Date.now())
      return fake.fetch(input, init)
    },
  })
  /** The (fake) time between consecutive requests — the retry waits. */
  const waits = () => sentAt.slice(1).map((at, i) => at - sentAt[i])
  return { c, fake, waits }
}

async function rejection(p: Promise<unknown>): Promise<EltariffError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(EltariffError)
  return error as EltariffError
}

describe('catalogue', () => {
  test('fetches the fixed catalogue URL and keeps only the fields matching needs', async () => {
    const { c, fake } = client({ [ROUTE]: () => jsonResponse([apiEntry(1), apiEntry(2)]) })
    const stats = newCallStats()

    const result = await c.catalogue({ stats })

    expect(result).toEqual({
      entries: [
        {
          meteringPointIdFrom: '735999110000000000',
          meteringPointIdTo: '735999119999999999',
          companyName: 'Nät 1 AB',
        },
        {
          meteringPointIdFrom: '735999120000000000',
          meteringPointIdTo: '735999129999999999',
          companyName: 'Nät 2 AB',
        },
      ],
      invalidEntries: 0,
    })
    // One constant URL, no query or path parameters: the facility ID can't leave.
    expect(fake.calls.map((r) => r.url)).toEqual(['https://eltariff.se/tariffcatalogue/all'])
    expect(fake.calls[0].headers.get('User-Agent')).toMatch(/^videbacken\//)
    expect(stats).toMatchObject({ requests: 1, retries: 0 })
    expect(stats.fetchMs).toBeGreaterThanOrEqual(0)
  })

  test('an entry without a usable name still counts, with a null name', async () => {
    const { c } = client({
      [ROUTE]: () =>
        jsonResponse([
          { ...apiEntry(1), companyName: '' },
          { ...apiEntry(2), companyName: null },
          { ...apiEntry(3), companyName: undefined },
          { ...apiEntry(4), companyName: 42 },
          { ...apiEntry(5), companyName: '  Nät 5 AB  ', apiUrl: null },
        ]),
    })

    const result = await c.catalogue()

    expect(result.entries.map((e) => e.companyName)).toEqual([null, null, null, null, 'Nät 5 AB'])
    expect(result.invalidEntries).toBe(0)
  })

  test('the company name is collapsed to one line and capped at 100 characters', async () => {
    const { c } = client({
      [ROUTE]: () =>
        jsonResponse([
          { ...apiEntry(1), companyName: 'Nät\n\n  1\tAB' },
          { ...apiEntry(2), companyName: `${'x'.repeat(99)} tail beyond the cap` },
        ]),
    })
    const [first, second] = (await c.catalogue()).entries
    expect(first.companyName).toBe('Nät 1 AB')
    expect(second.companyName).toBe('x'.repeat(99))
  })

  test('drops and counts entries unusable for matching', async () => {
    const { from, to } = { from: 'meteringPointIdFrom', to: 'meteringPointIdTo' } as const
    const unusable = [
      { ...apiEntry(2), [from]: 7359991200 }, // a number, not a string
      { ...apiEntry(2), [to]: 7359991299 },
      { ...apiEntry(2), [from]: '73599912000000000' }, // 17 digits
      { ...apiEntry(2), [to]: '7359991299999999999' }, // 19 digits
      { ...apiEntry(2), [from]: '73599912000000000x' },
      { ...apiEntry(2), [from]: ' 735999120000000000' },
      { ...apiEntry(2), [from]: undefined }, // key missing
      { ...apiEntry(2), [from]: '735999129999999999', [to]: '735999120000000000' }, // inverted
      null,
      'Nät 2 AB',
      7,
    ]
    const { c } = client({ [ROUTE]: () => jsonResponse([apiEntry(1), ...unusable]) })

    const result = await c.catalogue()

    expect(result.entries.map((e) => e.companyName)).toEqual(['Nät 1 AB'])
    expect(result.invalidEntries).toBe(unusable.length)
  })

  test('a single-ID range (from = to) is usable', async () => {
    const id = '735999110000000005'
    const { c } = client({
      [ROUTE]: () =>
        jsonResponse([{ ...apiEntry(1), meteringPointIdFrom: id, meteringPointIdTo: id }]),
    })
    expect((await c.catalogue()).entries).toHaveLength(1)
  })

  test('an empty catalogue is unexpected_response — the real one is never empty', async () => {
    const { c } = client({ [ROUTE]: () => jsonResponse([]) })
    expect(await rejection(c.catalogue())).toMatchObject({
      code: 'unexpected_response',
      status: 200,
    })
  })

  test('a catalogue with no usable entry at all is unexpected_response, not empty', async () => {
    // e.g. the API renamed the ID fields: every row fails.
    const renamed = [apiEntry(1), apiEntry(2)].map(
      ({ meteringPointIdFrom, meteringPointIdTo, ...rest }) => ({
        ...rest,
        meteringPointFrom: meteringPointIdFrom,
        meteringPointTo: meteringPointIdTo,
      }),
    )
    const { c } = client({ [ROUTE]: () => jsonResponse(renamed) })
    const error = await rejection(c.catalogue())
    expect(error).toMatchObject({ code: 'unexpected_response', status: 200 })
  })

  test('a body that is not a list is unexpected_response', async () => {
    const { c } = client({ [ROUTE]: () => jsonResponse({ entries: [apiEntry(1)] }) })
    const error = await rejection(c.catalogue())
    expect(error).toMatchObject({ code: 'unexpected_response', status: 200 })
  })

  test('invalid JSON is unexpected_response without echoing the body', async () => {
    const { c } = client({
      [ROUTE]: () => new Response('<html>secret-ish</html>', { status: 200 }),
    })
    const error = await rejection(c.catalogue())
    expect(error.code).toBe('unexpected_response')
    expect(error.message).not.toContain('secret-ish')
  })

  test.each([
    [400, 'unexpected_response'],
    [403, 'forbidden'],
    [404, 'unexpected_response'],
    [500, 'unreachable'],
  ] as const)('HTTP %i maps to %s without retrying or echoing the body', async (status, code) => {
    const { c, fake } = client({ [ROUTE]: () => new Response('secret-ish', { status }) })
    const error = await rejection(c.catalogue())
    expect(error).toMatchObject({ code, status })
    expect(error.message).not.toContain('secret-ish')
    expect(error.cause).toBeUndefined()
    expect(fake.calls).toHaveLength(1)
  })

  test('retries a 429 and a 503 with backoff, then succeeds', async () => {
    const stats = newCallStats()
    const { c, waits } = client({
      [ROUTE]: (_req, call) =>
        call === 0
          ? new Response(null, { status: 429 })
          : call === 1
            ? new Response(null, { status: 503 })
            : jsonResponse([apiEntry(1)]),
    })
    expect((await c.catalogue({ stats })).entries).toHaveLength(1)
    expect(stats).toMatchObject({ requests: 3, retries: 2 })
    expect(waits()).toEqual([500, 1500])
  })

  test('honors a short Retry-After', async () => {
    const { c, waits } = client({
      [ROUTE]: (_req, call) =>
        call === 0
          ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
          : jsonResponse([apiEntry(1)]),
    })
    expect((await c.catalogue()).entries).toHaveLength(1)
    expect(waits()).toEqual([2000])
  })

  test('a 429 that persists through the retries is rate_limited', async () => {
    const { c, fake } = client({ [ROUTE]: () => new Response(null, { status: 429 }) })
    expect(await rejection(c.catalogue())).toMatchObject({ code: 'rate_limited', status: 429 })
    expect(fake.calls).toHaveLength(3)
  })

  test.each([502, 503, 504])('a persistent %i is unreachable after two retries', async (status) => {
    const { c, fake } = client({ [ROUTE]: () => new Response(null, { status }) })
    expect(await rejection(c.catalogue())).toMatchObject({ code: 'unreachable', status })
    expect(fake.calls).toHaveLength(3)
  })

  test('a network failure is retried, then unreachable with only name/code as cause', async () => {
    const { c, fake } = client({
      [ROUTE]: () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNRESET', message: 'read ECONNRESET https://secret' },
        })
      },
    })
    const error = await rejection(c.catalogue())
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
    expect((await rejection(c.catalogue({ signal: controller.signal }))).code).toBe('unreachable')
    expect(fake.calls).toHaveLength(1)
  })

  test('an already-aborted signal fails without a request', async () => {
    const controller = new AbortController()
    controller.abort()
    const { c, fake } = client({ [ROUTE]: () => jsonResponse([apiEntry(1)]) })
    expect((await rejection(c.catalogue({ signal: controller.signal }))).code).toBe('unreachable')
    expect(fake.calls).toHaveLength(0)
  })

  test('a body that stalls past the timeout is retried, then unreachable', async () => {
    // Like real fetch, the body stream errors when the request's signal aborts.
    const stalled = (req: Request) =>
      new Response(
        new ReadableStream({
          start: (ctrl) => {
            ctrl.enqueue(new TextEncoder().encode('['))
            req.signal.addEventListener('abort', () => ctrl.error(req.signal.reason), {
              once: true,
            })
          },
        }),
        { status: 200 },
      )
    const { c, fake } = client({ [ROUTE]: stalled })
    const error = await rejection(c.catalogue())
    expect(error.code).toBe('unreachable')
    expect(error.cause).toEqual({ name: 'TimeoutError' })
    expect(fake.calls).toHaveLength(3)
  })
})

describe('adapter selection', () => {
  test('uses the real client outside tests and fails closed under VITEST', () => {
    expect(selectEltariffAdapter({})).toBe('http')
    expect(selectEltariffAdapter({ VITEST: 'true' })).toBe('notConfigured')
  })

  test('the default client under VITEST throws not_configured', async () => {
    const error = await rejection(eltariff.catalogue())
    expect(error.code).toBe('not_configured')
  })
})

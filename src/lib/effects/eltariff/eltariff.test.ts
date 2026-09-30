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
  return { c: createEltariffClient({ fetch: fake.fetch }), fake }
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
  test('fetches the whole catalogue and keeps the fields we match on', async () => {
    const { c, fake } = client({ [ROUTE]: () => jsonResponse([apiEntry(1), apiEntry(2)]) })
    const stats = newCallStats()

    const result = await c.catalogue({ stats })

    expect(result).toEqual({
      entries: [
        {
          companyName: 'Nät 1 AB',
          meteringPointIdFrom: '735999110000000000',
          meteringPointIdTo: '735999119999999999',
          apiUrl: 'https://grid1.example/tariffs',
        },
        {
          companyName: 'Nät 2 AB',
          meteringPointIdFrom: '735999120000000000',
          meteringPointIdTo: '735999129999999999',
          apiUrl: 'https://grid2.example/tariffs',
        },
      ],
      invalidEntries: 0,
    })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].url).toBe('https://eltariff.se/tariffcatalogue/all')
    expect(fake.calls[0].headers.get('User-Agent')).toMatch(/^videbacken\//)
    expect(stats).toMatchObject({ requests: 1, retries: 0 })
  })

  test('never calls the per-facility lookup endpoint', async () => {
    const { c, fake } = client({ [ROUTE]: () => jsonResponse([]) })
    await c.catalogue()
    expect(fake.calls.every((r) => !new URL(r.url).pathname.includes('lookup'))).toBe(true)
  })

  test('drops and counts malformed entries instead of failing the whole catalogue', async () => {
    const { c } = client({
      [ROUTE]: () =>
        jsonResponse([
          apiEntry(1),
          { ...apiEntry(2), meteringPointIdFrom: 735999120000000000 }, // a number, not a string
          { ...apiEntry(3), meteringPointIdTo: '73599913' }, // too short
          { ...apiEntry(4), companyName: '' },
          null,
        ]),
    })

    const result = await c.catalogue()

    expect(result.entries.map((e) => e.companyName)).toEqual(['Nät 1 AB'])
    expect(result.invalidEntries).toBe(4)
  })

  test('an empty catalogue is valid', async () => {
    const { c } = client({ [ROUTE]: () => jsonResponse([]) })
    expect(await c.catalogue()).toEqual({ entries: [], invalidEntries: 0 })
  })

  test('a body that is not a list is unexpected_response', async () => {
    const { c } = client({ [ROUTE]: () => jsonResponse({ entries: [apiEntry(1)] }) })
    const error = await rejection(c.catalogue())
    expect(error.code).toBe('unexpected_response')
    expect(error.status).toBe(200)
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
    [403, 'forbidden'],
    [404, 'unexpected_response'],
    [500, 'unreachable'],
  ] as const)('HTTP %i maps to %s without retrying', async (status, code) => {
    const { c, fake } = client({ [ROUTE]: () => new Response('nope', { status }) })
    const error = await rejection(c.catalogue())
    expect(error.code).toBe(code)
    expect(error.status).toBe(status)
    expect(fake.calls).toHaveLength(1)
  })

  test('retries a 503 and succeeds', async () => {
    const stats = newCallStats()
    const { c, fake } = client({
      [ROUTE]: (_req, call) =>
        call === 0 ? new Response(null, { status: 503 }) : jsonResponse([apiEntry(1)]),
    })
    const result = await c.catalogue({ stats })
    expect(result.entries).toHaveLength(1)
    expect(fake.calls).toHaveLength(2)
    expect(stats).toMatchObject({ requests: 2, retries: 1 })
  })

  test('a 429 that persists through the retries is rate_limited', async () => {
    const { c, fake } = client({ [ROUTE]: () => new Response(null, { status: 429 }) })
    const error = await rejection(c.catalogue())
    expect(error.code).toBe('rate_limited')
    expect(fake.calls).toHaveLength(3)
  })

  test('a network failure is unreachable, with only the error name and code as cause', async () => {
    const { c } = client({
      [ROUTE]: () => {
        throw Object.assign(new TypeError('fetch failed: https://eltariff.se/…'), {
          cause: { code: 'ECONNRESET' },
        })
      },
    })
    const error = await rejection(c.catalogue())
    expect(error.code).toBe('unreachable')
    expect(error.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
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

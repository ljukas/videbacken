import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch } from '../testing/fakeFetch'
import { createComfortCloudClient, newCallStats } from '.'
import { PINNED_APP_VERSION } from './constants'
import type { ComfortCloudError } from './errors'
import {
  accLoginReply,
  apiError,
  authRoutes,
  callbackForm,
  dayHistoryReply,
  deviceGroupReply,
  MATSAL_GUID,
  MODEL,
  monthHistoryReply,
  OVERVANING_GUID,
  playStorePage,
  ROUTES,
  rejectedPassword,
  secretsIn,
  TEST_ACCESS_TOKEN,
  TEST_ACCESS_TOKEN_2,
  TEST_CLIENT_ID,
  TEST_PASSWORD,
  TEST_USER,
} from './fixtures'
import { cfcApiKey } from './headers'

const NOW = new Date('2026-06-11T08:00:00.123Z')
const HOUR = 3_600_000
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.setTimerTickMode('nextTimerAsync')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const bearer = (req: Request) => req.headers.get('x-user-authorization-v2')
const version = (req: Request) => req.headers.get('x-app-version')
const historyBody = async (req: Request) =>
  (await req.clone().json()) as {
    deviceGuid: string
    dataMode: number
    date: string
    osTimezone: string
  }

/** A fake Comfort Cloud: Auth0 hands out TEST_ACCESS_TOKEN, then TEST_ACCESS_TOKEN_2. */
function server(overrides: Partial<Record<string, FakeRoute>> = {}) {
  const routes: Record<string, FakeRoute> = {
    ...authRoutes(),
    [ROUTES.accLogin]: () => accLoginReply(),
    [ROUTES.group]: () => deviceGroupReply(),
    [ROUTES.history]: async (req) => {
      const { dataMode, date } = await historyBody(req)
      return dataMode === 2
        ? monthHistoryReply(`${date.slice(0, 4)}-${date.slice(4, 6)}`)
        : dayHistoryReply(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`)
    },
    [ROUTES.playStore]: () => playStorePage('4.5.0'),
  }
  for (const [key, route] of Object.entries(overrides)) if (route) routes[key] = route
  const f = fakeFetch(routes)
  const client = createComfortCloudClient({
    fetch: f.fetch,
    user: TEST_USER,
    password: TEST_PASSWORD,
  })
  return { f, client }
}
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as ComfortCloudError,
  )
const apiKeyNow = (token: string) => cfcApiKey('2026-06-11 08:00:00', token)
const clean = (err: unknown) =>
  expect(secretsIn(err, [apiKeyNow(TEST_ACCESS_TOKEN), apiKeyNow(TEST_ACCESS_TOKEN_2)])).toEqual([])

describe('session', () => {
  test('logs in lazily, once, and reuses the session', async () => {
    const { f, client } = server()
    expect(f.calls).toHaveLength(0)
    const stats = newCallStats()
    await client.units({ stats })
    await client.dayHours(MATSAL_GUID, '2026-06-10', { stats })
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    expect(f.callsTo(ROUTES.accLogin)).toHaveLength(1)
    expect(stats).toMatchObject({ logins: 1, requests: 6 + 1 + 1 + 1, retries: 0 })
  })

  test('the session login has no client id; every later call carries the full header set', async () => {
    const { f, client } = server()
    await client.units()
    const login = f.callsTo(ROUTES.accLogin)[0]
    expect(await login.clone().json()).toEqual({ language: 0 })
    expect(login.headers.get('x-client-id')).toBeNull()
    expect(bearer(login)).toBe(`Bearer ${TEST_ACCESS_TOKEN}`)
    const group = f.callsTo(ROUTES.group)[0]
    expect(Object.fromEntries(group.headers)).toMatchObject({
      'user-agent': 'G-RAC',
      'x-app-name': 'Comfort Cloud',
      'x-app-type': '1',
      'x-app-version': PINNED_APP_VERSION,
      'x-app-timestamp': '2026-06-11 08:00:00',
      'x-cfc-api-key': apiKeyNow(TEST_ACCESS_TOKEN),
      'x-user-authorization-v2': `Bearer ${TEST_ACCESS_TOKEN}`,
      'x-client-id': TEST_CLIENT_ID,
    })
  })

  test('concurrent first calls share one login', async () => {
    const { f, client } = server()
    await Promise.all([
      client.units(),
      client.dayHours(MATSAL_GUID, '2026-06-10'),
      client.monthDays(OVERVANING_GUID, '2026-06'),
    ])
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    expect(f.callsTo(ROUTES.accLogin)).toHaveLength(1)
  })

  test('a token 23 h old is replaced before the call; 22 h 59 min is still used', async () => {
    const { f, client } = server()
    await client.units()
    vi.setSystemTime(NOW.getTime() + 23 * HOUR - 60_000)
    await client.units()
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    vi.setSystemTime(NOW.getTime() + 23 * HOUR)
    await client.units()
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    expect(bearer(f.callsTo(ROUTES.group)[2])).toBe(`Bearer ${TEST_ACCESS_TOKEN_2}`)
  })

  test('401 without 4106: one fresh login, the call retried with the new token', async () => {
    const { f, client } = server({
      [ROUTES.group]: (req) =>
        bearer(req) === `Bearer ${TEST_ACCESS_TOKEN}` ? apiError(401, 4100) : deviceGroupReply(),
    })
    const stats = newCallStats()
    expect(await client.units({ stats })).toHaveLength(2)
    expect(stats.logins).toBe(2)
    expect(f.callsTo(ROUTES.group).map(bearer)).toEqual([
      `Bearer ${TEST_ACCESS_TOKEN}`,
      `Bearer ${TEST_ACCESS_TOKEN_2}`,
    ])
  })

  test('401 again right after the fresh login is auth_failed', async () => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(401, 4100) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'auth_failed', op: 'units', status: 401 })
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    clean(err)
  })

  test('a refused login blocks new logins for five minutes', async () => {
    const { f, client } = server({ [ROUTES.password]: () => rejectedPassword() })
    const first = await caught(client.units())
    expect(first).toMatchObject({
      code: 'auth_failed',
      op: 'login',
      suspectFields: ['user', 'password'],
    })
    vi.setSystemTime(NOW.getTime() + 5 * 60_000 - 1)
    expect(await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))).toBe(first)
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    vi.setSystemTime(NOW.getTime() + 5 * 60_000)
    await caught(client.units())
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    clean(first)
  })
})

describe('app version', () => {
  const outdatedOnPinned: FakeRoute = (req) =>
    version(req) === PINNED_APP_VERSION ? apiError(401, 4106) : deviceGroupReply()

  test('401 + 4106: the Play Store version is looked up, the call retried, the version kept', async () => {
    const { f, client } = server({ [ROUTES.group]: outdatedOnPinned })
    expect(await client.units()).toHaveLength(2)
    expect(f.callsTo(ROUTES.group).map(version)).toEqual([PINNED_APP_VERSION, '4.5.0'])
    await client.dayHours(MATSAL_GUID, '2026-06-10')
    expect(version(f.callsTo(ROUTES.history)[0])).toBe('4.5.0')
    expect(f.callsTo(ROUTES.playStore)).toHaveLength(1)
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1) // 4106 is not a token problem
  })

  test('401 + 4106 on the session login is handled the same way', async () => {
    const { f, client } = server({
      [ROUTES.accLogin]: (req) =>
        version(req) === PINNED_APP_VERSION ? apiError(401, 4106) : accLoginReply(),
    })
    await client.units()
    expect(f.callsTo(ROUTES.accLogin).map(version)).toEqual([PINNED_APP_VERSION, '4.5.0'])
    expect(version(f.callsTo(ROUTES.group)[0])).toBe('4.5.0')
  })

  test('a failed lookup is unexpected_response and the call is not retried', async () => {
    for (const page of [
      () => new Response('<html>no version here</html>'),
      () => new Response(null, { status: 404 }),
      () => {
        throw new TypeError('fetch failed')
      },
    ]) {
      const { f, client } = server({ [ROUTES.group]: outdatedOnPinned, [ROUTES.playStore]: page })
      const err = await caught(client.units())
      expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
      expect(err.message).toContain('Play Store')
      expect(f.callsTo(ROUTES.group)).toHaveLength(1)
      clean(err)
    }
  })

  test('still 4106 after the lookup is unexpected_response, not a loop', async () => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(401, 4106) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
    clean(err)
    expect(f.callsTo(ROUTES.group)).toHaveLength(2)
    expect(f.callsTo(ROUTES.playStore)).toHaveLength(1)
  })
})

describe('calls', () => {
  test('units: the two air conditioners', async () => {
    const { client } = server()
    expect(await client.units()).toEqual([
      { guid: MATSAL_GUID, name: 'Matsal', model: MODEL },
      { guid: OVERVANING_GUID, name: 'Övervåning', model: MODEL },
    ])
  })

  test('dayHours: mode 0, the raw guid, the compact day, osTimezone +00:00', async () => {
    const { f, client } = server({
      [ROUTES.history]: () => dayHistoryReply('2026-06-10', { filledHours: 10 }),
    })
    const h = await client.dayHours(MATSAL_GUID, '2026-06-10')
    expect(await historyBody(f.callsTo(ROUTES.history)[0])).toEqual({
      deviceGuid: MATSAL_GUID,
      dataMode: 0,
      date: '20260610',
      osTimezone: '+00:00',
    })
    expect(h.registeredOn).toBe('2024-10-31')
    expect(h.rows).toHaveLength(10)
    expect(h.rows[9].hourStart).toEqual(new Date('2026-06-10T09:00:00Z'))
  })

  test('monthDays: mode 2 on the first of the month', async () => {
    const { f, client } = server({
      [ROUTES.history]: () => monthHistoryReply('2026-06', { filledDays: 11 }),
    })
    const h = await client.monthDays(OVERVANING_GUID, '2026-06')
    expect(await historyBody(f.callsTo(ROUTES.history)[0])).toEqual({
      deviceGuid: OVERVANING_GUID,
      dataMode: 2,
      date: '20260601',
      osTimezone: '+00:00',
    })
    expect(h.rows.map((r) => r.day).at(-1)).toBe('2026-06-11')
  })

  test('a bad day, month or guid is a RangeError before any request', async () => {
    const { f, client } = server()
    await expect(client.dayHours(MATSAL_GUID, '2026-02-30')).rejects.toThrow(RangeError)
    await expect(client.dayHours(MATSAL_GUID, '20260610')).rejects.toThrow(RangeError)
    await expect(client.monthDays(MATSAL_GUID, '2026-13')).rejects.toThrow(RangeError)
    await expect(client.dayHours('', '2026-06-10')).rejects.toThrow(RangeError)
    await expect(client.dayHours('x'.repeat(129), '2026-06-10')).rejects.toThrow(RangeError)
    expect(f.calls).toHaveLength(0)
  })

  test('an answer for another day fails the call (never stored under wrong hours)', async () => {
    const { client } = server({ [ROUTES.history]: () => dayHistoryReply('2026-06-11') })
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'history' })
    clean(err)
  })
})

describe('errors', () => {
  test.each([
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'unreachable'],
    [404, 'unexpected_response'],
    [400, 'unexpected_response'],
  ] as const)('history HTTP %i is %s', async (status, code) => {
    const { client } = server({
      [ROUTES.history]: () => new Response(`{"echo":"${TEST_USER}"}`, { status }),
    })
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code, op: 'history', status })
    clean(err)
  })

  test('503 is retried once, then unreachable', async () => {
    const { f, client } = server({ [ROUTES.group]: () => new Response(null, { status: 503 }) })
    const stats = newCallStats()
    const err = await caught(client.units({ stats }))
    expect(err).toMatchObject({ code: 'unreachable', op: 'units', status: 503 })
    expect(f.callsTo(ROUTES.group)).toHaveLength(2)
    expect(stats).toMatchObject({ retries: 1, requests: 6 + 1 + 2, logins: 1 })
    expect(Number.isFinite(stats.fetchMs)).toBe(true)
    expect(stats.fetchMs).toBeGreaterThanOrEqual(0)
    clean(err)
  })

  test.each([
    401, 400,
  ])('code 4103 (terms to accept, HTTP %i) is unexpected_response without a re-login', async (status) => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(status, 4103) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
    expect(err.message).toContain('4103')
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    clean(err)
  })

  test('a 200 that is not JSON is unexpected_response', async () => {
    const { client } = server({ [ROUTES.group]: () => new Response('<html>maintenance</html>') })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
    clean(err)
  })

  test('a network failure is unreachable with only name and code', async () => {
    const { client } = server({
      [ROUTES.history]: () => {
        throw Object.assign(
          new TypeError(`fetch failed Bearer ${TEST_ACCESS_TOKEN} ${MATSAL_GUID}`),
          {
            cause: { code: 'ETIMEDOUT' },
          },
        )
      },
    })
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code: 'unreachable', op: 'history' })
    expect(err.cause).toEqual({ name: 'TypeError', code: 'ETIMEDOUT' })
    clean(err)
  })

  test('an already-aborted signal fails unreachable before any request', async () => {
    const { f, client } = server()
    const ac = new AbortController()
    ac.abort()
    const err = await caught(client.units({ signal: ac.signal }))
    expect(err).toMatchObject({ code: 'unreachable', op: 'units' })
    expect(f.calls).toHaveLength(0)
    clean(err)
  })
})

const oldToken = (req: Request) => bearer(req) === `Bearer ${TEST_ACCESS_TOKEN}`
const jsonStatus = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })
const brokenBody = (status: number) => () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.error(new TypeError('terminated'))
      },
    }),
    { status },
  )

describe('answer bodies', () => {
  test.each([401, 500])('a HTTP %i whose body stream fails is unreachable', async (status) => {
    const { client } = server({ [ROUTES.group]: brokenBody(status) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unreachable', op: 'units', status })
    expect(err.cause).toEqual({ name: 'TypeError' })
    clean(err)
  })
})

describe('status codes are read from the JSON code field', () => {
  test('4106 digits inside another number are not the outdated-app code', async () => {
    const { f, client } = server({
      [ROUTES.group]: (req) =>
        oldToken(req) ? jsonStatus(401, '{"code":4100,"ts":1791441060000}') : deviceGroupReply(),
    })
    expect(await client.units()).toHaveLength(2)
    expect(f.callsTo(ROUTES.playStore)).toHaveLength(0)
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
  })

  test('4103 digits inside an id are not the terms error', async () => {
    const { f, client } = server({
      [ROUTES.group]: (req) =>
        oldToken(req) ? jsonStatus(401, '{"code":4100,"requestId":"a41035"}') : deviceGroupReply(),
    })
    expect(await client.units()).toHaveLength(2)
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
  })

  test('a 500 page that mentions 4103 is unreachable, not the terms error', async () => {
    const { client } = server({
      [ROUTES.group]: () => new Response('<html>error 4103 reference</html>', { status: 500 }),
    })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unreachable', op: 'units', status: 500 })
    clean(err)
  })
})

describe('a refused fresh token', () => {
  test('blocks logins for five minutes, then lets one through', async () => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(401, 4100) })
    const first = await caught(client.units())
    expect(first).toMatchObject({ code: 'auth_failed', op: 'units', status: 401 })
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    const sent = f.calls.length
    vi.setSystemTime(NOW.getTime() + 5 * 60_000 - 1)
    expect(await caught(client.units())).toBe(first)
    expect(f.calls).toHaveLength(sent)
    vi.setSystemTime(NOW.getTime() + 5 * 60_000)
    await caught(client.units())
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(4) // a login, then the refusal's one re-login
    clean(first)
  })
})

describe('Play Store lookup', () => {
  test('follows redirects; every API and Auth0 request stays manual', async () => {
    const { f, client } = server({
      [ROUTES.group]: (req) =>
        version(req) === PINNED_APP_VERSION ? apiError(401, 4106) : deviceGroupReply(),
    })
    await client.units()
    const store = f.callsTo(ROUTES.playStore)
    expect(store).toHaveLength(1)
    expect(store[0].redirect).toBe('follow')
    for (const req of f.calls.filter((r) => !store.includes(r))) expect(req.redirect).toBe('manual')
  })
})

describe('concurrent sessions', () => {
  test('two calls refused on the same old token cause one re-login', async () => {
    const { f, client } = server({
      [ROUTES.group]: (req) => (oldToken(req) ? apiError(401, 4100) : deviceGroupReply()),
    })
    const both = await Promise.all([client.units(), client.units()])
    expect(both.map((u) => u.length)).toEqual([2, 2])
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    expect(f.callsTo(ROUTES.group).map(bearer)).toEqual([
      `Bearer ${TEST_ACCESS_TOKEN}`,
      `Bearer ${TEST_ACCESS_TOKEN}`,
      `Bearer ${TEST_ACCESS_TOKEN_2}`,
      `Bearer ${TEST_ACCESS_TOKEN_2}`,
    ])
  })

  test('a shared login that fails fails every waiter with one error and one attempt', async () => {
    const { f, client } = server({ [ROUTES.password]: () => rejectedPassword() })
    const errs = await Promise.all([
      caught(client.units()),
      caught(client.dayHours(MATSAL_GUID, '2026-06-10')),
      caught(client.monthDays(OVERVANING_GUID, '2026-06')),
    ])
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    expect(errs[0]).toMatchObject({ code: 'auth_failed', op: 'login' })
    expect(errs[1]).toBe(errs[0])
    expect(errs[2]).toBe(errs[0])
    clean(errs[0])
    vi.setSystemTime(NOW.getTime() + 5 * 60_000)
    await caught(client.units())
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
  })
})

describe('which failed logins block', () => {
  test('an unreachable login does not block', async () => {
    const { f, client } = server({ [ROUTES.authorize]: () => new Response(null, { status: 503 }) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unreachable' })
    clean(err)
    const before = f.callsTo(ROUTES.authorize).length
    await caught(client.units())
    expect(f.callsTo(ROUTES.authorize).length).toBeGreaterThan(before)
  })

  test('an unexpected_response login does not block', async () => {
    const { f, client } = server({ [ROUTES.accLogin]: () => new Response('<html>x</html>') })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
    clean(err)
    await caught(client.units())
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
  })

  test('a successful login clears the block state', async () => {
    const { f, client } = server({
      [ROUTES.password]: (_req, call) => (call === 0 ? rejectedPassword() : callbackForm()),
      [ROUTES.group]: (req) => (oldToken(req) ? apiError(401, 4100) : deviceGroupReply()),
    })
    await caught(client.units())
    vi.setSystemTime(NOW.getTime() + 5 * 60_000)
    await client.units() // the block has expired; this login succeeds and clears it
    // Back inside the old block window: a refused token needs a re-login, which must not be blocked.
    vi.setSystemTime(NOW.getTime() + 60_000)
    expect(await client.units()).toHaveLength(2)
    expect(f.callsTo(ROUTES.authorize).length).toBeGreaterThanOrEqual(2)
  })
})

describe('4106 on the history call', () => {
  test('looks the version up and retries the same body', async () => {
    const { f, client } = server({
      [ROUTES.history]: (req) =>
        version(req) === PINNED_APP_VERSION ? apiError(401, 4106) : dayHistoryReply('2026-06-10'),
    })
    await client.dayHours(MATSAL_GUID, '2026-06-10')
    const hist = f.callsTo(ROUTES.history)
    expect(hist.map(version)).toEqual([PINNED_APP_VERSION, '4.5.0'])
    expect(await historyBody(hist[0])).toEqual(await historyBody(hist[1]))
    expect(f.callsTo(ROUTES.playStore)).toHaveLength(1)
  })

  test('a 400 with code 4106 is not the outdated-app signal', async () => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(400, 4106) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'units', status: 400 })
    expect(f.callsTo(ROUTES.playStore)).toHaveLength(0)
    expect(f.callsTo(ROUTES.group)).toHaveLength(1)
    clean(err)
  })
})

describe('error codes per operation', () => {
  const failing = (route: string, reply: FakeRoute) => server({ [route]: reply })

  test('login: 401 twice is auth_failed and blocks', async () => {
    const { f, client } = failing(ROUTES.accLogin, () => apiError(401, 4100))
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'auth_failed', op: 'login', status: 401 })
    clean(err)
    const sent = f.calls.length
    expect(await caught(client.units())).toBe(err)
    expect(f.calls).toHaveLength(sent)
  })

  test.each([
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'unreachable'],
  ] as const)('login: HTTP %i is %s', async (status, code) => {
    const { client } = failing(
      ROUTES.accLogin,
      () => new Response(`{"echo":"${TEST_USER}"}`, { status }),
    )
    const err = await caught(client.units())
    expect(err).toMatchObject({ code, op: 'login', status })
    clean(err)
  })

  test('login: 4103 is unexpected_response', async () => {
    const { client } = failing(ROUTES.accLogin, () => apiError(401, 4103))
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
    expect(err.message).toContain('4103')
    clean(err)
  })

  test.each([
    ['not JSON', () => new Response('<html>x</html>')],
    ['no clientId', () => jsonStatus(200, '{"language":0}')],
  ])('login: a 200 with %s is unexpected_response', async (_n, reply) => {
    const { client } = failing(ROUTES.accLogin, reply)
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
    clean(err)
  })

  test.each([
    [403, 'forbidden'],
    [429, 'rate_limited'],
  ] as const)('units: HTTP %i is %s', async (status, code) => {
    const { client } = failing(
      ROUTES.group,
      () => new Response(`{"echo":"${TEST_USER}"}`, { status }),
    )
    const err = await caught(client.units())
    expect(err).toMatchObject({ code, op: 'units', status })
    clean(err)
  })

  test('units: a network failure is unreachable', async () => {
    const { client } = failing(ROUTES.group, () => {
      throw Object.assign(new TypeError(`fetch failed ${TEST_ACCESS_TOKEN}`), {
        cause: { code: 'ECONNRESET' },
      })
    })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unreachable', op: 'units' })
    expect(err.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
    clean(err)
  })

  test('history: 401 twice is auth_failed', async () => {
    const { f, client } = failing(ROUTES.history, () => apiError(401, 4100))
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code: 'auth_failed', op: 'history', status: 401 })
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    clean(err)
  })

  test('history: 4103 is unexpected_response', async () => {
    const { client } = failing(ROUTES.history, () => apiError(401, 4103))
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'history' })
    expect(err.message).toContain('4103')
    clean(err)
  })

  test('history: a 200 that is not JSON is unexpected_response', async () => {
    const { client } = failing(ROUTES.history, () => new Response('<html>x</html>'))
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'history' })
    clean(err)
  })

  test('history: 503 is retried once, then unreachable', async () => {
    const { f, client } = failing(ROUTES.history, () => new Response(null, { status: 503 }))
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code: 'unreachable', op: 'history', status: 503 })
    expect(f.callsTo(ROUTES.history)).toHaveLength(2)
    clean(err)
  })

  test('monthDays: 403 is forbidden', async () => {
    const { client } = failing(ROUTES.history, () => new Response(null, { status: 403 }))
    const err = await caught(client.monthDays(OVERVANING_GUID, '2026-06'))
    expect(err).toMatchObject({ code: 'forbidden', op: 'history', status: 403 })
    clean(err)
  })

  test('monthDays: an answer for another month is unexpected_response', async () => {
    const { client } = failing(ROUTES.history, () => monthHistoryReply('2026-05'))
    const err = await caught(client.monthDays(OVERVANING_GUID, '2026-06'))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'history' })
    clean(err)
  })
})

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch } from '../testing/fakeFetch'
import { createComfortCloudClient, newCallStats } from '.'
import { PINNED_APP_VERSION } from './constants'
import type { ComfortCloudError } from './errors'
import {
  accLoginReply,
  apiError,
  authRoutes,
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
    }
  })

  test('still 4106 after the lookup is unexpected_response, not a loop', async () => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(401, 4106) })
    expect(await caught(client.units())).toMatchObject({ code: 'unexpected_response', op: 'units' })
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
    expect(await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))).toMatchObject({
      code: 'unexpected_response',
      op: 'history',
    })
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
    expect(await caught(client.units())).toMatchObject({
      code: 'unreachable',
      op: 'units',
      status: 503,
    })
    expect(f.callsTo(ROUTES.group)).toHaveLength(2)
  })

  test.each([
    401, 400,
  ])('code 4103 (terms to accept, HTTP %i) is unexpected_response without a re-login', async (status) => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(status, 4103) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
    expect(err.message).toContain('4103')
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
  })

  test('a 200 that is not JSON is unexpected_response', async () => {
    const { client } = server({ [ROUTES.group]: () => new Response('<html>maintenance</html>') })
    expect(await caught(client.units())).toMatchObject({ code: 'unexpected_response', op: 'units' })
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
    expect(await caught(client.units({ signal: ac.signal }))).toMatchObject({
      code: 'unreachable',
      op: 'units',
    })
    expect(f.calls).toHaveLength(0)
  })
})

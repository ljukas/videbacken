import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch, jsonResponse } from '../testing/fakeFetch'
import { createEmaldoClient } from './client'
import { newCallStats } from './emaldo'
import type { EmaldoError } from './errors'
import {
  DEVICE_ID,
  EMPTY_HOME_ID,
  HOME_ID,
  MODEL,
  okReply,
  openRequest,
  seriesDay,
  statusReply,
  TEST_APP_ID,
  TEST_APP_SECRET,
  TEST_PASSWORD,
  TEST_TOKEN,
  TEST_TOKEN_2,
  TEST_USER,
} from './fixtures'
import { SERIES_NAMES, type SeriesName } from './parse'

// ky waits on real timers: fake them, jumping straight to the next one (as skoda.test.ts).
const NOW = new Date('2026-06-11T08:00:00.123Z')
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.setTimerTickMode('nextTimerAsync')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const LOGIN = `POST /user/login/${TEST_APP_ID}`
const HOMES = `POST /home/list-homes/${TEST_APP_ID}`
const DEVICES = `POST /bmt/list-bmt/${TEST_APP_ID}`
const STATS: Record<SeriesName, string> = {
  grid: `POST /bmt/stats/grid/day/${TEST_APP_ID}`,
  mppt: `POST /bmt/stats/mppt-v2/day/${TEST_APP_ID}`,
  usage: `POST /bmt/stats/load/usage-v2/day/${TEST_APP_ID}`,
  battery: `POST /bmt/stats/battery-v2/day/${TEST_APP_ID}`,
}
const SECRETS = [
  TEST_USER,
  TEST_PASSWORD,
  TEST_TOKEN,
  TEST_APP_ID,
  TEST_APP_SECRET,
  HOME_ID,
  DEVICE_ID,
  TEST_TOKEN_2,
  EMPTY_HOME_ID,
  MODEL,
]

/**
 * A fake Emaldo cloud: logins hand out TEST_TOKEN, then TEST_TOKEN_2; stats
 * calls answer -12 unless sent with the accepted token (default: the newest
 * one issued; tests can move it). Every route can be overridden.
 */
function server(overrides: Partial<Record<string, FakeRoute>> = {}) {
  const tokens = [TEST_TOKEN, TEST_TOKEN_2]
  let issued = 0
  const state = { accept: null as string | null }
  const accepted = () => state.accept ?? tokens[issued - 1]
  const stats =
    (name: SeriesName): FakeRoute =>
    async (req) => {
      const { token } = await openRequest(req)
      if (token?.split('_')[0] !== accepted()) return statusReply(-12)
      return okReply(seriesDay(name, '2026-06-10'))
    }
  const routes: Record<string, FakeRoute> = {
    [LOGIN]: () => okReply({ token: tokens[issued++] ?? 'extra-token', user_id: 'u-1' }),
    [HOMES]: () => okReply({ list_homes: [{ home_id: EMPTY_HOME_ID }, { home_id: HOME_ID }] }),
    [DEVICES]: async (req) => {
      const { json } = await openRequest(req)
      return json?.includes(HOME_ID)
        ? okReply({ bmts: [{ id: DEVICE_ID, model: MODEL, name: 'Power Core' }] })
        : okReply({ bmts: null })
    },
    ...Object.fromEntries(SERIES_NAMES.map((n) => [STATS[n], stats(n)])),
  }
  for (const [key, route] of Object.entries(overrides)) if (route) routes[key] = route
  const f = fakeFetch(routes)
  const client = createEmaldoClient({
    fetch: f.fetch,
    user: TEST_USER,
    password: TEST_PASSWORD,
    appId: TEST_APP_ID,
    appSecret: TEST_APP_SECRET,
  })
  return { f, client, state }
}

const tick = async (n: number) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as EmaldoError,
  )
const describeCause = (cause: unknown) =>
  cause instanceof Error
    ? `${cause.name} ${cause.message} ${String((cause as { code?: unknown }).code)}`
    : JSON.stringify(cause ?? null)
const leaksNothing = (err: EmaldoError) => {
  const text = `${err.message} ${describeCause(err.cause)} ${JSON.stringify(err.cause ?? null)} ${String(err.stack ?? '')}`
  for (const s of SECRETS) expect(text).not.toContain(s)
}

describe('wire format', () => {
  test('login: api host, app id in the path, okhttp headers, encrypted body with gmtime, no token', async () => {
    const { f, client } = server()
    await client.fetchDay(-1)
    const [login] = f.callsTo(LOGIN)
    const url = new URL(login.url)
    expect(url.host).toBe('api.emaldo.com')
    expect(login.headers.get('user-agent')).toBe('okhttp/4.9.0')
    expect(login.headers.get('x-online-host')).toBe('api.emaldo.com')
    expect(login.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(login.redirect).toBe('error')
    const fields = await openRequest(login)
    const gmtime = `${NOW.getTime()}000000`
    expect(fields).toEqual({
      json: `{"email":"${TEST_USER}","password":"${TEST_PASSWORD}","gmtime":${gmtime}}`,
      token: null,
      gm: '1',
    })
  })

  test('discovery: list-homes sends only the token; list-bmt sends the home query', async () => {
    const { f, client } = server()
    await client.fetchDay(-1)
    const homes = await openRequest(f.callsTo(HOMES)[0])
    expect(homes.json).toBeNull()
    expect(homes.token).toBe(`${TEST_TOKEN}_${NOW.getTime()}000000`)
    const devices = await openRequest(f.callsTo(DEVICES)[0])
    expect(JSON.parse(devices.json?.replace(/"gmtime":\d+/, '"gmtime":0') ?? '')).toEqual({
      home_id: EMPTY_HOME_ID,
      models: [],
      page_size: 30,
      addtime: 1,
      order: 'asc',
      gmtime: 0,
    })
  })

  test('stats: data-plane host, the device query, grid asks for real 5-min data', async () => {
    const { f, client } = server()
    await client.fetchDay(-3)
    const grid = f.callsTo(STATS.grid)[0]
    expect(new URL(grid.url).host).toBe('dp.emaldo.com')
    expect(grid.headers.get('x-online-host')).toBe('dp.emaldo.com')
    const { json, token } = await openRequest(grid)
    expect(json).toBe(
      `{"home_id":"${HOME_ID}","id":"${DEVICE_ID}","model":"${MODEL}","offset":-3,"get_real":true,"query_interval":5,"gmtime":${NOW.getTime()}000000}`,
    )
    expect(token).toBe(`${TEST_TOKEN}_${NOW.getTime()}000000`)
    const usage = await openRequest(f.callsTo(STATS.usage)[0])
    expect(usage.json).toContain('"offset":-3,"gmtime":')
  })
})

describe('fetchDay', () => {
  test('logs in, discovers the home that has a battery, and returns the decoded day', async () => {
    const { f, client } = server()
    const stats = newCallStats()
    const day = await client.fetchDay(-1, { stats })
    expect(day.buckets).toHaveLength(288)
    expect(day.droppedBuckets).toBe(0)
    expect(day.dayStart).toEqual(new Date('2026-06-09T22:00:00Z'))
    expect(day.dayEnd).toEqual(new Date('2026-06-10T22:00:00Z'))
    expect(f.callsTo(DEVICES)).toHaveLength(2) // the empty home first, then ours
    expect(stats).toMatchObject({ requests: 8, retries: 0, logins: 1 }) // login, homes, 2 × list-bmt, 4 series
  })

  test('a second day reuses the token and the device: four requests, no login', async () => {
    const { f, client } = server()
    await client.fetchDay(-1)
    const stats = newCallStats()
    await client.fetchDay(-2, { stats })
    expect(stats).toMatchObject({ requests: 4, logins: 0 })
    expect(f.callsTo(LOGIN)).toHaveLength(1)
    expect(f.callsTo(HOMES)).toHaveLength(1)
  })

  test('concurrent first calls share one login and one discovery', async () => {
    const { f, client } = server()
    await Promise.all([client.fetchDay(-1), client.fetchDay(-2)])
    expect(f.callsTo(LOGIN)).toHaveLength(1)
    expect(f.callsTo(HOMES)).toHaveLength(1)
  })

  test('a plain (uncompressed) result is read too', async () => {
    const { client } = server({
      [STATS.usage]: () => okReply(seriesDay('usage', '2026-06-10'), { snappy: false }),
    })
    expect((await client.fetchDay(-1)).buckets).toHaveLength(288)
  })

  test.each([
    1,
    0.5,
    Number.NaN,
  ])('offset %s is a RangeError before any request', async (offset) => {
    const { f, client } = server()
    await expect(client.fetchDay(offset)).rejects.toBeInstanceOf(RangeError)
    expect(f.calls).toHaveLength(0)
  })
})

describe('session expiry (Status -12)', () => {
  test('an expired token: one re-login, the device kept, the call retried', async () => {
    const { f, client, state } = server()
    await client.fetchDay(-1)
    state.accept = TEST_TOKEN_2 // the server has dropped the first session
    const stats = newCallStats()
    expect((await client.fetchDay(-2, { stats })).buckets).toHaveLength(288)
    // All four series saw -12 at once; one shared re-login served them all.
    expect(f.callsTo(LOGIN)).toHaveLength(2)
    expect(f.callsTo(HOMES)).toHaveLength(1)
    expect(stats).toMatchObject({ logins: 1, requests: 9 }) // 4 refused + 1 login + 4 retried
    for (const n of SERIES_NAMES) expect(f.callsTo(STATS[n])).toHaveLength(3)
  })

  test('-12 again right after the re-login is auth_failed', async () => {
    const { f, client } = server(
      Object.fromEntries(SERIES_NAMES.map((n) => [STATS[n], () => statusReply(-12)])),
    )
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ name: 'EmaldoError', code: 'auth_failed', op: 'stats' })
    expect(f.callsTo(LOGIN)).toHaveLength(2) // the first login + exactly one re-login
    leaksNothing(err)
  })

  test('a stale token kept by a failed discovery: -12 in discovery logs in once more', async () => {
    let homes = 0
    const { f, client, state } = server({
      [HOMES]: async (req) => {
        if (homes++ < 2) throw new TypeError('fetch failed') // first call: both attempts fail
        const { token } = await openRequest(req)
        if (token?.split('_')[0] === TEST_TOKEN) return statusReply(-12) // the old session ended
        return okReply({ list_homes: [{ home_id: HOME_ID }] })
      },
    })
    state.accept = TEST_TOKEN_2
    expect(await caught(client.fetchDay(-1))).toMatchObject({ code: 'unreachable', op: 'discover' })
    await expect(client.fetchDay(-1)).resolves.toMatchObject({ droppedBuckets: 0 })
    expect(f.callsTo(LOGIN)).toHaveLength(2)
  })

  test('-12 during discovery on a fresh token is auth_failed', async () => {
    const { client } = server({ [HOMES]: () => statusReply(-12) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'auth_failed', op: 'discover' })
    leaksNothing(err)
  })
})

describe('failures', () => {
  test.each([
    -3, -12, 0,
  ])('a refused login (Status %i) is auth_failed and echoes nothing', async (status) => {
    const { f, client } = server({ [LOGIN]: () => statusReply(status) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'auth_failed', op: 'login' })
    expect(err.message).toContain(`Status ${status}`)
    expect(f.callsTo(HOMES)).toHaveLength(0)
    leaksNothing(err)
  })

  test('a failed login is not cached: the next call logs in again', async () => {
    let call = 0
    const { f, client, state } = server({
      [LOGIN]: () => (call++ === 0 ? statusReply(-3) : okReply({ token: TEST_TOKEN })),
    })
    state.accept = TEST_TOKEN
    await caught(client.fetchDay(-1))
    await expect(client.fetchDay(-1)).resolves.toMatchObject({ droppedBuckets: 0 })
    expect(f.callsTo(LOGIN)).toHaveLength(2)
  })

  test.each([
    -1, -999, 2,
  ])('an unknown Status %i on stats is unexpected_response', async (status) => {
    const { client } = server({ [STATS.battery]: () => statusReply(status) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'stats' })
    leaksNothing(err)
  })

  test('no home with a battery is unexpected_response from discover', async () => {
    const { client } = server({ [DEVICES]: () => okReply({ bmts: [] }) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'discover' })
    expect(err.message).toContain('battery')
    leaksNothing(err)
  })

  test('a failed discovery keeps the token and is retried on the next call', async () => {
    let call = 0
    const { f, client } = server({
      [HOMES]: () =>
        call++ === 0
          ? okReply({ list_homes: [] })
          : okReply({ list_homes: [{ home_id: HOME_ID }] }),
    })
    await caught(client.fetchDay(-1))
    await expect(client.fetchDay(-1)).resolves.toBeDefined()
    expect(f.callsTo(LOGIN)).toHaveLength(1)
    expect(f.callsTo(HOMES)).toHaveLength(2)
  })

  test('a result sealed with another secret hints that the app secret rotated', async () => {
    const { client } = server({
      [LOGIN]: () => okReply({ token: TEST_TOKEN }, { secret: 'rotated' }),
    })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
    expect(err.message).toContain('app id/secret may have rotated')
    leaksNothing(err)
  })

  test('a Status 1 without a string Result is unexpected_response', async () => {
    const { client } = server({
      [HOMES]: () => jsonResponse({ Status: 1, Result: { list_homes: [] } }),
    })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'discover' })
    leaksNothing(err)
  })

  test('a body that is not JSON, or has no integer Status, is unexpected_response', async () => {
    const html = server({ [STATS.grid]: () => new Response('<html>', { status: 200 }) })
    const htmlErr = await caught(html.client.fetchDay(-1))
    expect(htmlErr).toMatchObject({ code: 'unexpected_response', op: 'stats' })
    leaksNothing(htmlErr)
    const shape = server({ [STATS.grid]: () => jsonResponse({ status: 1 }) })
    const err = await caught(shape.client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response' })
    expect(err.message).toContain('at: Status')
    leaksNothing(err)
  })

  test('a day that fails the schema is unexpected_response naming the path only', async () => {
    const { client } = server({
      [STATS.mppt]: () => okReply({ ...seriesDay('mppt', '2026-06-10'), timezone: 'UTC' }),
    })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'stats' })
    expect(err.message).toContain('at: timezone')
    leaksNothing(err)
  })

  test.each([
    [500, 'unreachable', 1],
    [404, 'unexpected_response', 1],
    [429, 'rate_limited', 1],
  ] as const)('HTTP %i → %s, %i call', async (status, code, calls) => {
    const { f, client } = server({ [LOGIN]: () => new Response('x', { status }) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code, op: 'login', status })
    expect(f.callsTo(LOGIN)).toHaveLength(calls)
    leaksNothing(err)
  })

  test.each([502, 503, 504])('%i is retried once, then unreachable', async (status) => {
    const flaky = server({
      [STATS.grid]: (_req, call) =>
        call === 0 ? new Response(null, { status }) : okReply(seriesDay('grid', '2026-06-10')),
    })
    const stats = newCallStats()
    await expect(flaky.client.fetchDay(-1, { stats })).resolves.toBeDefined()
    expect(stats.retries).toBe(1)

    const down = server({ [STATS.grid]: () => new Response(null, { status }) })
    const downErr = await caught(down.client.fetchDay(-1))
    expect(downErr).toMatchObject({ code: 'unreachable', status })
    expect(down.f.callsTo(STATS.grid)).toHaveLength(2)
    leaksNothing(downErr)
  })

  test('network failures and timeouts are unreachable, retried once, and echo nothing', async () => {
    const net = server({
      [STATS.grid]: () => {
        throw Object.assign(new TypeError(`fetch failed for ${TEST_APP_ID} ${TEST_TOKEN}`), {
          code: 'ECONNRESET',
        })
      },
    })
    const netErr = await caught(net.client.fetchDay(-1))
    expect(netErr).toMatchObject({ code: 'unreachable', op: 'stats' })
    expect(netErr.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
    expect(net.f.callsTo(STATS.grid)).toHaveLength(2)
    leaksNothing(netErr)

    const hang = server({
      [STATS.grid]: (req) =>
        new Promise<Response>((_res, rej) =>
          req.signal.addEventListener('abort', () => rej(req.signal.reason)),
        ),
    })
    const hangErr = await caught(hang.client.fetchDay(-1))
    expect(hangErr).toMatchObject({ code: 'unreachable' })
    expect(hangErr.cause).toEqual({ name: 'TimeoutError' })
    expect(hang.f.callsTo(STATS.grid)).toHaveLength(2)
    leaksNothing(hangErr)
  })

  test('a caller abort is final: unreachable, nothing retried; a pre-aborted call sends nothing', async () => {
    const ctl = new AbortController()
    const { f, client } = server({
      [STATS.grid]: (req) =>
        new Promise<Response>((_res, rej) => {
          req.signal.addEventListener('abort', () => rej(req.signal.reason))
          ctl.abort()
        }),
    })
    const abortErr = await caught(client.fetchDay(-1, { signal: ctl.signal }))
    expect(abortErr).toMatchObject({ code: 'unreachable' })
    expect(f.callsTo(STATS.grid)).toHaveLength(1)
    leaksNothing(abortErr)

    const pre = server()
    const preErr = await caught(pre.client.fetchDay(-1, { signal: AbortSignal.abort() }))
    expect(preErr).toMatchObject({ code: 'unreachable' })
    expect(pre.f.calls).toHaveLength(0)
    leaksNothing(preErr)
  })
})

describe('login waits and cancellation', () => {
  test('a caller that aborts while waiting on a shared login leaves that login running', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    // Promises, not timers: with fake timers jumping ahead, an idle wait would time the login out.
    let started!: () => void
    const loginSeen = new Promise<void>((r) => {
      started = r
    })
    const { f, client, state } = server({
      [LOGIN]: async () => {
        started()
        await gate
        return okReply({ token: TEST_TOKEN, user_id: 'u-1' })
      },
    })
    state.accept = TEST_TOKEN
    const first = client.fetchDay(-1)
    await loginSeen
    const ctl = new AbortController()
    const second = caught(client.fetchDay(-2, { signal: ctl.signal }))
    ctl.abort()
    const err = await second
    expect(err).toMatchObject({ code: 'unreachable', op: 'stats' })
    leaksNothing(err)
    release()
    await expect(first).resolves.toMatchObject({ droppedBuckets: 0 })
    expect(f.callsTo(LOGIN)).toHaveLength(1)
  })

  test('an abort during the -12 round starts no re-login', async () => {
    const ctl = new AbortController()
    const { f, client } = server({
      [STATS.grid]: async () => {
        // A few microtasks on: the reply is out, the client has not reacted yet (any N in 1..20 works).
        void tick(10).then(() => ctl.abort())
        return statusReply(-12)
      },
    })
    const err = await caught(client.fetchDay(-1, { signal: ctl.signal }))
    expect(err).toMatchObject({ code: 'unreachable' })
    expect(f.callsTo(LOGIN)).toHaveLength(1)
    leaksNothing(err)
  })

  test('the first failing series cancels its siblings', async () => {
    let held = false
    const { f, client } = server({
      [STATS.grid]: () => new Response(null, { status: 404 }),
      [STATS.usage]: (req) =>
        new Promise<Response>((_res, rej) =>
          req.signal.addEventListener('abort', () => {
            held = req.signal.aborted
            rej(req.signal.reason)
          }),
        ),
    })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'stats', status: 404 })
    leaksNothing(err)
    expect(held).toBe(true)
    expect(f.callsTo(LOGIN)).toHaveLength(1)
    for (const n of SERIES_NAMES) expect(f.callsTo(STATS[n])).toHaveLength(1)
  })
})

describe('shared re-login', () => {
  /** Login 1 → TEST_TOKEN, login 2 → `second`; the server accepts whatever `accept.value` is. */
  function relogin(second: (n: number) => Response | Promise<Response>) {
    const accept = { value: TEST_TOKEN as string }
    const refused: SeriesName[] = []
    let logins = 0
    const stats = Object.fromEntries(
      SERIES_NAMES.map((n): [string, FakeRoute] => [
        STATS[n],
        async (req) => {
          const { token } = await openRequest(req)
          if (token?.split('_')[0] !== accept.value) {
            refused.push(n)
            return statusReply(-12)
          }
          return okReply(seriesDay(n, '2026-06-10'))
        },
      ]),
    )
    const s = server({
      [LOGIN]: () => (logins++ === 0 ? okReply({ token: TEST_TOKEN }) : second(logins)),
      ...stats,
    })
    return { ...s, accept, refused }
  }

  test('a refused re-login fails the call as auth_failed (login) and is not cached', async () => {
    let refuse = true
    const { f, client, accept } = relogin(() =>
      refuse ? statusReply(-3) : okReply({ token: TEST_TOKEN_2 }),
    )
    await client.fetchDay(-1)
    accept.value = 'gone' // the session ended; the re-login is refused
    const err = await caught(client.fetchDay(-2))
    expect(err).toMatchObject({ code: 'auth_failed', op: 'login' })
    leaksNothing(err)
    expect(f.callsTo(LOGIN)).toHaveLength(2)
    // Nothing is stuck: once the cloud accepts logins again, the next call logs in anew.
    refuse = false
    accept.value = TEST_TOKEN_2
    await expect(client.fetchDay(-3)).resolves.toMatchObject({ droppedBuckets: 0 })
    expect(f.callsTo(LOGIN)).toHaveLength(3)
  })

  test('all four -12s arrive before the one shared re-login, which they all wait on', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started!: () => void
    const loginSeen = new Promise<void>((r) => {
      started = r
    })
    let seen = -1
    const ctx: { refused: SeriesName[] } = { refused: [] }
    const { f, client, accept, refused } = relogin(async () => {
      seen = ctx.refused.length
      started()
      await gate
      return okReply({ token: TEST_TOKEN_2 })
    })
    ctx.refused = refused
    await client.fetchDay(-1)
    accept.value = TEST_TOKEN_2
    const day = client.fetchDay(-2)
    await loginSeen
    expect(seen).toBe(4)
    release()
    await expect(day).resolves.toMatchObject({ droppedBuckets: 0 })
    expect(f.callsTo(LOGIN)).toHaveLength(2)
  })
})

describe('more failures', () => {
  test('HTTP 429 on a stats route is rate_limited', async () => {
    const { client } = server({ [STATS.grid]: () => new Response('x', { status: 429 }) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'rate_limited', op: 'stats', status: 429 })
    leaksNothing(err)
  })

  test('-12 on list-bmt on a fresh token is auth_failed (discover)', async () => {
    const { client } = server({ [DEVICES]: () => statusReply(-12) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'auth_failed', op: 'discover' })
    leaksNothing(err)
  })

  test('a login Result without a token is unexpected_response', async () => {
    const { client } = server({ [LOGIN]: () => okReply({ user_id: 'u-1' }) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
    leaksNothing(err)
  })

  test('an undecodable stats Result hints that the app secret rotated', async () => {
    const { client } = server({
      [STATS.grid]: () => okReply(seriesDay('grid', '2026-06-10'), { secret: 'rotated' }),
    })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'stats' })
    expect(err.message).toContain('app id/secret may have rotated')
    leaksNothing(err)
  })
})

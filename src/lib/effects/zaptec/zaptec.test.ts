import { describe, expect, test } from 'vitest'
import { type FakeRoute, fakeFetch, jsonResponse } from '~/lib/effects/testing/fakeFetch'
import { fake } from './adapters/fake'
import { notConfigured } from './adapters/notConfigured'
import { createZaptecClient } from './client'
import { ZaptecError } from './errors'
import {
  CHARGER_ID,
  chargerJson,
  chargersBody,
  chargingStateBody,
  INSTALLATION_ID,
  sessionJson,
  sessionsPage,
  stateBody,
  TEST_CREDS,
  TEST_TOKEN,
  tokenBody,
} from './fixtures'
import { newCallStats, selectZaptecAdapter, zaptec } from './zaptec'

const T0 = Date.parse('2026-09-28T10:00:00Z')
const TOKEN = 'POST /oauth/token'
const CHARGERS = 'GET /api/chargers'
const SESSIONS = 'GET /api/sessions/archived'
const STATE = `GET /api/chargers/${CHARGER_ID}/state`

const tokenOk: FakeRoute = () => jsonResponse(tokenBody())
const chargersOk: FakeRoute = () => jsonResponse(chargersBody())

function setup(routes: Record<string, FakeRoute>) {
  let nowMs = T0
  const sleeps: number[] = []
  const ff = fakeFetch({ [TOKEN]: tokenOk, ...routes })
  const client = createZaptecClient({
    fetch: ff.fetch,
    creds: TEST_CREDS,
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5, // jitter factor exactly 1.0
  })
  return {
    client,
    ff,
    sleeps,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

async function caught(p: Promise<unknown>): Promise<ZaptecError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ZaptecError)
    return err as ZaptecError
  }
  throw new Error('expected a ZaptecError')
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('login', () => {
  test('concurrent calls share one in-flight login and send the expected requests', async () => {
    const { client, ff } = setup({
      [CHARGERS]: chargersOk,
      [STATE]: () => jsonResponse(chargingStateBody()),
    })

    await Promise.all([client.chargers(), client.chargers(), client.liveState(CHARGER_ID)])

    const tokenCalls = ff.callsTo(TOKEN)
    expect(tokenCalls).toHaveLength(1)
    const tokenReq = tokenCalls[0]
    expect(tokenReq.url).toBe('https://api.zaptec.com/oauth/token')
    expect(tokenReq.headers.get('content-type')).toContain('application/x-www-form-urlencoded')
    const form = new URLSearchParams(await tokenReq.text())
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'password',
      username: TEST_CREDS.username,
      password: TEST_CREDS.password,
      scope: 'openid',
    })
    for (const req of ff.calls) {
      expect(req.headers.get('user-agent')).toBe('videbacken/1.0 (private home dashboard)')
    }
    for (const req of ff.callsTo(CHARGERS)) {
      expect(req.url).toBe('https://api.zaptec.com/api/chargers')
      expect(req.headers.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`)
    }
  })

  test('reuses the token until expires_in − 300 s, then logs in again', async () => {
    const { client, ff, advance } = setup({ [CHARGERS]: chargersOk })

    await client.chargers()
    advance((86_400 - 300) * 1000 - 1)
    await client.chargers()
    expect(ff.callsTo(TOKEN)).toHaveLength(1)

    advance(1)
    await client.chargers()
    expect(ff.callsTo(TOKEN)).toHaveLength(2)
  })

  test('a short-lived token is refreshed halfway instead of 300 s early', async () => {
    const { client, ff, advance } = setup({
      [TOKEN]: () => jsonResponse(tokenBody({ expires_in: 300 })),
      [CHARGERS]: chargersOk,
    })

    await client.chargers()
    advance(150_000 - 1)
    await client.chargers()
    expect(ff.callsTo(TOKEN)).toHaveLength(1)

    advance(1)
    await client.chargers()
    expect(ff.callsTo(TOKEN)).toHaveLength(2)
  })

  test('a data-call 401 triggers one re-login, then succeeds', async () => {
    const { client, ff } = setup({
      [CHARGERS]: (_req, call) =>
        call === 0 ? new Response(null, { status: 401 }) : chargersOk(_req, call),
    })

    const chargers = await client.chargers()

    expect(chargers).toHaveLength(1)
    expect(ff.callsTo(TOKEN)).toHaveLength(2)
    expect(ff.callsTo(CHARGERS)).toHaveLength(2)
  })

  test('a second 401 after re-login fails auth_failed', async () => {
    const { client, ff } = setup({ [CHARGERS]: () => new Response(null, { status: 401 }) })

    const err = await caught(client.chargers())

    expect(err).toMatchObject({ code: 'auth_failed', op: 'chargers', status: 401 })
    expect(ff.callsTo(TOKEN)).toHaveLength(2)
    expect(ff.callsTo(CHARGERS)).toHaveLength(2)
  })

  test("a stale 401 doesn't discard a token another caller already refreshed", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const { client, ff } = setup({
      [TOKEN]: (_req, call) => jsonResponse(tokenBody({ access_token: `tok-${call}` })),
      [CHARGERS]: async (req, call) => {
        if (req.headers.get('authorization') === 'Bearer tok-1') return chargersOk(req, call)
        // Call 0 is the first caller, call 1 the second (it joined the login later):
        // hold the second caller's 401 until the first has refreshed the token.
        if (call === 1) await gate
        return new Response(null, { status: 401 })
      },
    })

    const first = client.chargers()
    const second = client.chargers()
    await expect(first).resolves.toHaveLength(1)
    release()
    await expect(second).resolves.toHaveLength(1)

    expect(ff.callsTo(TOKEN)).toHaveLength(2)
    expect(ff.callsTo(CHARGERS).map((r) => r.headers.get('authorization'))).toEqual([
      'Bearer tok-0',
      'Bearer tok-0',
      'Bearer tok-1',
      'Bearer tok-1',
    ])
  })

  test('token 400 → auth_failed, never retried', async () => {
    const { client, ff, sleeps } = setup({
      [TOKEN]: () => jsonResponse({ error: 'invalid_grant' }, { status: 400 }),
      [CHARGERS]: chargersOk,
    })

    const err = await caught(client.chargers())

    expect(err).toMatchObject({ code: 'auth_failed', op: 'token', status: 400 })
    expect(err.message).not.toContain('grant retired')
    expect(ff.callsTo(TOKEN)).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  test('token 401 → auth_failed', async () => {
    const { client } = setup({
      [TOKEN]: () => new Response('nope', { status: 401 }),
      [CHARGERS]: chargersOk,
    })
    expect(await caught(client.chargers())).toMatchObject({
      code: 'auth_failed',
      op: 'token',
      status: 401,
    })
  })

  test('unsupported_grant_type → auth_failed whose message says the grant was retired', async () => {
    const { client } = setup({
      [TOKEN]: () => jsonResponse({ error: 'unsupported_grant_type' }, { status: 400 }),
      [CHARGERS]: chargersOk,
    })

    const err = await caught(client.chargers())

    expect(err.code).toBe('auth_failed')
    expect(err.message).toContain('grant retired')
  })

  test('a rejected login blocks new logins for 5 min, then logs in again', async () => {
    const { client, ff, advance } = setup({
      [TOKEN]: (req, call) =>
        call === 0 ? new Response(null, { status: 401 }) : tokenOk(req, call),
      [CHARGERS]: chargersOk,
    })

    await caught(client.chargers())
    advance(300_000 - 1)
    expect(await caught(client.chargers())).toMatchObject({ code: 'auth_failed', op: 'token' })
    expect(ff.callsTo(TOKEN)).toHaveLength(1)

    advance(1)
    await expect(client.chargers()).resolves.toHaveLength(1)
    expect(ff.callsTo(TOKEN)).toHaveLength(2)
  })

  test('a transient login failure is not cached: the next call logs in again', async () => {
    const { client, ff } = setup({
      [TOKEN]: (req, call) => (call < 3 ? new Response(null, { status: 503 }) : tokenOk(req, call)),
      [CHARGERS]: chargersOk,
    })

    expect(await caught(client.chargers())).toMatchObject({ code: 'unreachable', op: 'token' })
    await expect(client.chargers()).resolves.toHaveLength(1)
    expect(ff.callsTo(TOKEN)).toHaveLength(4)
  })

  test("a caller's signal stops its wait on a shared login; other waiters still get the token", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const { client, ff } = setup({
      [TOKEN]: async (req, call) => {
        await gate
        return tokenOk(req, call)
      },
      [CHARGERS]: chargersOk,
    })
    const controller = new AbortController()

    const aborted = client.chargers({ signal: controller.signal })
    const patient = client.chargers()
    await Promise.resolve()
    controller.abort()

    expect(await caught(aborted)).toMatchObject({ code: 'unreachable', op: 'chargers' })
    release()
    await expect(patient).resolves.toHaveLength(1)
    expect(ff.callsTo(TOKEN)).toHaveLength(1)
    expect(ff.callsTo(CHARGERS)).toHaveLength(1)
  })

  test('malformed token response → unexpected_response', async () => {
    const { client } = setup({
      [TOKEN]: () => jsonResponse({ access_token: TEST_TOKEN }),
      [CHARGERS]: chargersOk,
    })
    const err = await caught(client.chargers())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'token' })
    expect(err.message).toContain('expires_in')
    expect(err.message).not.toContain(TEST_TOKEN)
  })
})

describe('status mapping and retries', () => {
  test('403 → forbidden', async () => {
    const { client } = setup({ [CHARGERS]: () => new Response(null, { status: 403 }) })
    expect(await caught(client.chargers())).toMatchObject({
      code: 'forbidden',
      op: 'chargers',
      status: 403,
    })
  })

  test('429 with Retry-After: 2 sleeps 2000 ms, then succeeds', async () => {
    const stats = newCallStats()
    const { client, sleeps } = setup({
      [CHARGERS]: (req, call) =>
        call === 0
          ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
          : chargersOk(req, call),
    })

    await expect(client.chargers({ stats })).resolves.toHaveLength(1)
    expect(sleeps).toEqual([2000])
    expect(stats.retries).toBe(1)
  })

  test('429 with Retry-After: 60 fails rate_limited without sleeping', async () => {
    const { client, ff, sleeps } = setup({
      [CHARGERS]: () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    })

    const err = await caught(client.chargers())

    expect(err).toMatchObject({ code: 'rate_limited', status: 429 })
    expect(sleeps).toEqual([])
    expect(ff.callsTo(CHARGERS)).toHaveLength(1)
  })

  test('429 without Retry-After retries with backoff, then fails rate_limited', async () => {
    const { client, sleeps } = setup({ [CHARGERS]: () => new Response(null, { status: 429 }) })
    expect(await caught(client.chargers())).toMatchObject({ code: 'rate_limited', status: 429 })
    expect(sleeps).toEqual([500, 1500])
  })

  test('503 ×3 → unreachable after two retries with 500/1500 ms backoff', async () => {
    const stats = newCallStats()
    const { client, ff, sleeps } = setup({ [CHARGERS]: () => new Response(null, { status: 503 }) })

    const err = await caught(client.chargers({ stats }))

    expect(err).toMatchObject({ code: 'unreachable', status: 503 })
    expect(stats.retries).toBe(2)
    expect(ff.callsTo(CHARGERS)).toHaveLength(3)
    expect(sleeps).toEqual([500, 1500])
  })

  test('backoff jitter stays within 0.8–1.2×', async () => {
    for (const [random, expected] of [
      [0, [400, 1200]],
      [0.999999, [600, 1800]],
    ] as const) {
      const sleeps: number[] = []
      const ff = fakeFetch({
        [TOKEN]: tokenOk,
        [CHARGERS]: () => new Response(null, { status: 502 }),
      })
      const client = createZaptecClient({
        fetch: ff.fetch,
        creds: TEST_CREDS,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        random: () => random,
      })
      await caught(client.chargers())
      expect(sleeps[0]).toBeCloseTo(expected[0], 0)
      expect(sleeps[1]).toBeCloseTo(expected[1], 0)
    }
  })

  test('500 → unreachable without retry; 404 → unexpected_response', async () => {
    const a = setup({ [CHARGERS]: () => new Response(null, { status: 500 }) })
    expect(await caught(a.client.chargers())).toMatchObject({ code: 'unreachable', status: 500 })
    expect(a.ff.callsTo(CHARGERS)).toHaveLength(1)

    const b = setup({ [CHARGERS]: () => new Response(null, { status: 404 }) })
    expect(await caught(b.client.chargers())).toMatchObject({
      code: 'unexpected_response',
      status: 404,
    })
  })

  test('token 5xx is retried; token 429 is not', async () => {
    const a = setup({
      [TOKEN]: (req, call) =>
        call === 0 ? new Response(null, { status: 503 }) : tokenOk(req, call),
      [CHARGERS]: chargersOk,
    })
    await expect(a.client.chargers()).resolves.toHaveLength(1)
    expect(a.ff.callsTo(TOKEN)).toHaveLength(2)

    const b = setup({
      [TOKEN]: () => new Response(null, { status: 429, headers: { 'Retry-After': '1' } }),
      [CHARGERS]: chargersOk,
    })
    expect(await caught(b.client.chargers())).toMatchObject({ code: 'rate_limited', op: 'token' })
    expect(b.ff.callsTo(TOKEN)).toHaveLength(1)
    expect(b.sleeps).toEqual([])
  })

  test('timeout → unreachable; every request carries an abort signal', async () => {
    const { client, ff } = setup({
      [CHARGERS]: () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      },
    })

    const err = await caught(client.chargers())

    expect(err).toMatchObject({ code: 'unreachable', op: 'chargers' })
    expect(err.cause).toEqual({ name: 'TimeoutError' })
    expect(ff.callsTo(CHARGERS)).toHaveLength(3) // network-class failures are retried
    for (const req of ff.calls) expect(req.signal).toBeInstanceOf(AbortSignal)
  })

  test('network error → unreachable; cause keeps only name/code', async () => {
    const { client } = setup({
      [CHARGERS]: () => {
        throw new TypeError(`fetch failed for ${TEST_TOKEN}`, {
          cause: { code: 'ECONNREFUSED', message: 'secret detail' },
        })
      },
    })

    const err = await caught(client.chargers())

    expect(err.code).toBe('unreachable')
    expect(err.cause).toEqual({ name: 'TypeError', code: 'ECONNREFUSED' })
  })

  test('an already-aborted caller signal fails without retrying', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client, ff, sleeps } = setup({ [CHARGERS]: chargersOk })

    const err = await caught(client.chargers({ signal: controller.signal }))

    expect(err.code).toBe('unreachable')
    expect(sleeps).toEqual([])
    expect(ff.callsTo(CHARGERS).length).toBeLessThanOrEqual(1)
  })
})

describe('chargers', () => {
  test('a multi-page chargers response fails unexpected_response instead of dropping chargers', async () => {
    const { client } = setup({
      [CHARGERS]: () => jsonResponse({ ...chargersBody(), Pages: 2 }),
    })

    const err = await caught(client.chargers())

    expect(err).toMatchObject({ code: 'unexpected_response', op: 'chargers' })
    expect(err.message).toContain('2 pages')
  })

  test('a response without Pages is read as one page', async () => {
    const { Pages: _, ...body } = chargersBody()
    const { client } = setup({ [CHARGERS]: () => jsonResponse(body) })
    await expect(client.chargers()).resolves.toHaveLength(1)
  })

  test('maps PascalCase fields to ZaptecCharger', async () => {
    const { client } = setup({
      [CHARGERS]: () =>
        jsonResponse(
          chargersBody([
            chargerJson(),
            chargerJson({ Id: 'chg-0002', Name: 'Uppfart', IsOnline: false }),
          ]),
        ),
    })

    expect(await client.chargers()).toEqual([
      { id: CHARGER_ID, name: 'Garage', installationId: INSTALLATION_ID, isOnline: true },
      { id: 'chg-0002', name: 'Uppfart', installationId: INSTALLATION_ID, isOnline: false },
    ])
  })
})

describe('sessionsEndedSince', () => {
  const since = new Date('2026-09-01T00:00:00Z')
  const until = new Date('2026-09-28T00:00:00Z')

  test('follows the cursor until hasMore is false, with the expected query params', async () => {
    const stats = newCallStats()
    const { client, ff } = setup({
      [SESSIONS]: (_req, call) =>
        jsonResponse(
          [
            sessionsPage([sessionJson({ id: 's1' }), sessionJson({ id: 's2' })], {
              cursor: 'c1',
              hasMore: true,
            }),
            sessionsPage([sessionJson({ id: 's3' })], { cursor: 'c2', hasMore: true }),
            sessionsPage([], { cursor: null, hasMore: false }),
          ][call],
        ),
    })

    const pages = await collect(
      client.sessionsEndedSince(since, { installationId: INSTALLATION_ID, until, stats }),
    )

    expect(pages.map((p) => p.map((s) => s.id))).toEqual([['s1', 's2'], ['s3'], []])
    expect(stats.pages).toBe(3)
    const queries = ff.callsTo(SESSIONS).map((r) => Object.fromEntries(new URL(r.url).searchParams))
    const base = {
      From: '2026-09-01T00:00:00.000Z',
      To: '2026-09-28T00:00:00.000Z',
      InstallationId: INSTALLATION_ID,
      PageSize: '200',
    }
    expect(queries).toEqual([base, { ...base, Cursor: 'c1' }, { ...base, Cursor: 'c2' }])
  })

  test('`until` defaults to now', async () => {
    const { client, ff } = setup({ [SESSIONS]: () => jsonResponse(sessionsPage([])) })
    await collect(client.sessionsEndedSince(since, { installationId: INSTALLATION_ID }))
    expect(new URL(ff.calls[1].url).searchParams.get('To')).toBe(new Date(T0).toISOString())
  })

  test('hasMore with a missing or repeated cursor → unexpected_response', async () => {
    const a = setup({
      [SESSIONS]: () => jsonResponse(sessionsPage([], { cursor: null, hasMore: true })),
    })
    expect(
      await caught(
        collect(a.client.sessionsEndedSince(since, { installationId: INSTALLATION_ID, until })),
      ),
    ).toMatchObject({ code: 'unexpected_response', op: 'sessions' })

    const b = setup({
      [SESSIONS]: () => jsonResponse(sessionsPage([], { cursor: 'same', hasMore: true })),
    })
    expect(
      await caught(
        collect(b.client.sessionsEndedSince(since, { installationId: INSTALLATION_ID, until })),
      ),
    ).toMatchObject({ code: 'unexpected_response', op: 'sessions' })
    expect(b.ff.callsTo(SESSIONS)).toHaveLength(2)
  })

  async function oneSession(json: Record<string, unknown>) {
    const { client } = setup({ [SESSIONS]: () => jsonResponse(sessionsPage([json])) })
    const [[session]] = await collect(
      client.sessionsEndedSince(since, { installationId: INSTALLATION_ID, until }),
    )
    return session
  }

  test('maps the session and pairs energyDetails into [start, end) intervals', async () => {
    const session = await oneSession(sessionJson())

    expect(session).toEqual({
      id: 'sess-0001',
      chargerId: CHARGER_ID,
      startAt: new Date('2026-09-27T19:30:00Z'),
      endAt: new Date('2026-09-27T22:00:00Z'),
      energyKwh: 21.5,
      intervals: [
        {
          startAt: new Date('2026-09-27T19:30:00Z'),
          endAt: new Date('2026-09-27T20:00:00Z'),
          energyKwh: 5.25,
        },
        {
          startAt: new Date('2026-09-27T20:00:00Z'),
          endAt: new Date('2026-09-27T21:00:00Z'),
          energyKwh: 10.75,
        },
        {
          startAt: new Date('2026-09-27T21:00:00Z'),
          endAt: new Date('2026-09-27T22:00:00Z'),
          energyKwh: 5.5,
        },
      ],
      authorizedUser: { email: 'owner@example.test', name: 'Test Owner' },
      tokenName: null,
      voided: false,
      replacedBySessionId: null,
      offline: false,
      reliableClock: true,
    })
    const sum = session.intervals.reduce((a, i) => a + i.energyKwh, 0)
    expect(sum).toBeCloseTo(session.energyKwh, 9)
  })

  test('parses offsets; offset-less timestamps are read as UTC', async () => {
    const session = await oneSession(
      sessionJson({
        startDateTime: '2026-09-27T21:30:00+02:00',
        endDateTime: '2026-09-27T21:00:00',
        energyDetails: [
          { timestamp: '2026-09-27T21:30:00+02:00', energy: 0 },
          { timestamp: '2026-09-27T22:00:00+02:00', energy: 1.5 },
          { timestamp: '2026-09-27T21:00:00', energy: 2.5 },
        ],
      }),
    )

    expect(session.startAt).toEqual(new Date('2026-09-27T19:30:00Z'))
    expect(session.endAt).toEqual(new Date('2026-09-27T21:00:00Z'))
    expect(session.intervals).toEqual([
      {
        startAt: new Date('2026-09-27T19:30:00Z'),
        endAt: new Date('2026-09-27T20:00:00Z'),
        energyKwh: 1.5,
      },
      {
        startAt: new Date('2026-09-27T20:00:00Z'),
        endAt: new Date('2026-09-27T21:00:00Z'),
        energyKwh: 2.5,
      },
    ])
  })

  test('sorts points, drops duplicate timestamps and clamps negative noise to 0', async () => {
    const session = await oneSession(
      sessionJson({
        energyDetails: [
          { timestamp: '2026-09-27T21:00:00Z', energy: 10.75 },
          { timestamp: '2026-09-27T19:30:00Z', energy: 0 },
          { timestamp: '2026-09-27T22:00:00Z', energy: -0.000001 },
          { timestamp: '2026-09-27T20:00:00Z', energy: 5.25 },
          { timestamp: '2026-09-27T20:00:00Z', energy: 5.25 },
        ],
      }),
    )

    expect(
      session.intervals.map((i) => [i.startAt.toISOString(), i.endAt.toISOString(), i.energyKwh]),
    ).toEqual([
      ['2026-09-27T19:30:00.000Z', '2026-09-27T20:00:00.000Z', 5.25],
      ['2026-09-27T20:00:00.000Z', '2026-09-27T21:00:00.000Z', 10.75],
      ['2026-09-27T21:00:00.000Z', '2026-09-27T22:00:00.000Z', 0],
    ])
    for (const i of session.intervals) {
      expect(i.endAt.getTime()).toBeGreaterThan(i.startAt.getTime())
      expect(i.energyKwh).toBeGreaterThanOrEqual(0)
    }
    expect(new Set(session.intervals.map((i) => i.startAt.getTime())).size).toBe(
      session.intervals.length,
    )
  })

  test('missing/empty/single-point energyDetails → no intervals; null user maps to null', async () => {
    for (const energyDetails of [null, [], [{ timestamp: '2026-09-27T19:30:00Z', energy: 0 }]]) {
      const session = await oneSession(
        sessionJson({ energyDetails, authorizedUser: null, tokenName: 'RFID-1' }),
      )
      expect(session.intervals).toEqual([])
      expect(session.authorizedUser).toBeNull()
      expect(session.tokenName).toBe('RFID-1')
    }
    const partial = await oneSession(sessionJson({ authorizedUser: { id: 'u', email: null } }))
    expect(partial.authorizedUser).toEqual({ email: null, name: null })
  })

  test('one malformed session is skipped and counted; the rest of the page imports', async () => {
    const stats = newCallStats()
    const { client } = setup({
      [SESSIONS]: () =>
        jsonResponse(
          sessionsPage([
            sessionJson({ id: 's1' }),
            sessionJson({ id: 's2', energy: null }),
            sessionJson({ id: 's3', reliableClock: undefined }),
          ]),
        ),
    })

    const pages = await collect(
      client.sessionsEndedSince(since, { installationId: INSTALLATION_ID, until, stats }),
    )

    expect(pages.flat().map((s) => s.id)).toEqual(['s1'])
    expect(stats.rejected).toBe(2)
  })

  test('a page of only one or two bad sessions is skipped, not failed', async () => {
    const stats = newCallStats()
    const { client } = setup({
      [SESSIONS]: () => jsonResponse(sessionsPage([sessionJson({ energy: null })])),
    })

    const pages = await collect(
      client.sessionsEndedSince(since, { installationId: INSTALLATION_ID, until, stats }),
    )

    expect(pages).toEqual([[]])
    expect(stats.rejected).toBe(1)
  })

  test('payload drift → unexpected_response listing field paths, never values', async () => {
    // Three sessions, all rejected: a shape change, not one odd record.
    const drifted = sessionJson({ energy: 'twelve-kWh', chargerId: undefined })
    const { client } = setup({
      [SESSIONS]: () => jsonResponse(sessionsPage([drifted, drifted, drifted])),
    })

    const err = await caught(
      collect(client.sessionsEndedSince(since, { installationId: INSTALLATION_ID, until })),
    )

    expect(err).toMatchObject({ code: 'unexpected_response', op: 'sessions' })
    expect(err.message).toContain('sessions.0.energy')
    expect(err.message).toContain('sessions.0.chargerId')
    for (const value of ['twelve-kWh', 'owner@example.test', 'Test Owner', 'OCMF']) {
      expect(err.message).not.toContain(value)
    }
  })

  test('non-JSON body → unexpected_response', async () => {
    const { client } = setup({
      [CHARGERS]: () => new Response('<html>oops</html>', { status: 200 }),
    })
    const err = await caught(client.chargers())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'chargers' })
    expect(err.message).not.toContain('oops')
  })
})

describe('liveState', () => {
  test.each([
    ['1', 'disconnected'],
    ['2', 'connected_requesting'],
    ['3', 'charging'],
    ['5', 'connected_finished'],
    ['4', 'unknown'],
    ['garbage', 'unknown'],
  ] as const)('mode %s → %s', async (value, mode) => {
    const { client } = setup({
      [STATE]: () => jsonResponse(stateBody([{ StateId: 710, ValueAsString: value }])),
    })
    const state = await client.liveState(CHARGER_ID)
    expect(state).toEqual({ mode, powerKw: null, sessionKwh: null, observedAt: new Date(T0) })
  })

  test('maps power (kW) and session kWh; a missing mode is unknown', async () => {
    const a = setup({ [STATE]: () => jsonResponse(chargingStateBody()) })
    expect(await a.client.liveState(CHARGER_ID)).toEqual({
      mode: 'charging',
      powerKw: 11.04,
      sessionKwh: 3.2,
      observedAt: new Date(T0),
    })

    const b = setup({
      [STATE]: () => jsonResponse(stateBody([{ StateId: 513, ValueAsString: null }])),
    })
    expect(await b.client.liveState(CHARGER_ID)).toMatchObject({ mode: 'unknown', powerKw: null })
  })

  test('caches successful reads for 15 s per charger', async () => {
    const { client, ff, advance } = setup({
      [STATE]: () => jsonResponse(chargingStateBody()),
      'GET /api/chargers/chg-0002/state': () => jsonResponse(chargingStateBody()),
    })

    await client.liveState(CHARGER_ID)
    advance(14_999)
    await client.liveState(CHARGER_ID)
    expect(ff.callsTo(STATE)).toHaveLength(1)

    await client.liveState('chg-0002')
    expect(ff.callsTo('GET /api/chargers/chg-0002/state')).toHaveLength(1)

    advance(1)
    await client.liveState(CHARGER_ID)
    expect(ff.callsTo(STATE)).toHaveLength(2)
  })

  // Characterization: concurrent reads aren't deduplicated today. Update this
  // if in-flight dedup is ever added on purpose.
  test('concurrent reads of one charger are not deduplicated', async () => {
    const { client, ff } = setup({ [STATE]: () => jsonResponse(chargingStateBody()) })

    await Promise.all([client.liveState(CHARGER_ID), client.liveState(CHARGER_ID)])

    expect(ff.callsTo(STATE)).toHaveLength(2)
  })

  test('a read that succeeds after a concurrent failure clears the cached failure', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const { client, ff } = setup({
      [STATE]: async (_req, call) => {
        if (call > 0) return new Response(null, { status: 503 })
        await gate
        return jsonResponse(chargingStateBody())
      },
    })

    const slow = client.liveState(CHARGER_ID)
    expect(await caught(client.liveState(CHARGER_ID))).toMatchObject({ code: 'unreachable' })
    release()
    await expect(slow).resolves.toMatchObject({ mode: 'charging' })

    // Served from the success cache, not the (now cleared) failure cache.
    await expect(client.liveState(CHARGER_ID)).resolves.toMatchObject({ mode: 'charging' })
    expect(ff.callsTo(STATE)).toHaveLength(2)
  })

  test('is never retried; an unreachable read is cached for 60 s', async () => {
    const { client, ff, sleeps, advance } = setup({
      [STATE]: (_req, call) =>
        call === 0 ? new Response(null, { status: 503 }) : jsonResponse(chargingStateBody()),
    })

    expect(await caught(client.liveState(CHARGER_ID))).toMatchObject({
      code: 'unreachable',
      op: 'state',
    })
    expect(ff.callsTo(STATE)).toHaveLength(1)
    expect(sleeps).toEqual([])

    advance(59_999)
    expect(await caught(client.liveState(CHARGER_ID))).toMatchObject({ code: 'unreachable' })
    expect(ff.callsTo(STATE)).toHaveLength(1)

    advance(1)
    await expect(client.liveState(CHARGER_ID)).resolves.toMatchObject({ mode: 'charging' })
    expect(ff.callsTo(STATE)).toHaveLength(2)
  })

  test("a read cut off by the caller's own signal is not cached", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const { client, ff } = setup({
      [STATE]: async (_req, call) => {
        if (call === 0) {
          await gate
          throw new DOMException('aborted', 'AbortError')
        }
        return jsonResponse(chargingStateBody())
      },
    })
    const controller = new AbortController()

    const read = client.liveState(CHARGER_ID, { signal: controller.signal })
    await new Promise((r) => setTimeout(r, 0))
    controller.abort(new DOMException('budget', 'TimeoutError'))
    release()
    expect(await caught(read)).toMatchObject({ code: 'unreachable', op: 'state' })

    // The next poll (no budget pressure) goes straight to Zaptec.
    await expect(client.liveState(CHARGER_ID)).resolves.toMatchObject({ mode: 'charging' })
    expect(ff.callsTo(STATE)).toHaveLength(2)
  })

  test('a login still failing after the caller gave up is cached for the next read', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const { client, ff } = setup({
      [TOKEN]: async () => {
        await gate
        return new Response(null, { status: 503 })
      },
      [STATE]: () => jsonResponse(chargingStateBody()),
    })
    const controller = new AbortController()

    const read = client.liveState(CHARGER_ID, { signal: controller.signal })
    await Promise.resolve()
    controller.abort(new DOMException('budget', 'TimeoutError'))
    expect(await caught(read)).toMatchObject({ code: 'unreachable', op: 'state' })

    // The shared login keeps going (three attempts) and then fails.
    release()
    await new Promise((r) => setTimeout(r, 0))
    const loginCalls = ff.callsTo(TOKEN).length

    // Cached: the next poll fails fast, with no new login.
    expect(await caught(client.liveState(CHARGER_ID))).toMatchObject({ code: 'unreachable' })
    expect(ff.callsTo(TOKEN)).toHaveLength(loginCalls)
    expect(ff.callsTo(STATE)).toHaveLength(0)
  })

  test('a rate-limited read is cached for 60 s', async () => {
    const { client, ff, advance } = setup({
      [STATE]: (_req, call) =>
        call === 0 ? new Response(null, { status: 429 }) : jsonResponse(chargingStateBody()),
    })

    expect(await caught(client.liveState(CHARGER_ID))).toMatchObject({ code: 'rate_limited' })
    advance(30_000)
    await caught(client.liveState(CHARGER_ID))
    expect(ff.callsTo(STATE)).toHaveLength(1)
    advance(30_000)
    await expect(client.liveState(CHARGER_ID)).resolves.toMatchObject({ mode: 'charging' })
  })

  test('after an auth failure, repeated reads make no new login for 5 min', async () => {
    const { client, ff, advance } = setup({
      [TOKEN]: (req, call) =>
        call === 0 ? new Response(null, { status: 401 }) : tokenOk(req, call),
      [STATE]: () => jsonResponse(chargingStateBody()),
    })

    expect(await caught(client.liveState(CHARGER_ID))).toMatchObject({ code: 'auth_failed' })
    for (let i = 0; i < 20; i++) {
      advance(14_999)
      await caught(client.liveState(CHARGER_ID))
    }
    advance(300_000 - 20 * 14_999 - 1)
    await caught(client.liveState(CHARGER_ID))
    expect(ff.callsTo(TOKEN)).toHaveLength(1)
    expect(ff.callsTo(STATE)).toHaveLength(0)

    advance(1)
    await expect(client.liveState(CHARGER_ID)).resolves.toMatchObject({ mode: 'charging' })
    expect(ff.callsTo(TOKEN)).toHaveLength(2)
  })

  test('a 403 read is cached for 5 min', async () => {
    const { client, ff, advance } = setup({
      [STATE]: (_req, call) =>
        call === 0 ? new Response(null, { status: 403 }) : jsonResponse(chargingStateBody()),
    })

    expect(await caught(client.liveState(CHARGER_ID))).toMatchObject({ code: 'forbidden' })
    advance(300_000 - 1)
    await caught(client.liveState(CHARGER_ID))
    expect(ff.callsTo(STATE)).toHaveLength(1)
    advance(1)
    await expect(client.liveState(CHARGER_ID)).resolves.toMatchObject({ mode: 'charging' })
  })

  test('an unexpected response is not cached', async () => {
    const { client, ff } = setup({
      [STATE]: (_req, call) =>
        call === 0 ? jsonResponse({ nope: true }) : jsonResponse(chargingStateBody()),
    })

    expect(await caught(client.liveState(CHARGER_ID))).toMatchObject({
      code: 'unexpected_response',
    })
    await expect(client.liveState(CHARGER_ID)).resolves.toMatchObject({ mode: 'charging' })
    expect(ff.callsTo(STATE)).toHaveLength(2)
  })

  test('encodes the charger id in the path', async () => {
    const { client, ff } = setup({
      'GET /api/chargers/a%2Fb/state': () => jsonResponse(chargingStateBody()),
    })
    await client.liveState('a/b')
    expect(ff.calls[1].url).toBe('https://api.zaptec.com/api/chargers/a%2Fb/state')
  })
})

describe('stats', () => {
  test('counts requests, retries and pages and times auth vs fetch', async () => {
    const stats = newCallStats()
    const { client } = setup({
      [CHARGERS]: (req, call) =>
        call === 0 ? new Response(null, { status: 502 }) : chargersOk(req, call),
      [SESSIONS]: () => jsonResponse(sessionsPage([sessionJson()])),
    })

    await client.chargers({ stats })
    await collect(
      client.sessionsEndedSince(new Date('2026-09-01T00:00:00Z'), {
        installationId: INSTALLATION_ID,
        stats,
      }),
    )

    expect(stats).toMatchObject({ requests: 4, retries: 1, pages: 1 })
    expect(stats.authMs).toBeGreaterThanOrEqual(0)
    expect(stats.fetchMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(stats.authMs + stats.fetchMs)).toBe(true)
  })
})

describe('secrets', () => {
  test('no password, username or token appears in any thrown message or cause', async () => {
    const secrets = [TEST_CREDS.password, TEST_CREDS.username, TEST_TOKEN]
    const echo = () => `${TEST_CREDS.username} ${TEST_CREDS.password} ${TEST_TOKEN}`
    const scenarios: Array<() => Promise<unknown>> = [
      () => setup({ [TOKEN]: () => new Response(echo(), { status: 400 }) }).client.chargers(),
      () =>
        setup({
          [TOKEN]: () =>
            jsonResponse({ error: 'unsupported_grant_type', detail: echo() }, { status: 400 }),
        }).client.chargers(),
      () =>
        setup({
          [TOKEN]: () => jsonResponse({ access_token: 42, expires_in: echo() }),
        }).client.chargers(),
      () => setup({ [CHARGERS]: () => new Response(echo(), { status: 401 }) }).client.chargers(),
      () => setup({ [CHARGERS]: () => new Response(echo(), { status: 200 }) }).client.chargers(),
      () =>
        setup({
          [CHARGERS]: () => {
            throw new TypeError(echo(), { cause: new Error(echo()) })
          },
        }).client.chargers(),
      () =>
        setup({ [CHARGERS]: () => jsonResponse(chargersBody([{ Id: echo() }])) }).client.chargers(),
    ]

    for (const run of scenarios) {
      const err = await caught(run())
      const surface = `${err.message} ${String(err.cause)} ${JSON.stringify(err.cause ?? null)} ${err.stack ?? ''}`
      for (const secret of secrets) expect(surface).not.toContain(secret)
    }
  })
})

describe('adapter selection', () => {
  const credsEnv = { ZAPTEC_USERNAME: 'u', ZAPTEC_PASSWORD: 'p' }

  test('notConfigured throws not_configured from every method', async () => {
    expect(await caught(notConfigured.chargers())).toMatchObject({
      code: 'not_configured',
      op: 'chargers',
    })
    expect(await caught(notConfigured.liveState(CHARGER_ID))).toMatchObject({
      code: 'not_configured',
      op: 'state',
    })
    expect(
      await caught(
        collect(notConfigured.sessionsEndedSince(new Date(), { installationId: INSTALLATION_ID })),
      ),
    ).toMatchObject({ code: 'not_configured', op: 'sessions' })
  })

  test.each([
    [{ VITEST: 'true', ZAPTEC_ADAPTER: 'fake' }, 'notConfigured'],
    [{ ZAPTEC_ADAPTER: 'fake' }, 'fake'],
    [{ ZAPTEC_ADAPTER: 'fake', NODE_ENV: 'development', VERCEL_ENV: 'preview' }, 'fake'],
    [{ ZAPTEC_ADAPTER: 'fake', VERCEL_ENV: 'production' }, 'notConfigured'],
    [{ ZAPTEC_ADAPTER: 'fake', NODE_ENV: 'production' }, 'notConfigured'],
    [{ ZAPTEC_ADAPTER: 'fake', VERCEL_ENV: 'production', ...credsEnv }, 'http'],
    [credsEnv, 'http'],
    [{ ZAPTEC_USERNAME: 'u' }, 'notConfigured'],
    [{}, 'notConfigured'],
  ] as const)('selects the adapter from env %o → %s', (env, kind) => {
    expect(selectZaptecAdapter(env)).toBe(kind)
  })

  test('under Vitest the lazily selected client is notConfigured', async () => {
    expect(await caught(zaptec.chargers())).toMatchObject({ code: 'not_configured' })
    expect(
      await caught(
        collect(zaptec.sessionsEndedSince(new Date(), { installationId: INSTALLATION_ID })),
      ),
    ).toMatchObject({ code: 'not_configured', op: 'sessions' })
  })
})

test('fake adapter yields sessions ending in [since, until) with valid intervals', async () => {
  const since = new Date('2026-09-10T00:00:00Z')
  const until = new Date('2026-09-13T00:00:00Z')
  const [sessions] = await collect(fake.sessionsEndedSince(since, { installationId: 'x', until }))

  expect(sessions).toHaveLength(3)
  for (const s of sessions) {
    expect(s.endAt.getTime()).toBeGreaterThanOrEqual(since.getTime())
    expect(s.endAt.getTime()).toBeLessThan(until.getTime())
    const sum = s.intervals.reduce((a, i) => a + i.energyKwh, 0)
    expect(sum).toBeCloseTo(s.energyKwh, 9)
    for (const i of s.intervals) expect(i.endAt.getTime()).toBeGreaterThan(i.startAt.getTime())
  }
})

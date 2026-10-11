import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch } from '../testing/fakeFetch'
import { passwordLogin, pkceChallenge, randomString } from './auth'
import { newCallStats } from './comfortCloud'
import {
  APP_CLIENT_ID,
  AUDIENCE,
  AUTH_API_USER_AGENT,
  AUTH_BASE,
  AUTH_BROWSER_USER_AGENT,
  AUTH0_CLIENT,
  REDIRECT_URI,
  SCOPE,
} from './constants'
import type { ComfortCloudError } from './errors'
import {
  authorizeRedirect,
  authRoutes,
  guardianPage,
  mfaTokenForm,
  ROUTES,
  rejectedPassword,
  resumeRedirect,
  secretsIn,
  TEST_ACCESS_TOKEN,
  TEST_AUTH0_STATE,
  TEST_CODE,
  TEST_CSRF,
  TEST_PASSWORD,
  TEST_USER,
  TEST_WRESULT,
  tokenReply,
} from './fixtures'

// ky waits on real timers: fake them, jumping straight to the next one (as emaldo.test.ts).
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

function login(overrides: Partial<Record<string, FakeRoute>> = {}) {
  const routes = authRoutes()
  for (const [key, route] of Object.entries(overrides)) if (route) routes[key] = route
  const f = fakeFetch(routes)
  const stats = newCallStats()
  const run = () =>
    passwordLogin({ fetch: f.fetch, user: TEST_USER, password: TEST_PASSWORD, stats })
  return { f, stats, run }
}
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as ComfortCloudError,
  )
const keys = (f: ReturnType<typeof fakeFetch>) =>
  f.calls.map((r) => `${r.method} ${new URL(r.url).pathname}`)

describe('PKCE helpers', () => {
  test('the S256 challenge matches upstream for a fixed verifier', () => {
    // python3 -I -c "import hashlib,base64;v='0123456789abcdefghijABCDEFGHIJklmnopqrstUVW';print(base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).split(b'=')[0].decode())"
    expect(pkceChallenge('0123456789abcdefghijABCDEFGHIJklmnopqrstUVW')).toBe(
      'uXi7Kb2X0AcU627-0OIOlA_yXr1Ii5m7cRDeVLUbxxA',
    )
  })

  test('random strings are alphanumeric, of the asked length, and differ', () => {
    const a = randomString(43)
    expect(a).toMatch(/^[A-Za-z0-9]{43}$/)
    expect(randomString(43)).not.toBe(a)
  })
})

describe('the happy path', () => {
  test('six Auth0 requests, redirects never auto-followed, the access token back', async () => {
    const { f, stats, run } = login()
    expect(await run()).toBe(TEST_ACCESS_TOKEN)
    expect(keys(f)).toEqual([
      ROUTES.authorize,
      ROUTES.loginPage,
      ROUTES.password,
      ROUTES.callback,
      ROUTES.resume,
      ROUTES.token,
    ])
    expect(f.calls.every((r) => r.redirect === 'manual')).toBe(true)
    expect(new Set(f.calls.map((r) => new URL(r.url).origin))).toEqual(new Set([AUTH_BASE]))
    expect(stats.requests).toBe(6)
  })

  test('the authorize parameters and a PKCE challenge for the verifier it exchanges', async () => {
    const { f, run } = login()
    await run()
    const authorize = f.callsTo(ROUTES.authorize)[0]
    const q = new URL(authorize.url).searchParams
    const token = (await f.callsTo(ROUTES.token)[0].clone().json()) as Record<string, string>
    expect(token.code_verifier).toMatch(/^[A-Za-z0-9]{43}$/)
    expect(q.get('code_challenge')).toBe(pkceChallenge(token.code_verifier))
    expect(q.get('state')).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(Object.fromEntries(q)).toMatchObject({
      scope: SCOPE,
      audience: AUDIENCE,
      protocol: 'oauth2',
      response_type: 'code',
      code_challenge_method: 'S256',
      auth0Client: AUTH0_CLIENT,
      client_id: APP_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    })
    expect(authorize.headers.get('user-agent')).toBe(AUTH_API_USER_AGENT)
    expect(token).toEqual({
      scope: 'openid',
      client_id: APP_CLIENT_ID,
      grant_type: 'authorization_code',
      code: TEST_CODE,
      redirect_uri: REDIRECT_URI,
      code_verifier: token.code_verifier,
    })
    expect(f.callsTo(ROUTES.token)[0].headers.get('auth0-client')).toBe(AUTH0_CLIENT)
  })

  test('carries the Auth0 cookies by path and posts the _csrf and state it was given', async () => {
    const { f, run } = login()
    await run()
    expect(f.callsTo(ROUTES.loginPage)[0].headers.get('cookie')).toContain('did=test-did')
    const post = f.callsTo(ROUTES.password)[0]
    expect(post.headers.get('cookie')).toContain(`_csrf=${TEST_CSRF}`)
    expect(post.headers.get('cookie')).toContain('auth0=test-auth0-cookie')
    expect(post.headers.get('auth0-client')).toBe(AUTH0_CLIENT)
    expect(post.headers.get('user-agent')).toBe(AUTH_API_USER_AGENT)
    expect(await post.clone().json()).toEqual({
      client_id: APP_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      tenant: 'pdpauthglb-a1',
      response_type: 'code',
      scope: SCOPE,
      audience: AUDIENCE,
      _csrf: TEST_CSRF,
      state: TEST_AUTH0_STATE,
      _intstate: 'deprecated',
      username: TEST_USER,
      password: TEST_PASSWORD,
      lang: 'en',
      connection: 'PanasonicID-Authentication',
    })
    // _csrf is scoped to /usernamepassword/login: the jar must not send it anywhere else
    expect(f.callsTo(ROUTES.callback)[0].headers.get('cookie')).not.toContain('_csrf')
  })

  test('posts the hidden callback form decoded, then follows its redirect with the updated cookie', async () => {
    const { f, run } = login()
    await run()
    const cb = f.callsTo(ROUTES.callback)[0]
    expect(cb.headers.get('content-type')).toContain('application/x-www-form-urlencoded')
    expect(cb.headers.get('user-agent')).toBe(AUTH_BROWSER_USER_AGENT)
    expect(Object.fromEntries(new URLSearchParams(await cb.clone().text()))).toEqual({
      wa: 'wsignin1.0',
      wresult: `${TEST_WRESULT}&sig`,
      wctx: `{"strategy":"auth0","state":"${TEST_AUTH0_STATE}"}`,
    })
    const resume = f.callsTo(ROUTES.resume)[0]
    expect(new URL(resume.url).searchParams.get('state')).toBe(TEST_AUTH0_STATE)
    expect(resume.headers.get('cookie')).toContain('auth0=test-auth0-callback')
  })

  test('an authorize redirect straight to the app with a code skips to the token exchange', async () => {
    const { f, run } = login({
      [ROUTES.authorize]: () => authorizeRedirect(`${REDIRECT_URI}?code=${TEST_CODE}&state=s`),
    })
    expect(await run()).toBe(TEST_ACCESS_TOKEN)
    expect(keys(f)).toEqual([ROUTES.authorize, ROUTES.token])
  })
})

describe('refusals', () => {
  test.each([
    400, 401,
  ])('a rejected password (%i) is auth_failed naming user and password', async (status) => {
    const { f, run } = login({ [ROUTES.password]: () => rejectedPassword(status) })
    const err = await caught(run())
    expect(err).toMatchObject({
      name: 'ComfortCloudError',
      code: 'auth_failed',
      op: 'login',
      status,
      message: 'Comfort Cloud rejected the user name or password',
      suspectFields: ['user', 'password'],
    })
    expect(f.callsTo(ROUTES.callback)).toHaveLength(0)
    expect(secretsIn(err)).toEqual([])
  })

  test.each([
    ['an mfa_token input', mfaTokenForm],
    ['an Auth0 Guardian config', guardianPage],
  ])('%s means MFA is demanded: auth_failed, no callback', async (_label, page) => {
    const { f, run } = login({ [ROUTES.password]: () => page() })
    const err = await caught(run())
    expect(err).toMatchObject({ code: 'auth_failed', op: 'login' })
    expect(err.message).toContain('2FA')
    expect(err.suspectFields).toBeUndefined()
    expect(f.callsTo(ROUTES.callback)).toHaveLength(0)
    expect(secretsIn(err)).toEqual([])
  })

  test('a step-up MFA page behind a code-less final redirect is auth_failed', async () => {
    const { f, run } = login({
      [ROUTES.resume]: () => resumeRedirect(`/u/mfa-otp-challenge?state=${TEST_AUTH0_STATE}`),
      'GET /u/mfa-otp-challenge': () => mfaTokenForm(),
    })
    const err = await caught(run())
    expect(err).toMatchObject({ code: 'auth_failed', op: 'login' })
    expect(err.message).toContain('2FA')
    expect(f.callsTo(ROUTES.token)).toHaveLength(0)
  })
})

describe('unexpected answers', () => {
  const unexpected = async (overrides: Partial<Record<string, FakeRoute>>) => {
    const { f, run } = login(overrides)
    const err = await caught(run())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
    expect(secretsIn(err)).toEqual([])
    return { f, err }
  }

  test('the final redirect reaches the app without a code', async () => {
    await unexpected({
      [ROUTES.resume]: () => resumeRedirect(`${REDIRECT_URI}?error=access_denied&state=s`),
    })
  })

  test('a code-less final redirect to a page without MFA', async () => {
    await unexpected({
      [ROUTES.resume]: () => resumeRedirect('/u/something-else'),
      'GET /u/something-else': () => new Response('<html><body>Hi</body></html>'),
    })
  })

  test('a redirect off the Panasonic login host is refused, not followed', async () => {
    const { f } = await unexpected({
      [ROUTES.authorize]: () => authorizeRedirect('https://evil.example.test/login?state=s'),
    })
    expect(keys(f)).toEqual([ROUTES.authorize])
  })

  test('a login page without the _csrf cookie', async () => {
    const { f } = await unexpected({ [ROUTES.loginPage]: () => new Response('<html></html>') })
    expect(f.callsTo(ROUTES.password)).toHaveLength(0)
  })

  test('a login redirect without a state', async () => {
    await unexpected({ [ROUTES.authorize]: () => authorizeRedirect('/login?client=x') })
  })

  test('a password answer without the callback form', async () => {
    await unexpected({ [ROUTES.password]: () => new Response('<html><body>Welcome</body></html>') })
  })

  test('authorize answering 200 instead of 302', async () => {
    const { err } = await unexpected({ [ROUTES.authorize]: () => new Response('ok') })
    expect(err.status).toBe(200)
  })

  test('a token answer that is not JSON, or has no access_token', async () => {
    await unexpected({ [ROUTES.token]: () => new Response('<html>no</html>') })
    await unexpected({ [ROUTES.token]: () => tokenReply('').clone() })
  })

  test('a refused code exchange', async () => {
    const { err } = await unexpected({ [ROUTES.token]: () => new Response('{}', { status: 400 }) })
    expect(err.status).toBe(400)
  })
})

describe('statuses and the network', () => {
  test('403 is forbidden and 429 rate_limited', async () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [429, 'rate_limited'],
    ] as const) {
      const { run } = login({
        [ROUTES.password]: () => new Response(`nope ${TEST_USER}`, { status }),
      })
      const err = await caught(run())
      expect(err).toMatchObject({
        code,
        op: 'login',
        status,
        message: `Comfort Cloud login failed: ${code} (HTTP ${status})`,
      })
    }
  })

  test('503 is retried once, then unreachable', async () => {
    const { f, run } = login({ [ROUTES.authorize]: () => new Response(null, { status: 503 }) })
    expect(await caught(run())).toMatchObject({ code: 'unreachable', op: 'login', status: 503 })
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
  })

  test('a network failure is unreachable, carrying only the error name and code', async () => {
    const { run } = login({
      [ROUTES.password]: () => {
        throw Object.assign(new TypeError(`fetch failed for ${TEST_USER}:${TEST_PASSWORD}`), {
          cause: { code: 'ECONNRESET' },
        })
      },
    })
    const err = await caught(run())
    expect(err).toMatchObject({ code: 'unreachable', op: 'login' })
    expect(err.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
    expect(secretsIn(err)).toEqual([])
  })
})

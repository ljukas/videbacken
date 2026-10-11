import { createHash, randomInt } from 'node:crypto'
import { CookieJar } from 'tough-cookie'
import { discard } from '../http'
import type { ComfortCloudCallStats } from './comfortCloud'
import {
  APP_CLIENT_ID,
  AUDIENCE,
  AUTH_API_USER_AGENT,
  AUTH_BASE,
  AUTH_BROWSER_USER_AGENT,
  AUTH0_CLIENT,
  AUTH0_CONNECTION,
  AUTH0_TENANT,
  REDIRECT_URI,
  SCOPE,
} from './constants'
import { ComfortCloudError } from './errors'
import { hasGuardianConfig, hiddenInputs } from './html'
import { parseJson, parseToken } from './parse'
import { send, statusError } from './request'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Upstream's `generate_random_string` (letters + digits), from a CSPRNG. */
export function randomString(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/** PKCE S256: base64url(SHA-256(verifier)), no padding (upstream's urlsafe_b64encode split on '='). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url')
}

export type LoginDeps = {
  fetch: typeof globalThis.fetch
  user: string
  password: string
  stats: ComfortCloudCallStats
}

const unexpected = (message: string) =>
  new ComfortCloudError('unexpected_response', 'login', undefined, { message })

const rejected = (status: number) =>
  new ComfortCloudError('auth_failed', 'login', status, {
    message: 'Comfort Cloud rejected the user name or password',
    suspectFields: ['user', 'password'],
  })

const mfaDemanded = () =>
  new ComfortCloudError('auth_failed', 'login', undefined, {
    message:
      'Comfort Cloud demands a 2FA code for this account; the sync logs in with the password only',
  })

/** `location` resolved against the Auth0 host; any other origin is refused (never sent the jar). */
function onAuthHost(location: string): URL {
  let url: URL
  try {
    url = new URL(location, AUTH_BASE)
  } catch {
    throw unexpected('Comfort Cloud login redirect is not a URL')
  }
  if (url.origin !== AUTH_BASE)
    throw unexpected('Comfort Cloud login redirected off the Panasonic login host')
  return url
}

/** The `code` query parameter of a redirect target, or null. */
function codeOf(location: string): string | null {
  try {
    return new URL(location, AUTH_BASE).searchParams.get('code')
  } catch {
    return null
  }
}

/** A 302's Location (the body released); any other status is `statusError`. */
async function redirectTarget(res: Response): Promise<string> {
  if (res.status !== 302) throw await statusError('login', res)
  const location = res.headers.get('location')
  await discard(res)
  if (!location) throw unexpected('Comfort Cloud login redirect has no Location')
  return location
}

/** A page's HTML when it answered 200, else '' (the body released). */
async function pageHtml(res: Response): Promise<string> {
  if (res.status === 200) return res.text()
  await discard(res)
  return ''
}

const demandsMfa = (html: string) => hiddenInputs(html).has('mfa_token') || hasGuardianConfig(html)

/**
 * Steps 1–4 of the spec's login, a port of upstream 2026.8.9 `PanasonicAuthentication.authenticate`
 * (password path only): PKCE authorize → the Auth0 password form → its WS-Fed callback → the code
 * exchange. Returns the access token. A fresh cookie jar per login (upstream clears the domain
 * first). Never logs; the password and every token stay out of errors.
 */
export async function passwordLogin(d: LoginDeps): Promise<string> {
  const jar = new CookieJar()

  /** One request to the Auth0 host with the jar's cookies; its Set-Cookie goes back into the jar. */
  async function auth(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    const cookie = await jar.getCookieString(url.href)
    if (cookie) headers.set('cookie', cookie)
    const res = await send(d.fetch, 'login', url.href, { ...init, headers }, { stats: d.stats })
    for (const setCookie of res.headers.getSetCookie()) {
      await jar.setCookie(setCookie, url.href, { ignoreError: true })
    }
    return res
  }
  const browserGet = (url: URL) => auth(url, { headers: { 'user-agent': AUTH_BROWSER_USER_AGENT } })

  /** Steps 2–3: the password form, its callback and the resumed authorize → the code. */
  async function passwordForm(loginLocation: string): Promise<string> {
    const loginUrl = onAuthHost(loginLocation)
    const state = loginUrl.searchParams.get('state')
    if (!state) throw unexpected('Comfort Cloud login redirect carries no state')
    const page = await browserGet(loginUrl)
    if (page.status !== 200) throw await statusError('login', page)

    const passwordUrl = new URL('/usernamepassword/login', AUTH_BASE)
    const csrf = (await jar.getCookies(passwordUrl.href)).find((c) => c.key === '_csrf')?.value
    if (!csrf) throw unexpected('Comfort Cloud login page set no _csrf cookie')
    const answer = await auth(passwordUrl, {
      method: 'POST',
      headers: {
        'auth0-client': AUTH0_CLIENT,
        'user-agent': AUTH_API_USER_AGENT,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: APP_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        tenant: AUTH0_TENANT,
        response_type: 'code',
        scope: SCOPE,
        audience: AUDIENCE,
        _csrf: csrf,
        state,
        _intstate: 'deprecated',
        username: d.user,
        password: d.password,
        lang: 'en',
        connection: AUTH0_CONNECTION,
      }),
    })
    if (answer.status === 400 || answer.status === 401) {
      await discard(answer)
      throw rejected(answer.status)
    }
    if (answer.status !== 200) throw await statusError('login', answer)
    const html = await answer.text()
    if (demandsMfa(html)) throw mfaDemanded()
    const fields = hiddenInputs(html)
    if (!fields.has('wa') || !fields.has('wresult') || !fields.has('wctx')) {
      throw unexpected('Comfort Cloud login answer has no callback form')
    }

    const callback = await auth(new URL('/login/callback', AUTH_BASE), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': AUTH_BROWSER_USER_AGENT,
      },
      body: new URLSearchParams([...fields]),
    })
    const resumed = await browserGet(onAuthHost(await redirectTarget(callback)))
    const final = await redirectTarget(resumed)
    const code = codeOf(final)
    if (code) return code
    if (final.startsWith(REDIRECT_URI)) {
      throw unexpected('Comfort Cloud login ended at the app without an authorization code')
    }
    // Upstream: some Auth0 setups surface a step-up MFA page only here.
    if (demandsMfa(await pageHtml(await browserGet(onAuthHost(final))))) throw mfaDemanded()
    throw unexpected('Comfort Cloud login did not produce an authorization code')
  }

  // Step 1: authorize with a PKCE challenge.
  const verifier = randomString(43)
  const authorize = new URL('/authorize', AUTH_BASE)
  const params = {
    scope: SCOPE,
    audience: AUDIENCE,
    protocol: 'oauth2',
    response_type: 'code',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    auth0Client: AUTH0_CLIENT,
    client_id: APP_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: randomString(20),
  }
  for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value)
  const location = await redirectTarget(
    await auth(authorize, { headers: { 'user-agent': AUTH_API_USER_AGENT } }),
  )

  // Auth0 may already know the session and send the app its code straight away.
  let code: string
  if (location.startsWith(REDIRECT_URI)) {
    const direct = codeOf(location)
    if (!direct)
      throw unexpected('Comfort Cloud authorize reached the app without an authorization code')
    code = direct
  } else {
    code = await passwordForm(location)
  }

  // Step 4: the code exchange.
  const tokenRes = await auth(new URL('/oauth/token', AUTH_BASE), {
    method: 'POST',
    headers: {
      'auth0-client': AUTH0_CLIENT,
      'user-agent': AUTH_API_USER_AGENT,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      scope: 'openid',
      client_id: APP_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })
  if (tokenRes.status !== 200) throw await statusError('login', tokenRes)
  return parseToken(parseJson('login', await tokenRes.text()))
}

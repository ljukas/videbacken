import { isUtcDay, isUtcMonth } from '~/lib/time/utc'
import { discard, networkCause } from '../http'
import { passwordLogin } from './auth'
import {
  type ComfortCloudCallOpts,
  type ComfortCloudCallStats,
  type ComfortCloudClient,
  newCallStats,
} from './comfortCloud'
import {
  ACC_BASE,
  AUTH_BROWSER_USER_AGENT,
  DATA_MODE_DAY,
  DATA_MODE_MONTH,
  OS_TIMEZONE,
  PINNED_APP_VERSION,
  PLAY_STORE_URL,
  PLAY_STORE_VERSION_RE,
} from './constants'
import { ComfortCloudError, type ComfortCloudOp } from './errors'
import { apiHeaders } from './headers'
import { parseAccLogin, parseDayHistory, parseJson, parseMonthHistory, parseUnits } from './parse'
import { errorForStatus, type SendOpts, send } from './request'

/** The token lasts 24 h; log in again an hour early (spec). The refresh token is never used. */
const TOKEN_MAX_AGE_MS = 23 * 3_600_000
/** A refused login blocks new attempts this long: a wrong password must not trip Auth0's lockout. */
const AUTH_FAILURE_TTL_MS = 5 * 60_000
const MAX_GUID_LENGTH = 128

type Session = { token: string; clientId: string; issuedAt: number }
type Auth = { token: string; clientId?: string }
/** An API answer with its body read ('' for a body-less copy after exhausted retries). */
type Answer = { status: number; text: string }

/** The JSON `code` field only: a timestamp or id containing the digits is not the code. */
const OUTDATED_CODE_RE = /"code"\s*:\s*"?4106"?(?!\d)/
const TERMS_CODE_RE = /"code"\s*:\s*"?4103"?(?!\d)/

/** 401 whose body names 4106: a newer app version is published (upstream's helpers.py). */
const isOutdatedApp = (a: Answer) => a.status === 401 && OUTDATED_CODE_RE.test(a.text)
/** 4103: updated terms wait for acceptance in the app (upstream's AgreementNotAcceptedError). */
const isTermsPending = (a: Answer) => TERMS_CODE_RE.test(a.text)

/**
 * Real Comfort Cloud client (ADR-0027). Logs in lazily with the password (`passwordLogin`, then
 * the `/auth/v2/login` session), keeps the token only in this closure, and shares one in-flight
 * login among concurrent callers. Never logs.
 */
export function createComfortCloudClient(deps: {
  fetch: typeof globalThis.fetch
  user: string
  password: string
  now?: () => Date
}): ComfortCloudClient {
  const now = deps.now ?? (() => new Date())
  let session: Session | null = null
  let pending: Promise<Session> | null = null
  let appVersion = PINNED_APP_VERSION
  let loginBlock: { error: ComfortCloudError; until: number } | null = null

  async function call(
    op: ComfortCloudOp,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    auth: Auth,
    o: SendOpts,
  ): Promise<Answer> {
    const res = await send(
      deps.fetch,
      op,
      `${ACC_BASE}${path}`,
      {
        method,
        headers: apiHeaders({ now: now(), token: auth.token, clientId: auth.clientId, appVersion }),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      o,
    )
    try {
      return { status: res.status, text: await res.text() }
    } catch (err) {
      throw new ComfortCloudError('unreachable', op, res.status, {
        cause: networkCause(err),
        message: `Comfort Cloud ${op} answer was cut off`,
      })
    }
  }

  async function refreshAppVersion(op: ComfortCloudOp, stats: ComfortCloudCallStats) {
    const failed = new ComfortCloudError('unexpected_response', op, undefined, {
      message: 'Comfort Cloud wants a newer app version and the Play Store lookup failed',
    })
    let res: Response
    try {
      res = await send(
        deps.fetch,
        op,
        PLAY_STORE_URL,
        { headers: { 'user-agent': AUTH_BROWSER_USER_AGENT } },
        { stats, redirect: 'follow' },
      )
    } catch {
      throw failed
    }
    if (!res.ok) {
      await discard(res)
      throw failed
    }
    const match = PLAY_STORE_VERSION_RE.exec(await res.text())
    if (!match) throw failed
    appVersion = match[1]
  }

  /** One API call; on 401 + 4106 the app version is looked up once and the call retried once. */
  async function apiCall(
    op: ComfortCloudOp,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    auth: Auth,
    o: SendOpts,
  ): Promise<Answer> {
    const answer = await call(op, method, path, body, auth, o)
    if (!isOutdatedApp(answer)) return answer
    await refreshAppVersion(op, o.stats)
    const retried = await call(op, method, path, body, auth, o)
    if (isOutdatedApp(retried)) {
      throw new ComfortCloudError('unexpected_response', op, 401, {
        message: `Comfort Cloud still asks for a newer app version after the lookup (${appVersion})`,
      })
    }
    return retried
  }

  /** A non-200 answer as an error; the body is only searched for codes, never quoted. */
  function answerError(op: ComfortCloudOp, a: Answer): ComfortCloudError {
    if (isTermsPending(a)) {
      return new ComfortCloudError('unexpected_response', op, a.status, {
        message: 'Comfort Cloud asks to accept updated terms in the app (code 4103)',
      })
    }
    if (a.status === 401) {
      return new ComfortCloudError('auth_failed', op, 401, {
        message: `Comfort Cloud refused the token on ${op}`,
      })
    }
    return errorForStatus(op, a.status)
  }

  async function logIn(stats: ComfortCloudCallStats): Promise<Session> {
    if (loginBlock !== null && now().getTime() < loginBlock.until) throw loginBlock.error
    stats.logins++
    try {
      const issuedAt = now().getTime()
      const token = await passwordLogin({
        fetch: deps.fetch,
        user: deps.user,
        password: deps.password,
        stats,
      })
      const answer = await apiCall(
        'login',
        'POST',
        '/auth/v2/login',
        { language: 0 },
        { token },
        { stats },
      )
      if (answer.status !== 200) throw answerError('login', answer)
      const clientId = parseAccLogin(parseJson('login', answer.text))
      loginBlock = null
      return { token, clientId, issuedAt }
    } catch (err) {
      // A throttled Auth0 must not be hit with the password again either.
      if (
        err instanceof ComfortCloudError &&
        (err.code === 'auth_failed' || err.code === 'rate_limited')
      ) {
        loginBlock = { error: err, until: now().getTime() + AUTH_FAILURE_TTL_MS }
      }
      throw err
    }
  }

  /**
   * The live session, or the shared login. A session that is `stale` (the caller saw it refused)
   * or 23 h old is dropped first; one that another caller already replaced is reused. `fresh`:
   * this call started or joined the login that issued the session (not read from the cache).
   */
  async function sessionFor(
    stats: ComfortCloudCallStats,
    stale?: Session,
  ): Promise<{ session: Session; fresh: boolean }> {
    if (
      session !== null &&
      (session === stale || now().getTime() - session.issuedAt >= TOKEN_MAX_AGE_MS)
    ) {
      session = null
    }
    if (session !== null) return { session, fresh: false }
    if (pending === null) {
      const shared = logIn(stats)
        .then((s) => {
          session = s
          return s
        })
        .finally(() => {
          pending = null
        })
      // Every waiter may have gone: the shared rejection must never go unhandled.
      shared.catch(() => {})
      pending = shared
    }
    return { session: await pending, fresh: true }
  }

  /**
   * An authenticated call: on a 401 that isn't 4106 or 4103, one fresh login and one retry, unless
   * the token was issued during this very call: that one is refused outright (no second login).
   */
  async function authed(
    op: ComfortCloudOp,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    o: ComfortCloudCallOpts = {},
  ): Promise<unknown> {
    if (o.signal?.aborted) {
      throw new ComfortCloudError('unreachable', op, undefined, {
        cause: networkCause(o.signal.reason),
        message: `Comfort Cloud ${op} call was cut off before it started`,
      })
    }
    const sendOpts: SendOpts = { stats: o.stats ?? newCallStats(), signal: o.signal }
    let { session: s, fresh } = await sessionFor(sendOpts.stats)
    let answer = await apiCall(op, method, path, body, s, sendOpts)
    if (answer.status === 401 && !isTermsPending(answer)) {
      if (!fresh) {
        s = (await sessionFor(sendOpts.stats, s)).session
        answer = await apiCall(op, method, path, body, s, sendOpts)
      }
      if (answer.status === 401 && !isTermsPending(answer)) {
        const refused = new ComfortCloudError('auth_failed', op, 401, {
          message: `Comfort Cloud refused the ${op} call right after a fresh login`,
        })
        // Only the session this call was refused on; another caller may hold a newer one.
        if (session === s) session = null
        // Later callers get a login error, not this call's op.
        loginBlock = {
          error: new ComfortCloudError('auth_failed', 'login', 401, {
            message: 'Comfort Cloud refused a fresh token',
          }),
          until: now().getTime() + AUTH_FAILURE_TTL_MS,
        }
        throw refused
      }
    }
    if (answer.status !== 200) throw answerError(op, answer)
    return parseJson(op, answer.text)
  }

  function checkGuid(guid: string) {
    if (guid.length === 0 || guid.length > MAX_GUID_LENGTH) {
      throw new RangeError(`Comfort Cloud device guid must be 1–${MAX_GUID_LENGTH} characters`)
    }
  }

  return {
    async units(o) {
      return parseUnits(await authed('units', 'GET', '/device/group', undefined, o))
    },

    async dayHours(guid, utcDay, o) {
      checkGuid(guid)
      if (!isUtcDay(utcDay))
        throw new RangeError(`Comfort Cloud day must be a YYYY-MM-DD UTC day, got ${utcDay}`)
      const body = {
        deviceGuid: guid,
        dataMode: DATA_MODE_DAY,
        date: utcDay.replaceAll('-', ''),
        osTimezone: OS_TIMEZONE,
      }
      return parseDayHistory(utcDay, await authed('history', 'POST', '/deviceHistoryData', body, o))
    },

    async monthDays(guid, utcMonth, o) {
      checkGuid(guid)
      if (!isUtcMonth(utcMonth))
        throw new RangeError(`Comfort Cloud month must be YYYY-MM, got ${utcMonth}`)
      const body = {
        deviceGuid: guid,
        dataMode: DATA_MODE_MONTH,
        date: `${utcMonth.replace('-', '')}01`,
        osTimezone: OS_TIMEZONE,
      }
      return parseMonthHistory(
        utcMonth,
        await authed('history', 'POST', '/deviceHistoryData', body, o),
      )
    },
  }
}

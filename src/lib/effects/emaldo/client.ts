import { discard, fetchWithRetry, networkCause } from '../http'
import {
  type CallOpts,
  type EmaldoCallStats,
  type EmaldoClient,
  type EmaldoDay,
  newCallStats,
} from './emaldo'
import { EmaldoError, type EmaldoOp } from './errors'
import {
  buildDay,
  parseDevices,
  parseEnvelope,
  parseHomeIds,
  parseLogin,
  parseSeries,
  SERIES_NAMES,
  type SeriesDay,
  type SeriesName,
} from './parse'
import { type Decoded, decodeResult, encodeBody, encodeToken, gmtimeOf } from './wire'

const API_HOST = 'api.emaldo.com'
/** `/bmt/stats/*` is served by the data-plane host. */
const STATS_HOST = 'dp.emaldo.com'
const STATS_PREFIX = '/bmt/stats/'
/** The phone app's HTTP stack; the API sees nothing else from it. */
const USER_AGENT = 'okhttp/4.9.0'
const TIMEOUT_MS = 10_000
const RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const RETRY_LIMIT = 1
const STATUS_OK = 1
const STATUS_SESSION_EXPIRED = -12
/** Homes checked for a battery during discovery. */
const MAX_HOMES_CHECKED = 10

const SERIES_REQUEST: Record<SeriesName, { path: string; extra: Record<string, unknown> }> = {
  grid: { path: '/bmt/stats/grid/day/', extra: { get_real: true, query_interval: 5 } },
  mppt: { path: '/bmt/stats/mppt-v2/day/', extra: {} },
  usage: { path: '/bmt/stats/load/usage-v2/day/', extra: {} },
  battery: { path: '/bmt/stats/battery-v2/day/', extra: {} },
}

type Device = { homeId: string; deviceId: string; model: string }
type Session = { token: string; device: Device }
type Reply = { expired: true } | { expired: false; result: unknown }

/**
 * Real Emaldo cloud client (ADR-0023). Logs in lazily, caches the token and
 * the discovered home/device for this instance, and re-logs in once per
 * request on Status -12. A login ends the account's other sessions, so
 * concurrent callers share one in-flight login. Never logs.
 */
export function createEmaldoClient(deps: {
  fetch: typeof globalThis.fetch
  user: string
  password: string
  appId: string
  appSecret: string
}): EmaldoClient {
  const secret = new TextEncoder().encode(deps.appSecret)
  let token: string | null = null
  let device: Device | null = null
  let pending: Promise<Session> | null = null

  /** One encrypted POST. Returns the decoded Result, or `expired` on Status -12. */
  async function post(
    op: EmaldoOp,
    path: string,
    fields: { json?: Record<string, unknown>; token?: string },
    signal: AbortSignal | undefined,
    stats: EmaldoCallStats,
  ): Promise<Reply> {
    const host = path.startsWith(STATS_PREFIX) ? STATS_HOST : API_HOST
    const gmtime = gmtimeOf(Date.now())
    const form = new URLSearchParams()
    if (fields.json) form.set('json', encodeBody(secret, fields.json, gmtime))
    if (fields.token !== undefined) form.set('token', encodeToken(secret, fields.token, gmtime))
    form.set('gm', '1')
    let res: Response
    try {
      res = await fetchWithRetry(
        `https://${host}${path}${encodeURIComponent(deps.appId)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            'X-Online-Host': host,
          },
          body: form,
          redirect: 'error',
        },
        {
          fetch: deps.fetch,
          timeoutMs: TIMEOUT_MS,
          retryStatuses: RETRY_STATUSES,
          retryLimit: RETRY_LIMIT,
          signal,
          stats,
          onTiming: (ms) => {
            stats.fetchMs += ms
          },
        },
      )
    } catch (err) {
      // ky's errors can carry the URL (with the app id): keep only name + code.
      throw new EmaldoError('unreachable', op, undefined, {
        cause: networkCause(err),
        message: `Emaldo ${op} request failed or was cut off`,
      })
    }
    if (!res.ok) {
      await discard(res)
      throw statusError(op, res.status)
    }
    let body: unknown
    try {
      body = JSON.parse(await res.text())
    } catch {
      throw new EmaldoError('unexpected_response', op, res.status, {
        message: `Emaldo ${op} response is not valid JSON (HTTP ${res.status})`,
      })
    }
    // ErrorMessage is never read: it can echo the account.
    const envelope = parseEnvelope(op, body)
    if (envelope.Status === STATUS_SESSION_EXPIRED) return { expired: true }
    if (envelope.Status !== STATUS_OK) throw refused(op, envelope.Status)
    const decoded: Decoded =
      typeof envelope.Result === 'string' ? decodeResult(secret, envelope.Result) : { ok: false }
    if (!decoded.ok) {
      throw new EmaldoError('unexpected_response', op, undefined, {
        message: `Emaldo ${op} result could not be decoded; the app id/secret may have rotated`,
      })
    }
    return { expired: false, result: decoded.value }
  }

  /**
   * A reply during discovery. On a token this establish just issued, -12 means
   * the login itself is not accepted; on a cached one it means the session
   * ended since a failed discovery, so the caller logs in again.
   */
  function fresh(op: EmaldoOp, reply: Reply, justIssued: boolean): unknown {
    if (reply.expired) {
      if (!justIssued) throw new StaleSession()
      throw new EmaldoError('auth_failed', op, undefined, {
        message: `Emaldo ${op} was refused right after a fresh login`,
      })
    }
    return reply.result
  }

  async function logIn(stats: EmaldoCallStats): Promise<string> {
    stats.logins++
    const reply = await post(
      'login',
      '/user/login/',
      { json: { email: deps.user, password: deps.password } },
      undefined,
      stats,
    )
    if (reply.expired) throw refused('login', STATUS_SESSION_EXPIRED)
    return parseLogin(reply.result)
  }

  /** The first home that has a battery — never just the first home. */
  async function discover(
    current: string,
    stats: EmaldoCallStats,
    justIssued: boolean,
  ): Promise<Device> {
    const homes = parseHomeIds(
      fresh(
        'discover',
        await post('discover', '/home/list-homes/', { token: current }, undefined, stats),
        justIssued,
      ),
    )
    for (const homeId of homes.slice(0, MAX_HOMES_CHECKED)) {
      const json = { home_id: homeId, models: [], page_size: 30, addtime: 1, order: 'asc' }
      const [found] = parseDevices(
        fresh(
          'discover',
          await post('discover', '/bmt/list-bmt/', { json, token: current }, undefined, stats),
          justIssued,
        ),
      )
      if (found) return { homeId, ...found }
    }
    throw new EmaldoError('unexpected_response', 'discover', undefined, {
      message: 'No Emaldo home on this account has a battery device',
    })
  }

  async function establish(stats: EmaldoCallStats): Promise<Session> {
    let justIssued = false
    if (token === null) {
      token = await logIn(stats)
      justIssued = true
    }
    if (device === null) {
      try {
        device = await discover(token, stats, justIssued)
      } catch (err) {
        if (!(err instanceof StaleSession)) throw err
        // The token outlived its session while discovery was failing: one fresh login.
        token = null
        token = await logIn(stats)
        device = await discover(token, stats, true)
      }
    }
    return { token, device }
  }

  /**
   * The cached session, or the shared in-flight login (+ discovery). With
   * `expired`, a session still on that token is replaced — once, however
   * many callers saw it expire. A caller's signal only stops its own wait;
   * the shared login runs on under its own timeouts.
   */
  function session(stats: EmaldoCallStats, signal?: AbortSignal, expired?: string) {
    if (token !== null && device !== null && token !== expired) {
      return Promise.resolve({ token, device })
    }
    if (pending === null) {
      if (token === expired) token = null
      const shared = establish(stats).finally(() => {
        pending = null
      })
      // Every waiter may have aborted: the shared rejection must never go unhandled.
      shared.catch(() => {})
      pending = shared
    }
    return signal ? abortable(pending, signal) : pending
  }

  /** An authenticated stats call with one re-login on Status -12. */
  async function stats(
    path: string,
    body: (d: Device) => Record<string, unknown>,
    o: { signal?: AbortSignal; stats: EmaldoCallStats },
  ): Promise<unknown> {
    let s = await session(o.stats, o.signal)
    let reply = await post(
      'stats',
      path,
      { json: body(s.device), token: s.token },
      o.signal,
      o.stats,
    )
    if (reply.expired) {
      s = await session(o.stats, o.signal, s.token)
      reply = await post('stats', path, { json: body(s.device), token: s.token }, o.signal, o.stats)
      if (reply.expired) {
        throw new EmaldoError('auth_failed', 'stats', undefined, {
          message: 'Emaldo session expired again right after a fresh login',
        })
      }
    }
    return reply.result
  }

  return {
    async fetchDay(offset: number, o: CallOpts = {}): Promise<EmaldoDay> {
      if (!Number.isInteger(offset) || offset > 0) {
        throw new RangeError(`Emaldo day offset must be an integer ≤ 0, got ${offset}`)
      }
      if (o.signal?.aborted) {
        throw new EmaldoError('unreachable', 'stats', undefined, {
          cause: networkCause(o.signal.reason),
          message: 'Emaldo call was cut off before it started',
        })
      }
      const callStats = o.stats ?? newCallStats()
      const series = await Promise.all(
        SERIES_NAMES.map(async (name): Promise<[SeriesName, SeriesDay]> => {
          const { path, extra } = SERIES_REQUEST[name]
          const result = await stats(
            path,
            (d) => ({ home_id: d.homeId, id: d.deviceId, model: d.model, offset, ...extra }),
            { signal: o.signal, stats: callStats },
          )
          return [name, parseSeries(name, result)]
        }),
      )
      return buildDay(offset, Object.fromEntries(series) as Record<SeriesName, SeriesDay>)
    },
  }
}

/** Internal: discovery saw -12 on a token it did not just issue. */
class StaleSession extends Error {}

function statusError(op: EmaldoOp, status: number): EmaldoError {
  if (status === 429) return new EmaldoError('rate_limited', op, status)
  if (status >= 500) return new EmaldoError('unreachable', op, status)
  return new EmaldoError('unexpected_response', op, status)
}

/** A Status other than 1 or -12. A refused login is a credentials problem. */
function refused(op: EmaldoOp, status: number): EmaldoError {
  if (op === 'login') {
    return new EmaldoError('auth_failed', op, undefined, {
      message: `Emaldo login was refused (Status ${status}): check EMALDO_USER / EMALDO_PASSWORD, or the app id/secret may have rotated`,
    })
  }
  return new EmaldoError('unexpected_response', op, undefined, {
    message: `Emaldo ${op} was refused (Status ${status})`,
  })
}

/** Races `p` against the caller's `signal`; an abort rejects with `unreachable`. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () =>
    new EmaldoError('unreachable', 'login', undefined, {
      cause: networkCause(signal.reason),
      message: 'Emaldo login wait was cut off',
    })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

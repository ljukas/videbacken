import type { ZaptecLiveState } from '~/lib/evCharging/types'
import { ZaptecError, type ZaptecOp } from './errors'
import {
  parse,
  parseChargers,
  parseLiveState,
  parseSessionsPage,
  tokenErrorSchema,
  tokenSchema,
} from './parse'
import { type CallOpts, newCallStats, type ZaptecCallStats, type ZaptecClient } from './zaptec'

const BASE_URL = 'https://api.zaptec.com'
const USER_AGENT = 'videbacken/1.0 (private home dashboard)'
const PAGE_SIZE = 200

const TOKEN_EXPIRY_MARGIN_MS = 300_000
const TIMEOUT_MS = 10_000
const LIVE_TIMEOUT_MS = 5_000
const LIVE_TTL_MS = 15_000
/** A rejected login (or 403) blocks new login attempts — protects the Zaptec account from lockout. */
const AUTH_FAILURE_TTL_MS = 300_000
/** An unreachable / rate-limited live read is answered from cache instead of re-hitting Zaptec. */
const LIVE_FAILURE_TTL_MS = 60_000
const AUTH_CODES: ReadonlySet<string> = new Set(['auth_failed', 'forbidden'])
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['unreachable', 'rate_limited'])

const MAX_RETRIES = 2
const MAX_RETRY_AFTER_MS = 10_000
const BACKOFF_MS = [500, 1500]
const DATA_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])
// Token 4xx (including 429) is never retried.
const TOKEN_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const NO_RETRY: ReadonlySet<number> = new Set()

type Deps = {
  fetch: typeof fetch
  creds: { username: string; password: string }
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

type SendOpts = {
  op: ZaptecOp
  signal?: AbortSignal
  stats: ZaptecCallStats
  timeoutMs: number
  /** Statuses to retry; network failures are retried whenever this is non-empty. */
  retryStatuses: ReadonlySet<number>
  timing: 'authMs' | 'fetchMs'
}

/**
 * Real Zaptec REST client. Does not log — it fills the caller's `stats` and
 * throws `ZaptecError`. See `./zaptec.ts` for the interface and selection.
 */
export function createZaptecClient(deps: Deps): ZaptecClient {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random

  let token: { value: string; expiresAt: number } | null = null
  let login: Promise<string> | null = null
  /** Set when a login was rejected; new logins are refused until `until`. */
  let loginBlock: { error: ZaptecError; until: number } | null = null
  const liveCache = new Map<string, { state: ZaptecLiveState; at: number }>()
  const liveFailures = new Map<string, { error: ZaptecError; until: number }>()

  /** One HTTP request with timeout + retries. Returns the final response (any status). */
  async function send(url: string, init: RequestInit, o: SendOpts): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('User-Agent', USER_AGENT)
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < MAX_RETRIES && o.retryStatuses.size > 0
      if (o.signal?.aborted) {
        throw new ZaptecError('unreachable', o.op, undefined, {
          cause: networkCause(o.signal.reason),
        })
      }
      const timeout = AbortSignal.timeout(o.timeoutMs)
      const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout

      o.stats.requests++
      const started = performance.now()
      let res: Response
      try {
        res = await deps.fetch(url, { ...init, headers, signal })
      } catch (err) {
        o.stats[o.timing] += performance.now() - started
        // A caller abort is final; a timeout or network failure may be retried.
        if (canRetry && !o.signal?.aborted) {
          await backoff(attempt, o.stats)
          continue
        }
        throw new ZaptecError('unreachable', o.op, undefined, { cause: networkCause(err) })
      }
      o.stats[o.timing] += performance.now() - started

      if (res.ok || !o.retryStatuses.has(res.status)) return res

      const retryAfter = retryAfterMs(res.headers.get('Retry-After'))
      if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
        throw new ZaptecError(res.status === 429 ? 'rate_limited' : 'unreachable', o.op, res.status)
      }
      if (!canRetry) return res
      await discard(res)
      if (retryAfter !== null) {
        o.stats.retries++
        await sleep(retryAfter)
      } else {
        await backoff(attempt, o.stats)
      }
    }
  }

  async function backoff(attempt: number, stats: ZaptecCallStats) {
    stats.retries++
    await sleep(BACKOFF_MS[attempt] * (0.8 + 0.4 * random()))
  }

  function retryAfterMs(header: string | null): number | null {
    if (header === null || header.trim() === '') return null
    const trimmed = header.trim()
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000
    const at = Date.parse(trimmed)
    return Number.isNaN(at) ? null : Math.max(0, at - now().getTime())
  }

  /**
   * The only place the password grant lives. Exchanges the credentials for an
   * access token; the form body and response never leave this function.
   */
  async function obtainToken(stats: ZaptecCallStats): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'password',
      username: deps.creds.username,
      password: deps.creds.password,
      scope: 'openid',
    })
    // The login is shared by concurrent callers, so it is bounded by its own
    // timeout only — one caller aborting must not fail the others' login.
    const res = await send(
      `${BASE_URL}/oauth/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      {
        op: 'token',
        stats,
        timeoutMs: TIMEOUT_MS,
        retryStatuses: TOKEN_RETRY_STATUSES,
        timing: 'authMs',
      },
    )
    if (res.status === 400 || res.status === 401) {
      const grantRetired = (await oauthErrorCode(res)) === 'unsupported_grant_type'
      throw new ZaptecError('auth_failed', 'token', res.status, {
        message: grantRetired
          ? `Zaptec login failed: password grant retired (unsupported_grant_type, HTTP ${res.status})`
          : `Zaptec login failed: credentials rejected (HTTP ${res.status})`,
      })
    }
    if (!res.ok) throw statusError('token', res)
    const parsed = parse('token', tokenSchema, await readJson('token', res))
    token = {
      value: parsed.access_token,
      expiresAt: now().getTime() + parsed.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    }
    return parsed.access_token
  }

  /**
   * The current token, or the shared in-flight login. A caller's `signal` only
   * stops *its* wait (→ `unreachable`); the login keeps running for the others.
   */
  function getToken(stats: ZaptecCallStats, op: ZaptecOp, signal?: AbortSignal): Promise<string> {
    const at = now().getTime()
    if (token && at < token.expiresAt) return Promise.resolve(token.value)
    if (loginBlock && at < loginBlock.until) return Promise.reject(loginBlock.error)
    if (!login) {
      const shared = obtainToken(stats)
        .then(
          (value) => {
            loginBlock = null
            return value
          },
          (err: unknown) => {
            if (err instanceof ZaptecError && AUTH_CODES.has(err.code)) {
              loginBlock = { error: err, until: now().getTime() + AUTH_FAILURE_TTL_MS }
            }
            throw err
          },
        )
        .finally(() => {
          login = null
        })
      // Every waiter may have aborted — the shared rejection must never go unhandled.
      shared.catch(() => {})
      login = shared
    }
    return signal ? abortable(login, signal, op) : login
  }

  /** Authenticated GET → parsed JSON, with one re-login on 401. */
  async function getJson(
    path: string,
    op: ZaptecOp,
    o: CallOpts,
    timeoutMs: number,
    retry: boolean,
  ) {
    const stats = o.stats ?? newCallStats()
    const sendOpts: SendOpts = {
      op,
      signal: o.signal,
      stats,
      timeoutMs,
      retryStatuses: retry ? DATA_RETRY_STATUSES : NO_RETRY,
      timing: 'fetchMs',
    }
    const request = (value: string) =>
      send(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${value}` } }, sendOpts)

    let used = await getToken(stats, op, o.signal)
    let res = await request(used)
    if (res.status === 401) {
      await discard(res)
      if (token?.value === used) token = null // don't clobber a concurrent refresh
      used = await getToken(stats, op, o.signal)
      res = await request(used)
    }
    if (!res.ok) throw statusError(op, res)
    return readJson(op, res)
  }

  return {
    async chargers(o = {}) {
      return parseChargers(await getJson('/api/chargers', 'chargers', o, TIMEOUT_MS, true))
    },

    async *sessionsEndedSince(since, o) {
      const stats = o.stats ?? newCallStats()
      const base = {
        From: since.toISOString(),
        To: (o.until ?? now()).toISOString(),
        InstallationId: o.installationId,
        PageSize: String(PAGE_SIZE),
      }
      let cursor: string | null = null
      for (;;) {
        const query = new URLSearchParams(cursor === null ? base : { ...base, Cursor: cursor })
        const page = parseSessionsPage(
          await getJson(
            `/api/sessions/archived?${query}`,
            'sessions',
            { ...o, stats },
            TIMEOUT_MS,
            true,
          ),
        )
        stats.pages++
        yield page.sessions
        if (!page.hasMore) return
        if (page.cursor === null || page.cursor === cursor) {
          throw new ZaptecError('unexpected_response', 'sessions', undefined, {
            message: 'Zaptec sessions response has hasMore without a new cursor',
          })
        }
        cursor = page.cursor
      }
    },

    async liveState(chargerId, o = {}) {
      const at = now().getTime()
      const failed = liveFailures.get(chargerId)
      if (failed && at < failed.until) throw failed.error
      const cached = liveCache.get(chargerId)
      if (cached && at - cached.at < LIVE_TTL_MS) return cached.state
      let body: unknown
      try {
        body = await getJson(
          `/api/chargers/${encodeURIComponent(chargerId)}/state`,
          'state',
          o,
          LIVE_TIMEOUT_MS,
          false,
        )
      } catch (err) {
        // Cache the failure so a polling dashboard can't hammer a down (or
        // credential-rejecting) Zaptec: auth failures 5 min, transient 60 s.
        if (err instanceof ZaptecError) {
          const ttl = AUTH_CODES.has(err.code)
            ? AUTH_FAILURE_TTL_MS
            : TRANSIENT_CODES.has(err.code)
              ? LIVE_FAILURE_TTL_MS
              : 0
          if (ttl > 0) liveFailures.set(chargerId, { error: err, until: now().getTime() + ttl })
        }
        throw err
      }
      const observedAt = now()
      const state = parseLiveState(body, observedAt)
      liveFailures.delete(chargerId)
      liveCache.set(chargerId, { state, at: observedAt.getTime() })
      return state
    },
  }
}

/** Races `p` against the caller's `signal`; an abort rejects with `unreachable`. */
function abortable<T>(p: Promise<T>, signal: AbortSignal, op: ZaptecOp): Promise<T> {
  const abortError = () =>
    new ZaptecError('unreachable', op, undefined, { cause: networkCause(signal.reason) })
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

function statusError(op: ZaptecOp, res: Response): ZaptecError {
  const { status } = res
  void discard(res)
  if (status === 401) return new ZaptecError('auth_failed', op, status)
  if (status === 403) return new ZaptecError('forbidden', op, status)
  if (status === 429) return new ZaptecError('rate_limited', op, status)
  if (status >= 500) return new ZaptecError('unreachable', op, status)
  return new ZaptecError('unexpected_response', op, status)
}

async function readJson(op: ZaptecOp, res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch (err) {
    // A body that isn't JSON (or a read that died mid-stream) — never echo it.
    const aborted =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    throw new ZaptecError(aborted ? 'unreachable' : 'unexpected_response', op, res.status, {
      cause: networkCause(err),
      message: aborted
        ? `Zaptec ${op} response was cut off`
        : `Zaptec ${op} response is not valid JSON (HTTP ${res.status})`,
    })
  }
}

/** Reads only the OAuth `error` code from a token error body. */
async function oauthErrorCode(res: Response): Promise<string | null> {
  try {
    const parsed = tokenErrorSchema.safeParse(await res.json())
    return parsed.success ? parsed.data.error : null
  } catch {
    return null
  }
}

async function discard(res: Response) {
  try {
    await res.body?.cancel()
  } catch {
    // ignore — the body is unused
  }
}

/** Keeps only a network error's `name` and `code` — its message may echo the request. */
function networkCause(err: unknown): { name: string; code?: string } {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null
  const name = typeof e?.name === 'string' ? e.name : 'Error'
  const code =
    typeof e?.code === 'string'
      ? e.code
      : typeof e?.cause?.code === 'string'
        ? e.cause.code
        : undefined
  return code === undefined ? { name } : { name, code }
}

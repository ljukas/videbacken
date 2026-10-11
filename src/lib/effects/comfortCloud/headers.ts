import { createHash } from 'node:crypto'
import { API_USER_AGENT, APP_KEY, APP_NAME } from './constants'

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/**
 * `x-app-timestamp`: `YYYY-MM-DD HH:mm:ss`. Upstream sends the host's wall clock; on Vercel that
 * is UTC, so we send UTC everywhere and local runs match prod.
 */
export function appTimestamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Upstream's `_get_api_key`: SHA-256 hex of "Comfort Cloud" + the app key + the timestamp read as a
 * UTC instant in epoch ms + "Bearer " + the token, with `cfc` inserted after the 9th character.
 * The result is derived from the token: never log it or put it in an error.
 */
export function cfcApiKey(timestamp: string, token: string): string {
  if (!TIMESTAMP_RE.test(timestamp)) throw new RangeError('Not a YYYY-MM-DD HH:mm:ss timestamp')
  const ms = Date.parse(`${timestamp.replace(' ', 'T')}Z`)
  if (!Number.isFinite(ms)) throw new RangeError('Not a YYYY-MM-DD HH:mm:ss timestamp')
  const hex = createHash('sha256')
    .update(`${APP_NAME}${APP_KEY}${ms}Bearer ${token}`, 'utf8')
    .digest('hex')
  return `${hex.slice(0, 9)}cfc${hex.slice(9)}`
}

/** The headers of every `accsmart` call (`PanasonicRequestHeader.get`); no client id on the session login. */
export function apiHeaders(o: {
  now: Date
  token: string
  appVersion: string
  clientId?: string
}): Record<string, string> {
  const timestamp = appTimestamp(o.now)
  return {
    accept: 'application/json; charset=utf-8',
    'content-type': 'application/json',
    'user-agent': API_USER_AGENT,
    'x-app-name': APP_NAME,
    'x-app-timestamp': timestamp,
    'x-app-type': '1',
    'x-app-version': o.appVersion,
    'x-cfc-api-key': cfcApiKey(timestamp, o.token),
    'x-user-authorization-v2': `Bearer ${o.token}`,
    ...(o.clientId ? { 'x-client-id': o.clientId } : {}),
  }
}

// Synthetic Emaldo test data — never real readings or credentials (the repo is
// public; real probe data stays in data/private/emaldo/). Responses are
// sealed in-test exactly as the server does: RC4(app secret, Snappy(JSON)).
import { compress } from 'snappyjs'
import { STOCKHOLM_TIME_ZONE, stockholmDayBounds } from '~/lib/time/stockholm'
import { jsonResponse } from '../testing/fakeFetch'
import type { SeriesName } from './parse'
import { fromHex, rc4, toHex } from './wire'

export const TEST_APP_ID = 'testapp0001'
export const TEST_APP_SECRET = 'test-app-secret-not-real'
export const TEST_USER = 'owner@example.test'
export const TEST_PASSWORD = 'not-a-real-password'
export const TEST_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001'
export const TEST_TOKEN_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002'
export const HOME_ID = 'home-test-0001'
export const EMPTY_HOME_ID = 'home-test-0000'
export const DEVICE_ID = 'device-test-0001'
export const MODEL = 'TEST-MODEL-1'

const KEY = new TextEncoder().encode(TEST_APP_SECRET)

/** A `Result` as the server sends it. */
export function seal(value: unknown, o: { snappy?: boolean; secret?: string } = {}): string {
  const json = new TextEncoder().encode(JSON.stringify(value))
  const key = o.secret === undefined ? KEY : new TextEncoder().encode(o.secret)
  return toHex(rc4(key, o.snappy === false ? json : compress(json)))
}

export const okReply = (value: unknown, o?: { snappy?: boolean; secret?: string }) =>
  jsonResponse({ Status: 1, Result: seal(value, o), ErrorMessage: '' })

/** A refusal whose ErrorMessage echoes the user, to prove it never reaches an error. */
export const statusReply = (status: number) =>
  jsonResponse({ Status: status, Result: '', ErrorMessage: `refused for ${TEST_USER}` })

/** The decrypted form fields of a request (null when absent). */
export async function openRequest(
  req: Request,
): Promise<{ json: string | null; token: string | null; gm: string | null }> {
  const form = new URLSearchParams(await req.clone().text())
  const open = (field: string) => {
    const hex = form.get(field)
    const sealed = hex === null ? null : fromHex(hex)
    return sealed === null ? null : new TextDecoder().decode(rc4(KEY, sealed))
  }
  return { json: open('json'), token: open('token'), gm: form.get('gm') }
}

/** Watts for synthetic minute `m`: every used column distinct, so a swapped column shows. */
export function syntheticRow(name: SeriesName, m: number): number[] {
  const k = m / 5 + 1
  switch (name) {
    case 'grid': // 13 columns, as seen live
      return [m, 12 * k, 6, 24 * k, 300, 0, 0, 0, 0, 0, 0, 0, 0]
    case 'mppt':
      return [m, 120, 240, 36 * k, 48, 0]
    case 'usage':
      return [m, 1, 60 * k, 2]
    case 'battery':
      return [m, 72, 84, 96, 108, 0]
    case 'level': // SoC %, plus an unused trailing column
      return [m, k % 101, 0]
  }
}

/** Every bucket minute of Stockholm `day`: 276, 288 or 300 of them. */
export function dayMinutes(day: string): number[] {
  const { startMs, endMs } = stockholmDayBounds(day)
  return Array.from({ length: (endMs - startMs) / 300_000 }, (_, i) => i * 5)
}

/** One series' decoded day response, with rows at `minutes`. */
export function seriesDay(
  name: SeriesName,
  day: string,
  minutes: number[] = dayMinutes(day),
  row: (name: SeriesName, m: number) => unknown[] = syntheticRow,
) {
  return {
    start_time: stockholmDayBounds(day).startMs / 1000,
    timezone: STOCKHOLM_TIME_ZONE,
    interval: 5,
    data: minutes.map((m) => row(name, m)),
    gmtime: 0,
  }
}

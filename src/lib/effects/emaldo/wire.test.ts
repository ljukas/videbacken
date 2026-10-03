import { compress } from 'snappyjs'
import { describe, expect, test } from 'vitest'
import {
  decodeResult,
  encodeBody,
  encodeToken,
  fromHex,
  gmtimeOf,
  MAX_DECODED_BYTES,
  rc4,
  toHex,
} from './wire'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const KEY = bytes('test-app-secret')
/** What the server would send: hex(RC4(KEY, maybe-Snappy(JSON))). */
const seal = (value: unknown, snappy = true) => {
  const json = bytes(JSON.stringify(value))
  return toHex(rc4(KEY, snappy ? compress(json) : json))
}
const open = (hex: string) => text(rc4(KEY, fromHex(hex) ?? new Uint8Array()))

describe('rc4', () => {
  test.each([
    ['Key', 'Plaintext', 'bbf316e8d940af0ad3'],
    ['Wiki', 'pedia', '1021bf0420'],
    ['Secret', 'Attack at dawn', '45a01f645fc35b383552544b9bf5'],
  ])('matches the published test vector for key %s', (key, plain, hex) => {
    expect(toHex(rc4(bytes(key), bytes(plain)))).toBe(hex)
  })

  test('is symmetric and starts a fresh keystream per call', () => {
    const sealed = rc4(KEY, bytes('hello'))
    expect(text(rc4(KEY, sealed))).toBe('hello')
    expect(toHex(rc4(KEY, bytes('hello')))).toBe(toHex(sealed))
  })

  test('refuses an empty key', () => {
    expect(() => rc4(new Uint8Array(), bytes('x'))).toThrow(RangeError)
  })
})

describe('hex', () => {
  test('round-trips and rejects odd length, non-hex and empty input', () => {
    expect(toHex(fromHex('00ff7A') ?? new Uint8Array())).toBe('00ff7a')
    for (const bad of ['', 'abc', 'zz', '0g', '00 ff']) expect(fromHex(bad)).toBeNull()
  })
})

describe('gmtimeOf', () => {
  test('is epoch ms followed by six zeros, built as text beyond MAX_SAFE_INTEGER', () => {
    const g = gmtimeOf(1_791_004_487_508.9)
    expect(g).toBe('1791004487508000000')
    expect(BigInt(g)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
  })
})

describe('encodeBody / encodeToken', () => {
  test('splices gmtime into the body as a bare integer literal', () => {
    const g = '1791004487508000000'
    expect(open(encodeBody(KEY, { home_id: 'h', offset: -1 }, g))).toBe(
      `{"home_id":"h","offset":-1,"gmtime":${g}}`,
    )
    expect(open(encodeBody(KEY, {}, g))).toBe(`{"gmtime":${g}}`)
  })

  test('the token field is <token>_<gmtime>', () => {
    expect(open(encodeToken(KEY, 'tok', '17000000'))).toBe('tok_17000000')
  })
})

describe('decodeResult', () => {
  const value = { start_time: 1_781_042_400, data: [[0, 1, 2, 3]] }

  test('reads a Snappy-compressed result', () => {
    expect(decodeResult(KEY, seal(value))).toEqual({ ok: true, value })
  })

  test('falls back to plain bytes, even when Snappy "decodes" them to garbage', () => {
    expect(decodeResult(KEY, seal(value, false))).toEqual({ ok: true, value })
    // snappyjs turns `{}` into 123 NUL bytes without throwing.
    expect(decodeResult(KEY, seal({}, false))).toEqual({ ok: true, value: {} })
  })

  test('a wrong key, bad hex or a non-JSON payload is not ok', () => {
    expect(decodeResult(bytes('rotated-secret'), seal(value))).toEqual({ ok: false })
    expect(decodeResult(KEY, 'xyz')).toEqual({ ok: false })
    expect(decodeResult(KEY, '')).toEqual({ ok: false })
    expect(decodeResult(KEY, toHex(rc4(KEY, bytes('<html>'))))).toEqual({ ok: false })
  })

  test('a Snappy header claiming more than MAX_DECODED_BYTES is refused, not allocated', () => {
    // varint length MAX_DECODED_BYTES + 1, then nothing.
    let n = MAX_DECODED_BYTES + 1
    const header: number[] = []
    while (n >= 0x80) {
      header.push((n & 0x7f) | 0x80)
      n >>>= 7
    }
    header.push(n)
    expect(decodeResult(KEY, toHex(rc4(KEY, new Uint8Array(header))))).toEqual({ ok: false })
  })
})

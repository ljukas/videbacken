// The Emaldo cloud's wire codec (ADR-0023; protocol from wertigpar/ha-emaldo,
// MIT). Every request field is hex(RC4(app secret, text)); a response's
// `Result` is hex → RC4 → raw (unframed) Snappy, or plain bytes.
//
// RC4 is hand-rolled: Node's OpenSSL 3 refuses it (`createCipheriv('rc4', …)`
// throws "digital envelope routines::unsupported"), and it is 15 lines. It is
// an obfuscation layer here, not security — TLS protects the traffic.
import { uncompress } from 'snappyjs'

/** Largest decompressed `Result` accepted: a day series is ≈30 kB; guards a hostile length header. */
export const MAX_DECODED_BYTES = 4 * 1024 * 1024

const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const HEX = /^(?:[0-9a-fA-F]{2})+$/

/** RC4 over `data` with a fresh keystream from `key` (symmetric: encrypts and decrypts). */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length === 0) throw new RangeError('RC4 key must not be empty')
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** Bytes of a non-empty, even-length hex string; null for anything else (Buffer alone would truncate silently). */
export function fromHex(hex: string): Uint8Array | null {
  return HEX.test(hex) ? new Uint8Array(Buffer.from(hex, 'hex')) : null
}

/**
 * The request clock the server checks: epoch ms × 1e6 as a decimal string. It
 * exceeds Number.MAX_SAFE_INTEGER, so it is built as text, never as a number.
 */
export function gmtimeOf(epochMs: number): string {
  return `${Math.trunc(epochMs)}000000`
}

/** hex(RC4(secret, utf-8 text)) — one form field. */
export function encodeField(secret: Uint8Array, text: string): string {
  return toHex(rc4(secret, utf8.encode(text)))
}

/** The `json` field: the body with `"gmtime":<digits>` spliced in as a bare integer literal. */
export function encodeBody(
  secret: Uint8Array,
  body: Record<string, unknown>,
  gmtime: string,
): string {
  const json = JSON.stringify(body)
  const separator = json === '{}' ? '' : ','
  return encodeField(secret, `${json.slice(0, -1)}${separator}"gmtime":${gmtime}}`)
}

/** The `token` field: `<token>_<gmtime>`. */
export function encodeToken(secret: Uint8Array, token: string, gmtime: string): string {
  return encodeField(secret, `${token}_${gmtime}`)
}

export type Decoded = { ok: true; value: unknown } | { ok: false }

/**
 * A response `Result` → JSON. Snappy first, then plain bytes: snappyjs does not
 * reject every non-Snappy input (`{}` "decompresses" to 123 NUL bytes), so a
 * decode only counts once it is valid UTF-8 *and* valid JSON. `{ ok: false }`
 * when neither reading works — most likely a rotated app secret.
 */
export function decodeResult(secret: Uint8Array, hex: string): Decoded {
  const sealed = fromHex(hex)
  if (sealed === null) return { ok: false }
  const raw = rc4(secret, sealed)
  for (const read of [() => uncompress(raw, MAX_DECODED_BYTES), () => raw]) {
    try {
      return { ok: true, value: JSON.parse(strictUtf8.decode(read())) }
    } catch {
      // try the next reading
    }
  }
  return { ok: false }
}

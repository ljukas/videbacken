# Solar-aware cost, step 1 — Emaldo house-energy client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested, fail-closed effect `src/lib/effects/emaldo/` whose `fetchDay(offset)` logs in to the Emaldo cloud,
finds the home's battery, fetches the four 5-minute day series (grid, solar, load, battery) and returns typed kWh
buckets. Nothing calls it yet; no schema; `emaldo` is **not** added to `INTEGRATION_SOURCES` (step 2 does that).

**Architecture:** Same shape as `src/lib/effects/skoda/`: `emaldo.ts` (types, adapter selector, lazy facade),
`client.ts` (`createEmaldoClient`), `parse.ts` (zod → buckets), `errors.ts` (`EmaldoError extends
IntegrationError`), `adapters/notConfigured.ts`, plus `wire.ts` for the request/response codec (hand-rolled RC4,
hex, the `gmtime` string, `snappyjs` raw decompression). HTTP goes through the shared `fetchWithRetry` (ky) in
`src/lib/effects/http.ts`: the encrypted form POST fits it as-is (Zaptec's login is already a retried
URLSearchParams POST), so timeouts, 502/503/504 retries, abort handling and per-attempt timing stay ADR-0019's.
The four series are fetched in parallel; a shared in-flight login means a `-12` on all four triggers exactly one
re-login (a login ends the account's other sessions, so four re-logins would knock each other out).

**Tech Stack:** TypeScript, zod 4, ky (via `effects/http.ts`), `snappyjs` 0.7 (new dependency) + `@types/snappyjs`,
`@date-fns/tz` (via `src/lib/time/stockholm.ts`), Vitest (node project) with `testing/fakeFetch`.

**Spec:** `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md` ("What the API does", "Sync") ·
**ADR:** `docs/adr/0023-solar-aware-charging-cost.md` · **Roadmap:** step 1 of
`docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md` · **Contract:** the cross-step names below
(`HouseBucket`, `EmaldoDay`, `EmaldoClient`, `createEmaldoClient`, `selectEmaldoAdapter`, `EmaldoError`, `EmaldoOp`)
are fixed; steps 2–5 build on them.

**Branch:** `feat/emaldo-client` · **PR title:** `feat(charging): add the Emaldo house-energy client`

## Decisions recorded while planning (2026-10-03)

- **RC4 is hand-rolled.** `node -e "require('crypto').createCipheriv('rc4', Buffer.alloc(16), null)"` on Node
  v23.10.0 throws `Error: error:0308010C:digital envelope routines::unsupported` (OpenSSL 3 disables RC4). Bun 1.3
  (BoringSSL) accepts it, but Vercel Functions run Node. ≈15 lines, checked against the three published test vectors.
- **Snappy uses `snappyjs`** (checked with `npm view`, the npm downloads API and the GitHub API): v0.7.0, MIT, zero
  dependencies, 21.5 kB unpacked, ≈2.4 M downloads/week (kafkajs and others depend on it), repo not archived; last
  release 2022-06 — acceptable because the Snappy raw block format is frozen. It implements the **raw (unframed)**
  format the API uses, has `uncompress(input, maxLength)` (a guard against a hostile length header) and `compress`
  (the tests seal synthetic responses with it). Types: `@types/snappyjs` 0.7.1 (2025-08). Server-only code, so bundle
  size doesn't matter.
  - **Caveat found:** `uncompress` does not reject every non-Snappy input: the plain bytes `{}` "decompress" to 123
    NUL bytes without throwing. `decodeResult` therefore accepts a reading only once it is valid UTF-8 **and** valid
    JSON, Snappy first, then plain bytes (the API's documented fallback). A test locks this in.
- **HTTP layer = `fetchWithRetry`**, retry limit 1 on 502/503/504/network/timeout, 10 s per attempt, `redirect:
  'error'`. Emaldo calls are reads (login included), so resending a POST is safe.
- **Grid import = column 1 + column 2** (import + emergency import). The probe's `analyze.py` summed both and its
  energy balance held within 1.4 %; emergency import was 0 on every probed day.
- **Row tolerance:** rows are zod tuples with a typed prefix and `unknown` rest (live rows have 13 / 6 / 4 / 6
  columns; unused columns may be anything). A negative value in a used column drops that bucket (counted), it doesn't
  fail the day: the step-2 table CHECKs `>= 0`, and a dropped bucket falls back to "no house data" (all grid, the
  safe upper bound). A wrong `timezone`, `interval`, `start_time`, minute or row shape fails the whole response
  (`unexpected_response`, path only).
- **Verified offline:** the planned `parse.ts` decodes all six probe days in `data/private/emaldo/data/` (normal,
  95-min-gap, spring-forward) with 0 mismatches against an independent computation, and the checkpoint script in Task
  8 passes end to end against a fake server serving those files.

## Contract deviations

1. `EmaldoCallStats` gains **`retries: number`** (additive): the shared `fetchWithRetry` policy requires a
   `{ requests, retries }` sink. Step 2 may log it or ignore it.
2. `droppedBuckets` also counts buckets with a **negative reading** in a used column (documented on the type).
3. HTTP **429 → `rate_limited`** (the contract lists only `auth_failed` / `unreachable` / `unexpected_response`);
   matches Zaptec/Škoda and the shared vocabulary.
4. A call whose `signal` is **already aborted** fails `unreachable` before any request (no login is started).
5. Extra private files: `fixtures.ts` (synthetic data + response sealing), `wire.test.ts`, `parse.test.ts`.
6. **CLAUDE.md** gets the Emaldo env-var bullet and the `effects/` code-map entry in this step (the env vars are already
   in `.env.example`, added with the design docs in #67). Step 2 only adds the `houseEnergy/` line and the cron.

## Global Constraints

- Effects isolated (ADR-0001); the client **never logs** — it fills the caller's `stats` and throws `EmaldoError`.
  Never `console.*` in `src/`.
- Pulled sources have **no devLog/fake adapter** (ADR-0019): any of the four `EMALDO_*` unset, or `VITEST=true` →
  `notConfigured` (`not_configured`).
- Error messages and `cause` **never** carry: user, password, app id, app secret, token, home/device ids, the API's
  `ErrorMessage`, or any reading. zod failures name paths only (`summarizeIssuePaths`); network errors keep only
  `networkCause` (`{ name, code }`).
- **Never commit real readings or credentials** (public repo): fixtures are synthetic; `data/private/` stays
  git-excluded; never print `.env.local`.
- Error mapping (exact): login `Status ≠ 1` → `auth_failed`; `-12` again after the one re-login → `auth_failed`;
  network / HTTP 5xx / timeout / caller abort → `unreachable`; HTTP 429 → `rate_limited`; non-JSON, zod failure,
  undecodable `Result` (message hints "the app id/secret may have rotated"), unknown `Status` on discover/stats, no
  home with a device → `unexpected_response`.
- Wire (exact): `POST https://{host}{path}{EMALDO_APP_ID}`; `/bmt/stats/*` → `dp.emaldo.com`, else
  `api.emaldo.com`; headers `Content-Type: application/x-www-form-urlencoded`, `User-Agent: okhttp/4.9.0`,
  `X-Online-Host: {host}`; fields `json` = hex(RC4(secret, body + `"gmtime":<digits>`)), `token` =
  hex(RC4(secret, `{token}_{gmtime}`)), `gm=1`; `gmtime` = `${epochMs}000000` as a **string**.
- kWh = average W ÷ 12 000 (W × 5 / 60 / 1000), integer watts summed **before** dividing.
- Stockholm calendar via `src/lib/time/stockholm.ts` only (the one module that names the zone).
- Biome style (single quotes, no semicolons, width 100); `bun run check` before each commit.
- Conventional Commits ≤ 72 chars, one hat per commit, every commit message ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **DST days and day bounds** — 276 / 300 buckets, bucket starts continuous in UTC, rows at or past the next
   Stockholm midnight dropped. → Task 2 ("spring-forward day", "fall-back day", "a row at or past the next midnight").
2. **Today's still-filling bucket when the four series end at different minutes** — everything from the earliest
   series' newest minute on is dropped. → Task 2 ("today drops the still-filling newest bucket").
3. **Session expiry under parallel requests** — four simultaneous `-12`s must cause **one** re-login (each login
   ends the others), the device must not be rediscovered, and a second `-12` must be `auth_failed`, not a loop.
   → Task 3 ("an expired token: one re-login…", "-12 again right after the re-login").
4. **Snappy false positives and a rotated secret** — plain JSON that `snappyjs` "decodes" to garbage must still be
   read; a response sealed with another secret must be `unexpected_response` with the rotation hint. → Task 1
   ("falls back to plain bytes…"), Task 3 ("a result sealed with another secret…").
5. **Nothing secret leaks into errors** — an `ErrorMessage` echoing the account, a network error whose message names
   the app id and token, a refused login. → Task 3 (`leaksNothing` in the refusal, network and discovery tests).

---

### Task 0: Verify main matches this plan

**Files:** none (only this plan, if it needs fixing) · **Reviewers:** none (a read-only gate)

- [ ] **Step 1: Make an isolated worktree from up-to-date main**

```bash
cd /Users/lukas/prog/videbacken
git fetch origin
git worktree add .claude/worktrees/emaldo-client -b feat/emaldo-client origin/main
cd .claude/worktrees/emaldo-client
cp ../../../.env .env
# .env.local holds secrets: copy it, never print it. It must not carry a prod DATABASE_URL (CLAUDE.md gotcha):
[ -f ../../../.env.local ] && cp ../../../.env.local .env.local && grep -c '^DATABASE_URL' .env.local
bun install
```
Expected: the `grep -c` prints `0`. If it prints anything else, delete those lines from `.env.local` before running
anything.

- [ ] **Step 2: The design docs are on main and this is the first step.** Step 1 has no predecessor checkpoint, but
  the spec, ADR-0023, the roadmap and the plans were written on `docs/charging-solar-cost-design`:

```bash
git ls-tree --name-only origin/main docs/adr/0023-solar-aware-charging-cost.md \
  docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md \
  docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md \
  docs/superpowers/plans/2026-10-03-solar-cost-1-emaldo-client.md
grep -n "^| 1 |" docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md
```
Expected: all four paths print; row 1 reads `not started`. If the docs aren't on main, **stop** and ask the owner to
merge the docs PR first. Then set row 1 to `in progress` (committed with Task 7's roadmap edit, not separately).

- [ ] **Step 3: Confirm every seam this plan consumes.** Run each grep; compare with the expectation.

```bash
# Nothing Emaldo exists yet; the source list is untouched (step 2 adds 'emaldo')
ls src/lib/effects/emaldo 2>&1 | head -1                  # → No such file or directory
grep -n "emaldo\|snappy" package.json src/lib/effects/index.ts src/lib/integrationHealth.ts   # → no output
# The shared HTTP policy: retryLimit option, POST allowed, discard + networkCause
grep -n "export async function fetchWithRetry\|retryLimit?: number\|methods: \['get', 'post'\]\|export async function discard\|export function networkCause" src/lib/effects/http.ts
grep -n "stats: { requests: number; retries: number }" src/lib/effects/http.ts
# fakeFetch routes by "<METHOD> <pathname>" (host ignored) and exposes callsTo
grep -n "new URL(req.url).pathname\|callsTo\|export function jsonResponse" src/lib/effects/testing/fakeFetch.ts
# Base error, lazy, the error vocabulary, issue paths
grep -n "export abstract class IntegrationError" src/lib/effects/integrationError.ts
grep -n "export function lazy" src/lib/effects/lazy.ts
grep -n "'auth_failed'\|'rate_limited'\|'unreachable'\|'unexpected_response'\|'not_configured'" src/lib/integrationHealth.ts
grep -n "export function issuePath\|export function summarizeIssuePaths" src/lib/issuePaths.ts
# Stockholm helpers
grep -n "export const STOCKHOLM_TIME_ZONE\|export function stockholmDayOf\|export function stockholmDayBounds\|export function addDays" src/lib/time/stockholm.ts
# The model effect this one copies, and its test idioms (fake timers, nextTimerAsync)
ls src/lib/effects/skoda src/lib/effects/skoda/adapters
grep -n "setTimerTickMode('nextTimerAsync')" src/lib/effects/skoda/skoda.test.ts
grep -n '"zod"\|"ky"\|"@date-fns/tz"' package.json
# The decisions above still hold
node -e "require('crypto').createCipheriv('rc4', Buffer.alloc(16), null)" 2>&1 | grep -c unsupported   # → 1
npm view snappyjs version license      # → 0.7.0 / MIT (a newer version: read its changelog for uncompress/compress)
```
Expected: each grep prints at least one line (except the two "→ no output" lines). If `fetchWithRetry`'s policy shape,
`fakeFetch`'s routing or the Stockholm helper names changed, fix this plan's code first.

- [ ] **Step 4: Baseline is green**

```bash
bunx vitest run src/lib/effects/skoda src/lib/effects/zaptec
```
Expected: PASS.

---

### Task 1: `snappyjs` + the wire codec (`wire.ts`)

**Files:**
- Modify: `package.json`, `bun.lock` (via `bun add`)
- Create: `src/lib/effects/emaldo/wire.ts`
- Test: `src/lib/effects/emaldo/wire.test.ts`

**Interfaces:**
- Consumes: `snappyjs` (`uncompress(input, maxLength)`, `compress(input)`).
- Produces (module-private to the effect):
  `rc4(key: Uint8Array, data: Uint8Array): Uint8Array` · `toHex(bytes: Uint8Array): string` ·
  `fromHex(hex: string): Uint8Array | null` · `gmtimeOf(epochMs: number): string` ·
  `encodeField(secret: Uint8Array, text: string): string` ·
  `encodeBody(secret: Uint8Array, body: Record<string, unknown>, gmtime: string): string` ·
  `encodeToken(secret: Uint8Array, token: string, gmtime: string): string` ·
  `type Decoded = { ok: true; value: unknown } | { ok: false }` ·
  `decodeResult(secret: Uint8Array, hex: string): Decoded` · `MAX_DECODED_BYTES = 4 MiB`.

**Reviewers:** A = `code-reviewer`, B = `test-completeness` (effect adapter pairing).

- [ ] **Step 1: Add the dependency**

```bash
bun add snappyjs@^0.7.0
bun add -d @types/snappyjs@^0.7.1
```

- [ ] **Step 2: Write the failing test** — `src/lib/effects/emaldo/wire.test.ts`

```ts
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
```

- [ ] **Step 3: Run it, expect FAIL**

Run: `bunx vitest run src/lib/effects/emaldo/wire.test.ts`
Expected: FAIL — `Failed to resolve import "./wire"`.

- [ ] **Step 4: Implement** — `src/lib/effects/emaldo/wire.ts`

```ts
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
```

- [ ] **Step 5: Run, expect PASS**

Run: `bunx vitest run src/lib/effects/emaldo/wire.test.ts && bun run check`
Expected: 13 tests pass; Biome clean (commit anything it rewrote).

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/lib/effects/emaldo/wire.ts src/lib/effects/emaldo/wire.test.ts
git commit -m "feat(charging): add the Emaldo wire codec (RC4 + Snappy)

Hand-rolled RC4 (Node's OpenSSL 3 refuses rc4) and snappyjs for the raw
Snappy results; a result counts only once it is valid UTF-8 and JSON.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: types, `EmaldoError`, and day parsing (`emaldo.ts`, `errors.ts`, `parse.ts`)

**Files:**
- Create: `src/lib/effects/emaldo/emaldo.ts` (types only in this task; Task 4 adds the selector + facade)
- Create: `src/lib/effects/emaldo/errors.ts`
- Create: `src/lib/effects/emaldo/parse.ts`
- Create: `src/lib/effects/emaldo/fixtures.ts` (synthetic data + response sealing, used by Tasks 2–3)
- Test: `src/lib/effects/emaldo/parse.test.ts`

**Interfaces:**
- Consumes: `IntegrationError` (`../integrationError`), `IntegrationErrorCode` (`~/lib/integrationHealth`),
  `issuePath` / `summarizeIssuePaths` (`~/lib/issuePaths`), `STOCKHOLM_TIME_ZONE` / `stockholmDayOf` /
  `stockholmDayBounds` (`~/lib/time/stockholm`), `jsonResponse` (`../testing/fakeFetch`), Task 1's `wire.ts`.
- Produces (contract): `HouseBucket`, `EmaldoDay`, `EmaldoCallStats`, `newCallStats()`, `CallOpts`,
  `EmaldoClient`, `EmaldoOp`, `EmaldoError`.
- Produces (private): `SERIES_NAMES`, `SeriesName`, `SeriesDay`, `parseEnvelope(op, body): { Status: number;
  Result?: unknown }`, `parseLogin(result): string`, `parseHomeIds(result): string[]`,
  `parseDevices(result): { deviceId: string; model: string }[]`, `parseSeries(name, result): SeriesDay`,
  `buildDay(offset: number, series: Record<SeriesName, SeriesDay>): EmaldoDay`.

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: Write the types** — `src/lib/effects/emaldo/emaldo.ts` (no logic to test yet beyond `newCallStats`)

```ts
/**
 * The house's 5-minute energy flows from the Emaldo cloud (ADR-0023). The
 * client never logs; callers pass a `stats` sink. Readings are a household
 * load profile: never log or echo them.
 */
export type HouseBucket = {
  /** start_time + minute × 60 s (a UTC instant). */
  bucketStart: Date
  /** Grid import, emergency-circuit import included. */
  gridImportKwh: number
  gridExportKwh: number
  /** Every MPPT string + third-party solar. */
  solarKwh: number
  /** House load, the car charger included. */
  loadKwh: number
  batteryDischargeKwh: number
  /** Battery column `charge_mppt`. */
  batteryChargeSolarKwh: number
  batteryChargeGridKwh: number
  batteryChargeAcKwh: number
}

export type EmaldoDay = {
  /** The response's start_time: Stockholm local midnight. */
  dayStart: Date
  /** The next Stockholm midnight (DST-aware), exclusive. */
  dayEnd: Date
  /** Ascending; only buckets present in all four series, inside [dayStart, dayEnd). */
  buckets: HouseBucket[]
  /**
   * Buckets seen but not returned: in some series only, outside the day, a
   * negative reading, or (offset 0) the still-filling newest bucket.
   */
  droppedBuckets: number
}

export interface EmaldoCallStats {
  fetchMs: number
  requests: number
  retries: number
  logins: number
}

export function newCallStats(): EmaldoCallStats {
  return { fetchMs: 0, requests: 0, retries: 0, logins: 0 }
}

export interface CallOpts {
  signal?: AbortSignal
  stats?: EmaldoCallStats
}

export interface EmaldoClient {
  /** offset 0 = today (Stockholm; newest bucket dropped), -1 = yesterday, … ; offset > 0 throws RangeError. */
  fetchDay(offset: number, o?: CallOpts): Promise<EmaldoDay>
}
```

- [ ] **Step 2: Write the error** — `src/lib/effects/emaldo/errors.ts`

```ts
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type EmaldoOp = 'login' | 'discover' | 'stats'

/**
 * The one error the Emaldo client throws. `status` is the HTTP status when
 * there was one; the API's own `Status` code may appear in the message.
 * Messages are written for an admin and never carry the credentials, the app
 * id or secret, the token, home or device ids, or any reading.
 */
export class EmaldoError extends IntegrationError {
  override readonly name = 'EmaldoError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: EmaldoOp,
    readonly status?: number,
    options?: { cause?: unknown; message?: string },
  ) {
    super(
      options?.message ??
        `Emaldo ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
  }
}
```

- [ ] **Step 3: Write the synthetic fixtures** — `src/lib/effects/emaldo/fixtures.ts`

```ts
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
```

- [ ] **Step 4: Write the failing test** — `src/lib/effects/emaldo/parse.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import type { HouseBucket } from './emaldo'
import { EmaldoError } from './errors'
import { dayMinutes, seriesDay, syntheticRow } from './fixtures'
import {
  buildDay,
  parseDevices,
  parseEnvelope,
  parseHomeIds,
  parseLogin,
  parseSeries,
  SERIES_NAMES,
  type SeriesName,
} from './parse'

/** The four parsed series of `day`, each with rows at `minutes[name]` (default: the whole day). */
function day(
  date: string,
  minutes: Partial<Record<SeriesName, number[]>> = {},
  row?: (name: SeriesName, m: number) => unknown[],
) {
  return Object.fromEntries(
    SERIES_NAMES.map((n) => [n, parseSeries(n, seriesDay(n, date, minutes[n], row))]),
  ) as Record<SeriesName, ReturnType<typeof parseSeries>>
}

/** What `syntheticRow` at minute `m` must decode to — written out, not derived from the code under test. */
function expected(date: string, m: number): HouseBucket {
  const k = m / 5 + 1
  return {
    bucketStart: new Date(stockholmDayBounds(date).startMs + m * 60_000),
    gridImportKwh: (12 * k + 6) / 12_000,
    gridExportKwh: (24 * k) / 12_000,
    solarKwh: (120 + 240 + 36 * k + 48) / 12_000,
    loadKwh: (60 * k) / 12_000,
    batteryDischargeKwh: 72 / 12_000,
    batteryChargeSolarKwh: 84 / 12_000,
    batteryChargeGridKwh: 96 / 12_000,
    batteryChargeAcKwh: 108 / 12_000,
  }
}

const unexpected = (fn: () => unknown, at?: string) => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(EmaldoError)
    expect(err).toMatchObject({ code: 'unexpected_response' })
    if (at) expect((err as Error).message).toContain(at)
    return
  }
  throw new Error('expected an EmaldoError')
}

describe('buildDay', () => {
  test('a normal day: 288 buckets, columns mapped, kWh = W / 12 000, bounds exact', () => {
    const out = buildDay(-1, day('2026-06-10'))
    const { startMs, endMs } = stockholmDayBounds('2026-06-10')
    expect(out.dayStart).toEqual(new Date(startMs))
    expect(out.dayEnd).toEqual(new Date(endMs))
    expect(out.buckets).toHaveLength(288)
    expect(out.droppedBuckets).toBe(0)
    expect(out.buckets[0]).toEqual(expected('2026-06-10', 0))
    expect(out.buckets[287]).toEqual(expected('2026-06-10', 1435))
  })

  test('spring-forward day: 276 buckets over 23 h, bucket starts continuous in UTC', () => {
    const out = buildDay(-1, day('2026-03-29'))
    expect(out.buckets).toHaveLength(276)
    expect(out.dayEnd.getTime() - out.dayStart.getTime()).toBe(23 * 3_600_000)
    expect(out.buckets.at(-1)).toEqual(expected('2026-03-29', 1375))
    const steps = new Set(
      out.buckets.slice(1).map((b, i) => +b.bucketStart - +out.buckets[i].bucketStart),
    )
    expect([...steps]).toEqual([300_000])
  })

  test('fall-back day: 300 buckets over 25 h', () => {
    const out = buildDay(-1, day('2025-10-26'))
    expect(out.buckets).toHaveLength(300)
    expect(out.dayEnd.getTime() - out.dayStart.getTime()).toBe(25 * 3_600_000)
    expect(out.buckets.at(-1)).toEqual(expected('2025-10-26', 1495))
  })

  test('a row at or past the next midnight is dropped and counted', () => {
    const extra = [...dayMinutes('2026-06-10'), 1440, 1445]
    const out = buildDay(
      -1,
      day('2026-06-10', { grid: extra, mppt: extra, usage: extra, battery: extra }),
    )
    expect(out.buckets).toHaveLength(288)
    expect(out.droppedBuckets).toBe(2)
  })

  test('a gap in all four series is just absent; a bucket missing from one series is dropped', () => {
    const all = dayMinutes('2026-03-18')
    const gap = all.filter((m) => m < 180 || m >= 275) // the 95-min hole shape
    const out = buildDay(-1, day('2026-03-18', { grid: gap, mppt: gap, usage: gap, battery: gap }))
    expect(out.buckets).toHaveLength(gap.length)
    expect(out.droppedBuckets).toBe(0)

    const noUsageAt10 = all.filter((m) => m !== 10)
    const partial = buildDay(-1, day('2026-03-18', { usage: noUsageAt10 }))
    expect(partial.buckets).toHaveLength(287)
    expect(partial.buckets.map((b) => b.bucketStart)).not.toContainEqual(
      expected('2026-03-18', 10).bucketStart,
    )
    expect(partial.droppedBuckets).toBe(1)
  })

  test('today drops the still-filling newest bucket, from the earliest series newest on', () => {
    const upTo = (last: number) => dayMinutes('2026-10-03').filter((m) => m <= last)
    const same = buildDay(
      0,
      day('2026-10-03', { grid: upTo(430), mppt: upTo(430), usage: upTo(430), battery: upTo(430) }),
    )
    expect(same.buckets).toHaveLength(86)
    expect(same.buckets.at(-1)?.bucketStart).toEqual(expected('2026-10-03', 425).bucketStart)
    expect(same.droppedBuckets).toBe(1)

    // grid already has 435, usage only up to 425: 425 and everything after go.
    const ragged = buildDay(
      0,
      day('2026-10-03', { grid: upTo(435), mppt: upTo(430), usage: upTo(425), battery: upTo(430) }),
    )
    expect(ragged.buckets.at(-1)?.bucketStart).toEqual(expected('2026-10-03', 420).bucketStart)
    expect(ragged.droppedBuckets).toBe(3) // 425, 430, 435

    // Yesterday keeps its last bucket.
    expect(buildDay(-1, day('2026-10-02')).buckets).toHaveLength(288)
  })

  test('an empty day (far past, or today just after midnight) is no buckets', () => {
    const none = { grid: [], mppt: [], usage: [], battery: [] }
    expect(buildDay(-1100, day('2023-09-29', none))).toMatchObject({
      buckets: [],
      droppedBuckets: 0,
    })
    expect(buildDay(0, day('2026-10-03', none))).toMatchObject({ buckets: [], droppedBuckets: 0 })
  })

  test('a negative reading in a used column drops that bucket; unused columns may be anything', () => {
    const row = (name: SeriesName, m: number) => {
      const r: unknown[] = syntheticRow(name, m)
      if (name === 'battery' && m === 60) r[3] = -1
      // A negative emergency import must not hide inside the import sum.
      if (name === 'grid' && m === 65) r[2] = -1
      if (name === 'grid') r[4] = null // an unused column
      return r
    }
    const out = buildDay(-1, day('2026-06-10', {}, row))
    expect(out.buckets).toHaveLength(286)
    expect(out.droppedBuckets).toBe(2)
  })

  test('series that disagree on the day, or a day not starting at Stockholm midnight, are refused', () => {
    const mixed = { ...day('2026-06-10'), usage: day('2026-06-11').usage }
    unexpected(() => buildDay(-1, mixed), 'disagree')
    const shifted = Object.fromEntries(
      Object.entries(day('2026-06-10')).map(([n, s]) => [
        n,
        { ...s, startTime: s.startTime + 3600 },
      ]),
    ) as ReturnType<typeof day>
    unexpected(() => buildDay(-1, shifted), 'Stockholm midnight')
  })
})

describe('parseSeries', () => {
  const base = () => seriesDay('grid', '2026-06-10', [0, 5])

  test.each([
    ['timezone', { timezone: 'UTC' }],
    ['interval', { interval: 15 }],
    ['start_time', { start_time: '1781042400' }],
    ['data', { data: null }],
    [
      'data.1.0',
      {
        data: [
          [0, 1, 2, 3],
          [7, 1, 2, 3],
        ],
      },
    ], // minute not on the 5-min grid
    ['data.0.3', { data: [[0, 1, 2]] }], // row too short
    ['data.0.1', { data: [[0, 'x', 2, 3]] }],
  ])('a wrong %s is unexpected_response naming the path, never the value', (at, patch) => {
    unexpected(() => parseSeries('grid', { ...base(), ...patch }), at)
  })

  test('a repeated minute is unexpected_response', () => {
    unexpected(
      () => parseSeries('usage', { ...seriesDay('usage', '2026-06-10', [0, 0]) }),
      'repeats',
    )
  })

  test('more than 400 rows is refused', () => {
    const rows = Array.from({ length: 401 }, (_, i) => i * 5)
    unexpected(() => parseSeries('mppt', seriesDay('mppt', '2026-06-10', rows)), 'data')
  })
})

describe('envelope, login and discovery', () => {
  test('envelope needs an integer Status', () => {
    expect(parseEnvelope('stats', { Status: -12 })).toEqual({ Status: -12 })
    unexpected(() => parseEnvelope('stats', { Status: '1' }), 'Status')
    unexpected(() => parseEnvelope('stats', []), '(root)')
  })

  test('login needs a non-empty token', () => {
    expect(parseLogin({ token: 'abc', user_id: 'u' })).toBe('abc')
    unexpected(() => parseLogin({ token: '' }), 'token')
    unexpected(() => parseLogin({}), 'token')
  })

  test('homes and devices: lists may be null or missing; entries must carry ids', () => {
    expect(parseHomeIds({ list_homes: [{ home_id: 'a', name: 'x' }, { home_id: 'b' }] })).toEqual([
      'a',
      'b',
    ])
    expect(parseHomeIds({ list_homes: null })).toEqual([])
    expect(parseHomeIds({})).toEqual([])
    expect(parseDevices({ bmts: [{ id: 'd', model: 'm', name: 'n' }] })).toEqual([
      { deviceId: 'd', model: 'm' },
    ])
    expect(parseDevices({ bmts: null })).toEqual([])
    unexpected(() => parseHomeIds({ list_homes: [{ home_id: 7 }] }), 'list_homes.0.home_id')
    unexpected(() => parseDevices({ bmts: [{ id: 'd' }] }), 'bmts.0.model')
  })
})
```

- [ ] **Step 5: Run it, expect FAIL**

Run: `bunx vitest run src/lib/effects/emaldo/parse.test.ts`
Expected: FAIL — `Failed to resolve import "./parse"` (from the test and from `fixtures.ts`).

- [ ] **Step 6: Implement** — `src/lib/effects/emaldo/parse.ts`

```ts
import { z } from 'zod'
import { issuePath, summarizeIssuePaths } from '~/lib/issuePaths'
import { STOCKHOLM_TIME_ZONE, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'
import type { EmaldoDay, HouseBucket } from './emaldo'
import { EmaldoError, type EmaldoOp } from './errors'

export const SERIES_NAMES = ['grid', 'mppt', 'usage', 'battery'] as const
export type SeriesName = (typeof SERIES_NAMES)[number]

const BUCKET_MINUTES = 5
/** Average W over one 5-min bucket → kWh: W × 5 / 60 / 1000 = W / 12 000. */
const W_PER_KWH_BUCKET = (60 / BUCKET_MINUTES) * 1000
/** A 25-h day has 300 rows; anything far beyond is not a day series. */
const MAX_ROWS = 400
const MAX_HOMES = 100

function unexpected(op: EmaldoOp, message: string): EmaldoError {
  return new EmaldoError('unexpected_response', op, undefined, { message })
}

function parse<T>(op: EmaldoOp, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const at = summarizeIssuePaths(parsed.error.issues.map((i) => issuePath(i.path)))
  throw unexpected(op, `Emaldo ${op} response has an unexpected shape at: ${at}`)
}

// ---- envelope, login, discovery -------------------------------------------

const envelopeSchema = z.object({ Status: z.int(), Result: z.unknown().optional() })
export type Envelope = z.infer<typeof envelopeSchema>

export function parseEnvelope(op: EmaldoOp, body: unknown): Envelope {
  return parse(op, envelopeSchema, body)
}

const loginSchema = z.object({ token: z.string().min(1).max(256) })

export function parseLogin(result: unknown): string {
  return parse('login', loginSchema, result).token
}

const id = z.string().min(1).max(128)
const homesSchema = z.object({
  list_homes: z
    .array(z.object({ home_id: id }))
    .max(MAX_HOMES)
    .nullish(),
})
const devicesSchema = z.object({
  bmts: z
    .array(z.object({ id, model: id }))
    .max(MAX_HOMES)
    .nullish(),
})

export function parseHomeIds(result: unknown): string[] {
  return (parse('discover', homesSchema, result).list_homes ?? []).map((h) => h.home_id)
}

export function parseDevices(result: unknown): { deviceId: string; model: string }[] {
  return (parse('discover', devicesSchema, result).bmts ?? []).map((d) => ({
    deviceId: d.id,
    model: d.model,
  }))
}

// ---- day series -----------------------------------------------------------

const minute = z.int().nonnegative().multipleOf(BUCKET_MINUTES)
const w = z.number() // finite; a negative reading drops its bucket in `buildDay`
const rest = z.unknown() // columns we don't use may be anything
const ROWS = {
  grid: z.tuple([minute, w, w, w], rest), // min, import, emergency import, export, …
  mppt: z.tuple([minute, w, w, w, w], rest), // min, string 1, 2, 3, third-party, …
  usage: z.tuple([minute, w, w], rest), // min, ?, load (charger included), …
  battery: z.tuple([minute, w, w, w, w], rest), // min, discharge, charge_mppt, charge_grid, charge_ac, …
}

const dayOf = <T extends z.ZodType>(row: T) =>
  z.object({
    start_time: z.int().positive(),
    timezone: z.literal(STOCKHOLM_TIME_ZONE),
    interval: z.literal(BUCKET_MINUTES),
    data: z.array(row).max(MAX_ROWS),
  })

/** One series of one day: minute → the raw watt columns we use, in a fixed order. */
export type SeriesDay = { startTime: number; rows: Map<number, readonly number[]> }

function collect<R extends readonly [number, ...unknown[]]>(
  day: { start_time: number; data: R[] },
  used: (row: R) => number[],
): SeriesDay {
  const rows = new Map<number, readonly number[]>()
  for (const row of day.data) {
    if (rows.has(row[0])) throw unexpected('stats', 'Emaldo stats response repeats a minute')
    rows.set(row[0], used(row))
  }
  return { startTime: day.start_time, rows }
}

export function parseSeries(name: SeriesName, result: unknown): SeriesDay {
  switch (name) {
    case 'grid':
      return collect(parse('stats', dayOf(ROWS.grid), result), (r) => [r[1], r[2], r[3]])
    case 'mppt':
      return collect(parse('stats', dayOf(ROWS.mppt), result), (r) => [r[1], r[2], r[3], r[4]])
    case 'usage':
      return collect(parse('stats', dayOf(ROWS.usage), result), (r) => [r[2]])
    case 'battery':
      return collect(parse('stats', dayOf(ROWS.battery), result), (r) => [r[1], r[2], r[3], r[4]])
  }
}

const kwh = (watts: number) => watts / W_PER_KWH_BUCKET
const newest = (rows: Map<number, unknown>) => (rows.size > 0 ? Math.max(...rows.keys()) : -1)

/**
 * The four series of one day → the buckets present in all of them, inside
 * [start_time, next Stockholm midnight). Offset 0 (today) also drops the
 * still-filling newest bucket: everything from the earliest of the four
 * series' newest minutes on.
 */
export function buildDay(offset: number, series: Record<SeriesName, SeriesDay>): EmaldoDay {
  const startTime = series.grid.startTime
  if (SERIES_NAMES.some((n) => series[n].startTime !== startTime)) {
    throw unexpected('stats', 'Emaldo day series disagree on the day start')
  }
  const startMs = startTime * 1000
  const { startMs: midnight, endMs } = stockholmDayBounds(stockholmDayOf(startMs))
  if (midnight !== startMs)
    throw unexpected('stats', 'Emaldo day does not start at a Stockholm midnight')

  const cutoff =
    offset === 0 ? Math.min(...SERIES_NAMES.map((n) => newest(series[n].rows))) : Infinity
  const minutes = new Set(SERIES_NAMES.flatMap((n) => [...series[n].rows.keys()]))
  const buckets: HouseBucket[] = []
  for (const m of [...minutes].sort((a, b) => a - b)) {
    const at = startMs + m * 60_000
    const g = series.grid.rows.get(m)
    const p = series.mppt.rows.get(m)
    const u = series.usage.rows.get(m)
    const b = series.battery.rows.get(m)
    if (!g || !p || !u || !b || at >= endMs || m >= cutoff) continue
    if ([g, p, u, b].some((cols) => cols.some((watts) => watts < 0))) continue
    buckets.push({
      bucketStart: new Date(at),
      gridImportKwh: kwh(g[0] + g[1]),
      gridExportKwh: kwh(g[2]),
      solarKwh: kwh(p[0] + p[1] + p[2] + p[3]),
      loadKwh: kwh(u[0]),
      batteryDischargeKwh: kwh(b[0]),
      batteryChargeSolarKwh: kwh(b[1]),
      batteryChargeGridKwh: kwh(b[2]),
      batteryChargeAcKwh: kwh(b[3]),
    })
  }
  return {
    dayStart: new Date(startMs),
    dayEnd: new Date(endMs),
    buckets,
    droppedBuckets: minutes.size - buckets.length,
  }
}
```

- [ ] **Step 7: Run, expect PASS**

Run: `bunx vitest run src/lib/effects/emaldo/ && bun run check`
Expected: wire + parse tests pass (13 + 21); Biome clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/effects/emaldo/
git commit -m "feat(charging): parse Emaldo day series into house buckets

Buckets present in all four series, inside the Stockholm day (276/288/300),
today's still-filling bucket dropped; shape errors name paths only.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: the client (`client.ts`)

**Files:**
- Create: `src/lib/effects/emaldo/client.ts`
- Test: `src/lib/effects/emaldo/emaldo.test.ts`

**Interfaces:**
- Consumes: `fetchWithRetry`, `discard`, `networkCause` (`../http`); Tasks 1–2.
- Produces (contract): `createEmaldoClient(deps: { fetch: typeof globalThis.fetch; user: string; password: string;
  appId: string; appSecret: string }): EmaldoClient` — lazy login, token + home/device cached per instance, one
  shared in-flight login, one re-login per request on `Status -12`, `fetchDay(offset)` with `offset > 0` (or
  non-integer) → `RangeError` before any request.

**Reviewers:** A = `code-reviewer`, B = `test-completeness`. Tell both to start from the assumption that the
re-login, the abort handling and the leak checks are wrong.

- [ ] **Step 1: Write the failing test** — `src/lib/effects/emaldo/emaldo.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch, jsonResponse } from '../testing/fakeFetch'
import { createEmaldoClient } from './client'
import { newCallStats } from './emaldo'
import type { EmaldoError } from './errors'
import {
  DEVICE_ID,
  EMPTY_HOME_ID,
  HOME_ID,
  MODEL,
  okReply,
  openRequest,
  seriesDay,
  statusReply,
  TEST_APP_ID,
  TEST_APP_SECRET,
  TEST_PASSWORD,
  TEST_TOKEN,
  TEST_TOKEN_2,
  TEST_USER,
} from './fixtures'
import { SERIES_NAMES, type SeriesName } from './parse'

// ky waits on real timers: fake them, jumping straight to the next one (as skoda.test.ts).
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

const LOGIN = `POST /user/login/${TEST_APP_ID}`
const HOMES = `POST /home/list-homes/${TEST_APP_ID}`
const DEVICES = `POST /bmt/list-bmt/${TEST_APP_ID}`
const STATS: Record<SeriesName, string> = {
  grid: `POST /bmt/stats/grid/day/${TEST_APP_ID}`,
  mppt: `POST /bmt/stats/mppt-v2/day/${TEST_APP_ID}`,
  usage: `POST /bmt/stats/load/usage-v2/day/${TEST_APP_ID}`,
  battery: `POST /bmt/stats/battery-v2/day/${TEST_APP_ID}`,
}
const SECRETS = [
  TEST_USER,
  TEST_PASSWORD,
  TEST_TOKEN,
  TEST_APP_ID,
  TEST_APP_SECRET,
  HOME_ID,
  DEVICE_ID,
]

/**
 * A fake Emaldo cloud: logins hand out TEST_TOKEN, then TEST_TOKEN_2; stats
 * calls answer -12 unless sent with the accepted token (default: the newest
 * one issued; tests can move it). Every route can be overridden.
 */
function server(overrides: Partial<Record<string, FakeRoute>> = {}) {
  const tokens = [TEST_TOKEN, TEST_TOKEN_2]
  let issued = 0
  const state = { accept: null as string | null }
  const accepted = () => state.accept ?? tokens[issued - 1]
  const stats =
    (name: SeriesName): FakeRoute =>
    async (req) => {
      const { token } = await openRequest(req)
      if (token?.split('_')[0] !== accepted()) return statusReply(-12)
      return okReply(seriesDay(name, '2026-06-10'))
    }
  const routes: Record<string, FakeRoute> = {
    [LOGIN]: () => okReply({ token: tokens[issued++] ?? 'extra-token', user_id: 'u-1' }),
    [HOMES]: () => okReply({ list_homes: [{ home_id: EMPTY_HOME_ID }, { home_id: HOME_ID }] }),
    [DEVICES]: async (req) => {
      const { json } = await openRequest(req)
      return json?.includes(HOME_ID)
        ? okReply({ bmts: [{ id: DEVICE_ID, model: MODEL, name: 'Power Core' }] })
        : okReply({ bmts: null })
    },
    ...Object.fromEntries(SERIES_NAMES.map((n) => [STATS[n], stats(n)])),
  }
  for (const [key, route] of Object.entries(overrides)) if (route) routes[key] = route
  const f = fakeFetch(routes)
  const client = createEmaldoClient({
    fetch: f.fetch,
    user: TEST_USER,
    password: TEST_PASSWORD,
    appId: TEST_APP_ID,
    appSecret: TEST_APP_SECRET,
  })
  return { f, client, state }
}

const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as EmaldoError,
  )
const leaksNothing = (err: EmaldoError) => {
  const text = `${err.message} ${JSON.stringify(err.cause ?? null)}`
  for (const s of SECRETS) expect(text).not.toContain(s)
}

describe('wire format', () => {
  test('login: api host, app id in the path, okhttp headers, encrypted body with gmtime, no token', async () => {
    const { f, client } = server()
    await client.fetchDay(-1)
    const [login] = f.callsTo(LOGIN)
    const url = new URL(login.url)
    expect(url.host).toBe('api.emaldo.com')
    expect(login.headers.get('user-agent')).toBe('okhttp/4.9.0')
    expect(login.headers.get('x-online-host')).toBe('api.emaldo.com')
    expect(login.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(login.redirect).toBe('error')
    const fields = await openRequest(login)
    const gmtime = `${NOW.getTime()}000000`
    expect(fields).toEqual({
      json: `{"email":"${TEST_USER}","password":"${TEST_PASSWORD}","gmtime":${gmtime}}`,
      token: null,
      gm: '1',
    })
  })

  test('discovery: list-homes sends only the token; list-bmt sends the home query', async () => {
    const { f, client } = server()
    await client.fetchDay(-1)
    const homes = await openRequest(f.callsTo(HOMES)[0])
    expect(homes.json).toBeNull()
    expect(homes.token).toBe(`${TEST_TOKEN}_${NOW.getTime()}000000`)
    const devices = await openRequest(f.callsTo(DEVICES)[0])
    expect(JSON.parse(devices.json?.replace(/"gmtime":\d+/, '"gmtime":0') ?? '')).toEqual({
      home_id: EMPTY_HOME_ID,
      models: [],
      page_size: 30,
      addtime: 1,
      order: 'asc',
      gmtime: 0,
    })
  })

  test('stats: data-plane host, the device query, grid asks for real 5-min data', async () => {
    const { f, client } = server()
    await client.fetchDay(-3)
    const grid = f.callsTo(STATS.grid)[0]
    expect(new URL(grid.url).host).toBe('dp.emaldo.com')
    expect(grid.headers.get('x-online-host')).toBe('dp.emaldo.com')
    const { json, token } = await openRequest(grid)
    expect(json).toBe(
      `{"home_id":"${HOME_ID}","id":"${DEVICE_ID}","model":"${MODEL}","offset":-3,"get_real":true,"query_interval":5,"gmtime":${NOW.getTime()}000000}`,
    )
    expect(token).toBe(`${TEST_TOKEN}_${NOW.getTime()}000000`)
    const usage = await openRequest(f.callsTo(STATS.usage)[0])
    expect(usage.json).toContain('"offset":-3,"gmtime":')
  })
})

describe('fetchDay', () => {
  test('logs in, discovers the home that has a battery, and returns the decoded day', async () => {
    const { f, client } = server()
    const stats = newCallStats()
    const day = await client.fetchDay(-1, { stats })
    expect(day.buckets).toHaveLength(288)
    expect(day.droppedBuckets).toBe(0)
    expect(day.dayStart).toEqual(new Date('2026-06-09T22:00:00Z'))
    expect(day.dayEnd).toEqual(new Date('2026-06-10T22:00:00Z'))
    expect(f.callsTo(DEVICES)).toHaveLength(2) // the empty home first, then ours
    expect(stats).toMatchObject({ requests: 8, retries: 0, logins: 1 }) // login, homes, 2 × list-bmt, 4 series
  })

  test('a second day reuses the token and the device: four requests, no login', async () => {
    const { f, client } = server()
    await client.fetchDay(-1)
    const stats = newCallStats()
    await client.fetchDay(-2, { stats })
    expect(stats).toMatchObject({ requests: 4, logins: 0 })
    expect(f.callsTo(LOGIN)).toHaveLength(1)
    expect(f.callsTo(HOMES)).toHaveLength(1)
  })

  test('concurrent first calls share one login and one discovery', async () => {
    const { f, client } = server()
    await Promise.all([client.fetchDay(-1), client.fetchDay(-2)])
    expect(f.callsTo(LOGIN)).toHaveLength(1)
    expect(f.callsTo(HOMES)).toHaveLength(1)
  })

  test('a plain (uncompressed) result is read too', async () => {
    const { client } = server({
      [STATS.usage]: () => okReply(seriesDay('usage', '2026-06-10'), { snappy: false }),
    })
    expect((await client.fetchDay(-1)).buckets).toHaveLength(288)
  })

  test.each([
    1,
    0.5,
    Number.NaN,
  ])('offset %s is a RangeError before any request', async (offset) => {
    const { f, client } = server()
    await expect(client.fetchDay(offset)).rejects.toBeInstanceOf(RangeError)
    expect(f.calls).toHaveLength(0)
  })
})

describe('session expiry (Status -12)', () => {
  test('an expired token: one re-login, the device kept, the call retried', async () => {
    const { f, client, state } = server()
    await client.fetchDay(-1)
    state.accept = TEST_TOKEN_2 // the server has dropped the first session
    const stats = newCallStats()
    expect((await client.fetchDay(-2, { stats })).buckets).toHaveLength(288)
    // All four series saw -12 at once; one shared re-login served them all.
    expect(f.callsTo(LOGIN)).toHaveLength(2)
    expect(f.callsTo(HOMES)).toHaveLength(1)
    expect(stats).toMatchObject({ logins: 1, requests: 9 }) // 4 refused + 1 login + 4 retried
    for (const n of SERIES_NAMES) expect(f.callsTo(STATS[n])).toHaveLength(3)
  })

  test('-12 again right after the re-login is auth_failed', async () => {
    const { f, client } = server(
      Object.fromEntries(SERIES_NAMES.map((n) => [STATS[n], () => statusReply(-12)])),
    )
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ name: 'EmaldoError', code: 'auth_failed', op: 'stats' })
    expect(f.callsTo(LOGIN)).toHaveLength(2) // the first login + exactly one re-login
    leaksNothing(err)
  })

  test('-12 during discovery on a fresh token is auth_failed', async () => {
    const { client } = server({ [HOMES]: () => statusReply(-12) })
    expect(await caught(client.fetchDay(-1))).toMatchObject({ code: 'auth_failed', op: 'discover' })
  })
})

describe('failures', () => {
  test.each([
    -3, -12, 0,
  ])('a refused login (Status %i) is auth_failed and echoes nothing', async (status) => {
    const { f, client } = server({ [LOGIN]: () => statusReply(status) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'auth_failed', op: 'login' })
    expect(err.message).toContain(`Status ${status}`)
    expect(f.callsTo(HOMES)).toHaveLength(0)
    leaksNothing(err)
  })

  test('a failed login is not cached: the next call logs in again', async () => {
    let call = 0
    const { f, client, state } = server({
      [LOGIN]: () => (call++ === 0 ? statusReply(-3) : okReply({ token: TEST_TOKEN })),
    })
    state.accept = TEST_TOKEN
    await caught(client.fetchDay(-1))
    await expect(client.fetchDay(-1)).resolves.toMatchObject({ droppedBuckets: 0 })
    expect(f.callsTo(LOGIN)).toHaveLength(2)
  })

  test.each([
    -1, -999, 2,
  ])('an unknown Status %i on stats is unexpected_response', async (status) => {
    const { client } = server({ [STATS.battery]: () => statusReply(status) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'stats' })
    leaksNothing(err)
  })

  test('no home with a battery is unexpected_response from discover', async () => {
    const { client } = server({ [DEVICES]: () => okReply({ bmts: [] }) })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'discover' })
    expect(err.message).toContain('battery')
    leaksNothing(err)
  })

  test('a failed discovery keeps the token and is retried on the next call', async () => {
    let call = 0
    const { f, client } = server({
      [HOMES]: () =>
        call++ === 0
          ? okReply({ list_homes: [] })
          : okReply({ list_homes: [{ home_id: HOME_ID }] }),
    })
    await caught(client.fetchDay(-1))
    await expect(client.fetchDay(-1)).resolves.toBeDefined()
    expect(f.callsTo(LOGIN)).toHaveLength(1)
    expect(f.callsTo(HOMES)).toHaveLength(2)
  })

  test('a result sealed with another secret hints that the app secret rotated', async () => {
    const { client } = server({
      [LOGIN]: () => okReply({ token: TEST_TOKEN }, { secret: 'rotated' }),
    })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
    expect(err.message).toContain('app id/secret may have rotated')
    leaksNothing(err)
  })

  test('a Status 1 without a string Result is unexpected_response', async () => {
    const { client } = server({
      [HOMES]: () => jsonResponse({ Status: 1, Result: { list_homes: [] } }),
    })
    expect(await caught(client.fetchDay(-1))).toMatchObject({
      code: 'unexpected_response',
      op: 'discover',
    })
  })

  test('a body that is not JSON, or has no integer Status, is unexpected_response', async () => {
    const html = server({ [STATS.grid]: () => new Response('<html>', { status: 200 }) })
    expect(await caught(html.client.fetchDay(-1))).toMatchObject({
      code: 'unexpected_response',
      op: 'stats',
    })
    const shape = server({ [STATS.grid]: () => jsonResponse({ status: 1 }) })
    const err = await caught(shape.client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response' })
    expect(err.message).toContain('at: Status')
  })

  test('a day that fails the schema is unexpected_response naming the path only', async () => {
    const { client } = server({
      [STATS.mppt]: () => okReply({ ...seriesDay('mppt', '2026-06-10'), timezone: 'UTC' }),
    })
    const err = await caught(client.fetchDay(-1))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'stats' })
    expect(err.message).toContain('at: timezone')
  })

  test.each([
    [500, 'unreachable', 1],
    [404, 'unexpected_response', 1],
    [429, 'rate_limited', 1],
  ] as const)('HTTP %i → %s, %i call', async (status, code, calls) => {
    const { f, client } = server({ [LOGIN]: () => new Response('x', { status }) })
    expect(await caught(client.fetchDay(-1))).toMatchObject({ code, op: 'login', status })
    expect(f.callsTo(LOGIN)).toHaveLength(calls)
  })

  test.each([502, 503, 504])('%i is retried once, then unreachable', async (status) => {
    const flaky = server({
      [STATS.grid]: (_req, call) =>
        call === 0 ? new Response(null, { status }) : okReply(seriesDay('grid', '2026-06-10')),
    })
    const stats = newCallStats()
    await expect(flaky.client.fetchDay(-1, { stats })).resolves.toBeDefined()
    expect(stats.retries).toBe(1)

    const down = server({ [STATS.grid]: () => new Response(null, { status }) })
    expect(await caught(down.client.fetchDay(-1))).toMatchObject({ code: 'unreachable', status })
    expect(down.f.callsTo(STATS.grid)).toHaveLength(2)
  })

  test('network failures and timeouts are unreachable, retried once, and echo nothing', async () => {
    const net = server({
      [STATS.grid]: () => {
        throw Object.assign(new TypeError(`fetch failed for ${TEST_APP_ID} ${TEST_TOKEN}`), {
          code: 'ECONNRESET',
        })
      },
    })
    const netErr = await caught(net.client.fetchDay(-1))
    expect(netErr).toMatchObject({ code: 'unreachable', op: 'stats' })
    expect(netErr.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
    expect(net.f.callsTo(STATS.grid)).toHaveLength(2)
    leaksNothing(netErr)

    const hang = server({
      [STATS.grid]: (req) =>
        new Promise<Response>((_res, rej) =>
          req.signal.addEventListener('abort', () => rej(req.signal.reason)),
        ),
    })
    const hangErr = await caught(hang.client.fetchDay(-1))
    expect(hangErr).toMatchObject({ code: 'unreachable' })
    expect(hangErr.cause).toEqual({ name: 'TimeoutError' })
    expect(hang.f.callsTo(STATS.grid)).toHaveLength(2)
  })

  test('a caller abort is final: unreachable, nothing retried; a pre-aborted call sends nothing', async () => {
    const ctl = new AbortController()
    const { f, client } = server({
      [STATS.grid]: (req) =>
        new Promise<Response>((_res, rej) => {
          req.signal.addEventListener('abort', () => rej(req.signal.reason))
          ctl.abort()
        }),
    })
    expect(await caught(client.fetchDay(-1, { signal: ctl.signal }))).toMatchObject({
      code: 'unreachable',
    })
    expect(f.callsTo(STATS.grid)).toHaveLength(1)

    const pre = server()
    expect(await caught(pre.client.fetchDay(-1, { signal: AbortSignal.abort() }))).toMatchObject({
      code: 'unreachable',
    })
    expect(pre.f.calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bunx vitest run src/lib/effects/emaldo/emaldo.test.ts`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 3: Implement** — `src/lib/effects/emaldo/client.ts`

```ts
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

  /** A reply on a token that is seconds old: -12 here means the login itself is not accepted. */
  function fresh(op: EmaldoOp, reply: Reply): unknown {
    if (reply.expired) {
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
  async function discover(current: string, stats: EmaldoCallStats): Promise<Device> {
    const homes = parseHomeIds(
      fresh(
        'discover',
        await post('discover', '/home/list-homes/', { token: current }, undefined, stats),
      ),
    )
    for (const homeId of homes.slice(0, MAX_HOMES_CHECKED)) {
      const json = { home_id: homeId, models: [], page_size: 30, addtime: 1, order: 'asc' }
      const [found] = parseDevices(
        fresh(
          'discover',
          await post('discover', '/bmt/list-bmt/', { json, token: current }, undefined, stats),
        ),
      )
      if (found) return { homeId, ...found }
    }
    throw new EmaldoError('unexpected_response', 'discover', undefined, {
      message: 'No Emaldo home on this account has a battery device',
    })
  }

  async function establish(stats: EmaldoCallStats): Promise<Session> {
    token ??= await logIn(stats)
    device ??= await discover(token, stats)
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
```

- [ ] **Step 4: Run, expect PASS**

Run: `bunx vitest run src/lib/effects/emaldo/ && bun run check`
Expected: all pass (13 + 21 + 34); Biome clean. If a count differs, check which test is missing rather than
adjusting the number.

- [ ] **Step 5: Commit**

```bash
git add src/lib/effects/emaldo/client.ts src/lib/effects/emaldo/emaldo.test.ts
git commit -m "feat(charging): add the Emaldo cloud client

Lazy login and discovery (the home that has a battery), the four day
series in parallel, one shared re-login on Status -12, ADR-0019 retries.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: adapter selection, facade, registration, env and docs

**Files:**
- Modify: `src/lib/effects/emaldo/emaldo.ts` (prepend the `lazy` import; append selector + facade)
- Create: `src/lib/effects/emaldo/adapters/notConfigured.ts`, `src/lib/effects/emaldo/index.ts`
- Modify: `src/lib/effects/index.ts` (register), `src/lib/effects/emaldo/emaldo.test.ts` (selection tests)
- Verify: `.env.example` (EMALDO_* already present). Modify: `src/lib/effects/http.ts` (comments lines 1 and 45),
  `src/lib/effects/testing/fakeFetch.ts` (comment line 2)
- Modify (docs commit): `CLAUDE.md` (lines 25, 65, env-var list after line 197), the spec's "What the API does" and
  "Sync" bullets

**Interfaces:**
- Produces (contract): `selectEmaldoAdapter(env: Record<string, string | undefined>): 'notConfigured' | 'http'`
  (`http` only when `EMALDO_USER`, `EMALDO_PASSWORD`, `EMALDO_APP_ID`, `EMALDO_APP_SECRET` are all non-empty and
  `VITEST !== 'true'`); `export const emaldo: EmaldoClient`; barrel `src/lib/effects/emaldo/index.ts`;
  `export { emaldo } from './emaldo'` in `src/lib/effects/index.ts`.

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: Write the failing test.** In `src/lib/effects/emaldo/emaldo.test.ts`, replace the three imports

```ts
import { createEmaldoClient } from './client'
import { newCallStats } from './emaldo'
import type { EmaldoError } from './errors'
```
with the barrel:
```ts
import {
  createEmaldoClient,
  type EmaldoError,
  emaldo as emaldoSingleton,
  newCallStats,
  selectEmaldoAdapter,
} from '.'
```
and insert this block right before `describe('wire format', () => {`:
```ts
describe('adapter selection', () => {
  const all = { EMALDO_USER: 'u', EMALDO_PASSWORD: 'p', EMALDO_APP_ID: 'i', EMALDO_APP_SECRET: 's' }

  test('http only with all four variables, never under VITEST', () => {
    expect(selectEmaldoAdapter(all)).toBe('http')
    for (const key of Object.keys(all)) {
      expect(selectEmaldoAdapter({ ...all, [key]: '' })).toBe('notConfigured')
      expect(selectEmaldoAdapter({ ...all, [key]: undefined })).toBe('notConfigured')
    }
    expect(selectEmaldoAdapter({ ...all, VITEST: 'true' })).toBe('notConfigured')
  })

  test('the exported singleton fails closed as not_configured under VITEST', async () => {
    await expect(emaldoSingleton.fetchDay(-1)).rejects.toMatchObject({
      name: 'EmaldoError',
      code: 'not_configured',
      op: 'stats',
    })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bunx vitest run src/lib/effects/emaldo/emaldo.test.ts`
Expected: FAIL — `Failed to resolve import "."` (no `index.ts` yet).

- [ ] **Step 3: Implement.**

`src/lib/effects/emaldo/emaldo.ts` — add as the first line, followed by a blank line:
```ts
import { lazy } from '../lazy'
```
and append at the end of the file:
```ts

type Env = Record<string, string | undefined>

/** `http` only when all four EMALDO_* variables are set — never under VITEST. */
export function selectEmaldoAdapter(env: Env): 'notConfigured' | 'http' {
  if (env.VITEST === 'true') return 'notConfigured'
  return env.EMALDO_USER && env.EMALDO_PASSWORD && env.EMALDO_APP_ID && env.EMALDO_APP_SECRET
    ? 'http'
    : 'notConfigured'
}

const getAdapter = lazy(async (): Promise<EmaldoClient> => {
  const { EMALDO_USER, EMALDO_PASSWORD, EMALDO_APP_ID, EMALDO_APP_SECRET } = process.env
  if (
    selectEmaldoAdapter(process.env) === 'http' &&
    EMALDO_USER &&
    EMALDO_PASSWORD &&
    EMALDO_APP_ID &&
    EMALDO_APP_SECRET
  ) {
    const { createEmaldoClient } = await import('./client')
    return createEmaldoClient({
      fetch: globalThis.fetch,
      user: EMALDO_USER,
      password: EMALDO_PASSWORD,
      appId: EMALDO_APP_ID,
      appSecret: EMALDO_APP_SECRET,
    })
  }
  return (await import('./adapters/notConfigured')).notConfigured
})

export const emaldo: EmaldoClient = {
  async fetchDay(offset, o) {
    return (await getAdapter()).fetchDay(offset, o)
  },
}
```

`src/lib/effects/emaldo/adapters/notConfigured.ts`:
```ts
import type { EmaldoClient } from '../emaldo'
import { EmaldoError } from '../errors'

// Selected when any EMALDO_* variable is unset (and under VITEST): fails
// closed so health shows "not configured", never a fake healthy sync.
export const notConfigured: EmaldoClient = {
  async fetchDay() {
    throw new EmaldoError('not_configured', 'stats', undefined, {
      message:
        'Emaldo client is not configured (EMALDO_USER / EMALDO_PASSWORD / EMALDO_APP_ID / EMALDO_APP_SECRET unset)',
    })
  },
}
```

`src/lib/effects/emaldo/index.ts`:
```ts
export { createEmaldoClient } from './client'
export {
  type CallOpts,
  type EmaldoCallStats,
  type EmaldoClient,
  type EmaldoDay,
  emaldo,
  type HouseBucket,
  newCallStats,
  selectEmaldoAdapter,
} from './emaldo'
export { EmaldoError, type EmaldoOp } from './errors'
```

`src/lib/effects/index.ts` — insert after `export { elpris } from './elpris'` and let Biome order it:
```ts
export { emaldo } from './emaldo'
```

`src/lib/effects/http.ts` — replace the two header comment lines 1–2, and the comment line above
`methods: ['get', 'post'],` (`` // `post` only for the Zaptec login, the one POST. ``); no behavior change:
```ts
// HTTP for the pulled-integration clients (Zaptec, elpris, Škoda, Emaldo):
// ADR-0019's timeout + retry policy, owned by ky.
```
```ts
        // `post`: the Zaptec login and every Emaldo call — all reads, safe to resend.
        methods: ['get', 'post'],
```

`src/lib/effects/testing/fakeFetch.ts` line 2:
```ts
 * Hand-written `fetch` stand-in for integration client tests (Zaptec, elpris, Škoda, Emaldo).
```

`.env.example` already has the four blank `EMALDO_*` vars and their comment block (added with the design docs, #67).
Check it is still there and still accurate (`grep -n "^EMALDO_" .env.example` → 4 lines); edit the comment only if
this step changed something it describes.

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run src/lib/effects/ && bun run check && bun run build
```
Expected: every effect test passes (emaldo: 13 + 21 + 36); Biome clean; the build bundles `snappyjs` (a CommonJS
package imported by name) without warnings about missing exports.

- [ ] **Step 5: Commit (code)**

```bash
git add src/lib/effects/
git commit -m "feat(charging): wire the Emaldo effect and its env vars

Fails closed as not_configured unless all four EMALDO_* are set; nothing
calls it until the readings sync (roadmap step 2).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Docs.** `CLAUDE.md`:
  - Line 25: `Pulled integrations (Zaptec, elpris, Škoda) have **no** devLog adapter` →
    `Pulled integrations (Zaptec, elpris, Škoda, Emaldo) have **no** devLog adapter`.
  - Line 65 (code map `effects/`): `zaptec, elpris, skoda (pulled, fail closed — ADR-0019)` →
    `zaptec, elpris, skoda, emaldo (pulled, fail closed — ADR-0019; emaldo = house energy flows, RC4 + Snappy wire, ADR-0023)`.
  - Env-var list, after the `SKODA_API_KEY` bullet (line 197), add:
    `` - `EMALDO_USER`/`EMALDO_PASSWORD`/`EMALDO_APP_ID`/`EMALDO_APP_SECRET` (any unset → `not_configured`; a dedicated Emaldo account — a login ends its other sessions; app id/secret come from the Emaldo Android app and can rotate; Vercel Production only, never Preview; ADR-0023). ``

  Spec `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md`:
  - In "What the API does", after the `/bmt/stats/grid/day/` bullet's line, add a sub-bullet:
    `  - Live rows carry 13 (grid), 6 (mppt), 4 (usage) and 6 (battery) columns; unused columns are ignored. Grid import = import + emergency_import.`
  - In "Sync" (lines 99–100), replace the sentence that starts `` Snappy uses the `snappyjs` package if maintained `` and ends `with the reason in the PR.` with
    `` Snappy uses the `snappyjs` package (step 1: MIT, no dependencies, ≈2.4 M weekly downloads, raw format with a `maxLength` guard; last release 2022, acceptable for a frozen format). It doesn't reject every non-Snappy input, so a result counts only once it parses as JSON, Snappy first, then plain. ``

```bash
bun run check
git add CLAUDE.md docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md
git commit -m "docs(charging): record the Emaldo client decisions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Review the branch (feature-workflow Phase 5)

**Files:** whatever the findings touch · **Reviewers:** the gates below, dispatched in parallel, each told to assume
the branch is wrong and not up to spec.

Gates that apply (no schema or `drizzle/` change → `migration-guard` and the schema-design review don't apply):
- [ ] **`test-completeness`** (agent) — effect adapter + `errors.ts` changed: every `EmaldoError` code the client can
  throw (`auth_failed`, `unreachable`, `rate_limited`, `unexpected_response`, `not_configured`) has a test, per op.
- [ ] **`code-reviewer`** (agent) — ADR-0001/0002/0003/0019/0023 adherence over `git diff origin/main...HEAD`.
- [ ] **General correctness pass** — `/code-review high` on the branch (it's ≈1 600 lines incl. tests).
- [ ] **Security pass** — `/security-review`: the effect handles third-party credentials and a session token; check
  that nothing secret reaches messages, causes, logs or the repo, that redirects are refused, and that
  `.env.example` holds no values.
- [ ] Fix every confirmed finding in this branch (or rule on it explicitly in the PR's Risks section), re-run
  `bunx vitest run src/lib/effects/emaldo/`, commit each fix with its own conventional message.

---

### Task 6: Pre-PR gate (feature-workflow Phase 6)

**Files:** none (Biome may rewrite) · **Reviewers:** none

- [ ] **Step 1: Run the gate**

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```
Expected: all green; "sv/en keys match" (this step adds no messages). No UI changed → no browser check.

- [ ] **Step 2: Nothing private is staged**

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD | grep -n -i "data/private\|EMALDO_[A-Z_]*=[^ ]" || echo "clean"
```
Expected: only `src/lib/effects/**`, `package.json`, `bun.lock`, `.env.example`, `CLAUDE.md`, the spec and the
roadmap; `clean`.

---

### Task 7: Roadmap row + open the PR (feature-workflow Phase 7)

**Files:** Modify `docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md` (row 1) · **Reviewers:** none

- [ ] **Step 1: Push and open the PR** with `.github/PULL_REQUEST_TEMPLATE.md`. Title (exact):
  `feat(charging): add the Emaldo house-energy client`

```bash
git push -u origin feat/emaldo-client
gh pr create --title "feat(charging): add the Emaldo house-energy client" --body-file /tmp/emaldo-pr.md
```
`/tmp/emaldo-pr.md` (fill the Verification boxes with what you actually ran):
```markdown
## Why

Step 1 of the solar-aware charging cost ([ADR-0023](docs/adr/0023-solar-aware-charging-cost.md),
[roadmap](docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md)): a fail-closed client for the house's
5-minute energy flows from the Emaldo cloud. Nothing calls it yet; the readings sync is step 2.

## What changed

- `src/lib/effects/emaldo/`: `fetchDay(offset)` → typed kWh buckets (login, discovery of the home that has a
  battery, four day series in parallel, one shared re-login on Status -12, ADR-0019 retries).
- RC4 hand-rolled: Node's OpenSSL 3 refuses `createCipheriv('rc4', …)` ("digital envelope routines::unsupported").
- Snappy via `snappyjs` (MIT, no deps, ≈2.4 M weekly downloads, raw format + `maxLength`; last release 2022, fine
  for a frozen format). It doesn't reject all non-Snappy input, so a result counts only once it parses as JSON.
- `.env.example` already lists `EMALDO_USER`, `EMALDO_PASSWORD`, `EMALDO_APP_ID`, `EMALDO_APP_SECRET` (blank; added in #67).

## Verification

- [ ] `bun run check` clean
- [ ] `bun run build` passes (tsc + bundle)
- [ ] `bun run test` passes
- [ ] Responsive on desktop + mobile — _N/A (no UI)_

## Risks / follow-ups

- Unofficial API and an app secret from Emaldo's Android app: a rotated secret fails as `unexpected_response` with a
  hint; cost falls back to all-grid (ADR-0023 Consequences).
- Checkpoint 1 (local, real credentials) runs after merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 2: Update roadmap row 1** with the PR link and status `PR open`:

```
| 1 | Emaldo client (effect, env, `not_configured`; unused) | [plan](../plans/2026-10-03-solar-cost-1-emaldo-client.md) | [#NN](https://github.com/<owner>/<repo>/pull/NN) | PR open | — |
```
(`gh pr view --json url -q .url` gives the link.)

```bash
git add docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md
git commit -m "docs(charging): link the Emaldo client PR in the roadmap

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
```

- [ ] **Step 3: CI** — wait for `CI Success` and `Validate Conventional Commit title` to go green; fix and push if
  not. The owner squash-merges.

---

### Task 8: STOP — checkpoint 1 is the owner's (or the next session's)

Don't start step 2 in this session. After the PR is merged, the roadmap's **checkpoint 1 (local)** must pass before
step 2 starts:

> Run the new client locally with the real credentials against two days from `data/private/emaldo/` (one normal
> day, the spring-forward day). The decoded buckets match the probe's raw files exactly: same bucket count, same
> values.

How (on up-to-date `main`, in the main checkout `/Users/lukas/prog/videbacken`):

1. `.env.local` must hold all four `EMALDO_*` values (today it has only `EMALDO_USER` / `EMALDO_PASSWORD`). Take
   `EMALDO_APP_ID` / `EMALDO_APP_SECRET` from `DEFAULT_APP_ID` / `DEFAULT_APP_SECRET` in a fresh clone of
   `github.com/wertigpar/ha-emaldo` (`custom_components/emaldo/const.py`, or the `emaldo_lib/const.py` it
   imports). Never print or commit them.
2. Create the throwaway script `data/private/emaldo/checkpoint.ts` (git-excluded, beside the probe):

```ts
// LOCAL ONLY — never commit (data/private/ is git-excluded). Roadmap checkpoint 1: the repo's
// Emaldo client fetches two probe days live and must match the probe's raw files exactly.
// Run from the repo root on up-to-date main:  bun data/private/emaldo/checkpoint.ts
// Needs EMALDO_USER / EMALDO_PASSWORD / EMALDO_APP_ID / EMALDO_APP_SECRET in .env.local.
// Logs in once, which ends the Emaldo account's other sessions. Prints counts only.
import '../../../scripts/loadEnv'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEmaldoClient, type HouseBucket, newCallStats } from '../../../src/lib/effects/emaldo'
import { addDays, stockholmDayBounds, stockholmDayOf } from '../../../src/lib/time/stockholm'

const DAYS = ['2026-06-10', '2026-03-29'] // a normal day; the spring-forward day (276 buckets)
const DATA = join(import.meta.dir, 'data')
const FIELDS = [
  'gridImportKwh',
  'gridExportKwh',
  'solarKwh',
  'loadKwh',
  'batteryDischargeKwh',
  'batteryChargeSolarKwh',
  'batteryChargeGridKwh',
  'batteryChargeAcKwh',
] as const

function env(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`${key} is not set in .env.local`)
  return value
}

/** Days back from today (Stockholm): 0 = today. */
function offsetOf(day: string): number {
  let offset = 0
  for (let d = stockholmDayOf(Date.now()); d !== day; d = addDays(d, -1)) offset--
  return offset
}

/** The probe's decoded rows → buckets, computed here independently of the client. */
function fromProbe(day: string): HouseBucket[] {
  type Raw = { start_time: number; data: number[][] }
  const read = (s: string): Raw => JSON.parse(readFileSync(join(DATA, `${day}.${s}.json`), 'utf8'))
  const [grid, mppt, usage, battery] = ['grid', 'mppt', 'usage', 'battery'].map(read)
  const byMinute = (r: Raw) => new Map(r.data.map((row) => [row[0], row]))
  const [p, u, b] = [mppt, usage, battery].map(byMinute)
  const { endMs } = stockholmDayBounds(day)
  const out: HouseBucket[] = []
  for (const g of [...grid.data].sort((x, y) => x[0] - y[0])) {
    const m = g[0]
    const pr = p.get(m)
    const ur = u.get(m)
    const br = b.get(m)
    const at = grid.start_time * 1000 + m * 60_000
    if (!pr || !ur || !br || at >= endMs) continue
    out.push({
      bucketStart: new Date(at),
      gridImportKwh: (g[1] + g[2]) / 12_000,
      gridExportKwh: g[3] / 12_000,
      solarKwh: (pr[1] + pr[2] + pr[3] + pr[4]) / 12_000,
      loadKwh: ur[2] / 12_000,
      batteryDischargeKwh: br[1] / 12_000,
      batteryChargeSolarKwh: br[2] / 12_000,
      batteryChargeGridKwh: br[3] / 12_000,
      batteryChargeAcKwh: br[4] / 12_000,
    })
  }
  return out
}

const client = createEmaldoClient({
  fetch: globalThis.fetch,
  user: env('EMALDO_USER'),
  password: env('EMALDO_PASSWORD'),
  appId: env('EMALDO_APP_ID'),
  appSecret: env('EMALDO_APP_SECRET'),
})
const stats = newCallStats()
let failed = false
for (const day of DAYS) {
  const got = await client.fetchDay(offsetOf(day), { stats })
  const want = fromProbe(day)
  let mismatched = 0
  for (let i = 0; i < Math.max(got.buckets.length, want.length); i++) {
    const g = got.buckets[i]
    const w = want[i]
    const same =
      g !== undefined &&
      w !== undefined &&
      g.bucketStart.getTime() === w.bucketStart.getTime() &&
      FIELDS.every((f) => g[f] === w[f])
    if (!same) mismatched++
  }
  const ok =
    got.dayStart.getTime() === stockholmDayBounds(day).startMs &&
    got.buckets.length === want.length &&
    mismatched === 0
  if (!ok) failed = true
  console.log(
    `${day}: client ${got.buckets.length} buckets (dropped ${got.droppedBuckets}), probe ${want.length}, mismatched ${mismatched} → ${ok ? 'PASS' : 'FAIL'}`,
  )
}
console.log(`requests ${stats.requests}, logins ${stats.logins}, retries ${stats.retries}`)
process.exit(failed ? 1 : 0)
```

3. Run it from the repo root: `bun data/private/emaldo/checkpoint.ts`. It logs in once (this ends the account's other
   sessions) and makes ≈11 requests. **Pass** = exit code 0 and two lines
   `2026-06-10: client 288 buckets (dropped 0), probe 288, mismatched 0 → PASS` and
   `2026-03-29: client 276 buckets (dropped 0), probe 276, mismatched 0 → PASS`. It prints counts only, never values.
   - `auth_failed` from `login` → check the four env values. `unexpected_response` "app id/secret may have rotated"
     → re-extract them from a newer ha-emaldo. Either way the client works as designed; fix the env and re-run.
   - A count or value mismatch → **don't start step 2**: debug with `superpowers:systematic-debugging` (compare one
     bucket's raw row against the client output locally; never paste values into the repo or a PR).
4. Record the result in the roadmap: row 1 status `merged` → `checkpoint passed`, "Checkpoint result" e.g.
   `2026-10-04: 288/288 + 276/276 buckets, 0 mismatches`, plus a Log line — in a small
   `docs(charging): record solar-cost checkpoint 1` PR, or in step 2's PR if the owner says so.

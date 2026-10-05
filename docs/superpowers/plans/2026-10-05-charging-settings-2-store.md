# Charging settings step 2 — credential store and resolver — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pulled integrations resolve their credentials per call from an AES-256-GCM-encrypted
`integration_credential` row (stored value beats env, field by field), rebuilding a client only when the
resolved values change. No UI and no procedures yet: with no stored rows, behavior is unchanged.

**Architecture:** A client-safe vocabulary (`integrationCredentials.ts`) → a table + migration → a pure
server-only crypto module → a service that owns the table → a resolver with a 60 s cache of the stored read →
`keyedAdapter`, which replaces `lazy()` in the Zaptec, Škoda and Emaldo facades → the Škoda home point and the
grid watcher's facility ID read through the resolver.

**Tech stack:** `node:crypto` (AES-256-GCM, SHA-256), Drizzle (`pg`), Vitest node project with `setupDatabase()`.

**Spec:** [charging settings design](../specs/2026-10-05-charging-settings-design.md), section "Step 2".
**ADR:** [ADR-0026](../../adr/0026-integration-credential-store.md). **Roadmap:**
[charging settings](../roadmaps/2026-10-05-charging-settings.md), step 2.

## Global constraints

- Credential **values** never appear in logs, error messages, return values of `status()`, or test snapshots.
  Logs carry source and field names only.
- Precedence per field: **stored → env → missing**. A blank env var (`''` or whitespace) counts as missing.
- A stored row that can't be decrypted **fails closed**: `credentials_unreadable`, never a fallback to env.
- No stored row + no key → resolve from env, no error (today's behavior).
- Under VITEST the three facades return `notConfigured` **before any DB read**.
- Key: `CREDENTIALS_ENCRYPTION_KEY`, base64 of exactly 32 bytes (`openssl rand -base64 32`); anything else = missing.
- Envelope `v1.<iv>.<tag>.<ct>`, base64url parts, 12-byte IV, 16-byte tag, AAD = source name.
- Field validation (trimmed, ≤ 512 chars): `vin` `^[A-HJ-NPR-Z0-9]{17}$` after upper-casing; `homeCoordinates`
  must pass `parseHomePoint`; `facilityId` must pass `parseFacilityId`; every other field non-empty.
- All DB access to `integration_credential` goes through `src/lib/services/integrationCredential/` (ADR-0002).
- `src/lib/credentials/*` is server-only; nothing client-side may import it. `src/lib/integrationCredentials.ts`
  stays dependency-free (client-safe).
- Biome formatting, Conventional Commits, `bun` only. **Never run vitest while another vitest process is running on
  the shared DB** (`ps aux | grep -c '[v]itest'` must print 0 first); reviewers never run vitest.

## Spec corrections (found in Phase 1; amend spec + ADR in task 6)

1. `updated_by` is **`uuid`** (`user.id` is a uuid), not `text`.
2. `SELECT … FOR UPDATE` can't lock a row that doesn't exist, so two concurrent first saves for the same source
   could each merge over nothing and the later upsert would drop the earlier fields. `set` takes
   `pg_advisory_xact_lock(hashtext('integration_credential:' || source))` first, then reads the row.
3. The resolver caches only the **stored read** (60 s). Env is merged on every call, which is free and keeps test
   env stubs working. `setupDatabase()` clears the cache before each test, because each test gets a fresh schema.
4. Decrypt failures are a plain `CredentialsUnreadableError` (crypto layer); `keyedAdapter` maps them to the
   source's own `IntegrationError` subclass with code `credentials_unreadable`. Otherwise `runPulledSync` would
   record `internal_error` and rethrow.
5. The Škoda home point is resolved before `runPulledSync` (the run's `init` needs it). If the row is unreadable it
   resolves to `null`; the client call inside `execute` then fails with `credentials_unreadable` and is recorded.

## Review focus

1. **Concurrent first saves** for one source keep both saves' fields (advisory lock). Task 3 test.
2. **A row encrypted for one source pasted into another's row** must not decrypt (AAD). Task 2 test.
3. **A whitespace-only env var** must count as missing, not as a credential. Task 4 test.
4. **A credential change on a warm instance** must rebuild the client within 60 s, and an unchanged one must
   *not* (Emaldo logins end other sessions). Tasks 4 and 5 tests.
5. **Decrypted JSON of the wrong shape** (non-object, non-string values, unknown keys) is unreadable, never
   partial data. Task 3 test.

## Files

| File | Responsibility |
|---|---|
| `src/lib/integrationCredentials.ts` (new) | Client-safe vocabulary: sources, fields, kind, origin, value types |
| `src/lib/integrationHealth.ts` | + `credentials_unreadable` in `INTEGRATION_ERROR_CODES` |
| `src/lib/integrationHealthMessage.ts`, `messages/{sv,en}.json` | Copy for the new code |
| `src/lib/db/schema/integrationCredential.ts` (new), `schema/index.ts`, `drizzle/0018_*` | Table + CHECK changes |
| `src/lib/credentials/env.ts` (new) | Field → env var map, `envCredential()` |
| `src/lib/credentials/crypto.ts` (new) | Key parsing, `encrypt`, `decrypt`, `CredentialsUnreadableError` |
| `src/lib/credentials/cache.ts` (new) | 60 s cache of the stored read + `invalidateCredentials` |
| `src/lib/services/integrationCredential/` (new) | `status`, `set`, `clear`, `readStored`, validation, domain errors |
| `src/lib/credentials/resolve.ts` (new) | `resolveCredentials(source)` → values + fingerprint |
| `src/lib/effects/keyedAdapter.ts` (new) | Per-call resolve, fingerprint-keyed client cache, VITEST short-circuit |
| `src/lib/effects/{zaptec,skoda,emaldo}/{*.ts,adapters/notConfigured.ts}` | Facades on `keyedAdapter`; `unavailable(code)` adapters |
| `src/lib/vehicleState/sync.ts`, `src/lib/gridTariff/catalogueCheck.ts` | Home point / facility ID via the resolver |
| `test/setup.ts` | Clear the credential cache per test |

---

### Task 0: Check that main still matches the spec

- [ ] Confirm the shapes Phase 1 mapped are unchanged on the branch base:
  ```bash
  grep -n "lazy(" src/lib/effects/{zaptec/zaptec,skoda/skoda,emaldo/emaldo}.ts
  grep -n "SKODA_HOME_COORDINATES" src/lib/vehicleState/sync.ts
  grep -n "env = process.env" src/lib/gridTariff/catalogueCheck.ts
  grep -n "INTEGRATION_ERROR_CODES = " src/lib/integrationHealth.ts
  ls drizzle/*.sql | tail -1          # expect 0017_energy_mix_and_battery_pool.sql
  git fetch -q && git ls-tree --name-only origin/main drizzle/ | grep -c sql   # a new 0018 on main → renumber at PR time
  ```
  Expected: one `lazy(` per facade, the env read in `sync.ts:67`, `env = process.env` in `catalogueCheck.ts`, the
  latest migration `0017`. If anything differs, stop and amend this plan.

### Task 1: Vocabulary, the new health code, and the table

**Files:**
- Create: `src/lib/integrationCredentials.ts`, `src/lib/db/schema/integrationCredential.ts`, `drizzle/0018_integration_credential.sql` (generated)
- Modify: `src/lib/integrationHealth.ts:11-20`, `src/lib/integrationHealthMessage.ts:47-75`, `messages/sv.json`, `messages/en.json` (after `integration_health_error_auth_failed_skoda`, alphabetical), `src/lib/db/schema/index.ts`, `src/lib/evCharging/clientSafe.browser.test.tsx` (add the new module)

**Interfaces — produces:**
```ts
// src/lib/integrationCredentials.ts — dependency-free, client-safe
export const CREDENTIAL_SOURCES = ['zaptec', 'skoda', 'emaldo', 'gridTariff'] as const
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number]
export const CREDENTIAL_FIELDS = {
  zaptec: ['username', 'password'],
  skoda: ['apiKey', 'vin', 'homeCoordinates'],
  emaldo: ['user', 'password', 'appId', 'appSecret'],
  gridTariff: ['facilityId'],
} as const satisfies Record<CredentialSource, readonly string[]>
export type CredentialField<S extends CredentialSource> = (typeof CREDENTIAL_FIELDS)[S][number]
export type CredentialValues<S extends CredentialSource> = Partial<Record<CredentialField<S>, string>>
export type CredentialOrigin = 'stored' | 'env' | 'missing'
/** secret → password input; text → plain input (still never pre-filled). Only the VIN is text. */
export const credentialFieldKind = (source: CredentialSource, field: string): 'secret' | 'text' =>
  source === 'skoda' && field === 'vin' ? 'text' : 'secret'
export const isCredentialField = <S extends CredentialSource>(source: S, field: string): field is CredentialField<S> =>
  (CREDENTIAL_FIELDS[source] as readonly string[]).includes(field)
```

- [ ] **Step 1: vocabulary + code.** Write `integrationCredentials.ts` as above (header comment in the
  `integrationHealth.ts` style: client-safe, no imports). Append `'credentials_unreadable'` to
  `INTEGRATION_ERROR_CODES` (before `internal_error`). Run `bun run typecheck`: expect exactly one error, the
  exhaustive switch in `integrationHealthMessage.ts`.
- [ ] **Step 2: copy.** Add `case 'credentials_unreadable': return m.integration_health_error_credentials_unreadable({ source }, opts)` and the keys:
  - sv: `"De sparade inloggningsuppgifterna för {source} går inte att läsa – krypteringsnyckeln saknas eller har bytts. En admin behöver fylla i dem igen under Laddning → Inställningar."`
  - en: `"The stored credentials for {source} can't be read – the encryption key is missing or has changed. An admin needs to enter them again under Charging → Settings."`

  `bun run i18n:compile && bun run typecheck` → clean. `integrationHealthMessage.test.ts` covers the new code
  automatically (it iterates every code × source × locale).
- [ ] **Step 3: schema.** `src/lib/db/schema/integrationCredential.ts`:
  ```ts
  import { sql } from 'drizzle-orm'
  import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
  import { CREDENTIAL_SOURCES } from '../../integrationCredentials'
  import { sqlList } from '../sqlList'
  import { user } from './betterAuth'

  // GUI-set integration credentials (ADR-0026): one row per credential owner, the
  // fields as one AES-256-GCM-encrypted JSON object. Only the field *names* and
  // who/when are plaintext. Read and written only by services/integrationCredential.
  export const integrationCredential = pgTable(
    'integration_credential',
    {
      source: text('source').primaryKey(),
      // `v1.<iv>.<tag>.<ciphertext>`, base64url parts; the version prefix leaves room for key rotation.
      ciphertext: text('ciphertext').notNull(),
      fieldsSet: text('fields_set').array().notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
      updatedBy: uuid('updated_by').references(() => user.id, { onDelete: 'set null' }),
    },
    (table) => [
      check('integration_credential_source_check', sql`${table.source} IN (${sqlList(CREDENTIAL_SOURCES)})`),
      check('integration_credential_ciphertext_check', sql`${table.ciphertext} LIKE 'v1.%'`),
      check('integration_credential_fields_set_check', sql`cardinality(${table.fieldsSet}) > 0`),
    ],
  ).enableRLS()
  ```
  No index on `updated_by`: four rows at most, and a user delete scans them trivially. Add
  `export * from './integrationCredential'` to `schema/index.ts` between `houseEnergy` and `integrationSync`.
- [ ] **Step 4: migrate.** `bun run db:generate --name=integration_credential`. Inspect the SQL: `CREATE TABLE`,
  `ENABLE ROW LEVEL SECURITY`, the FK `ON DELETE set null`, and DROP + ADD of `integration_sync_error_code_check`
  and `integration_sync_run_error_code_check` with `'credentials_unreadable'` in the list. No other statement.
  `bun run db:migrate` (local).
- [ ] **Step 5: test.** Add the new module to `clientSafe.browser.test.tsx`'s list in the existing style. Run
  `bunx vitest run test/rls.test.ts src/lib/db/evChargingSchema.test.ts src/lib/integrationHealthMessage.test.ts`
  → PASS (the RLS test picks up the table; the schema test inserts every code, including the new one).
- [ ] **Step 6: commit** `feat(charging): add the integration credential table and code`.

**Reviewers:** `migration-guard` + schema-design reviewer (loads `supabase-postgres-best-practices`; queries:
PK lookup by source, full scan of ≤ 4 rows for `status`, upsert by PK, delete by PK, user delete → set null).

### Task 2: Crypto and the env map

**Files:**
- Create: `src/lib/credentials/crypto.ts`, `src/lib/credentials/env.ts`, `src/lib/credentials/crypto.test.ts`, `src/lib/credentials/env.test.ts`

**Interfaces — produces:**
```ts
// crypto.ts (server-only)
export class CredentialsUnreadableError extends Error {
  constructor(readonly source: CredentialSource, readonly reason: 'key_missing' | 'invalid')
  // message: `stored ${source} credentials are unreadable (${reason})` — never ciphertext or plaintext
}
export function encryptionKey(env?: Env): Buffer | null       // trimmed; /^[A-Za-z0-9+/]{43}=$/ → 32 bytes, else null
export function isEncryptionKeyConfigured(env?: Env): boolean
export function encrypt(source: CredentialSource, plaintext: string, env?: Env): string // throws Error if no key
export function decrypt(source: CredentialSource, envelope: string, env?: Env): string  // throws CredentialsUnreadableError
// env.ts (server-only)
export const CREDENTIAL_ENV: { [S in CredentialSource]: Record<CredentialField<S>, string> }
export function envCredential<S extends CredentialSource>(source: S, field: CredentialField<S>, env?: Env): string | undefined
// undefined when unset or blank after trim; otherwise the raw value
```
`type Env = Record<string, string | undefined>`, defaulting to `process.env` and read on every call.

- [ ] **Step 1: failing tests** (`crypto.test.ts`, no DB). Generate two keys in the test with
  `randomBytes(32).toString('base64')` and pass them via the `env` argument:
  - round-trip `decrypt('skoda', encrypt('skoda', '{"apiKey":"k"}', env), env)` returns the input;
  - the envelope matches `/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/` and contains no plaintext;
  - two encryptions of the same input differ (fresh IV);
  - each throws `CredentialsUnreadableError` with `reason: 'invalid'`: a wrong key; the AAD swap (`encrypt('zaptec', …)` decrypted as `'emaldo'`); a flipped tag byte; a truncated ciphertext; `v2.` prefix; three parts;
  - `decrypt` with no key throws `reason: 'key_missing'`; `encrypt` with no key throws a plain `Error`;
  - `encryptionKey` returns null for `undefined`, `''`, 16 bytes base64, 33 bytes, non-base64 garbage; accepts a key with surrounding whitespace;
  - the thrown error's `message` and `stack` contain neither the plaintext nor the key.

  `env.test.ts`: every `CREDENTIAL_FIELDS` entry has an env name (iterate the vocabulary); `envCredential`
  returns undefined for unset, `''` and `'  '`, the raw value otherwise; the names match the spec's map
  (`zaptec.username → ZAPTEC_USERNAME`, …, `gridTariff.facilityId → GRID_FACILITY_ID`).
- [ ] **Step 2:** run `bunx vitest run src/lib/credentials` → FAIL (modules missing).
- [ ] **Step 3: implement.**
  ```ts
  const ALGO = 'aes-256-gcm'
  const VERSION = 'v1'
  const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/
  export function encryptionKey(env: Env = process.env): Buffer | null {
    const raw = env.CREDENTIALS_ENCRYPTION_KEY?.trim()
    if (!raw || !KEY_PATTERN.test(raw)) return null
    const key = Buffer.from(raw, 'base64')
    return key.length === 32 ? key : null
  }
  export function encrypt(source, plaintext, env = process.env) {
    const key = encryptionKey(env)
    if (!key) throw new Error('CREDENTIALS_ENCRYPTION_KEY is missing or not 32 bytes of base64')
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGO, key, iv)
    cipher.setAAD(Buffer.from(source, 'utf8'))
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return [VERSION, iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
  }
  export function decrypt(source, envelope, env = process.env) {
    const key = encryptionKey(env)
    if (!key) throw new CredentialsUnreadableError(source, 'key_missing')
    const parts = envelope.split('.')
    try {
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('envelope')
      const [iv, tag, ct] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'))
      if (iv.length !== 12 || tag.length !== 16) throw new Error('envelope')
      const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: 16 })
      decipher.setAAD(Buffer.from(source, 'utf8'))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    } catch {
      // No `cause`: node's crypto errors carry no secrets, but nothing here needs them either.
      throw new CredentialsUnreadableError(source, 'invalid')
    }
  }
  ```
  Header comment: why this is not an effect (ADR-0026 §7), why the key is not derived from `BETTER_AUTH_SECRET`.
- [ ] **Step 4:** `bunx vitest run src/lib/credentials` → PASS.
- [ ] **Step 5: commit** `feat(charging): add credential encryption and the env map`.

**Reviewers:** `code-reviewer` + a security reviewer (loads `better-auth-security-best-practices` for secret
handling; told to attack the envelope parsing, AAD binding, key parsing and error leakage).

### Task 3: The credential service and its cache

**Files:**
- Create: `src/lib/credentials/cache.ts`, `src/lib/services/integrationCredential/{integrationCredential.ts,errors.ts,index.ts,integrationCredential.test.ts}`
- Modify: `test/setup.ts` (beforeEach: `invalidateCredentials()`)

**Interfaces — consumes:** task 1 vocabulary + table; task 2 `encrypt`, `decrypt`, `isEncryptionKeyConfigured`,
`CredentialsUnreadableError`, `envCredential`; `parseHomePoint` (`~/lib/vehicleState/geofence`),
`parseFacilityId` (`~/lib/gridTariff/coverage`).

**Interfaces — produces:**
```ts
// cache.ts (server-only, no imports beyond types)
export const STORED_TTL_MS = 60_000
export function cachedStored<T>(source: CredentialSource, load: () => Promise<T>, now?: number): Promise<T>
// shares one in-flight promise; a rejected load is dropped, not cached; entries expire after STORED_TTL_MS
export function invalidateCredentials(source?: CredentialSource): void // no arg → clear all

// errors.ts
export type IntegrationCredentialDomainErrorCode = 'INVALID_FIELD' | 'NOTHING_TO_SAVE' | 'ENCRYPTION_KEY_MISSING'
export class IntegrationCredentialDomainError extends Error {
  constructor(readonly code: IntegrationCredentialDomainErrorCode, readonly field?: string)
  // message: code, plus ` (${field})` for INVALID_FIELD — never the value
}

// integrationCredential.ts
export type CredentialSourceStatus<S extends CredentialSource> = {
  fields: Record<CredentialField<S>, { origin: CredentialOrigin }>
  updatedAt: Date | null
  unreadable: boolean
}
export type CredentialStatus = {
  encryptionKeyConfigured: boolean
  sources: { [S in CredentialSource]: CredentialSourceStatus<S> }
}
export async function status(): Promise<CredentialStatus>
export async function set<S extends CredentialSource>(
  source: S, fields: Record<string, string | undefined>, userId: string | null,
): Promise<{ fieldsSet: CredentialField<S>[]; updatedAt: Date }>
export async function clear(source: CredentialSource): Promise<boolean> // true when a row was deleted
export async function readStored<S extends CredentialSource>(source: S): Promise<CredentialValues<S> | null>
// throws CredentialsUnreadableError (row present, key missing/wrong, tampered, or JSON of the wrong shape)
```

Behavior details:
- `status`: one `SELECT` of all rows. Per row, try `readStored`-style decrypt; `unreadable` = it threw. A field's
  origin is `stored` if its name is in `fields_set` (even when unreadable), else `env` if `envCredential` has a
  value, else `missing`. Never returns a value.
- `set`, in this order:
  1. Unknown field name → `INVALID_FIELD` with that field.
  2. Normalize each provided field: `trim()`; blank → skipped (keeps the stored value); `> 512` →
     `INVALID_FIELD`; `vin` upper-cased then the pattern; `homeCoordinates` → `parseHomePoint(v) !== null`;
     `facilityId` → `parseFacilityId(v) !== null`. Store the trimmed (VIN upper-cased) string.
  3. Nothing left → `NOTHING_TO_SAVE`.
  4. `!isEncryptionKeyConfigured()` → `ENCRYPTION_KEY_MISSING`.
  5. `db.transaction`: `` tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'integration_credential:' + source}))`) ``,
     then `SELECT … FOR UPDATE` the row; decrypt + parse it (an unreadable row → `{}`, and log
     `warn('integration credentials replaced unreadable row', { source })`); merge new over old; `encrypt` the
     JSON; upsert (`onConflictDoUpdate` on `source`) with `fieldsSet` = merged keys in `CREDENTIAL_FIELDS` order,
     `updatedBy: userId`.
  6. After commit: `invalidateCredentials(source)`.
- `clear`: `DELETE … RETURNING source`; `invalidateCredentials(source)`; return whether a row went.
- `readStored`: `SELECT` the row; null if none; `decrypt`; `JSON.parse` in a try; reject (as
  `CredentialsUnreadableError(source, 'invalid')`) anything that isn't a plain object whose keys are all
  `CREDENTIAL_FIELDS[source]` members and whose values are all non-empty strings.

- [ ] **Step 1: failing tests** (`setupDatabase()` first; `vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', KEY)` in
  `beforeEach`, `vi.unstubAllEnvs()` in `afterEach`; insert one `user` row for `updatedBy`):
  - `set('skoda', { apiKey: 'k1' })` then `set('skoda', { vin: 'tmbjr7ny0pz123456' })` → `readStored` is
    `{ apiKey: 'k1', vin: 'TMBJR7NY0PZ123456' }` (per-field merge, VIN upper-cased);
  - a blank and a whitespace field keep the stored value; `' k2 '` is stored as `'k2'`;
  - `INVALID_FIELD`: unknown field (`{ token: 'x' }` → field `token`), bad VIN, 18-char VIN, I/O/Q in VIN,
    `homeCoordinates: 'home'`, `facilityId: '12345'`, a 513-char password. Each: `field` set, `message` without
    the value, and no row written;
  - `NOTHING_TO_SAVE` for `{}` and `{ apiKey: '  ' }`;
  - `ENCRYPTION_KEY_MISSING` with the key stubbed `''` (no row written);
  - an unreadable row (written under key A, set under key B) is **replaced**: after `set('skoda', { apiKey: 'k' })`
    under B, `readStored` = `{ apiKey: 'k' }`;
  - the raw `ciphertext` column contains none of the plaintext values; `fields_set` lists names only;
  - `readStored` throws `CredentialsUnreadableError` under a wrong key, a missing key, and for a row whose
    ciphertext is a valid envelope of `'[1]'`, `'{"apiKey":7}'`, `'{"bogus":"x"}'` (write those via `encrypt` +
    a direct `db.insert` in the test — the service never writes them);
  - `status()` with: a stored apiKey + `SKODA_VIN` env + nothing for homeCoordinates → `stored / env / missing`;
    `JSON.stringify(status())` contains no stored or env value; `unreadable: true` for a wrong-key row with its
    fields still `stored`; `encryptionKeyConfigured` follows the key;
  - `clear` deletes (true), then is idempotent (false);
  - **concurrent first saves**: `Promise.all([set('emaldo', { user: 'u' }), set('emaldo', { password: 'p' })])`
    → `readStored` has both fields;
  - `updatedBy` is set null when that user is deleted.

  Cache tests in the same file or `src/lib/credentials/cache.test.ts` (no DB): one in-flight load shared by two
  callers; a value reused before the TTL and reloaded after it (pass `now`); a rejected load is not cached;
  `invalidateCredentials('skoda')` drops only Škoda; no-arg clears all.
- [ ] **Step 2:** run the two files → FAIL.
- [ ] **Step 3: implement** cache, errors, service, barrel (`export * from './errors'`, `export * from './integrationCredential'`), and the `test/setup.ts` `beforeEach` line (`invalidateCredentials()` before creating the schema, with a one-line comment).
- [ ] **Step 4:** run them → PASS. Then `bun run typecheck`.
- [ ] **Step 5: commit** `feat(charging): add the integration credential service`.

**Reviewers:** `code-reviewer` + `test-completeness`.

### Task 4: The resolver

**Files:**
- Create: `src/lib/credentials/resolve.ts`, `src/lib/credentials/resolve.test.ts`

**Interfaces — produces:**
```ts
export type ResolvedCredentials<S extends CredentialSource> = { values: CredentialValues<S>; fingerprint: string }
export async function resolveCredentials<S extends CredentialSource>(source: S): Promise<ResolvedCredentials<S>>
// values[field] = stored[field] ?? envCredential(source, field); absent when neither
// fingerprint = sha256 hex of JSON.stringify(CREDENTIAL_FIELDS[source].map((f) => [f, values[f] ?? null]))
// stored read via cachedStored(source, () => service.readStored(source)); throws CredentialsUnreadableError
```

- [ ] **Step 1: failing tests** (`setupDatabase()`, key stubbed):
  - precedence: no row + env → env; a stored field beats its env var; another field still from env; neither →
    absent (not `''`);
  - a whitespace-only env var is absent;
  - no key + no row → env values, no error; no key + a row → throws `CredentialsUnreadableError`;
  - the cache: after `resolveCredentials('zaptec')`, a direct `db.update` of the row is **not** seen (cached), a
    service `set` **is** seen at once (invalidated); `vi.useFakeTimers()` + advance 61 s → a direct DB change is
    seen;
  - the fingerprint is equal for equal values (stored vs env origin of the same value included) and differs when
    one value changes; it is 64 hex chars and contains no value.
- [ ] **Step 2:** FAIL. **Step 3:** implement (header comment: why only the stored read is cached).
  **Step 4:** PASS.
- [ ] **Step 5: commit** `feat(charging): resolve integration credentials over env`.

**Reviewers:** `code-reviewer` + `test-completeness`.

### Task 5: `keyedAdapter` and the three facades

**Files:**
- Create: `src/lib/effects/keyedAdapter.ts`, `src/lib/effects/keyedAdapter.test.ts`
- Modify: `src/lib/effects/{zaptec/zaptec.ts,skoda/skoda.ts,emaldo/emaldo.ts}` (replace `lazy`), their
  `adapters/notConfigured.ts`, `emaldo/client.ts:340` (message), tests `zaptec.test.ts:1173-1209`,
  `skoda.test.ts:62-65`, `emaldo.test.ts:122-171`

**Interfaces — produces:**
```ts
// keyedAdapter.ts (server-only)
export type UnavailableCode = 'not_configured' | 'credentials_unreadable'
export function keyedAdapter<S extends CredentialSource, T>(opts: {
  source: S
  /** Builds a client for these values; may itself return the not-configured adapter. */
  build: (values: CredentialValues<S>) => Promise<T>
  /** A client whose every method throws the source's IntegrationError with this code. */
  unavailable: (code: UnavailableCode) => Promise<T>
  resolve?: (source: S) => Promise<ResolvedCredentials<S>> // default resolveCredentials
  env?: Env // default process.env, read per call (VITEST check)
}): () => Promise<T>
```
Per call: `env.VITEST === 'true'` → `unavailable('not_configured')` (no resolve). Else `resolve(source)`;
`CredentialsUnreadableError` → `unavailable('credentials_unreadable')`; other errors propagate. Same fingerprint
as the cached entry → the cached promise; otherwise `build(values)`, cached with its fingerprint (a rejected build
drops the entry if it is still the current one).

Each source's `adapters/notConfigured.ts` exports `unavailable(code)` and keeps `notConfigured = unavailable('not_configured')`:
- not configured: `'Škoda client is not configured (set it under Inställningar or as SKODA_API_KEY / SKODA_VIN)'`, Zaptec `… (… or as ZAPTEC_USERNAME / ZAPTEC_PASSWORD)`, Emaldo `… (… or as EMALDO_USER / EMALDO_PASSWORD / EMALDO_APP_ID / EMALDO_APP_SECRET)`.
- unreadable: `'Stored <Source> credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Inställningar'`.
- Ops as today (Zaptec: per method; Škoda `vehicle`; Emaldo `stats`).

Selectors lose env as the credential source and their VITEST check (now in `keyedAdapter`):
`selectZaptecAdapter(values: CredentialValues<'zaptec'>, env: Env)` (env only for `ZAPTEC_ADAPTER` + the
production guard), `selectSkodaAdapter(values)`, `selectEmaldoAdapter(values)`.

Facade shape (Škoda shown; Zaptec and Emaldo identical in form):
```ts
const getAdapter = keyedAdapter({
  source: 'skoda',
  unavailable: async (code) => (await import('./adapters/notConfigured')).unavailable(code),
  build: async (values): Promise<SkodaClient> => {
    const { apiKey, vin } = values
    if (selectSkodaAdapter(values) === 'http' && apiKey && vin) {
      const { createSkodaClient } = await import('./client')
      return createSkodaClient({ fetch: globalThis.fetch, apiKey, vin })
    }
    return (await import('./adapters/notConfigured')).notConfigured
  },
})
```
Update each facade's header comment (credentials from the resolver, ADR-0026). `emaldo/client.ts:340`'s
login-refused message names "the stored or env Emaldo credentials" instead of the env names only.

- [ ] **Step 1: failing tests.** `keyedAdapter.test.ts` (no DB; inject `resolve` and `env: {}`):
  - same fingerprint twice → `build` called once, same instance; a changed fingerprint → a new instance;
  - two concurrent first calls → one `build`;
  - `CredentialsUnreadableError` from `resolve` → `unavailable('credentials_unreadable')`, `build` not called;
  - another error from `resolve` propagates unchanged;
  - `env: { VITEST: 'true' }` → `unavailable('not_configured')` and `resolve` never called;
  - a rejected `build` is retried on the next call.

  Per facade (existing files): the selection tables move to `(values[, env])` (drop the VITEST rows, keep the
  `fake` + production-guard rows for Zaptec); `unavailable('credentials_unreadable')` throws the source's error
  with that code (`ZaptecError` from all three methods with their ops, `SkodaError` op `vehicle`, `EmaldoError`
  op `stats`), and its message contains no value; the VITEST singleton tests stay. Rewrite
  `emaldo.test.ts:143-171` as "maps each resolved field to the right option": `vi.doMock('~/lib/credentials/resolve', () => ({ resolveCredentials: async () => ({ values: { user: TEST_USER, password: TEST_PASSWORD, appId: TEST_APP_ID, appSecret: TEST_APP_SECRET }, fingerprint: 'f' }) }))` before the fresh `import('./emaldo')` (keep `vi.resetModules()`, the `VITEST` stub, `stubGlobal('fetch')`; add `vi.doUnmock` in `afterEach`).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** run `bunx vitest run src/lib/effects` and
  `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts` (relies on the VITEST `notConfigured`) → PASS.
- [ ] **Step 5:** `grep -rn "lazy" src/lib/effects/{zaptec,skoda,emaldo}` → nothing; `lazy.ts` stays (email,
  storage, queue, elpris, eltariff use it).
- [ ] **Step 6: commit** `feat(charging): rebuild integration clients only when credentials change`.

**Reviewers:** `code-reviewer` + `test-completeness`.

### Task 6: Home point, facility ID, docs

**Files:**
- Modify: `src/lib/vehicleState/sync.ts:56-67`, `src/lib/vehicleState/sync.test.ts:132+`,
  `src/lib/gridTariff/catalogueCheck.ts:13-15,47-72`, `src/lib/gridTariff/catalogueCheck.test.ts` (all `env: ENV`),
  `src/lib/gridTariff/catalogueCheckCron.test.ts` (mock the resolver), `.env.example`, `CLAUDE.md` (code map +
  env list), `docs/adr/0026-integration-credential-store.md`, `docs/adr/0019-external-data-integrations.md`
  (one-line pointer), `docs/superpowers/specs/2026-10-05-charging-settings-design.md` (step 2 corrections),
  `docs/superpowers/roadmaps/2026-10-05-charging-settings.md`

**Interfaces — consumes:** `resolveCredentials`, `CredentialsUnreadableError`.

- [ ] **Step 1: home point.** In `runSkodaSync`:
  ```ts
  const homePoint =
    opts.deps && 'homePoint' in opts.deps ? (opts.deps.homePoint ?? null) : await resolveHomePoint()
  ```
  with a module-level helper:
  ```ts
  // Stored over env (ADR-0026). An unreadable row means the Škoda client call fails
  // with credentials_unreadable inside the run, so the point is just off here.
  async function resolveHomePoint(): Promise<LatLon | null> {
    try {
      return parseHomePoint((await resolveCredentials('skoda')).values.homeCoordinates)
    } catch (error) {
      if (error instanceof CredentialsUnreadableError) return null
      throw error
    }
  }
  ```
  Tests (`sync.test.ts`, has `setupDatabase()`): the existing env test still passes; add "a stored home point
  beats SKODA_HOME_COORDINATES" (key stubbed, `integrationCredentialService.set('skoda', { homeCoordinates: … })`);
  add "an unreadable Škoda row turns the geofence off" (row written under another key; injected fake client →
  `geofence: 'off'`).
- [ ] **Step 2: facility ID.** `runCatalogueCheck(deps: { log; client?; facilityId?: () => Promise<string | undefined> })`,
  default `async () => (await resolveCredentials('gridTariff')).values.facilityId`. Inside the `try`, before
  `parseFacilityId`:
  ```ts
  let rawId: string | undefined
  try {
    rawId = await facilityId()
  } catch (error) {
    if (!(error instanceof CredentialsUnreadableError)) throw error
    result.outcome = 'failed'
    result.code = 'credentials_unreadable'
    return result
  }
  ```
  The `finally` already logs `failed` at warn — make an unreadable row log at **error** (add
  `result.code === 'credentials_unreadable'` to the error branch). Update the doc comment (`not_configured`: "no
  facility ID stored or in `GRID_FACILITY_ID`"). Tests: replace `env: ENV` with `facilityId: id(FACILITY)`
  (`const id = (v?: string) => async () => v`); the unset/blank/malformed table passes `id(undefined)`,
  `id(' ')`, `id('12345')`; add "an unreadable stored ID is failed / credentials_unreadable, nothing fetched,
  logged at error"; add "the default reads the stored ID over GRID_FACILITY_ID" (key + `set('gridTariff', …)` +
  env stub of another valid ID; assert covered by the stored ID's range only). `catalogueCheckCron.test.ts`: add
  `vi.mock('~/lib/credentials/resolve', () => ({ resolveCredentials: async () => ({ values: { facilityId: process.env.GRID_FACILITY_ID?.trim() || undefined }, fingerprint: 'f' }) }))` — that file has no DB — with a comment saying why.
- [ ] **Step 3: run** `bunx vitest run src/lib/vehicleState src/lib/gridTariff` → PASS.
- [ ] **Step 4: docs.**
  - `.env.example`: `CREDENTIALS_ENCRYPTION_KEY=` with a comment (`openssl rand -base64 32`; one per Vercel
    environment; enables GUI-set credentials that override the env vars below field by field, ADR-0026).
  - `CLAUDE.md`: code map — `credentials/` (crypto, env map, cache, resolver; server-only) under `lib/`,
    `integrationCredential` in the services list and `integrationCredential` in the schema list,
    `integrationCredentials.ts` next to `integrationHealth.ts`; env list — `CREDENTIALS_ENCRYPTION_KEY`, and a
    note on the credential vars that a stored value overrides each.
  - ADR-0026: amend the decision with the spec corrections above (uuid `updated_by`, advisory lock, stored-read
    cache, error mapping). ADR-0019: one line under its health codes pointing to ADR-0026 for
    `credentials_unreadable`.
  - Spec step 2: the same corrections, inline.
  - Roadmap: step 1 → `checkpoint passed` with "2026-10-05: owner checked the page on prod; the member redirect
    was verified locally"; step 2 → plan link, PR link, `PR open`.
- [ ] **Step 5: commit** `feat(charging): read the home point and facility ID through the resolver` (code) and
  `docs(charging): record the credential store decisions` (docs).

**Reviewers:** `code-reviewer` + `test-completeness`.

---

## Pre-PR (Phase 5–7)

- Branch review: `code-reviewer`, `migration-guard` + schema-design review over the whole diff, `test-completeness`,
  and a security pass (credential handling).
- [Pre-PR gate](../../feature-workflow.md#pre-pr-gate) in full (check, check:ci, build, db:migrate, test, sv/en keys).
- No UI changed → no browser check. Phase 6 evidence = the gate + a local smoke: with the local
  `CREDENTIALS_ENCRYPTION_KEY` and no rows, `bun run dev` + "Synka nu" on each source from `/charging/settings`
  behaves as before (Zaptec/Škoda/Emaldo from the local `.env.local` values if present, else `not_configured`).
- Re-check `origin/main` for a new `drizzle/0018_*` (parallel sessions) before opening the PR; if one landed,
  rebase, delete our migration + snapshot, regenerate.
- PR title `feat(charging): store integration credentials encrypted`; body per the template; link ADR-0026.
- Checkpoint 2 (prod, after merge) is the owner's: four sources `ok` through one cron cycle; `integration_credential`
  exists and is empty.

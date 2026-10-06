# Charging settings step 3a — credentials server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server side of the credentials UI: per-source save rules (`INVALID_FIELD` lists every bad field,
`REENTER_ALL_FIELDS`), the field names a failed sync points at (`suspect_fields`), and the admin-only `credentials`
procedures. No UI.

**Architecture:** The credential service gains the save rules. `IntegrationError` gains optional `suspectFields`,
which the Škoda, Zaptec and Emaldo clients set from their own status handling; `runPulledSync` → `recordOutcome`
writes them to a new `suspect_fields text[]` on `integration_sync` and `integration_sync_run`, and the health read
model exposes them to admins. A new `credentials` oRPC router wraps the service.

**Tech Stack:** Drizzle (node-postgres), oRPC 1.14 (typed errors with `data`), Zod 4, Vitest (node project, per-test
schema via `setupDatabase()`), bun.

**Spec:** `docs/superpowers/specs/2026-10-05-charging-settings-design.md` — sections "Credentials per source" and
"Step 3a". ADR: `docs/adr/0026-integration-credential-store.md`. Roadmap:
`docs/superpowers/roadmaps/2026-10-05-charging-settings.md`.

## Global Constraints

- Values never leave the service except through `readStored` (resolver). Errors, logs, procedure outputs and the new
  column carry **field names only**, never values.
- An unknown field name is echoed only if it matches `/^[A-Za-z]{1,32}$/`, else `unknown`.
- All `db` access through services (ADR-0002). Procedures: `adminProcedure` for all three; `.errors()` maps domain
  codes; no `readStored` / `resolveCredentials` in procedures or routes.
- Logging via `~/lib/logger` only; pass errors under the `error` key (the server logger runs `serializeError`, which
  drops a Drizzle query's bound params — the ciphertext).
- Every table ends with `.enableRLS()`; migrations via `bun run db:generate --name=<desc>`; never hand-edit
  `drizzle/meta/`.
- **Rollback safety:** older code must still be able to write both sync tables after this migration (Vercel instant
  rollback). No CHECK may tie `integration_sync.suspect_fields` to another column that older code changes.
- Conventional commits, ≤72 chars, one hat per commit. Commit trailer:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never run two vitest processes at once (shared local DB, per-worker schema names collide). Reviewers must not run
  vitest while the implementer does.

## Review Focus

1. **A rollback's leftover `suspect_fields`** (older code records a success, clears `error_code`, leaves the column):
   health must not show stale suspects → Task 3 test "getHealth hides leftover suspect fields once error_code is null".
2. **A save over an unreadable row that leaves out a field** must write nothing and name the missing fields →
   Task 1 test "REENTER_ALL_FIELDS ... writes nothing".
3. **Two invalid fields plus an unknown one in one save** → all named in one error, unknown deduplicated → Task 1 test
   "lists every invalid field at once".
4. **A field of another source sent to `set`** (`{ source: 'skoda', fields: { username } }`) → rejected at input,
   nothing stored → Task 5 test "rejects a field of another source".
5. **A failure code change mid-streak** (auth_failed with `apiKey` → `unreachable`) must drop the stale suspects →
   Task 3 test "a later failure without suspects clears them".

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/services/integrationCredential/errors.ts` | modify | `fields: string[]` on the error; new `REENTER_ALL_FIELDS` |
| `src/lib/services/integrationCredential/integrationCredential.ts` | modify | collect every invalid field; require every field over an unreadable row |
| `src/lib/integrationCredentials.ts` | modify | `CREDENTIAL_FIELD_NAMES` (flat vocabulary, for the CHECK) |
| `src/lib/db/schema/integrationSync.ts` | modify | `suspect_fields` on both tables + CHECKs |
| `drizzle/0019_integration_sync_suspect_fields.sql` | generated | the migration |
| `src/lib/effects/integrationError.ts` | modify | optional `suspectFields` + constructor |
| `src/lib/services/integrationSync/transition.ts` | modify | `SyncOutcome.suspectFields`, `HealthSnapshot.suspectFields`, `nextRow` |
| `src/lib/services/integrationSync/integrationSync.ts` | modify | write both columns, `adminDetail.suspectFields`, `RunRow.suspectFields` |
| `src/lib/integrations/runPulledSync.ts` | modify | pass `error.suspectFields` into the outcome |
| `src/lib/effects/{skoda,zaptec,emaldo}/{errors,client}.ts` | modify | typed `suspectFields` option; the mappings |
| `src/lib/orpc/procedures/credentials.ts` (+ `.test.ts`) | create | `status` / `set` / `clear` |
| `src/lib/orpc/router.ts` | modify | register `credentials` |
| `test/browser/syncHealth.ts`, browser fixtures | modify | only if typecheck demands the new fields |
| roadmap, spec | modify | row 3a `PR open`; spec corrections from this plan |

---

### Task 0: Check main still matches the spec

**Files:** none (read-only).

- [ ] **Step 1:** Confirm the seams the plan edits still have the shapes below. Run:

```bash
grep -n "INVALID_FIELD\|NOTHING_TO_SAVE\|ENCRYPTION_KEY_MISSING" src/lib/services/integrationCredential/errors.ts
grep -n "abstract readonly code" src/lib/effects/integrationError.ts
grep -n "status === 403 || status === 404" src/lib/effects/skoda/client.ts
grep -n "grantRetired" src/lib/effects/zaptec/client.ts
grep -n "could not be decoded\|function refused" src/lib/effects/emaldo/client.ts
ls drizzle | tail -2
```

Expected: every grep hits; the newest migration is `0018_integration_credential.sql`. If any differs, stop and
re-read the changed file before continuing.

---

### Task 1: Save rules — every invalid field, `REENTER_ALL_FIELDS`

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/services/integrationCredential/errors.ts`
- Modify: `src/lib/services/integrationCredential/integrationCredential.ts` (`normalize`, `set`)
- Test: `src/lib/services/integrationCredential/integrationCredential.test.ts`

**Interfaces:**
- Produces: `IntegrationCredentialDomainError { code; fields: readonly string[] }` (was `field?: string`);
  `IntegrationCredentialDomainErrorCode` gains `'REENTER_ALL_FIELDS'`. `INVALID_FIELD.fields` = every invalid name
  (unknown names first in input order, deduplicated, then known fields in vocabulary order).
  `REENTER_ALL_FIELDS.fields` = the source's fields the save left blank, in vocabulary order. Message:
  `` `${code} (${fields.join(', ')})` `` when `fields` is non-empty, else `code`.

- [ ] **Step 1: Update the existing tests to the new shape, and add the new ones (failing).**

In `integrationCredential.test.ts`, replace every `err.field` / `.field` assertion with `err.fields`:
`expect(err.field).toBe(x)` → `expect(err.fields).toEqual([x])`, and
`expect(err.message).toBe(\`INVALID_FIELD (${field})\`)` stays as is (one field). Then change the test
`'replaces an unreadable row and logs only the source'` to send every Škoda field:

```ts
  it('replaces an unreadable row when every field is sent, and logs only the source', async () => {
    await set('skoda', { apiKey: 'old-key' }, null)
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const warn = vi.spyOn(logger, 'warn')
    const result = await set(
      'skoda',
      { apiKey: 'new-key', vin: 'TMBJR7NY0PZ123456', homeCoordinates: '59.3293,18.0686' },
      null,
    )
    expect(result.fieldsSet).toEqual(['apiKey', 'vin', 'homeCoordinates'])
    expect(await readStored('skoda')).toEqual({
      apiKey: 'new-key',
      vin: 'TMBJR7NY0PZ123456',
      homeCoordinates: '59.3293,18.0686',
    })
    expect(warn).toHaveBeenCalledWith('integration credentials replaced unreadable row', {
      source: 'skoda',
    })
  })
```

(Keep the original test's exact `warn` assertion shape if it differs; check `homeCoordinates` format against an
existing passing case in the same file — the "stores home coordinates" test.)

Add inside `describe('set', …)`:

```ts
  it('lists every invalid field at once, unknown names first and deduplicated', async () => {
    const err = await domainError(() =>
      set(
        'skoda',
        { 'x-1': 'a', 'y-2': 'b', apiKey: 'fine', vin: 'short', homeCoordinates: 'nowhere' },
        null,
      ),
    )
    expect(err.code).toBe('INVALID_FIELD')
    expect(err.fields).toEqual(['unknown', 'vin', 'homeCoordinates'])
    expect(err.message).toBe('INVALID_FIELD (unknown, vin, homeCoordinates)')
    expect(await rows()).toEqual([])
  })

  it('REENTER_ALL_FIELDS over an unreadable row with a field left blank writes nothing', async () => {
    await set('zaptec', { username: 'u', password: 'p' }, null)
    const [before] = await rows()
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', newKey())
    const err = await domainError(() => set('zaptec', { username: 'new-user', password: '  ' }, null))
    expect(err.code).toBe('REENTER_ALL_FIELDS')
    expect(err.fields).toEqual(['password'])
    expect(err.message).toBe('REENTER_ALL_FIELDS (password)')
    const [after] = await rows()
    expect(after.ciphertext).toBe(before.ciphertext)
  })

  it('over a readable row a blank field still keeps its stored value', async () => {
    await set('zaptec', { username: 'u', password: 'p' }, null)
    await set('zaptec', { username: 'u2', password: '' }, null)
    expect(await readStored('zaptec')).toEqual({ username: 'u2', password: 'p' })
  })
```

- [ ] **Step 2: Run them; expect failures.**

Run: `bunx vitest run src/lib/services/integrationCredential/integrationCredential.test.ts`
Expected: FAIL — `err.fields` undefined; `REENTER_ALL_FIELDS` not thrown.

- [ ] **Step 3: Implement.** `errors.ts`:

```ts
export type IntegrationCredentialDomainErrorCode =
  // Unknown field names for the source, or values that fail their field's validation; `fields` lists them all.
  | 'INVALID_FIELD'
  // Every provided field was blank: nothing would change.
  | 'NOTHING_TO_SAVE'
  // CREDENTIALS_ENCRYPTION_KEY is unset or malformed, so nothing can be encrypted.
  | 'ENCRYPTION_KEY_MISSING'
  // The stored row can't be read and the save left fields blank (`fields`): they would
  // silently fall back to env, so every field of the source must be entered again.
  | 'REENTER_ALL_FIELDS'

export class IntegrationCredentialDomainError extends Error {
  constructor(
    readonly code: IntegrationCredentialDomainErrorCode,
    readonly fields: readonly string[] = [],
  ) {
    // Field names only — never a value.
    super(fields.length > 0 ? `${code} (${fields.join(', ')})` : code)
    this.name = 'IntegrationCredentialDomainError'
  }
}
```

In `integrationCredential.ts`, make `normalize` report instead of throw:

```ts
const INVALID = Symbol('invalid')

/** The value to store for one field; null for a blank one (keeps the stored value); INVALID when it fails validation. */
function normalize(
  source: CredentialSource,
  field: string,
  raw: unknown,
): string | null | typeof INVALID {
  if (raw === undefined) return null
  if (typeof raw !== 'string') return INVALID
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = source === 'skoda' && field === 'vin' ? trimmed.toUpperCase() : trimmed
  const valid =
    value.length <= MAX_VALUE_LENGTH &&
    !CONTROL_CHARACTER.test(value) &&
    value.isWellFormed() &&
    (source === 'skoda' && field === 'vin'
      ? VIN_PATTERN.test(value)
      : source === 'skoda' && field === 'homeCoordinates'
        ? parseHomePoint(value) !== null
        : source === 'gridTariff' && field === 'facilityId'
          ? parseFacilityId(value) !== null
          : true)
  return valid ? value : INVALID
}
```

Replace the validation head of `set` (everything before `if (!isEncryptionKeyConfigured())`) with:

```ts
  const invalid = new Set<string>()
  for (const field of Object.keys(fields)) {
    // Echo the caller's key only when it looks like a field name.
    if (!isCredentialField(source, field)) invalid.add(SAFE_FIELD_NAME.test(field) ? field : 'unknown')
  }
  const updates: CredentialValues<S> = {}
  for (const field of fieldsOf(source)) {
    if (!Object.hasOwn(fields, field)) continue
    const value = normalize(source, field, fields[field])
    if (value === INVALID) invalid.add(field)
    else if (value !== null) updates[field] = value
  }
  if (invalid.size > 0) {
    throw new IntegrationCredentialDomainError('INVALID_FIELD', [...invalid])
  }
  if (Object.keys(updates).length === 0) {
    throw new IntegrationCredentialDomainError('NOTHING_TO_SAVE')
  }
```

And inside the transaction, replace the unreadable-row `catch` body:

```ts
        } catch (err) {
          if (!(err instanceof CredentialsUnreadableError)) throw err
          // Unsent fields would silently fall back to env: the whole source is re-entered.
          const missing = fieldsOf(source).filter((field) => updates[field] === undefined)
          if (missing.length > 0) throw new IntegrationCredentialDomainError('REENTER_ALL_FIELDS', missing)
          logger.warn('integration credentials replaced unreadable row', { source })
        }
```

Update the doc comment on `set`: "Over an unreadable row every field of the source must be sent
(`REENTER_ALL_FIELDS`)."

- [ ] **Step 4: Run; expect PASS.** `bunx vitest run src/lib/services/integrationCredential/` then
`bun run typecheck` (fix any other `.field` reader the compiler names).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/services/integrationCredential
git commit -m "feat(charging): name every invalid credential field and require re-entry"
```

---

### Task 2: Schema — `suspect_fields` on both sync tables

**Reviewers:** `migration-guard` + schema-design reviewer (`general-purpose` agent that loads
`supabase-postgres-best-practices` and judges against the writes in `recordOutcome` and the reads in
`getAllHealth` / `listRecentRunsBySource`; it must also judge rollback safety and the `<@` vocabulary CHECK).

**Files:**
- Modify: `src/lib/integrationCredentials.ts`
- Modify: `src/lib/db/schema/integrationSync.ts`
- Create (generated): `drizzle/0019_integration_sync_suspect_fields.sql` + `drizzle/meta/*`
- Test: `src/lib/services/integrationSync/integrationSync.test.ts`

**Interfaces:**
- Produces: `CREDENTIAL_FIELD_NAMES: readonly string[]` (every field name across sources, deduplicated, in
  vocabulary order); `integrationSync.suspectFields` and `integrationSyncRun.suspectFields`, both `string[] | null`.

- [ ] **Step 1: Write the failing CHECK tests** at the end of `integrationSync.test.ts`:

```ts
const runValues = {
  source: 'zaptec',
  trigger: 'cron',
  startedAt: T0,
  finishedAt: T0,
  durationMs: 0,
  timings: {},
} as const

test('integration_sync_run suspect_fields: names from the vocabulary, only on a failed run', async () => {
  await db.insert(integrationSyncRun).values({
    ...runValues,
    outcome: 'failed',
    errorCode: 'auth_failed',
    suspectFields: ['username', 'password'],
  })
  await expect(
    db.insert(integrationSyncRun).values({ ...runValues, outcome: 'ok', suspectFields: ['vin'] }),
  ).rejects.toThrow()
  await expect(
    db.insert(integrationSyncRun).values({
      ...runValues,
      outcome: 'failed',
      errorCode: 'auth_failed',
      suspectFields: [],
    }),
  ).rejects.toThrow()
  await expect(
    db.insert(integrationSyncRun).values({
      ...runValues,
      outcome: 'failed',
      errorCode: 'auth_failed',
      suspectFields: ['token'],
    }),
  ).rejects.toThrow()
})

test('integration_sync suspect_fields: non-empty vocabulary names; no tie to error_code (rollback-safe)', async () => {
  await db.insert(integrationSync).values({ source: 'zaptec', updatedAt: T0 })
  // A rollback's success leaves the column while clearing error_code: must be writable.
  await db
    .update(integrationSync)
    .set({ suspectFields: ['username'] })
    .where(eq(integrationSync.source, 'zaptec'))
  await expect(
    db.update(integrationSync).set({ suspectFields: [] }).where(eq(integrationSync.source, 'zaptec')),
  ).rejects.toThrow()
  await expect(
    db
      .update(integrationSync)
      .set({ suspectFields: ['token'] })
      .where(eq(integrationSync.source, 'zaptec')),
  ).rejects.toThrow()
})
```

- [ ] **Step 2: Run; expect FAIL** (TypeScript: `suspectFields` doesn't exist).
`bunx vitest run src/lib/services/integrationSync/integrationSync.test.ts`

- [ ] **Step 3: Add the vocabulary** to `src/lib/integrationCredentials.ts`, after `CREDENTIAL_FIELDS`:

```ts
/**
 * Every field name across sources, deduplicated, in vocabulary order: the allowed values of the sync tables'
 * `suspect_fields` (names only). Changing it changes the rendered DB CHECK text: run `bun run db:generate`.
 */
export const CREDENTIAL_FIELD_NAMES: readonly string[] = [
  ...new Set(Object.values(CREDENTIAL_FIELDS).flat()),
]
```

- [ ] **Step 4: Add the columns and CHECKs** in `src/lib/db/schema/integrationSync.ts`. Import
`CREDENTIAL_FIELD_NAMES` from `'../../integrationCredentials'`. Shared helper above the tables:

```ts
// Non-empty and drawn from the credential vocabulary (names only, never a value — ADR-0026).
const suspectFieldsCheck = (column: AnyPgColumn) =>
  sql`${column} IS NULL OR (cardinality(${column}) > 0 AND ${column} <@ ARRAY[${sqlList(CREDENTIAL_FIELD_NAMES)}]::text[])`
```

(`AnyPgColumn` from `drizzle-orm/pg-core`.) In `integrationSync`, after `credentialReminderDays`:

```ts
    // The credential fields the current failure points at (Škoda 404 → vin), set by the
    // client from the vendor's answer; null when it points at none. Read only while
    // `error_code` is set: no CHECK ties the two, because older code (an instant
    // rollback) clears `error_code` on success and leaves this column.
    suspectFields: text('suspect_fields').array(),
```

and the CHECK `check('integration_sync_suspect_fields_check', suspectFieldsCheck(table.suspectFields))`.

In `integrationSyncRun`, after `errorMessage`:

```ts
    // The run's suspect credential fields (see integration_sync.suspect_fields).
    suspectFields: text('suspect_fields').array(),
```

and CHECKs `check('integration_sync_run_suspect_fields_check', suspectFieldsCheck(table.suspectFields))`,
`check('integration_sync_run_suspect_fields_outcome_check', sql\`${table.suspectFields} IS NULL OR ${table.outcome} <> 'ok'\`)`.
(Rows are append-only and older code inserts NULL, so this one is rollback-safe.)

- [ ] **Step 5: Generate and apply.**

```bash
bun run db:generate --name=integration_sync_suspect_fields
cat drizzle/0019_integration_sync_suspect_fields.sql
bun run db:migrate
```

Expected SQL: two `ADD COLUMN "suspect_fields" text[]` (nullable, no default: no rewrite) and three
`ADD CONSTRAINT ... CHECK` lines; nothing dropped. Adding a CHECK scans the table once under an ACCESS EXCLUSIVE
lock; `integration_sync` has ≤4 rows and `integration_sync_run` is pruned to 90 days, so it is instant.

- [ ] **Step 6: Run; expect PASS.** `bunx vitest run src/lib/services/integrationSync/integrationSync.test.ts test/rls.test.ts`

- [ ] **Step 7: Commit.**

```bash
git add src/lib/integrationCredentials.ts src/lib/db/schema/integrationSync.ts drizzle src/lib/services/integrationSync/integrationSync.test.ts
git commit -m "feat(charging): add suspect credential fields to sync health"
```

---

### Task 3: Sync lifecycle records and exposes suspect fields

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/effects/integrationError.ts`
- Modify: `src/lib/services/integrationSync/transition.ts`
- Modify: `src/lib/services/integrationSync/integrationSync.ts`
- Modify: `src/lib/integrations/runPulledSync.ts`
- Test: `transition.test.ts`, `integrationSync.test.ts`, `src/lib/integrations/runPulledSync.test.ts`
- Fixtures (only if `bun run typecheck` names them): `test/browser/syncHealth.ts`,
  `src/components/evCharging/*.browser.test.tsx`, `src/routes/_authenticated/**/-*.browser.test.tsx`

**Interfaces:**
- Consumes: Task 2's columns.
- Produces:
  - `IntegrationError.suspectFields?: readonly string[]` (unset or non-empty), constructor
    `(message: string, options?: { cause?: unknown; suspectFields?: readonly string[] })`.
  - `SyncOutcome` failure branch: `suspectFields?: readonly string[] | null`.
  - `HealthSnapshot.suspectFields: string[] | null`.
  - `IntegrationHealth.adminDetail.suspectFields: string[] | null` (null unless `code` is set).
  - `RunRow.suspectFields: string[] | null`.

- [ ] **Step 1: Failing tests.**

`transition.test.ts`: add `suspectFields: null` to the `never` snapshot, then:

```ts
describe('suspect fields', () => {
  const authFailed = (suspectFields?: readonly string[] | null): SyncOutcome => ({
    ok: false,
    kind: 'failed',
    code: 'auth_failed',
    message: 'refused',
    stats,
    suspectFields,
  })

  test('a failure records its suspect fields', () => {
    expect(nextRow(healthy, authFailed(['apiKey']), NOW, STARTED).row.suspectFields).toEqual(['apiKey'])
  })
  test('none or an empty list is null', () => {
    expect(nextRow(healthy, authFailed(), NOW, STARTED).row.suspectFields).toBeNull()
    expect(nextRow(healthy, authFailed([]), NOW, STARTED).row.suspectFields).toBeNull()
  })
  test('a later failure without suspects clears them', () => {
    const first = nextRow(healthy, authFailed(['apiKey']), NOW, STARTED).row
    expect(nextRow(first, fail('unreachable'), NOW, STARTED).row.suspectFields).toBeNull()
  })
  test('success clears them', () => {
    const first = nextRow(healthy, authFailed(['vin']), NOW, STARTED).row
    expect(nextRow(first, ok, NOW, STARTED).row.suspectFields).toBeNull()
  })
})
```

`integrationSync.test.ts` (a typed helper: spreading the union-typed `failed` wouldn't type-check):

```ts
const authFailed = (suspectFields: readonly string[]): SyncOutcome => ({
  ok: false,
  kind: 'failed',
  code: 'auth_failed',
  message: 'refused',
  stats,
  suspectFields,
})

test('recordOutcome stores suspect fields on the health row and the run; admins see them', async () => {
  const attemptId = await acquire(T0)
  await recordOutcome(
    'zaptec',
    authFailed(['username', 'password']),
    { attemptId, trigger: 'admin', startedAt: T0, now: at(1000) },
  )
  const admin = await getHealth('zaptec', { now: at(2000), includeAdminDetail: true })
  expect(admin.adminDetail?.suspectFields).toEqual(['username', 'password'])
  const member = await getHealth('zaptec', { now: at(2000), includeAdminDetail: false })
  expect(member.adminDetail).toBeNull()
  expect((await listRecentRuns('zaptec', { limit: 1 }))[0].suspectFields).toEqual(['username', 'password'])
  expect((await listRecentRunsBySource({ limit: 1 })).zaptec[0].suspectFields).toEqual([
    'username',
    'password',
  ])
})

test('a success clears suspect fields; its run row has none', async () => {
  let attemptId = await acquire(T0)
  await recordOutcome('zaptec', authFailed(['password']), {
    attemptId, trigger: 'cron', startedAt: T0, now: at(1000),
  })
  attemptId = await acquire(at(2000))
  await recordOutcome('zaptec', ok, { attemptId, trigger: 'cron', startedAt: at(2000), now: at(3000) })
  const health = await getHealth('zaptec', { now: at(4000), includeAdminDetail: true })
  expect(health.adminDetail?.suspectFields).toBeNull()
  const [row] = await db.select().from(integrationSync).where(eq(integrationSync.source, 'zaptec'))
  expect(row.suspectFields).toBeNull()
  expect((await listRecentRuns('zaptec', { limit: 1 }))[0].suspectFields).toBeNull()
})

test('getHealth hides leftover suspect fields once error_code is null (a rollback’s success)', async () => {
  const attemptId = await acquire(T0)
  await recordOutcome('zaptec', ok, { attemptId, trigger: 'cron', startedAt: T0, now: at(1000) })
  await db
    .update(integrationSync)
    .set({ suspectFields: ['password'] })
    .where(eq(integrationSync.source, 'zaptec'))
  const health = await getHealth('zaptec', { now: at(2000), includeAdminDetail: true })
  expect(health.adminDetail?.suspectFields).toBeNull()
})
```

`runPulledSync.test.ts`: let `FakeRemoteError` take suspects, and add:

```ts
class FakeRemoteError extends IntegrationError {
  override readonly name = 'FakeRemoteError'
  constructor(
    readonly code: IntegrationErrorCode,
    suspectFields?: readonly string[],
  ) {
    super(`remote failed: ${code}`, { suspectFields })
  }
}

test('an IntegrationError’s suspect fields are recorded with the failure', async () => {
  await run(async () => {
    throw new FakeRemoteError('auth_failed', ['apiKey', 'vin'])
  })
  const health = await getHealth('elpris', { now: T0, includeAdminDetail: true })
  expect(health.adminDetail?.suspectFields).toEqual(['apiKey', 'vin'])
})

test('an internal error records no suspect fields', async () => {
  await expect(run(async () => {
    throw new Error('bug')
  })).rejects.toThrow('bug')
  const health = await getHealth('elpris', { now: T0, includeAdminDetail: true })
  expect(health.adminDetail?.suspectFields).toBeNull()
})
```

(Use the file's existing `run(execute, opts?)` helper; if its default options need a logger, copy the call shape of
the test `'an IntegrationError is a recorded failure: warn line, code, no throw'`.)

- [ ] **Step 2: Run; expect FAIL.**
`bunx vitest run src/lib/services/integrationSync src/lib/integrations/runPulledSync.test.ts`

- [ ] **Step 3: Implement.**

`integrationError.ts`:

```ts
export abstract class IntegrationError extends Error {
  abstract readonly code: IntegrationErrorCode
  /**
   * The credential fields the vendor's answer points at (Škoda 404 → `vin`), by name only
   * (ADR-0026); unset when it points at none. Recorded with the run as `suspect_fields`.
   */
  readonly suspectFields?: readonly string[]

  constructor(message: string, options?: { cause?: unknown; suspectFields?: readonly string[] }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    if (options?.suspectFields?.length) this.suspectFields = options.suspectFields
  }
}
```

`transition.ts`: add `suspectFields?: readonly string[] | null` to the failure branch of `SyncOutcome`,
`suspectFields: string[] | null` to `HealthSnapshot`. In `nextRow`, the success row gets `suspectFields: null`; the
failure row gets `suspectFields: outcome.suspectFields?.length ? [...outcome.suspectFields] : null`.

`integrationSync.ts`:
- `toSnapshot`: `suspectFields: row.suspectFields`.
- `IntegrationHealth.adminDetail` type gains `suspectFields: string[] | null`; in `toHealth`:
  `suspectFields: snapshot?.errorCode ? snapshot.suspectFields : null` with the comment
  `// Gated on error_code: a rollback's success clears the code and leaves the column.`
- `recordOutcome`'s run insert: `suspectFields: row.suspectFields` (the failure's list, null on success).
- `RunRow` gains `suspectFields: string[] | null`; `runColumns` gains `suspectFields: integrationSyncRun.suspectFields`;
  the LATERAL select in `listRecentRunsBySource` gains `suspectFields: recent.suspectFields`.

`runPulledSync.ts`, in the failure `outcome`: `suspectFields: failed ? (error.suspectFields ?? null) : null,`.

- [ ] **Step 4: Run; expect PASS**, then `bun run typecheck`. Add `suspectFields: null` to any fixture the compiler
names (e.g. `adminDetail` objects in browser tests, `RunRow` literals in `SyncRunsDialog.browser.test.tsx`).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/effects/integrationError.ts src/lib/services/integrationSync src/lib/integrations test src/components src/routes
git commit -m "feat(charging): record suspect credential fields with each sync"
```

---

### Task 4: Clients name the fields their vendor points at

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/effects/skoda/errors.ts`, `src/lib/effects/skoda/client.ts` (`statusError`)
- Modify: `src/lib/effects/zaptec/errors.ts`, `src/lib/effects/zaptec/client.ts` (token 400/401 branch)
- Modify: `src/lib/effects/emaldo/errors.ts`, `src/lib/effects/emaldo/client.ts` (`refused`, the decode failure)
- Test: `src/lib/effects/{skoda,zaptec,emaldo}/{skoda,zaptec,emaldo}.test.ts`

**Interfaces:**
- Consumes: Task 3's `IntegrationError` constructor.
- Produces: each subclass's options gain `suspectFields?: readonly CredentialField<'skoda' | 'zaptec' | 'emaldo'>[]`
  (its own source).

Mappings (spec "Credentials per source"):

| Client | Condition | `suspectFields` |
|---|---|---|
| Škoda `statusError` | 401 | `['apiKey']` |
| Škoda `statusError` | 404 | `['vin']` |
| Škoda `statusError` | 403 | `['apiKey', 'vin']` |
| Zaptec token | 400/401, not `unsupported_grant_type` | `['username', 'password']` |
| Zaptec token | 400/401, `unsupported_grant_type` | none |
| Emaldo `refused('login', …)` | refused login | `['user', 'password']` |
| Emaldo `post` | Result can't be decoded | `['appId', 'appSecret']` |

Everything else (Škoda 429/5xx, Zaptec chargers 401 after a re-login, Emaldo -12 after a fresh login, a non-login
refusal, `not_configured`, `credentials_unreadable`) sets none.

- [ ] **Step 1: Failing tests.**

`skoda.test.ts` — extend the status table with the expected suspects:

```ts
test.each([
  [401, 'auth_failed', ['apiKey']],
  [403, 'forbidden', ['apiKey', 'vin']],
  [404, 'forbidden', ['vin']],
  [429, 'rate_limited', undefined],
  [500, 'unreachable', undefined],
  [400, 'unexpected_response', undefined],
] as const)('HTTP %i → %s, suspects %j', async (status, code, suspectFields) => {
  const { skoda } = client(() => jsonResponse({ type: 'x', status }, { status }))
  const err = await skoda.vehicleState().catch((e: unknown) => e)
  expect(err).toMatchObject({ name: 'SkodaError', code, status })
  expect((err as SkodaError).suspectFields).toEqual(suspectFields)
})
```

(Replace the existing `'HTTP %i → %s'` table; import `SkodaError` if the file doesn't.)

`zaptec.test.ts` — in `'token 400 → auth_failed, never retried'` add
`expect(err.suspectFields).toEqual(['username', 'password'])`; in the grant-retired test (search
`unsupported_grant_type`) add `expect(err.suspectFields).toBeUndefined()`; in `'a second 401 after re-login fails
auth_failed'` add `expect(err.suspectFields).toBeUndefined()`.

`emaldo.test.ts` — in `'a refused login (Status %i) is auth_failed and echoes nothing'` add
`expect(err.suspectFields).toEqual(['user', 'password'])`; in `'a result sealed with another secret hints that the
app secret rotated'` and `'an undecodable stats Result hints that the app secret rotated'` add
`expect(err.suspectFields).toEqual(['appId', 'appSecret'])`; in `'-12 again right after the re-login is
auth_failed'` and `'-12 during discovery on a fresh token is auth_failed'` add
`expect(err.suspectFields).toBeUndefined()`.

- [ ] **Step 2: Run; expect FAIL.**
`bunx vitest run src/lib/effects/skoda src/lib/effects/zaptec src/lib/effects/emaldo`

- [ ] **Step 3: Implement.** Each subclass, e.g. `skoda/errors.ts`:

```ts
import type { CredentialField } from '~/lib/integrationCredentials'
…
    options?: {
      cause?: unknown
      message?: string
      /** The Škoda credential fields this answer points at (names only). */
      suspectFields?: readonly CredentialField<'skoda'>[]
    },
  ) {
    super(
      options?.message ??
        `Škoda ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      { cause: options?.cause, suspectFields: options?.suspectFields },
    )
  }
```

(Same for `ZaptecError` with `CredentialField<'zaptec'>` and `EmaldoError` with `CredentialField<'emaldo'>`.
`IntegrationError`'s constructor treats `cause: undefined` as no cause.)

`skoda/client.ts` `statusError`:

```ts
function statusError(status: number): SkodaError {
  // 401 api-key-expired.
  if (status === 401) return new SkodaError('auth_failed', 'vehicle', status, { suspectFields: ['apiKey'] })
  // 403 api-key-not-authorized: the key isn't for this car — can't tell which is wrong.
  if (status === 403) {
    return new SkodaError('forbidden', 'vehicle', status, { suspectFields: ['apiKey', 'vin'] })
  }
  // 404: no vehicle for the VIN.
  if (status === 404) return new SkodaError('forbidden', 'vehicle', status, { suspectFields: ['vin'] })
  if (status === 429) return new SkodaError('rate_limited', 'vehicle', status)
  if (status >= 500) return new SkodaError('unreachable', 'vehicle', status)
  return new SkodaError('unexpected_response', 'vehicle', status)
}
```

`zaptec/client.ts`, the token 400/401 branch: add
`suspectFields: grantRetired ? undefined : ['username', 'password'],` to the options.

`emaldo/client.ts`: in `refused`, the login branch's options gain `suspectFields: ['user', 'password']`; the
decode-failure `throw` in `post` gains `suspectFields: ['appId', 'appSecret']`.

- [ ] **Step 4: Run; expect PASS.** Same command, then `bun run typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/effects
git commit -m "feat(charging): point vendor credential failures at their fields"
```

---

### Task 5: `credentials` procedures

**Reviewers:** `code-reviewer` + a reviewer loading `better-auth-security-best-practices` (permission boundary,
value leakage through errors/logs/outputs).

**Files:**
- Create: `src/lib/orpc/procedures/credentials.ts`
- Create: `src/lib/orpc/procedures/credentials.test.ts`
- Modify: `src/lib/orpc/router.ts`
- Check: `src/lib/services/integrationCredential/index.ts` re-exports `status`, `set`, `clear`,
  `IntegrationCredentialDomainError` and the code type (add any missing).

**Interfaces:**
- Consumes: Task 1's error shape; the service's `status()`, `set()`, `clear()`.
- Produces (3b relies on these): `appRouter.credentials.status` → `CredentialStatus`;
  `credentials.set({ source, fields })` → `{ fieldsSet, updatedAt }`, defined errors `INVALID_FIELD` /
  `REENTER_ALL_FIELDS` (both `data: { fields: string[] }`), `NOTHING_TO_SAVE`, `ENCRYPTION_KEY_MISSING`;
  `credentials.clear({ source })` → `{ cleared: boolean }`.

- [ ] **Step 1: Failing tests** — `credentials.test.ts` (copy `noopLog`, `baseContext`, `mockSession`, `signIn` from
`tariff.test.ts` verbatim):

```ts
import { randomBytes } from 'node:crypto'
import { call, ORPCError } from '@orpc/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
// …auth, db, user, Logger imports as in tariff.test.ts…
import { CREDENTIAL_FIELDS, CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import { readStored } from '~/lib/services/integrationCredential'
import { setupDatabase } from '~test/setup'
import { credentialsRouter, setCredentialsInput } from './credentials'

setupDatabase()

beforeEach(() => {
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function capturingLog() {
  const lines: unknown[][] = []
  const log: Logger = {
    debug: (...a) => lines.push(a),
    info: (...a) => lines.push(a),
    warn: (...a) => lines.push(a),
    error: (...a) => lines.push(a),
    child: () => log,
  }
  return { log, text: () => JSON.stringify(lines) }
}

const SECRET = 'sk-super-secret-value-123'

test.each([
  ['status', undefined],
  ['set', { source: 'zaptec', fields: { password: SECRET } }],
  ['clear', { source: 'zaptec' }],
] as const)('%s is forbidden for a member and rejects anonymous callers', async (name, input) => {
  await expect(call(credentialsRouter[name], input as never, { context: baseContext() })).rejects.toThrow()
  await signIn('user')
  await expect(
    call(credentialsRouter[name], input as never, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await readStored('zaptec')).toBeNull()
})

test('the input schema allows exactly each source’s own fields', () => {
  for (const source of CREDENTIAL_SOURCES) {
    const option = setCredentialsInput.options.find((o) => o.shape.source.value === source)
    expect(Object.keys(option?.shape.fields.shape ?? {})).toEqual([...CREDENTIAL_FIELDS[source]])
  }
})

test('set stores, returns names only, and logs names only', async () => {
  await signIn('admin')
  const { log, text } = capturingLog()
  const result = await call(
    credentialsRouter.set,
    { source: 'zaptec', fields: { username: 'me@example.com', password: SECRET } },
    { context: { ...baseContext(), log } },
  )
  expect(result.fieldsSet).toEqual(['username', 'password'])
  expect(JSON.stringify(result)).not.toContain(SECRET)
  expect(await readStored('zaptec')).toEqual({ username: 'me@example.com', password: SECRET })
  expect(text()).toContain('admin set integration credentials')
  expect(text()).not.toContain(SECRET)
  expect(text()).not.toContain('me@example.com')
})

test('set maps INVALID_FIELD with every field name and no value', async () => {
  await signIn('admin')
  const err = await call(
    credentialsRouter.set,
    { source: 'skoda', fields: { vin: 'bad-vin-value', homeCoordinates: 'nowhere-value' } },
    { context: baseContext() },
  ).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ORPCError)
  expect(err).toMatchObject({ code: 'INVALID_FIELD', defined: true, data: { fields: ['vin', 'homeCoordinates'] } })
  expect(JSON.stringify(err)).not.toContain('bad-vin-value')
})

test('set maps REENTER_ALL_FIELDS with the blank fields', async () => {
  await signIn('admin')
  await call(credentialsRouter.set, { source: 'zaptec', fields: { username: 'u', password: 'p' } }, {
    context: baseContext(),
  })
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
  await expect(
    call(credentialsRouter.set, { source: 'zaptec', fields: { username: 'u2' } }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'REENTER_ALL_FIELDS', defined: true, data: { fields: ['password'] } })
})

test.each([
  ['NOTHING_TO_SAVE', { password: '   ' }, undefined],
  ['ENCRYPTION_KEY_MISSING', { password: SECRET }, ''],
] as const)('set maps %s', async (code, fields, key) => {
  await signIn('admin')
  if (key !== undefined) vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', key)
  await expect(
    call(credentialsRouter.set, { source: 'zaptec', fields }, { context: baseContext() }),
  ).rejects.toMatchObject({ code, defined: true })
})

test('set rejects a field of another source at input, storing nothing', async () => {
  await signIn('admin')
  await expect(
    call(credentialsRouter.set, { source: 'skoda', fields: { username: SECRET } } as never, {
      context: baseContext(),
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(await readStored('skoda')).toBeNull()
})

test('status reports origins without values; clear removes the row and logs the source', async () => {
  await signIn('admin')
  await call(credentialsRouter.set, { source: 'zaptec', fields: { password: SECRET } }, {
    context: baseContext(),
  })
  const status = await call(credentialsRouter.status, undefined, { context: baseContext() })
  expect(status.sources.zaptec.fields.password.origin).toBe('stored')
  expect(JSON.stringify(status)).not.toContain(SECRET)

  const { log, text } = capturingLog()
  expect(
    await call(credentialsRouter.clear, { source: 'zaptec' }, { context: { ...baseContext(), log } }),
  ).toEqual({ cleared: true })
  expect(await readStored('zaptec')).toBeNull()
  expect(text()).toContain('admin cleared integration credentials')
  expect(
    await call(credentialsRouter.clear, { source: 'zaptec' }, { context: baseContext() }),
  ).toEqual({ cleared: false })
})
```

- [ ] **Step 2: Run; expect FAIL** (module missing). `bunx vitest run src/lib/orpc/procedures/credentials.test.ts`

- [ ] **Step 3: Implement** `src/lib/orpc/procedures/credentials.ts`:

```ts
import { z } from 'zod'
import { CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import { adminProcedure } from '~/lib/orpc/context'
import * as credentialService from '~/lib/services/integrationCredential'
import {
  IntegrationCredentialDomainError,
  type IntegrationCredentialDomainErrorCode,
} from '~/lib/services/integrationCredential'

// Field names only, never values (ADR-0026). `data` is sent to the client.
const fieldNames = z.object({ fields: z.array(z.string()) })

const credentialErrors = {
  INVALID_FIELD: { status: 422, data: fieldNames },
  REENTER_ALL_FIELDS: { status: 422, data: fieldNames },
  NOTHING_TO_SAVE: { status: 422 },
  ENCRYPTION_KEY_MISSING: { status: 409 },
} satisfies Record<IntegrationCredentialDomainErrorCode, { status: number }>

// Bounds the payload only; the service enforces the real limits (512 chars, per-field
// formats) and names each failing field in INVALID_FIELD.
const value = z.string().max(4096).optional()

// One branch per source, each with exactly that source's fields (CREDENTIAL_FIELDS;
// a test pins the match): a field of another source is a BAD_REQUEST.
export const setCredentialsInput = z.discriminatedUnion('source', [
  z.object({ source: z.literal('zaptec'), fields: z.strictObject({ username: value, password: value }) }),
  z.object({
    source: z.literal('skoda'),
    fields: z.strictObject({ apiKey: value, vin: value, homeCoordinates: value }),
  }),
  z.object({
    source: z.literal('emaldo'),
    fields: z.strictObject({ user: value, password: value, appId: value, appSecret: value }),
  }),
  z.object({ source: z.literal('gridTariff'), fields: z.strictObject({ facilityId: value }) }),
])

export const credentialsRouter = {
  // A read, but admin-only: where each credential comes from is admin detail. Never values.
  status: adminProcedure.handler(() => credentialService.status()),

  set: adminProcedure
    .errors(credentialErrors)
    .input(setCredentialsInput)
    .handler(async ({ input, context, errors }) => {
      // The names the admin filled in, for the log line — never the values.
      const fields = Object.entries(input.fields)
        .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
        .map(([name]) => name)
      const started = performance.now()
      try {
        const result = await credentialService.set(input.source, input.fields, context.user.id)
        context.log.info('admin set integration credentials', { source: input.source, fields })
        return result
      } catch (err) {
        if (err instanceof IntegrationCredentialDomainError) {
          if (err.code === 'INVALID_FIELD' || err.code === 'REENTER_ALL_FIELDS') {
            throw errors[err.code]({ data: { fields: [...err.fields] } })
          }
          throw errors[err.code]()
        }
        throw err
      } finally {
        if (context.timings) context.timings.credentialsSetMs = performance.now() - started
      }
    }),

  clear: adminProcedure
    .input(z.object({ source: z.enum(CREDENTIAL_SOURCES) }))
    .handler(async ({ input, context }) => {
      const cleared = await credentialService.clear(input.source)
      context.log.info('admin cleared integration credentials', { source: input.source, cleared })
      return { cleared }
    }),
}
```

Check `context.timings`'s type in `src/lib/orpc/context.ts`; if it's a typed record, use whatever shape
`getSessionMs` uses (and round like it does). Register in `src/lib/orpc/router.ts`: import
`credentialsRouter` and add `credentials: credentialsRouter,` (alphabetical, before `energy`).

- [ ] **Step 4: Run; expect PASS.** `bunx vitest run src/lib/orpc/procedures/credentials.test.ts`, then
`bun run typecheck`. If `setCredentialsInput.options[i].shape.source.value` doesn't type-check in Zod 4, read the
literal via `.shape.source.def.values[0]` (check the Zod 4 docs via Context7 before guessing).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/orpc
git commit -m "feat(charging): add admin credentials procedures"
```

---

### Task 6: Docs, branch review, pre-PR gate, PR

**Files:** `docs/superpowers/roadmaps/2026-10-05-charging-settings.md`,
`docs/superpowers/specs/2026-10-05-charging-settings-design.md`, `docs/adr/0026-integration-credential-store.md`.

- [ ] **Step 1: Spec corrections from this plan** (Step 3a section):
  - Replace the CHECK bullet with: `integration_sync.suspect_fields`: non-empty, names from `CREDENTIAL_FIELD_NAMES`;
    **no tie to `error_code`** (older code clears the code on success and leaves the column, so such a CHECK would
    break an instant rollback); the read model shows it only while `error_code` is set.
    `integration_sync_run.suspect_fields`: the same, plus `IS NULL OR outcome <> 'ok'` (append-only; older code
    inserts NULL).
  - `REENTER_ALL_FIELDS` carries `data: { fields }` (the blank ones), like `INVALID_FIELD`.
  - `suspectFields` is in `adminDetail` (admins only), not top-level health.
  - Mirror the first point in ADR-0026's step 3 amendment.
- [ ] **Step 2: Roadmap row 3a:** PR link, status `PR open`.
- [ ] **Step 3: Branch review (Phase 5):** in parallel — `code-reviewer`, `migration-guard`, the schema-design
  reviewer, `test-completeness`, plus `/security-review` for the procedures. Fix or rule on every finding.
- [ ] **Step 4: Pre-PR gate** (`docs/feature-workflow.md` → Pre-PR gate): `bun run check`, `bun run check:ci`,
  `bun run build`, `bun run db:up && bun run db:migrate`, `bun run test`, the sv/en key check (no keys change in 3a).
- [ ] **Step 5: PR** with `.github/PULL_REQUEST_TEMPLATE.md`; title
  `feat(charging): add credentials procedures and suspect fields`. Body notes for 3b: the procedure contract
  (Task 5 Interfaces), `adminDetail.suspectFields`, `RunRow.suspectFields`.

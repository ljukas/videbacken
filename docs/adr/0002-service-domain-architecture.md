# ADR 0002 — Services + Domain-Error Architecture

- **Status**: Accepted
- **Date**: 2026-05-21
- **Deciders**: Lukas
- **Decision in one line**: All DB access lives in `src/lib/services/<entity>/`. Services own invariants and raise a typed `<Entity>DomainError` with a discriminating English `code` union. oRPC procedures stay thin: parse → service → catch domain error → map to Swedish `ORPCError` → run side effects.

---

## Context

Videbacken's read/write paths cross three layers: HTTP request → oRPC procedure → DB. Without a seam, three things drift:

1. **Domain invariants scatter.** "You can't delete the last admin," "you can't act on yourself," "you can't update a soft-deleted user" — each of these is true regardless of caller. If they live in the procedure that happens to need them first, the next caller (a server function, an auth callback, a future Slack command) re-implements them by hand and the rules silently fork.
2. **DB primitives leak.** `db.select(...)` in a route loader looks innocent until the third place has to be kept in sync with a schema change. `db` becomes an ambient global; the schema becomes everyone's problem.
3. **Errors arrive at the boundary in the wrong shape.** Procedures need Swedish, human-readable messages with the right ORPC status code. Services need testable, machine-readable failure modes that don't depend on a translation table. If the service throws a Swedish string, tests assert on Swedish strings; if the procedure throws a raw `Error`, the UI can't tell `LAST_ADMIN` apart from `NOT_FOUND`.

The canonical example today is admin user management. `revokeUser` enforces three guards (`NOT_FOUND`, `CANNOT_ACT_ON_SELF`, `LAST_ADMIN`); `updateAsAdmin` enforces four guards (`NOT_FOUND`, `TARGET_DELETED`, `CANNOT_ACT_ON_SELF`, `LAST_ADMIN`). Six months from now, a future feature — boat-week assignments — will have its own invariants ("can't assign a deleted user," "share-rotation order is fixed"). The seam needs to be in place before that lands, not retrofitted after.

---

## Decision (TL;DR)

**Services own data access and domain rules. Procedures are thin glue.**

- All `db.*` calls live in `src/lib/services/<entity>/<entity>.ts`. Outside that namespace and `src/lib/db/`, zero modules import `db`.
- Invariants are enforced inside the guarded service operations (`updateAsAdmin`, `revokeUser`, …), never in callers.
- Service operations either return the new state or throw an `<Entity>DomainError` whose `code` field is a TypeScript-narrow union of English machine identifiers.
- oRPC procedures `try { await service.op() } catch (err) { rethrowAsORPC(err, ...) }` — translating each `code` to an `ORPCError` with the right status (`NOT_FOUND` / `CONFLICT` / `FORBIDDEN` / `BAD_REQUEST`) and a Swedish user-facing message.
- Cross-system side effects (Better Auth session revoke, Blob deletes, email) happen in the procedure **after** the service call succeeds, never inside the service. (Side-effects layering is in ADR-0001.)

The canonical example is `src/lib/services/user/`. Read it before adding a new service.

This is a **deep module** in the architecture-skill sense: the interface is small (a handful of named operations per entity), the implementation hides invariant checks, soft-delete bookkeeping, and SQL detail. The deletion test: removing the `services/` namespace would re-scatter `db.select(...)` + admin-count guards across procedures, route loaders, and auth callbacks — yes, complexity would re-concentrate. That's a real seam.

---

## Alternatives considered

### A. Inline `db.select(...)` in procedures and route loaders
- ➕ One fewer layer; reads top-to-bottom.
- ➖ The same invariant gets re-implemented per caller. `countAdmins() <= 1` shows up three times in three procedures, slightly differently, with one place wrong.
- ➖ Refactoring a schema column means grepping every route, hook, and procedure.
- ➖ Testing an invariant means standing up a full oRPC request — the cheap unit test is impossible.
- **Verdict**: fails the deletion test the moment a second caller appears, which it has.

### B. ORM-level Active Record (drizzle relations + methods on row objects)
- ➕ Encapsulated by row.
- ➖ Drizzle's design isn't this; doing it would mean fighting the ORM.
- ➖ Invariants that span multiple rows (admin count) don't fit the row-level shape.
- **Verdict**: don't.

### C. "Repository" pattern (one repo per table, separate "domain service" layer)
- ➕ Familiar to enterprise-Java readers.
- ➖ Three layers (repo / service / procedure) for ~5 entities is bureaucratic. Drizzle already *is* the repository — adding a wrapper that re-exports `db.select` per table is pure indirection.
- ➖ The deletion test for the repo layer fails: removing it would not re-concentrate complexity, only move it.
- **Verdict**: don't. The two layers (`service` + `procedure`) earn their keep; a third doesn't.

### D. Throw raw `Error` / `ORPCError` from services
- ➕ One fewer error type.
- ➖ Services that throw `ORPCError` are coupled to the transport. A future job-runner or CLI caller can't use them.
- ➖ Services that throw bare `Error` force every procedure to string-match on `.message` to decide the HTTP status. Brittle.
- **Verdict**: don't. The typed `code` is the whole point.

### E. Result types (`Result<T, E>`) instead of throws
- ➕ Forces callers to handle errors at the type level.
- ➖ Inconsistent with the rest of the codebase (drizzle, Better Auth, oRPC all throw).
- ➖ Every happy-path return becomes a `.unwrap()` call site or a `match`.
- **Verdict**: not worth the friction at this scale. Revisit if invariant complexity grows.

---

## Architecture

### The `src/lib/services/<entity>/` namespace

```
src/lib/services/
  <entity>/
    <entity>.ts          named exports — data access + guarded operations
    errors.ts            <Entity>DomainError + Code union (only when invariants exist)
    <entity>.test.ts     colocated; runs against the per-test schema
    index.ts             barrel: `export * from './<entity>'` (+ `./errors`)
```

A service may additionally carry pure-function test files when logic warrants them (e.g. `approvedEmail/gate.test.ts`) — same folder, no harness implications.

Services today: `approvedEmail/`, `evCharging/`, `file/`, `integrationSync/`, `sensor/`, `spotPrice/`, `tariff/`, `user/`. Their procedure-side counterparts live in `src/lib/orpc/procedures/`: `evCharging.ts`, `health.ts`, `image.ts`, `sensor.ts`, `tariff.ts`, `user.ts` (not 1:1 — `evCharging.ts` draws on both `evCharging` and `integrationSync`, `health` needs no service, `approvedEmail` is reached through the `user` service, and `spotPrice` through the elpris sync and the cost read model).

External code always imports through the barrel:

```ts
import * as userService from '~/lib/services/user'
const row = await userService.findActiveById(id)
```

Never `~/lib/services/user/user` — the folder is the unit of import, the barrel is the public surface.

`evCharging/` and `integrationSync/` deliberately have **no** `errors.ts`. Neither rejects a write with a domain error today — `integrationSync`'s invariants (see the 2026-09-28 amendment) are enforced by row locking and transition logic, not thrown codes — so the file would be empty. The convention is: **`errors.ts` appears exactly when the first invariant does.**

### The guarded-operation pattern

Inside the service module, two kinds of functions coexist:

- **Read primitives** — `findRowById`, `listAll`, `countAdmins`. Exported. Read-only, no rules to enforce.
- **Guarded write operations** — `updateAsAdmin`, `revokeUser`, `inviteUser`, `updateOwnProfile`. Exported. **Where invariants live.**

There are no exported raw `updateUser` / `softDeleteUser` primitives. When invariants exist, the guarded operation is the only way in. The naming says "this is the operation the caller is allowed to invoke" — bare CRUD never escapes.

```ts
// src/lib/services/user/user.ts
export async function updateAsAdmin(actorId: string, targetId: string, input: UpdateUserInput): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const target = await findRowById(targetId, tx)
    if (!target) throw new UserDomainError('NOT_FOUND')
    if (target.deletedAt) throw new UserDomainError('TARGET_DELETED')

    const demotingSelf = actorId === targetId && input.role !== 'admin'
    if (demotingSelf) throw new UserDomainError('CANNOT_ACT_ON_SELF')

    const demotingAdmin = target.role === 'admin' && input.role !== 'admin'
    if (demotingAdmin && (await countAdmins(tx)) <= 1) {
      throw new UserDomainError('LAST_ADMIN')
    }

    const [row] = await tx
      .update(user)
      .set({ name: input.name, phone: input.phone, role: input.role })
      .where(eq(user.id, targetId))
      .returning(userSelection)
    return row
  })
}
```

Rules read in sequence; the `tx.update` is the last line and everything above it is the rule layer. `updateAsAdmin` runs entirely inside `db.transaction`, with reads going through the transaction. `revokeUser` is only partly transactional: it reads `isApproved` before the transaction, runs its user-row read, guards (`CANNOT_ACT_ON_SELF`, `LAST_ADMIN`) and soft-delete inside it, and calls `removeApproved` after commit. The read primitives (`findRowById`, `countAdmins`) take a `DbOrTx` parameter defaulting to `db`, so the same helpers serve both transactional guards and plain reads. If a future maintainer wants to add "can't change a user's role while some related operation of theirs is still pending," they extend the rule layer in this function — no new file, no caller change.

### Check first — never translate Postgres errors (added 2026-06-10)

When an invariant is also backed by a DB constraint (a unique index, a CHECK), the service still enforces it **check-first**: an explicit read, then the typed domain error.

```ts
// src/lib/services/approvedEmail/approvedEmail.ts
export async function addApproved(input: { email: string; role: 'user' | 'admin'; addedByUserId: string | null }) {
  const email = normalizeEmail(input.email)
  if (await isApproved(email)) throw new ApprovedEmailDomainError('EMAIL_ALREADY_APPROVED')
  // ... insert
}
```

What we deliberately do **not** do: let the insert fail and translate the Postgres error — neither by message-regexing (`/duplicate key|unique constraint/`) nor by SQLSTATE matching (`err.code === '23505'`). Both make the domain layer's behavior depend on driver error shapes, and the regex variant breaks the moment Postgres wording or locale changes. A check-first read keeps the rule readable in sequence with the other guards and throws the same `<Entity>DomainError` shape as every other invariant.

The constraint itself stays in the schema as a backstop. The window between check and write means a racing duplicate surfaces as a raw DB error (a 500) instead of the Swedish message — accepted at this scale (one or two admins). The same acceptance applies to cross-row invariants with **no** constraint backstop (`LAST_ADMIN`): the check runs inside the guarded operation's transaction, but concurrent admins could in principle interleave check-then-write. We don't serialize for it. If the `LAST_ADMIN` race ever fired, recovery is one manual `UPDATE "user" SET role = 'admin' …` — note the `approved_email` allowlist gates every sign-in (not just account creation), and `INITIAL_ADMIN_EMAILS` only seeds the *initial* admin row(s) at startup (see ADR-0017), so a zero-admin state does not self-heal. Should concurrent admin mutations ever become real (more admins, automation), serialize the guarded operation with `pg_advisory_xact_lock(hashtext('<entity>_guard'))` as the first statement of its transaction (the idiom the Supabase skill's `lock-advisory` rule recommends) — still no SQLSTATE translation, no SERIALIZABLE retries.

### Effect-boundary invariants (added 2026-06-10)

One class of check legitimately lives in the procedure, not the service: ownership/shape validation that requires **storage knowledge**. Services may not import `~/lib/effects` (see "Why services stay free of Better Auth / Resend / Blob imports" below), so a check that needs the storage layer's pathname conventions can't live there. Example:

- `confirmAvatarUpload` (`src/lib/orpc/procedures/image.ts`) rejects pathnames where ``stripEnvPrefix(input.pathname).startsWith(`avatars/${context.user.id}/`)`` is false.

`stripEnvPrefix` is exported from `src/lib/effects/storage/storage.ts` so the env-prefixing convention and its validation can't drift apart. These are **effect-boundary invariants** — the rule belongs to the storage contract, not the entity's data model. Don't mistake them for violations of "invariants are enforced inside guarded service operations, never in callers"; that rule governs invariants over the entity's own rows.

### The `<Entity>DomainError` shape

`errors.ts` is small and shaped exactly like this:

```ts
// src/lib/services/user/errors.ts
export type UserDomainErrorCode =
  | 'NOT_FOUND'
  | 'TARGET_DELETED'
  | 'CANNOT_ACT_ON_SELF'
  | 'LAST_ADMIN'
  | 'ALREADY_ACCEPTED'       // resend on an invite that already signed in — ADR-0017
  | 'EMAIL_ALREADY_APPROVED' // invite for an email already on the allowlist — ADR-0017

export class UserDomainError extends Error {
  constructor(public readonly code: UserDomainErrorCode) {
    super(code)
    this.name = 'UserDomainError'
  }
}
```

- `code` is a literal union — TypeScript narrows it in the procedure's `switch`, so the compiler enforces exhaustive mapping.
- The constructor takes only `code`. No structured `details` payload yet — add one if a future invariant genuinely needs it (e.g. `{ code: 'CONFLICT', conflictingId }`), but resist as long as the code alone is sufficient.
- `super(code)` makes the English code the `.message` — useful in test failures and logs without forcing a Swedish lookup.
- `this.name = 'UserDomainError'` makes `err instanceof UserDomainError` the discriminator in catches; never string-match the message.

### Error mapping at the procedure boundary

Each entity gets a `rethrowAsORPC(err, context)`-style helper that translates `code` to `ORPCError`. It usually lives in the entity's procedure file; when two procedure files map the same domain error, sharing one exhaustive mapper is sanctioned. The Swedish strings live here — colocated with the other UI-language strings the procedure exposes:

```ts
// src/lib/orpc/procedures/user.ts — the original shape; the router has since moved to
// the code-only style of the 2026-06-13 amendment
function rethrowAsORPC(err: unknown, context: 'update' | 'delete' | 'restore'): never {
  if (!(err instanceof UserDomainError)) throw err
  switch (err.code) {
    case 'NOT_FOUND':
      throw new ORPCError('NOT_FOUND', { message: 'Användaren hittades inte' })
    case 'TARGET_DELETED':
      throw new ORPCError('CONFLICT', { message: 'Användaren är borttagen och kan inte ändras' })
    case 'CANNOT_ACT_ON_SELF':
      throw new ORPCError('FORBIDDEN', {
        message: context === 'delete' ? 'Du kan inte radera dig själv' : 'Du kan inte degradera dig själv',
      })
    case 'LAST_ADMIN':
      throw new ORPCError('CONFLICT', { message: 'Det måste finnas minst en administratör' })
  }
}
```

Three things to notice:

1. **Non-`UserDomainError` re-throws unchanged.** Unknown errors propagate to oRPC's `onError` interceptor and are logged as `'orpc handler error'`. Catch only what you understand.
2. **The `context` parameter** is how one `code` produces two Swedish strings depending on which operation surfaced it. `CANNOT_ACT_ON_SELF` reads as "you can't delete yourself" in `delete` and "you can't demote yourself" in `update`. The English code is single; the human translation is contextual.
3. **The switch is exhaustive on the union.** Adding a new code to `UserDomainErrorCode` breaks the build at the switch until a case is added — the type system enforces complete handling.

### Procedure shape — services + side effects in order

A guarded write looks like this end-to-end:

```ts
revoke: adminProcedure
  .errors(userErrors)
  .input(z.object({ email: z.email() }))
  .handler(async ({ input, context, errors }) => {
    let result
    try {
      result = await userService.revokeUser({ email: input.email, actorUserId: context.user.id })
    } catch (err) {
      if (err instanceof UserDomainError) throw errors[err.code]()
      throw err
    }
    // Cross-system side effect — only after the service mutation succeeds.
    if (result.userId) {
      await auth.api.revokeUserSessions({ body: { userId: result.userId }, headers: context.headers })
    }
    context.log.info('admin revoked user access', { email: input.email, targetId: result.userId })
  }),
```

The ordering is load-bearing:

1. **Service call first.** If invariants fail, nothing else fires.
2. **Side effect second.** Better Auth's session revoke happens only when the revoke's soft-delete committed. Reverse the order and you'd revoke sessions for users who fail the `LAST_ADMIN` check.
3. **Log last.** The `info` line is observational; it goes on the way out, after the operation is fully complete (DB mutation + side effect). See ADR-0003 for the logging seam.

### Why services stay free of Better Auth / Resend / Blob imports

The schema-per-test harness (`test/setup.ts`) gives every test a fresh schema with all migrations run, populated only by the test itself. That harness can't speak Better Auth's session API; it can't dial out to Resend. So a service that imports those things becomes untestable through the harness — you'd be forced into HTTP-level integration tests for everything.

By contract:

- A service touches its own DB tables (`db.*`) and nothing else.
- A service may receive a `tx` and call into another service's primitives via the same `db`/`tx`, but never imports `~/lib/auth`, `~/lib/effects`, or any HTTP client.
- Cross-system work is the procedure's job (see ADR-0001 for the `effects/` namespace and tier rules).

This is also why test files for the user service can build minimal admins and members via direct `db.insert(user).values(...)` — the test is itself an authorised in-process caller. Outside test files, raw `db.insert(...)` is a violation.

### When does a new service get an `errors.ts`?

The instant the first invariant lands. Until then, a service has no `errors.ts` — raw CRUD/reads, no rules to enforce. Today `approvedEmail/`, `file/`, `sensor/`, `spotPrice/`, `tariff/` and `user/` have at least one invariant and therefore an `errors.ts`; `evCharging/` and `integrationSync/` have none.

The pattern is symmetric: a service without invariants has no need to differentiate failures beyond "couldn't find it" (return `null`) and "DB-level error" (re-thrown unchanged). The moment you write a guard — `if (something) throw new XDomainError('...')` — you also add `errors.ts` and one barrel re-export. Don't add an empty errors file in anticipation. It works in reverse too: when a guard goes away, its code goes with it, and an `errors.ts` whose last code disappears gets deleted.

### Why this is a deep module (in the skill's terms)

- **Interface**: a handful of named operations per entity (`listAll`, `listUsersAndPending`, `inviteUser`, `assertPendingInvite`, `revokeUser`, `updateAsAdmin`) plus the typed error union. Stable.
- **Implementation**: SQL composition, soft-delete bookkeeping, admin-count guards, self-action checks, idempotency of repeated revokes. Hidden behind the named operations.
- **Test surface = the interface.** `user.test.ts` calls the exported functions and asserts on `UserDomainError.code`. The schema-per-test harness gives every test a real DB; nothing is mocked.
- **The barrel is the seam.** External code imports `~/lib/services/user` — never the inner `user.ts`. That decoupling means rearranging internal files (splitting `user.ts` into `read.ts` + `write.ts`, say) is invisible to callers.

---

## Verification

A reader can confirm the architecture is being followed without running anything:

- **No `db.*` calls outside services.** `grep -rn "db\.\(select\|insert\|update\|delete\)" src/ --include="*.ts" --include="*.tsx" | grep -v "src/lib/services/" | grep -v "src/lib/db/"` should produce **zero hits**.
- **No `~/lib/db` imports outside services + the db module itself.** `grep -rn "from.*lib/db" src/ --include="*.ts" --include="*.tsx" | grep -v "src/lib/services/" | grep -v "src/lib/db/" | grep -v "\.test\.ts"` should produce **zero hits**. One sanctioned `db` import escapes this pattern entirely: `src/lib/auth.ts` imports `{ db } from './db'` (relative path) to hand the handle to `drizzleAdapter` — wiring, not querying; Better Auth issues its own queries through the adapter.
- **No transport imports inside services.** `grep -rn "lib/auth\|lib/effects\|@resend" src/lib/services/` should produce zero hits.
- **Procedures import services through the barrel.** `grep -rn "lib/services/[a-zA-Z]*/" src/lib/orpc/procedures/` — zero hits; only `lib/services/<entity>` (the folder, via the barrel).
- **Domain errors carry typed codes.** `grep -rn "instanceof.*DomainError" src/ --include="*.ts" | grep -v "\.test\.ts"` — every match today is at a boundary that maps `.code`: the procedure files (`user.ts` and `tariff.ts` via `errors[err.code]()`, `sensor.ts`), the Shelly webhook (`src/lib/sensor/shellyWebhook.ts`), and `src/lib/services/user/user.ts` re-coding `approvedEmail`'s error as its own (test files also match `instanceof` legitimately, hence the exclusion).
- **`errors.ts` exists iff invariants exist.** A service folder with `errors.ts` must have at least one `throw new X DomainError(...)` in its `<entity>.ts`. A service folder *without* `errors.ts` must have zero `throw` statements in `<entity>.ts`.

Manual smoke test:

1. `bun run test src/lib/services/user/user.test.ts` — runs the user service against schema-per-test; asserts `UserDomainError.code` on each invariant violation.
2. `LAST_ADMIN` on revoke is covered by the service test only — it isn't reachable by hand (an acting admin revoking a *different* admin means ≥2 admins exist, and revoking yourself trips `CANNOT_ACT_ON_SELF` first; only the accepted concurrent-admin race could hit it).
3. As an admin, try to revoke yourself → the UI hides Revoke on your own row (`UsersTable`), so open `/users?dialog=revoke&email=<your email>` directly and confirm → expect a FORBIDDEN toast in Swedish ("Du kan inte återkalla din egen åtkomst"), no DB change.

---

## Critical files

- `src/lib/services/user/user.ts` — canonical service with invariants.
- `src/lib/services/user/errors.ts` — canonical `<Entity>DomainError` shape.
- `src/lib/services/user/user.test.ts` — canonical test pattern through the service interface.
- `src/lib/services/user/index.ts` — canonical barrel.
- `src/lib/orpc/procedures/user.ts` — canonical error-mapping (`errors[err.code]()`) + service+side-effect ordering.
- `test/setup.ts` — schema-per-test harness that makes services testable in isolation.
- `src/lib/services/approvedEmail/`, `src/lib/services/tariff/` — other current services with their own `errors.ts`.

---

## Adding a service (concrete recipe)

1. **Create `src/lib/services/<entity>/`** with three files:
   - `<entity>.ts` — named exports for read primitives + guarded operations.
   - `<entity>.test.ts` — colocated. First line of test body imports the service through `'./<entity>'`; first line of file calls `setupDatabase()` from `~test/setup`.
   - `index.ts` — `export * from './<entity>'`.
2. **If the service enforces any invariant**, add `errors.ts`:
   - Define `<Entity>DomainErrorCode` as a literal union.
   - Define `<Entity>DomainError extends Error` with `code: <Entity>DomainErrorCode` and `this.name = '<Entity>DomainError'`.
   - Extend the barrel: `export * from './errors'`.
3. **Create or extend `src/lib/orpc/procedures/<entity>.ts`**:
   - Add a `rethrowAsORPC(err, context)` helper switching on `err.code` — or, per the 2026-06-13 amendment (the style every current router uses), a `.errors(<entity>Errors)` map rethrown as `errors[err.code]()`.
   - Procedures: `try { await <entity>Service.op(...) } catch (err) { rethrowAsORPC(err, '<op>') }`, then side effects, then `context.log.info(...)`.
4. **Add the router** to `src/lib/orpc/router.ts` if it's a new entity.
5. **Run `bun run test src/lib/services/<entity>/`** — the colocated test runs against a fresh schema with every migration applied; no fixtures needed.

---

## Consequences

**Positive**:
- One named seat for every invariant. Refactoring a rule means editing one function in one file.
- DB schema changes propagate cleanly: every callsite is inside `services/`, found via grep on a column name.
- Services are testable in isolation against a real DB via the schema-per-test harness — no mocks, no HTTP stand-up.
- The error mapping at the procedure boundary makes the contract explicit: English `code` for code, Swedish for users.
- Future non-HTTP callers (a CLI, a job runner, a Slack command) can call services directly without re-implementing rules.

**Negative**:
- Two layers per write operation (service + procedure) — an upfront cost paid for every CRUD. Mitigated by the canonical example: copying `services/user/` is the fastest way to start.
- The procedure-local `rethrowAsORPC` helper is per-entity boilerplate. Generalising it (a single `mapDomainError(error, mapping)` helper) is tempting but would force the Swedish-message table into a shared module — splitting it from the procedure that owns the messages. Resist.
- Adding a code to `<Entity>DomainErrorCode` is a two-file change (service + procedure mapping). The type system catches the missed case at compile time, but it still requires touching both files.

**Revisit triggers** — re-open this ADR if any of these change:
- A service grows enough invariants that the guarded-operation file becomes hard to read (~500 lines). Split into multiple files inside the entity folder; the barrel stays one line.
- A real need emerges to call a service from a non-HTTP context where throwing isn't the right control flow (e.g. a batch job that wants to collect all failures rather than abort on the first). At that point evaluate a `Result<T, E>` variant of the public surface.
- The Swedish messages spread to a third location (today: only `rethrowAsORPC` + form field placeholders). A shared message catalogue might become worth its weight.

---

## Amendment (2026-06-13, extended 2026-06-14): domain errors are code-only; the client localizes

Routers no longer map `<Entity>DomainError.code` to a Swedish `ORPCError` on the
server (first applied to the since-removed `folder` router). Instead each
mutating procedure declares the codes as **oRPC typed errors**
(`.errors(userErrors)`, status only — no message, no `data`) and rethrows
code-only: `if (err instanceof UserDomainError) throw errors[err.code](); throw
err`. The client owns error i18n via `src/lib/orpc/<entity>ErrorMessage.ts` (an
exhaustive `switch` over the code union, imported as a *type only* so no service
runtime leaks into the bundle) — today `userErrorMessage.ts`,
`tariffErrorMessage.ts`, `sensorErrorMessage.ts`.

Why:
- The discriminated code survives to the client type-safely (`isDefinedError(err)`
  narrows `err.code`), which lets `TariffDialog` surface the user-fixable
  `TARIFF_VALID_FROM_TAKEN` as an inline field error rather than a toast.
- Applying it to one procedure while the rest of the router stayed message-based
  would split a router's error handling in two, so each router migrates as a
  whole and its `rethrow*AsORPC` helper is deleted.

**Extended to the `document` router (2026-06-14)** — removed with the document
feature; its specifics (an errors map shared with the bin router, typed
upload-boundary errors, mixed-dialog discrimination) no longer govern code.

**Extended to the `user` router (2026-06-14).** Same shape: `userErrors` in
`procedures/user.ts`; client localizes via `src/lib/orpc/userErrorMessage.ts`.
The wrinkle was `CANNOT_ACT_ON_SELF`, whose message was context-dependent on the
server (`rethrowAsORPC(err, context)` → "can't delete yourself" vs "can't demote
yourself"). We **kept the code single** (the transport code equals the domain
code, so the backend stays uniform and `satisfies Record<UserDomainErrorCode>`)
and moved the contextual phrasing to the client: `userErrorMessage(code,
selfAction)` picks revoke-vs-demote, and the dialogs pass their own context
(`RevokeUserDialog` → `'revoke'`, `EditUserDialog` → `'demote'`). This is exactly
this ADR's "the English code is single; the human translation is contextual" —
now resolved at the presentation layer.

**Extended to the `season` router (2026-06-14)** — removed with the seasons
feature; no longer governs code.

This is an **alternative** to the `rethrowAsORPC` pattern above, not a
replacement of it. No router remains on the Swedish-`ORPCError` domain-error
mapping (`share`, the last, was removed with its feature). Prefer this code-only
style when a client needs to branch on the specific failure (inline field errors,
contextual or distinct recovery UI); the message-mapping style remains fine when
the client only needs to show the message.

## Amendment (2026-06-24): user service grows the invitation ops + two codes

The `user` service gained its invitation ops ([ADR-0017](./0017-authentication.md)), all following the patterns above. Under ADR-0017's allowlist model they are: `inviteUser` (a check-first guarded write — the duplicate check runs in `approvedEmail`'s `addApproved` and is re-coded as `EMAIL_ALREADY_APPROVED`, the unique constraint staying the silent backstop, per "Check first" §) and `assertPendingInvite(email)` (a read-only guard that throws `NOT_FOUND` / `ALREADY_ACCEPTED`). `create` was reshaped into `invite` + `resendInvite` at the procedure layer.

The `UserDomainErrorCode` union grew two members — **`ALREADY_ACCEPTED`** (resend on an invite that already signed in) and **`EMAIL_ALREADY_APPROVED`** (invite for an email already on the allowlist; originally `EMAIL_TAKEN`) — staying **code-only** per the 2026-06-14 amendment above: `userErrors` in `procedures/user.ts` declares them status-only (`satisfies Record<UserDomainErrorCode, …>` catches a missed key at build), and `src/lib/orpc/userErrorMessage.ts`'s exhaustive switch localizes them. No new Swedish in the procedure; the type system forced both the `userErrors` key and the `userErrorMessage` case the moment each code was added.

## Amendment (2026-09-28): row locking inside a service transaction; role-shaped reads take a flag

Two clarifications land alongside [ADR-0019](./0019-external-data-integrations.md), which introduces
the first service (`src/lib/services/integrationSync/`) that needs both.

**`SELECT … FOR UPDATE` inside a service's own transaction is a sanctioned pattern**, not only the
`pg_advisory_xact_lock` escape hatch the "Check first — never translate Postgres errors" section
describes. `integrationSync`'s `recordOutcome` takes the row lock on `integration_sync` as its first
statement to serialize concurrent *finishers* of a sync run — a different problem from the
advisory-lock section's `LAST_ADMIN` race, where a lost race is a rare, manually-recoverable
inconvenience. Here, two runs finishing at the same instant without a lock could both observe "was
healthy" and both fire a transition alert email — exactly the noise ADR-0019 exists to prevent — so
serializing the finish is load-bearing, not a nice-to-have. `FOR UPDATE` inside the same transaction
as the read-check and the write is the minimal fix; it carries no new exception to "never translate
Postgres errors" or "no SERIALIZABLE retries" — it's ordinary row-level locking, already implied by
"reads going through the transaction" in the guarded-operation pattern above, just stated explicitly
now that a service leans on it as its central invariant rather than incidentally.

**Role-shaped reads take an explicit flag, never the caller's role.** `getHealth(source, { now,
includeAdminDetail })` takes a plain `includeAdminDetail: boolean`, not `role: 'user' | 'admin'`. A
service has no business knowing about auth roles — "why services stay free of Better Auth / Resend /
Blob imports" above already keeps `~/lib/auth` out of services entirely — so the procedure
(`syncStatus` in `src/lib/orpc/procedures/evCharging.ts`) computes `includeAdminDetail =
context.user.role === 'admin'` and passes the boolean down. No prior service has had a read shape
that varies by caller, so this wasn't previously a named convention; it now is one, for the next
service that needs it.

## Amendment (2026-09-29): pruned to the current template

References to features the template removed (documents/folders/document bin, seasons, shares, their procedures and `*ErrorMessage.ts` files, the `presence`/`realtime` procedures) were removed or replaced with current examples (`user`, `approvedEmail`, `tariff`, `evCharging`/`integrationSync`), and the `user` service's since-renamed operations and codes (`revokeUser`, `assertPendingInvite`, `EMAIL_ALREADY_APPROVED`) are cited by their current names. The document and season extensions of the 2026-06-13 amendment are marked as no longer governing code. No decision changed.

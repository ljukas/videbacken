# ADR 0003 — Logging Architecture

- **Status**: Accepted
- **Date**: 2026-05-21
- **Deciders**: Lukas
- **Decision in one line**: All app code logs through `~/lib/logger/` — pino on the server, console + `keepalive` POST on the browser. Logs are JSON to stdout, captured by Vercel Runtime Logs. No external observability service.

---

> **Amended 2026-06-10** (implementation reality + one recorded decision):
> - **`runEffect` was never built** (see ADR-0001's 2026-06-04 amendment). Where this ADR says tier-2 `runEffect` "swallows errors" (Context, point 1) and "logs with the effect's tag" (*What to log*, "Significant business events"), read the real tier-2 contract instead: inline `effects.x.y(...).catch((error) => context.log.warn('failed to …', { error }))` at the call site. Live examples: the blurhash and thumbnail enqueues in `src/lib/orpc/procedures/document.ts`.
> - **`/api/log` is deliberately open ingest.** The route is unauthenticated and has no rate limit — an accepted risk at ~20 users on a URL nobody knows. The guardrails are payload-shaped, not identity-shaped: levels restricted to `warn`/`error`, `msg` ≤ 500 chars, an 8 KB body cap (byte-accurate via `Buffer.byteLength(text, 'utf8')` as of 2026-06-10 — `text.length` would undercount multibyte bodies), and `source: 'browser'` appended server-side so spoofed entries are at least filterable. Revisit if abuse is observed in the log stream or the app becomes known on the public internet.

---

## Context

Oceanview is a small internal app (10–20 users) deployed on Vercel Hobby. Before this ADR, logging meant scattered `console.log` calls — fine for local debugging, useless for production: messages were unstructured, browser errors had no path to the server, and there was no request scope tying multiple log lines from one HTTP call together.

Three things forced the question:

1. **Effect failures need a home.** ADR-0001 introduces tier-2 `runEffect` which swallows errors. Without structured logging, those swallowed errors vanish silently — the worst outcome for a small internal tool with no on-call rotation.
2. **Browser crashes need to surface.** The dashboard is a SPA; a React error boundary that fires in someone's tablet at 11pm is invisible to admin unless the browser forwards the error somewhere durable.
3. **`context.log` per oRPC request.** Multi-line traces of a single admin action (`session resolved → admin gate passed → service called → effect dispatched → response 200`) only become useful if all lines share a `requestId`.

The question is **where logs land** and **how callers attach scope without ceremony**. Both have to be answered before the codebase scales past a handful of significant events.

---

## Decision (TL;DR)

**A single `Logger` interface, two adapters (pino-on-server, console-on-browser), structured JSON to stdout, picked up by Vercel Runtime Logs.** Browser `warn` / `error` is forwarded to `/api/log` so the same place — Vercel's runtime log stream — contains both server and client problems.

The interface is exactly the surface callers see:

```ts
// src/lib/logger/types.ts
interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}
```

Two import sites, never `console.*`:

```ts
// Outside oRPC — services, server functions, route loaders, auth callbacks, effect adapters
import { logger } from '~/lib/logger/server'
logger.info('magic-link sent', { email, userId })
```

```ts
// Inside an oRPC procedure — use context.log; it's a child logger already tagged with
// requestId (set in src/routes/api/rpc/$.ts) and userId (set by sessionMiddleware).
adminProcedure.input(schema).handler(async ({ input, context }) => {
  const created = await userService.createAsAdmin(input)
  context.log.info('admin created user', { targetId: created.id, role: input.role })
  return created
})
```

```ts
// Browser — same interface, different adapter.
import { logger } from '~/lib/logger/browser'
logger.error('react error boundary', { error })  // forwards to /api/log
logger.info('opened admin drawer')               // console only, never forwarded
```

This is a **deep seam** in the architecture-skill sense: small interface (5 methods), real implementations on both sides (pino vs console + keepalive forward), and a single test surface (the `Logger` interface) instead of `console` spies scattered through tests. Two real adapters from day one = real seam, not hypothetical.

---

## Alternatives considered

### A. `console.*` directly, no abstraction
- ➕ Zero code.
- ➖ Browser errors never reach a server. Production crashes are invisible.
- ➖ No structured fields → no querying ("show me every `admin.userDeleted` for actor X").
- ➖ No request scope: a multi-step request's log lines can't be correlated.
- ➖ Secrets risk: a developer who logs `request` once leaks `Cookie` / `Authorization` to wherever logs land.
- **Verdict**: fails the moment the first production bug needs to be diagnosed.

### B. Sentry / Datadog / Axiom / Logtail / Better Stack
- ➕ Best-in-class search, alerting, retention, error grouping.
- ➕ Browser SDK auto-captures `window.error` + `unhandledrejection` with stack traces.
- ➖ Adds a vendor, a secret, a paid plan threshold to monitor, and a separate dashboard to alt-tab to.
- ➖ At ~20 users the free-tier quotas are fine, but the cognitive cost of "log somewhere other than the platform you're already in" is paid forever.
- ➖ The non-negotiable **"free tier first"** isn't violated — but it's adjacent: a second account and SDK to maintain is exactly the kind of fixed cost the project should avoid until it pays for itself.
- **Verdict**: don't. Revisit if Vercel's 1-day Hobby retention bites or if alerting becomes a real need (see revisit triggers).

### C. pino → stdout → Vercel Runtime Logs ← **chosen**
- ➕ One transport. Vercel captures stdout for free; no SDK, no secret, no extra vendor.
- ➕ pino is the lowest-overhead Node logger and supports `child(fields)` natively (zero-cost request scoping).
- ➕ `pino-pretty` in dev gives colorized human output without changing call sites.
- ➕ Browser side stays tiny: a console wrapper that fetches `/api/log` on warn/error. No SDK weight in the bundle.
- ➖ Vercel Hobby retention is 1 day. Fine for ~20 users — a problem someone reports in the morning can still be diagnosed; longer-running mysteries can't.
- ➖ No alerting. Acceptable: no on-call rotation exists.
- **Verdict**: matches the project's scale. The seam is built so swapping to (B) later means changing two adapter files, not the call sites.

### D. Console-on-server + Sentry-on-browser (hybrid)
- ➕ Some teams do this.
- ➖ Two log destinations to triage. Defeats the whole point of "one place to look."
- **Verdict**: don't.

---

## Architecture

### The `src/lib/logger/` namespace

```
src/lib/logger/
  types.ts          Logger interface — debug/info/warn/error + child(fields)
  server.ts         pino-backed; createServerLogger(destination?), singleton `logger`,
                    createRequestLogger(request) → { log, requestId }
  browser.ts        console + keepalive POST /api/log on warn|error;
                    installGlobalHandlers() for window.error + unhandledrejection
  redact.ts         pino redact paths — scrubs authorization/cookie if logged
  index.ts          re-exports the Logger type (only)
  server.test.ts    injectable destination → assert JSON shape, levels, child, redact
  browser.test.ts   mocked fetch → assert forwarding, swallowed errors, child scope
```

### Server adapter — `~/lib/logger/server`

- Singleton `logger` via `createServerLogger()` at module load. Factory accepts an optional `DestinationStream` so tests can intercept JSON output without mocking pino.
- Level defaults: `debug` when `NODE_ENV === 'development'`, `info` otherwise — note that `test` therefore runs at `info`, not `debug`. Override via `LOG_LEVEL` env.
- Base fields baked in: `{ service: 'oceanview', env: NODE_ENV }`.
- `pino-pretty` transport in dev (keyed off the same `NODE_ENV === 'development'` flag as the level default) for colorized output; **transport is dropped when a destination is supplied** (pino-pretty spawns a worker that ignores custom destinations — the factory handles this so test code doesn't have to).
- `child(fields)` is native pino — no allocation per request beyond the small fields object.

### Request scope — how `requestId` + `userId` attach

This is a two-step assembly, not a single middleware:

1. **The oRPC catch-all route** (`src/routes/api/rpc/$.ts`) calls `createRequestLogger(request)`, which reads `x-vercel-id` (or generates a UUID), and returns `{ log, requestId }` — a `logger.child({ requestId, path })`. Both go straight into the oRPC context.
2. **`sessionMiddleware`** (`src/lib/orpc/context.ts`) resolves the Better Auth session and, when there's a user, replaces `context.log` with `context.log.child({ userId: user.id })`. No-op for unauthenticated callers.

Net effect inside any handler: `context.log` already carries `{ requestId, path, userId? }`. Handlers add per-event fields (`targetId`, `role`, `error`). There is no single `loggingMiddleware` — the work is deliberately split between the route entrypoint (request-scoped log construction) and `sessionMiddleware` (user enrichment); the handler-facing contract — "use `context.log`, it's already tagged" — is the same either way.

The oRPC catch-all is not the only `createRequestLogger` construction site. The SSR in-process oRPC client (`src/lib/orpc/client.ts`) builds the same `{ log, requestId }` context for server-side renders, and the file routes (`src/routes/api/files/download.$id.ts`, `src/routes/api/files/view.$id.ts`) call it for their auth-gated redirects.

The oRPC handler is constructed with an `onError` interceptor that calls `logger.error('orpc handler error', { error })`, so any thrown exception in a procedure leaves exactly one error log on the way out, regardless of whether the handler caught and rethrew it. Because the interceptor logs through the module singleton — it runs outside the per-request context — that line carries **no** `requestId`/`userId`. Moving error logging into a context-aware middleware is a candidate future improvement, not a commitment.

### Browser adapter — `~/lib/logger/browser`

- Singleton `logger` over `makeLogger({})`. Each call merges the scope object with per-call fields, then dispatches:
  - `debug` / `info` → `console.debug` / `console.info` only. Never forwarded.
  - `warn` / `error` → `console.warn` / `console.error` **plus** `fetch('/api/log', { method: 'POST', keepalive: true, body: ... })`.
- `keepalive: true` is the critical flag: it lets the request finish even if the user closes the tab or navigates away mid-error.
- The forward is fire-and-forget; a `.catch(() => {})` plus a `try/catch` ensures the logger **never throws**. A broken `/api/log` doesn't break the app.
- `child(fields)` returns a new logger with the merged scope — same semantics as pino's.
- `installGlobalHandlers()` registers `window.error` and `unhandledrejection` listeners. Both serialize the error (`name`, `message`, `stack`) and call `logger.error(...)`. Idempotent: a module-level `handlersInstalled` flag guards against double registration during HMR. Invoked once from `src/router.tsx` in `getRouter()`.

The `/api/log` route (`src/routes/api/log.ts`) is the receiving end:
- Validates with Zod: `level` ∈ `{warn, error}`, `msg` 1–500 chars, `fields` optional record.
- Hard cap: **8 KB request body** (byte-accurate via `Buffer.byteLength(text, 'utf8')`), returns 413 above.
- Forwarded payloads land on the server logger with `source: 'browser'` added so the stream is filterable.
- Unauthenticated and unthrottled **by design** — accepted risk at this scale; see the 2026-06-10 amendment at the top for the rationale and revisit trigger.

### Redaction policy — `~/lib/logger/redact.ts`

Pino's `redact` paths scrub `authorization`, `cookie`, and `set-cookie` headers if a request or headers object is ever logged — paths cover both root-level (`headers.authorization`) and wildcards (`*.headers.cookie`). The censor string is `<redacted>`.

**Caveat encoded in the redact module's comment**: PII (user IDs, admin emails) is **not** redacted. This is intentional for a 10–20-user internal app: the value of correlating an event to "lukas@bovra.se did X" outweighs the data-protection cost when the only readers of logs are the app's own admins. Revisit if the user count grows or external compliance enters scope.

The first line of defence is still **don't log credentials in the first place** — the redact policy is a safety net, not a primary control.

### Conventions

These are what callers must follow to keep logs greppable:

- **Message is a short English noun phrase.** `'magic-link sent'`, `'admin created user'`, `'getSession failed'`. Lowercase, no trailing punctuation, no interpolation. Log messages stay English; only user-facing UI strings are Swedish.
- **Structured fields, not interpolation.** `logger.info('user updated', { targetId, role })` — never `` logger.info(`user ${id} updated`) ``. Fields are queryable; strings are not.
- **Use the right level.**
  - `debug` — local-only details (`'serializer cache miss'`).
  - `info` — significant events you'd care about post-hoc (`'admin created user'`, `'magic-link sent'`).
  - `warn` — unusual but recoverable (`'getSession returned null inside protectedProcedure'`).
  - `error` — caught exceptions and unhandled rejections.
- **Never log secrets or session tokens.** The redact policy is a backstop; the rule is don't pass them in. Log identifiers (`userId`, `targetId`), not credentials.

### What to log — the policy that makes the volume signal-rich

- **Errors** — every caught exception that isn't immediately rethrown as a typed user-facing error. `context.log.error('orpc handler error', { error })`. The oRPC `onError` interceptor already handles thrown handler errors; you only need explicit `.error(...)` calls when *catching* an exception and continuing.
- **Significant business events** — admin actions (`'admin created user'`, `'admin soft-deleted user'`), auth lifecycle (`'magic-link sent'`, `'auth session created'`, `'magic-link denied (unknown email)'`), effect failures (when a tier-2 `runEffect` swallows an error, it logs with the effect's tag).
- **Skip**: per-request access logs (Vercel's request log already covers this and Hobby retention isn't worth burning on it), debug breadcrumbs that mirror the code, anything you'd remove the next day.

The implicit rule: if a future you reading the production log stream wouldn't care about this line, it shouldn't exist.

### Adding a log call

No setup. Inside an oRPC procedure, `context.log` is already scoped — call it. Outside oRPC (service, server function, route loader, auth callback, effect adapter), import the singleton:

```ts
import { logger } from '~/lib/logger/server'
logger.warn('getSession failed', { error })
```

Background code (no request, hence no `context.log`) follows the same singleton path with a `component` child for scope: `scripts/devQueueWorker.ts` logs through `logger.child({ component: 'devQueueWorker' })`, and the queue handlers in `src/lib/queue/handlers/` import the singleton directly.

In the browser:

```ts
import { logger } from '~/lib/logger/browser'
logger.error('react error boundary', { error })
```

If a procedure or service introduces a new **significant event** (new admin action, new auth state change, new effect kind), add one `info` line alongside the operation. If a caught exception used to be `console.error`'d, it becomes `logger.error('<noun phrase>', { error })`.

### Why this is a deep module (in the skill's terms)

- **Interface**: 5 methods (`debug`, `info`, `warn`, `error`, `child`). Stable.
- **Implementation**: pino transport selection, `pino-pretty` worker handling, redact path matching, browser `keepalive` fetch with multi-layer error swallowing, global handler idempotence, Zod-validated `/api/log` ingress with size cap. Hidden behind 5 methods.
- **Two adapters from day one** (server pino + browser console-and-forward) — the seam is real, not hypothetical.
- **Test surface = the interface**: `createServerLogger(destination)` lets server tests assert JSON shape, `redact` policy, level filtering, `child` scope without mocking pino. Browser tests mock `fetch` once and assert forwarding policy. No tests need a real network or stdout.

---

## Verification

A reader can confirm the architecture is being followed without running anything:

- **No raw console calls in app code.** `grep -rn "console\." src/ --include="*.ts" --include="*.tsx"` should match only `src/lib/logger/browser.ts` (the sanctioned wrapper) and possibly `src/lib/logger/server.test.ts` / `browser.test.ts`. Anything else is a violation. Note the lint coverage is partial: only `console.debug`/`console.info` carry `biome-ignore` comments in the wrapper, because `biome.json` allows `console.warn`/`console.error` globally — for those two levels the no-console rule is enforced by review (this grep), not by lint.
- **No `~/lib/logger/server` import in browser code.** Component files (`src/components/`, `src/routes/`, `src/hooks/`) should import from `~/lib/logger/browser` only, never `/server`. The reverse — `~/lib/logger/browser` imported by server code — is also wrong.
- **`installGlobalHandlers()` is called exactly once.** Grep `installGlobalHandlers` — should appear in `src/lib/logger/browser.ts` (definition) and `src/router.tsx` (single call site).
- **`/api/log` is the only browser→server log forwarder.** Grep `fetch.*'/api/log'` — should appear only in `src/lib/logger/browser.ts`.
- **Procedures use `context.log`, not the singleton.** Grep `~/lib/logger/server` inside `src/lib/orpc/procedures/` — should be zero hits.

Manual smoke test after a change in this area:

1. `pnpm dev:log` then visit `/login` and submit a magic link. The `/tmp/oceanview-dev.log` file should contain a pretty-printed `magic-link sent` (or `magic-link (devLog)`) line with `email` and `url` fields.
2. From browser devtools console, run `throw new Error('test')`. A `window.error` POST to `/api/log` should appear in the network tab, and the dev log should gain an `error` line with `source: 'browser'`.
3. Trigger an oRPC procedure that throws inside a service. The dev log should gain one `orpc handler error` line — note it carries **no** `requestId`/`userId`, because the `onError` interceptor logs through the module singleton, outside the per-request context (see Architecture).
4. Hit any oRPC procedure twice in quick succession. The two requests' log lines should be correlatable by distinct `requestId` values.

---

## Critical files

- `src/lib/logger/types.ts` — interface.
- `src/lib/logger/server.ts` — pino factory, singleton, `createRequestLogger`.
- `src/lib/logger/browser.ts` — console + forward, `installGlobalHandlers`.
- `src/lib/logger/redact.ts` — redact paths.
- `src/routes/api/log.ts` — browser log sink, Zod-validated.
- `src/routes/api/rpc/$.ts` — `createRequestLogger(request)` + oRPC `onError` interceptor.
- `src/lib/orpc/client.ts` — SSR in-process client; second `createRequestLogger` call site.
- `src/routes/api/files/download.$id.ts` / `view.$id.ts` — file routes; remaining `createRequestLogger` call sites.
- `src/lib/orpc/context.ts` — `sessionMiddleware` attaches `userId` to `context.log`.
- `src/router.tsx` — `installGlobalHandlers()` call site.

---

## Consequences

**Positive**:
- One named seat for all logging. The "where does this log go?" question has a single answer regardless of layer (server, browser, oRPC handler, route loader, auth callback).
- Request-scoped logs by default — multi-line traces of a single admin action correlate via `requestId`.
- Browser crashes reach the same place as server crashes — one stream to triage.
- Two adapters from day one means tests assert against the interface, never against `console` spies or network mocks beyond a single `fetch` stub.
- Swapping to Sentry / Axiom / etc. later means rewriting two adapter files; no call sites change.

**Negative**:
- Vercel Hobby retention is 1 day. Long-running mysteries that surface after 24h are unrecoverable.
- No alerting. A production error log waits to be noticed; nothing pages anyone. Acceptable while there's no on-call rotation.
- No search UI beyond Vercel's runtime-logs viewer. Filtering by structured fields is grep-style.

**Revisit triggers** — re-open this ADR if any of these change:
- The user count grows past the "internal tool" boundary, or external compliance enters scope (PII redaction policy then needs tightening).
- Hobby retention bites — a real bug couldn't be diagnosed because the logs had rolled off.
- `/api/log` abuse appears in the stream (spoofed or garbage browser entries), or the app becomes known on the public internet — the open-ingest decision (2026-06-10 amendment) then needs auth and/or rate limiting.
- Alerting becomes a real need (the team gains an on-call rotation).
- A second piece of telemetry (metrics, traces) lands; at that point it may be cheaper to adopt one vendor (Sentry, Axiom, Datadog) for everything than to stitch three free tiers together.

# ADR 0001 — Side-Effects Architecture

- **Status**: Accepted
- **Date**: 2026-05-21
- **Deciders**: Lukas
- **Decision in one line**: Call side-effect adapters directly from oRPC procedures, behind a small typed `src/lib/effects/` module that mirrors `services/`. Skip in-process pub/sub. Add a Postgres-backed outbox only for the narrow set of effects that genuinely need durability.

---

> **Amended 2026-05-25.** The tier-3 ("Durable / deferred") passages — TL;DR row, the durability footnote under "Why not pub/sub?", **Approach comparison D**, and the section formerly titled *"When to reach for tier 3 (outbox)"* — are superseded by **[ADR-0007 — Background-Job Queue Architecture](./0007-background-job-queue-architecture.md)**. The durable tier landed as Vercel Queues + a shared handler (BullMQ + Redis in local dev), not the speculated Postgres outbox + cron worker. The trigger wasn't durability; it was latency + CPU offload (blurhash). The outbox shape stays *available* as a layered option for a future effect that genuinely needs DB-atomic enqueue, but is no longer the recommended default for tier 3 — see ADR-0007. Everything else in this ADR (tiers 1 and 2, the `effects/` seam, why not pub/sub at points 1–3 and 5) stands as originally written.

> **Amended 2026-06-04** (implementation reality — the seam stands, these details drifted):
> - **No `runEffect.ts` helper.** Tier-2 fire-and-forget is expressed inline at the call site as `effects.x.y(...).catch((error) => context.log.warn(...))`, plus Better Auth's `backgroundTasks` / Vercel `waitUntil()` where work must outlive the response. The `runEffect(tag, fn)` wrapper described below and in Phase 1 was never built; read its mentions as "the tier-2 contract" (catch + log, never throw to caller), not a literal function.
> - **No `audit` effect.** `effects.audit` / `src/lib/effects/audit/` shown in the namespace tree and call-site examples is illustrative only — it was never implemented (correctly deferred per Phase 1 point 5). Ignore it as a current file.
> - **`email` ships three adapters**, not two: `resend` (prod), `smtp` (dev → Mailpit), `devLog` (test). See [ADR-0008](./0008-email-architecture.md). The "two adapters from day one" line is about the seam being real; three only strengthens it.
> - **The effects inventory is wider than email/storage/queue.** Two **in-process** effects also live under `src/lib/effects/` and follow the same seam, but own in-process state rather than the outside world: `realtime` (SSE pub/sub — see [ADR-0004](./0004-realtime-sync-architecture.md)) and `presence` (online/away tracking — see [ADR-0011](./0011-presence-online-status-architecture.md)). The "effects own the outside world" framing below predates them; treat in-process effects as a sanctioned second category.

> **Amended 2026-06-10** (storage reality, caller classes, a stale carve-out — the seam still stands):
> - **Storage landed per [ADR-0006](./0006-file-storage.md), not R2.** The namespace tree's `storage/adapters/r2.ts` and the `presignUpload`/`presignDownload`/`deleteObject` sketch are historical. `src/lib/effects/storage/` ships three adapters — `vercelBlob` (prod), `s3` (dev → RustFS), `devLog` (test) — plus `clientUpload.ts`, the browser-side dispatcher that switches on the discriminated `upload.kind`, and an `envPrefix()`/`stripEnvPrefix()` pair exported from `storage.ts` (kept together so adapter prefixing and validation can't drift). Read every R2 mention below — the "R2 presign" tier-1 example in the TL;DR table, "R2 has no egress fees" in the carried-forward non-negotiables, the `r2` verification grep — as historical; ADR-0006 is the storage source of truth, the same way the 2026-06-04 amendment routes email to [ADR-0008](./0008-email-architecture.md).
> - **Sanctioned caller classes today** are four: oRPC procedures; the magic-link callback in `src/lib/auth.ts` (the `magicLink` plugin's `sendMagicLink` awaits `emailEffect.sendMagicLink`); queue handlers in `src/lib/queue/handlers/` ([ADR-0007](./0007-background-job-queue-architecture.md)); and the auth-gated file routes `src/routes/api/files/{download,view}.$id.ts` (session check → `storage.getReadUrl` → 302). The carried-forward non-negotiable naming `/api/cron/drain` as *the one* non-oRPC exception is stale — that route was never built. The actual non-oRPC server entrypoints are `/api/files/*`, `/api/log` (browser log sink — [ADR-0003](./0003-logging-architecture.md)), and the Nitro `vercel:queue` consumer plugin (`server/plugins/queueConsumer.ts`).
> - **Strike the `enqueueEffect(tx, …)` carve-out.** The "Services … **may** call `enqueueEffect(tx, …)` for tier 3" clause in the carried-forward non-negotiables was never built (no outbox exists). The shipped rule is stronger and unconditional: services import **nothing** from `src/lib/effects/` — `grep -ri "effects" src/lib/services/` returns zero hits.
> - **The Context paragraph is a 2026-05-21 snapshot.** "Only one cross-system side effect actually executes" and "the magic-link transport is `console.log` in `src/lib/auth.ts:46`" were true at decision time only. Today the transport is `emailEffect.sendMagicLink`, awaited (tier 1) inside the `magicLink` plugin callback, and the effects inventory spans email, storage, queue, realtime, and presence.
> - **Adapter selection is lazy, not at module load.** The shared helper is `src/lib/effects/lazy.ts`: each multi-adapter effect wraps its env-branching selector in `lazy(...)`, which dynamically imports and caches the adapter on **first call** (keeping adapters code-split). The sketch's `export const email: EmailEffects = pickAdapter() // resolves … at module load` describes the seam, not the shipped mechanism — and the tree slot drawn as `runEffect.ts` is occupied by `lazy.ts` in reality.
> - **Tier classification of the in-process effects.** `realtime` and `presence` are awaited inline at every publish/acquire site with no catch — sound only because the in-memory adapters are infallible by construction (they cannot throw). If a fallible adapter (Redis/Postgres pub/sub) ever replaces them, every publish site moves to the tier-2 contract: catch + log, never fail the request.
> - **The Verification section is the phase-1 checklist** — see the in-place notes there; the original greps no longer pass and are replaced with ones that do.

---

## Context

Oceanview is a small internal app (10–20 users) for a sailboat co-ownership group, deployed on Vercel Hobby. The scaffold is complete; the codebase is disciplined: **services own DB access, oRPC procedures orchestrate, Better Auth owns sessions, no event bus or queue exists**. Today only one cross-system side effect actually executes — `auth.api.revokeUserSessions()` inline in `src/lib/orpc/procedures/user.ts` after `softDeleteAsAdmin`. The magic-link transport is `console.log` in `src/lib/auth.ts:46`. As Resend, R2, audit logs, scheduled boat-week reminders, and future webhooks come online, the codebase needs a **clear seat** for side-effect logic so it doesn't sprawl into procedures or hide in service files (which would break the "services own only the DB" rule).

The question worth answering now (rather than once five callers exist): **publish-and-listen, or call directly?** Get the seam right once; everything downstream becomes mechanical.

---

## Decision (TL;DR)

**Call side-effect adapters directly from oRPC procedures, behind a small typed `effects` module that mirrors `services/`. Skip the in-process event bus. Add a Postgres-backed outbox only for the narrow set of effects that genuinely need durability.**

Three execution tiers, all routed through the same `effects/` seam:

| Tier | When | Mechanism | Example |
|---|---|---|---|
| **1. Sync-critical** | Caller must know if it failed | `await effects.x.y(...)` — surfaces to caller | Magic-link send, session revoke, R2 presign |
| **2. Fire-and-forget** | Best-effort; failure is logged but doesn't fail the request | `runEffect(() => effects.x.y(...))` — catches + logs | Audit log entry, analytics ping |
| **3. Durable / deferred** *(superseded by [ADR-0007](./0007-background-job-queue-architecture.md))* | Heavy / CPU-bound / runs out-of-band; latency tolerated | `queue.publish('<topic>', payload)` via `~/lib/effects/queue/`; consumed by Vercel Queues in prod, BullMQ worker in dev | Blurhash generation; future thumbnail/transcode, scheduled boat-week reminders, batched digests |

This keeps the **interface** small (typed adapter functions), the **implementation** swappable (Resend today, alternative tomorrow), and the **locality** preserved (the procedure reads top-to-bottom: validate → service mutation → effect — no hidden listeners). It also satisfies the "deletion test": removing the `effects/` namespace would re-scatter Resend/R2/Slack glue across procedures, which it currently isn't doing. That's a real seam, not a pass-through.

---

## Why not pub/sub?

Pub/sub is the obvious-looking alternative, so it deserves a direct answer. The five things people reach for pub/sub to get, and what actually happens in this runtime:

1. **Decoupling** — Producer doesn't import consumer. Real benefit, but **within one monorepo it's cosmetic**: every listener still lives in the same codebase, in the same deploy, owned by the same team. A typed `effects.email.userInvited(...)` call behind a swappable interface gives the same "swap the implementation" benefit with stronger types and a control flow you can read top-to-bottom. The decoupling pub/sub is famous for matters at **system boundaries** (microservices, external subscribers) — not at the call-site boundary inside one app.

2. **Multiple consumers** — Real benefit, but Oceanview has **zero cases** of it today and no obvious cases coming. When "user created → send welcome + log audit + sync CRM" actually appears, the simpler shape is a `onUserCreated(user)` orchestrator function that calls all three effects — explicit, typed, traceable. Three function calls beat three listener registrations every time the answer to "what fires when X happens?" matters (which is constantly, during debugging).

3. **Async / don't block the request** — On Vercel Functions, **fire-and-forget after the response is unsafe**: the function can be frozen or killed once the response is sent. The listener's `await` may never resolve. The only safe "async" inside a request is to finish before returning — which is what direct calls already do, and which `runEffect` (tier 2) makes explicit for best-effort cases. In-process pub/sub doesn't change this physics.

4. **Durability** — This is the most common misconception. An in-process `EventEmitter` has **zero durability**: if the process dies mid-handler, the event is lost forever, with no record it was ever fired. People reach for pub/sub *thinking* they're getting durability, then are surprised when events vanish. Real durability requires either a managed broker (SNS/Kafka/Redis Streams — vendor + cost + ops) or the outbox pattern (Postgres table, no new vendor) — both of which are still available to you here as tier 3, exactly where they're earned. **(Note 2026-05-25: tier 3 has landed; the mechanism is a managed queue, not the outbox — see [ADR-0007](./0007-background-job-queue-architecture.md). Both options remain composable behind the `effects/` seam.)**

5. **Replay / audit log** — Also needs durable storage. Outbox gives this for the price of one table.

The summary: **in-process pub/sub gives you indirection without the benefits**. Real pub/sub gives you the benefits but requires real infrastructure that a 10–20 user internal tool doesn't pay back. The typed `effects` seam captures the only benefit that actually applies here (swappable implementations behind a stable interface) without lying to future maintainers about what's durable. When durability or fan-out becomes a real requirement, **the outbox tier slots in behind the same seam** — procedures don't have to change.

Said in the architecture skill's vocabulary: pub/sub at this scale is a **shallow seam** (the interface is nearly as complex as the implementation, and the implementation buys you nothing the call-site can't already see). The typed effects module is a **deep seam** — small surface, real leverage, real locality.

---

## Approach comparison

### A. Direct calls inlined in procedures (status quo for `revokeUserSessions`)
- ➕ Zero new abstraction. Reads top-down.
- ➖ Procedures couple to every transport SDK (Resend, R2 client, Slack). Hard to swap adapters, hard to test the orchestration without hitting Resend.
- ➖ Same logic repeated in every procedure that sends "welcome user" / "user removed" emails.
- **Verdict**: fine for 1 caller, fails the deletion test once you have ≥2.

### B. Direct calls behind a typed `effects` module ← **recommended baseline**
- ➕ Single seam per effect (the `effects.email.sendMagicLink` interface, etc.). Test surface = interface.
- ➕ Procedures stay shallow & readable: `await effects.email.userInvited(...)`.
- ➕ Adapters swap freely (dev-log adapter for local, Resend for prod). Two adapters from day one = real seam (per the architecture skill's heuristic).
- ➕ Costs nothing — it's a folder + a few typed functions.
- ➖ Doesn't solve durability. If the request crashes between the DB commit and the email send, the email is lost.
- **Verdict**: correct default. Layers 1 and 2 from the TL;DR table.

### C. In-process event bus (Node `EventEmitter` / typed emitter library)
- ➕ Theoretically decoupled — `user.delete` doesn't import the email module.
- ➖ **On serverless this is a trap.** Listeners run inside the same function lifecycle; if you fire-and-forget, the function may exit before the listener finishes. If you `await`, you've just rebuilt direct calls with more indirection.
- ➖ Hidden control flow. Reading `procedures/user.ts` doesn't tell you what fires on delete; you have to grep listener registrations.
- ➖ Type safety degrades unless you wire a typed emitter, at which point you've reinvented option B with more ceremony.
- ➖ "Decoupling" is fake when every listener lives in the same monorepo. The real decoupling option B gives you (swappable adapter behind a typed interface) is stronger and simpler.
- **Verdict**: don't.

### D. Postgres outbox + cron worker (durable layer)
- ➕ Effect intent is committed in the **same transaction** as the state change → no lost effects, no double-fired effects.
- ➕ Worker runs on its own clock; survives crashes; supports retries with backoff.
- ➕ Uses existing Postgres; no new vendor.
- ➖ Real complexity: dispatch table, status enum, claim semantics (SELECT … FOR UPDATE SKIP LOCKED), idempotency keys on the adapter side, dead-letter handling.
- ➖ Vercel Hobby crons run **once per day max** (Pro = unlimited). For sub-day latency you'd need an external trigger (cron-job.org pings a `/api/effects/drain` route, or upgrade).
- **Verdict**: **superseded by [ADR-0007](./0007-background-job-queue-architecture.md)** — the durable tier landed as Vercel Queues + a shared handler, not an outbox + cron. The 1/day Hobby-cron limit is what tipped it: blurhash needs sub-minute latency, not sub-day. Outbox stays available as a layered option *combined with* the queue if a future effect ever needs DB-atomic enqueue, but it is no longer the default tier-3 mechanism.

### E. External orchestrator (Inngest / Trigger.dev / QStash)
- ➕ Real reliability + retries + scheduling + observability UI.
- ➖ Adds vendor (free tiers exist, but it's another account, another secret, another dashboard).
- ➖ For 10–20 users and a handful of effects, the cognitive cost is higher than the outbox pattern.
- **Verdict**: don't reach for it. If outbox ever bends, then upgrade — but the migration is mechanical because effects already live behind a typed seam.

---

## Architecture

### The `src/lib/effects/` namespace

Mirrors `src/lib/services/`: one folder per effect domain, barrel `index.ts`, colocated tests. Where services own the DB, **effects own the outside world** (SMTP, object storage, third-party APIs, audit log, future Slack).

```
src/lib/effects/
  index.ts                       barrel — re-exports effects.email, effects.storage, effects.audit, …
  runEffect.ts                   tier-2 helper: catch, log, tag; never throws to caller
  outbox/
    schema.ts                    drizzle schema for `effect_outbox` (tier 3)
    enqueue.ts                   enqueueEffect(tx, kind, payload) — call inside a service tx
    drain.ts                     drainOutbox() — claims batch, dispatches via effects.*, marks status
    drain.test.ts                claim/retry/backoff/idempotency tests
  email/
    index.ts                     barrel re-exports
    email.ts                     typed interface: sendMagicLink, userInvited, userRemoved, …
    adapters/
      resend.ts                  Resend adapter (used when RESEND_API_KEY is set)
      devLog.ts                  console.log adapter (used in dev + tests)
    email.test.ts                interface tests using the devLog adapter
  storage/
    storage.ts                   presignUpload, presignDownload, deleteObject (R2 adapter)
    adapters/r2.ts
  audit/
    audit.ts                     log(actorId, action, target, metadata) — writes to audit table
```

### The seam

`effects/<domain>/<domain>.ts` exports **typed functions**, not adapter classes:

```ts
// src/lib/effects/email/email.ts — illustrative sketch; the shipped interface
// has only sendMagicLink (userInvited/userRemoved were never needed), and the
// adapter resolves lazily on first call via lazy.ts (see 2026-06-10 amendment)
export interface EmailEffects {
  sendMagicLink(input: { to: string; url: string }): Promise<void>
  userInvited(input: { to: string; inviterName: string }): Promise<void>
  userRemoved(input: { to: string; reason?: string }): Promise<void>
}

export const email: EmailEffects = pickAdapter() // resolves Resend vs devLog at module load
```

Procedures import the named functions — no DI container, no factory at the call site:

```ts
// src/lib/orpc/procedures/user.ts
import * as userService from '~/lib/services/user'
import { email, audit } from '~/lib/effects'
import { runEffect } from '~/lib/effects/runEffect'

// tier 1 — sync-critical: caller blocks on email send, surfaces error
await email.userInvited({ to: input.email, inviterName: ctx.user.name })

// tier 2 — fire-and-forget: audit log shouldn't fail the request
runEffect('audit.userCreated', () => audit.log(ctx.user.id, 'user.created', created.id))
```

For Better Auth's `sendMagicLink` callback in `src/lib/auth.ts`, the callback becomes a one-line forwarder into `email.sendMagicLink` — preserving the existing entrypoint without leaking Resend into `auth.ts`.

### Why this is a deep module (in the skill's terms)

- **Interface**: ~5 typed functions per domain. Stable.
- **Implementation**: Resend HTTP retries, MIME formatting, error mapping, locale (Swedish), template rendering, env-driven adapter selection. Hidden.
- **Two adapters from day one** (Resend + devLog) — the seam is real, not hypothetical.
- **Test surface = the interface**: services + procedures use the devLog adapter; we don't mock Resend, we have a real second implementation.

### How the durable tier landed *(superseded — see [ADR-0007](./0007-background-job-queue-architecture.md))*

The first tier-3 candidate turned out to be blurhash placeholder generation (introduced alongside [ADR-0006](./0006-file-storage.md)), not the boat-week reminder. The forcing function wasn't durability (blurhash is recomputable from the stored bytes), it was **latency + CPU offload**: doing `sharp` + `blurhash` inline would block upload responses and inflate Function CPU time. That made a managed queue the right shape over the speculated Postgres outbox + cron. ADR-0007 documents the producer seam (`~/lib/effects/queue/`), the shared handler (`~/lib/queue/handlers/<topic>.ts`), and the prod / dev / test wiring. When (if) a future effect genuinely needs DB-atomic enqueue — boat-week reminders being a likely candidate — outbox layers on top of the queue rather than replacing it.

---

## Scaffolding to create (when executed)

### Phase 1 — tier 1 & 2 only (lands now, alongside Resend wiring)

1. **Create `src/lib/effects/email/`**:
   - `email.ts`: `EmailEffects` interface + adapter selector (`pickAdapter()` returns Resend when `RESEND_API_KEY` is set, devLog otherwise — same env-driven pattern Better Auth already uses).
   - `adapters/resend.ts`: Resend SDK adapter. Swedish templates inline for now (small enough; promote to a `templates/` subfolder once we have ≥3).
   - `adapters/devLog.ts`: console-logs the payload, returns void. Used in dev + every test.
   - `index.ts`: re-export `email`.
   - `email.test.ts`: interface contract test that runs against the devLog adapter (asserts no throws on the expected shapes).

2. **Create `src/lib/effects/runEffect.ts`** — tier 2 helper:
   - `runEffect(tag: string, fn: () => Promise<void>): void` — invokes `fn`, swallows errors, logs with the tag. Never `await`ed by callers.

3. **Create `src/lib/effects/index.ts`** as a barrel: `export * as email from './email'`, etc.

4. **Wire Better Auth's `sendMagicLink`** in `src/lib/auth.ts:36-48`:
   ```ts
   sendMagicLink: async ({ email: to, url }) => {
     await email.sendMagicLink({ to, url })
   }
   ```
   Remove the inline `console.log`. The devLog adapter already prints in development.

5. **Refactor `procedures/user.ts:78-87`** (the `delete` procedure):
   - Keep `revokeUserSessions` as tier-1 direct call (it's correct — caller must know).
   - Add `runEffect('audit.userDeleted', () => audit.log(...))` once `effects/audit` exists; until then, do nothing (don't speculatively add audit).

6. **Add to `.env.example`**: nothing new (`RESEND_API_KEY` is already there).

7. **Add to CLAUDE.md** "How we write code":
   - One paragraph: where effects live, the three tiers, the "services don't call effects" rule (procedures orchestrate both — services stay DB-only, preserving the existing non-negotiable).

### Phase 2 — tier 3 *(superseded by [ADR-0007](./0007-background-job-queue-architecture.md))*

The originally planned scaffolding (`effect_outbox` table, `enqueue.ts`, `drain.ts`, cron route, drain test) was not built. The realised tier-3 mechanism is a queue (`~/lib/effects/queue/` + `~/lib/queue/handlers/`); ADR-0007 documents the files that exist today. If a future effect requires DB-atomic enqueue, the outbox would slot in *next to* the queue (enqueue into an outbox row inside the service tx; cron drains by calling `queue.publish`), not replace it.

### Non-negotiables that constrain this design (carried forward)

- **Services stay DB-only** (CLAUDE.md). Effects are called by procedures, never by services. Services receive a tx and **may** call `enqueueEffect(tx, …)` for tier 3 (because outbox writes are DB writes — that's the only reason a service touches the effects namespace, and only the `outbox/enqueue` helper, not the adapters).
- **All non-auth server calls through oRPC** (CLAUDE.md). The `/api/cron/drain` route is the one exception, justified because cron is not an oRPC client; it should still verify a shared secret.
- **Free tier first**: Resend free tier (3k/mo) covers Oceanview easily. R2 has no egress fees. Vercel cron on Hobby = 1/day; if tier-3 latency needs more, swap to a free external pinger before paying for Pro.
- **Swedish user-facing text**: email templates are Swedish; subject lines, body, footer all in informal "du".

---

## Verification

After phase 1 lands *(historical checklist — kept as written except the two greps, replaced 2026-06-10 with ones that pass against today's tree)*:

- `pnpm test` passes — `email.test.ts` exercises the interface contract against devLog.
- `pnpm dev` — request a magic link from `/login`; in dev (no `RESEND_API_KEY`) the link prints to console as before; in a `.env` with `RESEND_API_KEY` set, the message arrives in the inbox.
- Manually delete a user via `/admin/users` — confirm: (a) user is soft-deleted, (b) their session is revoked (existing behavior preserved), (c) no new errors in logs.
- `pnpm check` — Biome lint passes.
- `grep -ri "effects\|better-auth\|@vercel/blob\|resend" src/lib/services/` — zero hits (services stay DB-only: no effects namespace, no auth SDK, no transport SDK). *(The original `email`/`resend`/`r2` grep rotted — services legitimately contain `email` as a column/field name.)*
- `grep -ri "resend\|nodemailer\|@vercel/blob\|@aws-sdk" src/lib/orpc/procedures/` — zero hits (procedures use the `effects` seam, never a transport SDK directly).

After phase 2 lands *(superseded — the outbox was never built; see [ADR-0007](./0007-background-job-queue-architecture.md) for the queue's verification story)*:

- `drain.test.ts` covers: claim semantics under concurrency, retry with backoff, idempotent re-dispatch, dead-letter on max attempts.
- Trigger the cron route manually with the secret header — outbox drains; without the secret, returns 401.
- Insert an effect row by hand, observe it dispatched on the next cron tick.

---

## Critical files to touch (phase 1)

- `src/lib/auth.ts:36-48` — replace inline `console.log` with `email.sendMagicLink`.
- `src/lib/orpc/procedures/user.ts` — no change required for phase 1; keep `revokeUserSessions` as-is.
- `src/lib/effects/**` — new (entire folder).
- `CLAUDE.md` — add a "Side effects" subsection under "How we write code" referencing the three tiers and the `effects/` namespace.
- `package.json` — add `resend` dependency.

---

## Consequences

**Positive**:
- One named seat for all side-effect logic, mirroring the existing `services/` discipline.
- Procedures stay readable top-to-bottom; no hidden listeners.
- Two adapters per effect from day one (real adapter, devLog) means tests don't mock the outside world.
- Tier 3 (outbox) can slot in later without touching procedures.

**Negative**:
- Tier 1 doesn't survive process crashes between DB commit and effect dispatch. Acceptable for everything currently planned; revisit per-effect when needed.
- Adds a `src/lib/effects/` namespace before there are many effects — a small upfront cost paid against future scattering.

**Revisit triggers** — re-open this ADR if any of these change:
- Multiple consumers genuinely appear for a single "event" (≥3 different effects fanning out from one state change).
- An effect emerges that **must** succeed even on crash, and the boat-week reminder feature is not the first such case.
- Vercel Hobby's 1/day cron limit becomes a meaningful blocker before tier 3 is implemented.

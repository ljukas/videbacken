# ADR 0007 — Background-Job Queue Architecture

- **Status**: Accepted
- **Date**: 2026-05-25
- **Deciders**: Lukas
- **Decision in one line**: Heavy / deferred work runs on a queue. Producers call `queue.publish(topic, payload)` through `~/lib/effects/queue/`; the same handler in `src/lib/queue/handlers/<topic>.ts` runs in production (Vercel Queues → Nitro `vercel:queue` hook) and in local dev (BullMQ + Redis worker). The adapter is chosen at runtime from env; tests use a `devLog` no-op. **Supersedes the tier-3 / outbox passages in [ADR-0001](./0001-side-effects-architecture.md).**

> **Amended 2026-06-24.** A fourth topic landed: **`email_user_invited`** (`{ to, inviteUrl, locale }`) — the first **email** topic, and the first producer that is **not** an oRPC procedure. It is published from Better Auth's `sendVerificationEmail` hook (`src/lib/auth.ts`), making user invitations tier-3 (delivery off the admin's request, with retry/backoff). Handler: `src/lib/queue/handlers/emailUserInvited.ts` (a thin `email.sendUserInvited(...)` — all token/link work happened on the producer side). Wired through all five places per *How to add a new topic*: the union/payload in `queue.ts`, the handler, the `vercel:queue` switch (`queueConsumer.ts`), the `vite.config.ts` trigger, and the dev `Worker` (`devQueueWorker.ts`). See [ADR-0008](./0008-email-architecture.md) (the email seam) and [ADR-0017](./0017-user-invitation-flow.md) (the invitation flow). Note this loosens the producer's "no auth hook" verification grep below — `publish('email_user_invited', …)` legitimately lives in `src/lib/auth.ts`.

> **Amended 2026-06-10.** Vercel Queues re-verified: it is **GA**, no longer public beta. Billing is per operation, metered in 4 KiB chunks, across five operation types (Send / Receive / Delete / Visibility change / Notify); operations are regionally priced against plan credits; sends with an idempotency key and push deliveries with max concurrency bill at 2× for that operation; functions invoked in push mode are billed as normal Fluid compute. Default message retention is 24 h (max 7 days) — which *simplifies* the swap path documented below: unprocessed messages for recomputable jobs like blurhash self-expire, so there is nothing to migrate. At ~20 users our volume is trivially inside Hobby plan credits. The "exits beta with surprising pricing" revisit trigger is retired and restated in measurable terms below. Sources: [vercel.com/docs/queues](https://vercel.com/docs/queues), [vercel.com/docs/queues/pricing](https://vercel.com/docs/queues/pricing).

---

## Context

[ADR-0006](./0006-file-storage.md) put avatars and documents in Vercel Blob. That created the need for a `<canvas>`-style placeholder while the real image loads — a [blurhash](https://blurha.sh). Generating one is **expensive**: `sharp` decodes the bytes, downscales, and hands a pixel buffer to `blurhash`'s encoder. On a 5 MB JPEG that's hundreds of milliseconds, sometimes seconds, and it loads two heavy native modules (`sharp` is ~30 MB on disk; `blurhash` is small but allocates). Doing it inline inside `confirmAvatarUpload` would:

- Block the upload response on CPU work the user doesn't need to wait for.
- Hold a Vercel Function open for the duration, burning Active CPU pricing on a request that should be sub-100 ms.
- Drag `sharp` into the cold-start of every Function bundle, not just the consumer.

The shape of the problem — *fire-and-forget durable work, executed out-of-band, retryable, observable* — is a queue. We need one now (blurhash), and the next obvious candidates (scheduled boat-week reminders, future thumbnail/transcode, batched email digests) all fit the same shape.

[ADR-0001](./0001-side-effects-architecture.md) reserved a "tier 3 / durable" slot for exactly this, and speculated a Postgres outbox + cron worker would land there first. That speculation is wrong: blurhash is **not** durability-bound (the source bytes are in Blob; we can always recompute), it's **latency-bound** (sub-minute) and **CPU-bound** (offload). Vercel Queues is the right fit for the actual workload, on the platform we're already on, and the `effects/` seam from ADR-0001 absorbs the change without a rewrite. This ADR replaces those passages.

---

## Decision (TL;DR)

**One producer interface, three runtime adapters, one shared consumer handler.**

| Environment | Producer adapter | Broker | Consumer |
|---|---|---|---|
| Production (Vercel) | `vercelQueue` (`@vercel/queue`) | Vercel Queues | `server/plugins/queueConsumer.ts` — Nitro `vercel:queue` hook |
| Local dev with broker (`REDIS_URL` set) | `bullmqQueue` | Redis (docker `compose.yaml` `queue` service) | `scripts/devQueueWorker.ts` (`pnpm dev:worker`) |
| Local dev without broker | `devLog` (no-op) | — | — (uploads succeed; blurhash skipped) |
| Tests (`VITEST=true`) | `devLog` | — | — |

The producer interface lives at `~/lib/effects/queue/` (alongside `email`, `storage`, `realtime`); the consumer handler lives at `~/lib/queue/handlers/<topic>.ts`. Both Vercel Queues and the dev BullMQ worker call the **same** handler function — the wire-up is the only thing that differs.

This is a **deep seam**: a one-method interface (`publish`) with real leverage behind it (three live adapters, a shared consumer, retries, idempotent handler logic). Two adapters from day one would have qualified; we have three.

---

## Alternatives considered

### A. Inline `await` inside the upload procedure
- ➕ Zero new infrastructure.
- ➖ Blocks the upload response on `sharp` + `blurhash`.
- ➖ Burns Function CPU on the request path.
- ➖ Drags `sharp` into every Function's cold-start bundle.
- **Verdict**: no — defeats the upload UX and inflates compute cost.

### B. Postgres outbox + cron drain (what ADR-0001 speculated)
- ➕ No new vendor — uses the database we already have.
- ➕ Effect intent commits in the same transaction as the state change.
- ➖ Vercel Hobby cron is **once per day**; blurhash needs sub-minute latency.
- ➖ We'd own claim semantics (`SELECT … FOR UPDATE SKIP LOCKED`), retries, dead-letters, idempotency keys. Real complexity for a workload that doesn't need durability.
- **Verdict**: would work for the *durability* axis alone, but not for latency. Stays available as a layered option when durability ever becomes a hard requirement (see "Outbox is not dead, just dormant" below).

### C. External orchestrator (Inngest / Trigger.dev / QStash)
- ➕ Real reliability, retries, scheduling, an observability UI.
- ➖ Another vendor, another account, another secret.
- ➖ For a 10–20 user internal app, an additional dashboard is friction without payback.
- **Verdict**: not yet. The `effects/queue/` seam makes this a future swap, not a rewrite.

### D. Vercel Queues + queue effect seam ← **chosen**
- ➕ Native to the platform we're already on; OIDC-authed; retries built in.
- ➕ Producer behind the existing `~/lib/effects/` seam — procedures stay thin.
- ➕ Two adapters from day one (devLog + vercelQueue); the BullMQ adapter for dev makes the seam a three-adapter reality.
- ➕ Shared handler in `~/lib/queue/handlers/` means prod and dev execute the *same* code path.
- ➖ Vercel Queues was in public beta at decision time — SLA / pricing risk bounded by the swap-to-Redis escape hatch documented below. (Now GA; see the 2026-06-10 amendment.)
- **Verdict**: yes.

---

## Architecture

### The producer seam — `src/lib/effects/queue/`

One interface, typed per topic via a discriminated payload map:

```ts
// src/lib/effects/queue/queue.ts
export type QueueTopic = 'blurhash' | 'image_thumbnail' | 'pdf_thumbnail' | 'email_user_invited'

export type QueuePayloadMap = {
  blurhash:
    | { fileId: string; kind: 'avatar'; userId: string }
    | { fileId: string; kind: 'document' }
  image_thumbnail: { documentId: string }
  pdf_thumbnail: { documentId: string } // reserved; not yet produced or consumed
  email_user_invited: { to: string; inviteUrl: string; locale: Locale } // ADR-0017
}

export interface QueueEffects {
  publish<T extends QueueTopic>(topic: T, payload: QueuePayloadMap[T]): Promise<void>
}
```

> **Amended 2026-06-04.** `blurhash` is the canonical example throughout this ADR, but it is no longer the only live topic. **`image_thumbnail`** landed as the second real topic for [ADR-0010 — Document Management](./0010-document-management.md): handler `src/lib/queue/handlers/imageThumbnail.ts` (reads the private original, renders a WebP, writes it to the *public* store at `thumbnails/{documentId}.webp`, publishes `document.changed`), produced from `src/lib/orpc/procedures/document.ts`, registered in `vite.config.ts` triggers and the `vercel:queue` plugin switch, and consumed by a second BullMQ `Worker` in `scripts/devQueueWorker.ts`. It is the working proof of the *How to add a new topic* recipe below. **`pdf_thumbnail`** is forward-declared in the union only — no producer publishes it and no handler consumes it yet (PDFs render a mime-type icon); it stays reserved until the renderer's serverless-dependency story is proven. See ADR-0010.

Adapter selection happens on first `publish()` via dynamic import, cached for the rest of the process (the branching is wrapped in the shared `lazy()` memoizer from `src/lib/effects/lazy.ts` — same semantics, shared with the other effect selectors):

```ts
const getAdapter = lazy(async (): Promise<QueueEffects> => {
  if (process.env.VITEST === 'true') return (await import('./adapters/devLog')).devLog
  if (process.env.REDIS_URL)        return (await import('./adapters/bullmqQueue')).bullmqQueue
  if (!process.env.VERCEL)          return (await import('./adapters/devLog')).devLog
  return (await import('./adapters/vercelQueue')).vercelQueue
})
```

Three properties this gets us:

- **Per-topic payload typing.** The discriminated union (`kind: 'avatar' | 'document'`) lives in the producer's type, not deferred to the row in storage. The handler dispatches on `kind` without re-querying.
- **Bundle isolation.** BullMQ stays out of the production Nitro bundle; `@vercel/queue` stays out of the local `tsx` worker. Each runtime ships only the adapter it actually uses.
- **Fire-and-forget on failure.** Callers `.catch()` the publish so an upload still succeeds if the broker is briefly unavailable — the worst case is a missing blurhash, not a failed upload.

Canonical producer call sites:

```ts
// `confirmAvatarUpload` — src/lib/orpc/procedures/image.ts
await queue
  .publish('blurhash', { fileId: newRow.id, kind: 'avatar', userId: context.user.id })
  .catch((error) => {
    context.log.warn('failed to enqueue avatar blurhash', { fileId: newRow.id, error })
  })

// `confirmDocumentUpload` — src/lib/orpc/procedures/document.ts
// Behind the same SHARP_DECODABLE_MIME_SET gate, it enqueues `image_thumbnail`
// alongside `blurhash`.
if (SHARP_DECODABLE_MIME_SET.has(inserted.file.mime)) {
  await queue
    .publish('blurhash', { fileId: inserted.file.id, kind: 'document' })
    .catch((error) => { /* log and continue */ })
  await queue
    .publish('image_thumbnail', { documentId: inserted.document.id })
    .catch((error) => { /* log and continue */ })
}
```

### The handler contract — `src/lib/queue/handlers/<topic>.ts`

Handlers are *consumer-side code* and deliberately live outside `~/lib/effects/queue/` (which is *producer-side*). Both prod and dev consumers import the same function — that shared call site is the whole point.

```ts
// src/lib/queue/handlers/blurhash.ts
export async function handleBlurhashMessage(
  msg: QueuePayloadMap['blurhash'],
  metadata: { messageId: string; deliveryCount: number },
): Promise<void>
```

Handler invariants every implementation must keep:

- **Idempotent.** Re-runs are free. The handler re-fetches the file row, skips when `blurhash` is already set, skips when the file was soft-deleted between enqueue and dispatch, and skips unsupported MIMEs (`SHARP_DECODABLE_MIME_SET`) without throwing — so the queue acks instead of retrying.
- **Self-contained side effects.** Mirrors onto `user.image_blurhash` are explicit (`if (msg.kind === 'avatar')`), driven by the payload — never inferred from the row.
- **Lazy native imports.** `sharp` and `blurhash` are dynamic-imported inside `generateBlurhash`, so the modules only load on the first message — not at cold-start.

### Production setup

The Nitro plugin is registered explicitly because TanStack Start manages Nitro's serverDir:

```ts
// vite.config.ts
nitro({
  plugins: ['./server/plugins/queueConsumer.ts'],
  vercel: {
    config: {
      queues: { triggers: [{ topic: 'blurhash' }, { topic: 'image_thumbnail' }] },
    },
  },
})
```

And the plugin itself is a one-liner over the shared handler:

```ts
// server/plugins/queueConsumer.ts
export default definePlugin((nitro) => {
  nitro.hooks.hook('vercel:queue', async ({ message, metadata }) => {
    if (metadata.topicName !== 'blurhash') return
    await handleBlurhashMessage(message as QueuePayloadMap['blurhash'], {
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
    })
  })
})
```

Vercel Queues runs on Fluid Compute (same region, same OIDC auth) — no env-var wiring is required. Retries and backoff use Vercel's defaults; observe runs in **Vercel Runtime Logs** (the same place every other Function logs).

### Development setup

Two halves: a broker (docker) and a worker process (separate terminal). With `REDIS_URL` unset, dev falls back to the `devLog` adapter — uploads still work, blurhash just isn't generated, which is a fine default when you don't want the broker running.

**1. The broker** — `compose.yaml` declares two services:

```yaml
queue:
  image: redis:7.4-alpine
  ports: ["14521:6379"]
  command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]
  volumes: [redis_data:/data]
  healthcheck: { test: ["CMD", "redis-cli", "ping"], ... }

queue-studio:
  profiles: [studio]       # opt-in via `pnpm queue:studio`
  image: emirce/bullstudio:1.4.0
  ports: ["14504:4000"]
  environment: { REDIS_URL: redis://queue:6379 }
```

AOF (`appendfsync everysec`) means queued jobs survive `docker compose down`. `queue-studio` is profile-gated so it doesn't auto-start with `pnpm dev:up`; activate via `pnpm queue:studio` and visit `http://localhost:14504`.

**2. The worker** — `scripts/devQueueWorker.ts` wraps BullMQ's `Worker` around the same `handleBlurhashMessage` the prod plugin uses:

```ts
const worker = new Worker<QueuePayloadMap['blurhash']>(
  'blurhash',
  async (job) => {
    await handleBlurhashMessage(job.data, {
      messageId: job.id ?? 'local-unknown',
      deliveryCount: job.attemptsMade + 1,
    })
  },
  { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:14521' } },
)
```

BullMQ owns polling, ack, retries (`attempts: 3, backoff: exponential @ 500ms` — configured on the producer adapter), and graceful shutdown on SIGINT/SIGTERM.

**3. Three-terminal dev workflow** when you want the full path:

```sh
# Terminal 1 — DB + Redis
pnpm dev:up

# Terminal 2 — local consumer
pnpm dev:worker

# Terminal 3 — app
pnpm dev

# Optional — BullMQ dashboard at http://localhost:14504
pnpm queue:studio
```

To skip the queue path entirely (e.g. iterating on UI), blank out `REDIS_URL` and skip `pnpm dev:worker`; the producer falls through to `devLog`, the upload procedure logs `queue publish (devLog)`, and the image renders without a placeholder. Note the current posture: `.env.example` ships `REDIS_URL=redis://localhost:14521` pre-filled, so a freshly copied `.env` opts *into* the BullMQ adapter — skipping the queue path is an opt-out, not the opt-in this section originally described.

### Test setup

`VITEST === 'true'` is checked **first** in `getAdapter()`, so every test routes through `devLog` regardless of any other env. No broker is started; no worker runs; nothing crosses a process boundary. The contract test in `src/lib/effects/queue/queue.test.ts` asserts only that `publish` resolves without throwing — exactly the property the producer's `.catch()` blocks rely on at the call site. Handler tests live next to the handler and import it directly without involving the seam — `src/lib/queue/handlers/imageThumbnail.test.ts` is the existing example.

This matches the rest of the `effects/` namespace: tests prove the *contract*, not the transport.

---

## Swappability: Vercel Queues → Redis in production

On record because the swap was an explicit design goal: Vercel Queues was in public beta when this ADR landed (GA since — see the 2026-06-10 amendment), and we want a documented exit if pricing, quotas, or features force one.

**Producer side is trivial.** The selector checks `REDIS_URL` *before* the `!VERCEL` check, so setting `REDIS_URL` in Vercel env (pointing at a managed Redis — Upstash, Render, etc.) is all it takes for producers to route through `bullmqQueue` in production. No code changes.

**Consumer side is the real work.** Vercel Functions don't host long-lived workers, so a BullMQ worker has to live somewhere persistent — Fly.io, Railway, Render, a small VM — pointing at the same Redis. The Nitro plugin in `server/plugins/queueConsumer.ts` becomes dead code under this configuration (or stays in place during cutover; it's a few lines).

**What to budget when the swap happens:**
- One managed-Redis account (Upstash has a free tier covering our scale).
- One worker host (Fly.io free tier covers it; the worker process is small).
- Migrating any unprocessed Vercel Queues messages — in practice nothing: messages self-expire at the default 24 h retention (max 7 days), and blurhash/thumbnails are idempotent and recomputable, so unprocessed backlog can simply be left to expire.

**Revisit triggers** for actually pulling this lever:
- Per-operation billing (GA model — see the 2026-06-10 amendment) starts consuming a meaningful share of plan credits. Implausible at ~20 users, but it keeps the trigger measurable.
- We hit a quota wall we can't paper over.
- A topic appears that needs features Vercel Queues doesn't offer (priority lanes, delayed jobs, schedules, dead-letter introspection beyond the dashboard).

### Outbox is not dead, just dormant

A future durable effect (e.g. "user confirmed deletion → must email them within 24h, even if the request crashes mid-flight") would justify the outbox pattern *layered on top of* the queue: enqueue an outbox row inside the same DB transaction; a cron route drains it by calling `queue.publish`. The queue handles delivery + retries; the outbox handles "must commit atomically with the state change." That is a tier we'll add per-effect, not by default — the queue alone is enough for blurhash and everything currently on the horizon.

---

## Verification

After this ADR's pattern lands or is touched:

- `grep -rn "@vercel/queue" src/` — only `src/lib/effects/queue/adapters/vercelQueue.ts` should match.
- `grep -rn "from 'bullmq'" src/ scripts/` — only `src/lib/effects/queue/adapters/bullmqQueue.ts` and `scripts/devQueueWorker.ts` should match.
- `grep -rn "publish('blurhash" src/` — every producer-side hit must be an oRPC procedure file (currently `src/lib/orpc/procedures/image.ts` for avatars, `src/lib/orpc/procedures/document.ts` for documents); test files in `src/lib/effects/queue/` are also expected. No service, no auth hook, no React file.
- `grep -rn "publish('image_thumbnail" src/` — only `src/lib/orpc/procedures/document.ts` (plus the queue test). Its handler is `src/lib/queue/handlers/imageThumbnail.ts`.
- `grep -rn "vercel:queue" server/` — only `server/plugins/queueConsumer.ts` should match (no other hook subscribers).
- `pnpm test` — `src/lib/effects/queue/queue.test.ts` passes; selects the `devLog` adapter regardless of `REDIS_URL`.
- Manual smoke (dev, `REDIS_URL` unset + no worker): upload an avatar → 200; log shows `queue publish (devLog)`; avatar renders without a placeholder.
- Manual smoke (dev, `REDIS_URL` set + `pnpm dev:worker` running): upload an avatar → 200; within a few seconds the worker logs `blurhash: stored` followed by `job completed` (`scripts/devQueueWorker.ts`), and the user row gains a `blurhash`. Don't look for the job in Bull Studio (`:14504`) — the producer enqueues with `removeOnComplete: true` (`src/lib/effects/queue/adapters/bullmqQueue.ts`), so completed jobs vanish from Redis; only failed jobs (kept at 100 via `removeOnFail`) show up there.
- Manual smoke (preview deploy): upload an avatar in a preview URL → Vercel Runtime Logs show `queue publish` on the producer Function and `blurhash: stored` on the consumer Function.

---

## Critical files

- `src/lib/effects/queue/queue.ts` — `QueueEffects` interface, `QueueTopic`/`QueuePayloadMap` types, runtime adapter selector.
- `src/lib/effects/queue/adapters/vercelQueue.ts` — production adapter (`@vercel/queue` `send()`).
- `src/lib/effects/queue/adapters/bullmqQueue.ts` — local dev adapter (BullMQ `Queue` per topic).
- `src/lib/effects/queue/adapters/devLog.ts` — no-op adapter (tests + offline dev).
- `src/lib/effects/queue/queue.test.ts` — contract test.
- `src/lib/effects/index.ts` — re-exports `queue` alongside `email`, `storage`, `realtime`.
- `src/lib/queue/handlers/blurhash.ts` — shared consumer handler (`blurhash` topic).
- `src/lib/queue/handlers/imageThumbnail.ts` — shared consumer handler (`image_thumbnail` topic; ADR-0010).
- `src/lib/queue/handlers/emailUserInvited.ts` — shared consumer handler (`email_user_invited` topic; ADR-0017). Producer is Better Auth's `sendVerificationEmail` hook in `src/lib/auth.ts`, not an oRPC procedure.
- `server/plugins/queueConsumer.ts` — Vercel Queues consumer (Nitro `vercel:queue` hook).
- `scripts/devQueueWorker.ts` — local BullMQ consumer; run via `pnpm dev:worker`.
- `compose.yaml` — `queue` and `queue-studio` services.
- `vite.config.ts` — Nitro plugin registration + `vercel.config.queues.triggers`.
- `.env.example` — ships `REDIS_URL=redis://localhost:14521` pre-filled (opt-out posture: blank it to fall back to `devLog`).
- `src/lib/orpc/procedures/image.ts` (`confirmAvatarUpload`), `src/lib/orpc/procedures/document.ts` (`confirmDocumentUpload`) — current producer call sites.

---

## Consequences

**Positive**:
- CPU-heavy work moves off the request path; upload responses stay fast.
- Producer and consumer execute identical code in prod and dev — no "dev-only" branches in the handler.
- The seam is genuinely deep: three real adapters behind a one-method interface; tests prove the contract, not the transport.
- Swap to Redis-in-prod is unblocked at the producer layer; only the worker host is operational work.
- The `effects/` namespace stays the single seat for cross-system side effects (`email`, `storage`, `realtime`, `queue`) — ADR-0001's discipline is preserved.

**Negative**:
- End-to-end blurhash exercise in dev requires Docker + a second terminal — friction when you want to test the full flow.
- Vercel Queues is a single-vendor managed dependency (GA since the 2026-06-10 amendment, which retired the beta-SLA concern) — still bounded by the swap escape hatch.
- Adding a new topic touches five places: the `QueueTopic` / `QueuePayloadMap` union (`queue.ts`), a handler file, the Nitro plugin's `topicName` switch (`queueConsumer.ts`), a `vercel.config.queues.triggers` entry (`vite.config.ts`), and a dev-worker `Worker` (`devQueueWorker.ts`). Cheap, but not zero — and forgetting the trigger fails silently in prod.

**Revisit triggers** — re-open this ADR if any of these change:
- Vercel Queues' per-operation billing (see the 2026-06-10 amendment) grows to break the free-tier-first guideline — not plausible at ~20 users, but kept as the measurable restatement of the retired "exits beta with surprising pricing" trigger.
- A second topic needs cross-topic ordering, fan-out, or scheduling that the current shape doesn't model cleanly.
- A future effect genuinely needs DB-atomic enqueue (outbox layered on the queue, per "Outbox is not dead, just dormant").
- The worker bundle grows enough that the dev `tsx` script approach becomes a build issue.

---

## How to add a new topic

1. Extend the `QueueTopic` union in `src/lib/effects/queue/queue.ts` and add the payload shape to `QueuePayloadMap`.
2. Create `src/lib/queue/handlers/<topic>.ts` exporting `handle<Topic>Message(msg, metadata)`. Keep it idempotent — handler invariants from the blurhash example apply.
3. Wire the prod consumer — **two halves, both mandatory**: extend the `metadata.topicName` switch in `server/plugins/queueConsumer.ts` *and* add a `{ topic: '<topic>' }` entry to `vercel.config.queues.triggers` in `vite.config.ts`. Every topic needs its own trigger even when you only extend the existing switch (`image_thumbnail` is the precedent); a topic without a trigger is silently never delivered in prod — the publish succeeds and nothing consumes it.
4. Wire the dev consumer: add a `Worker` for the topic to the `workers` array in `scripts/devQueueWorker.ts` (already multi-topic).
5. Call `queue.publish('<topic>', payload)` from the oRPC procedure, after the service call succeeds, with `.catch()` for the fire-and-forget guarantee.
6. No producer test is required beyond the existing contract test; add a handler test next to the handler if its logic warrants one.

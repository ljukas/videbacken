# ADR 0007 — Background-Job Queue Architecture

- **Status**: Accepted
- **Date**: 2026-05-25
- **Deciders**: Lukas
- **Decision in one line**: Heavy / deferred work runs on a queue. Producers call `queue.publish(topic, payload)` through `~/lib/effects/queue/`; the same handler in `src/lib/queue/handlers/<topic>.ts` runs in production (Vercel Queues → Nitro `vercel:queue` hook) and in local dev (BullMQ + Redis worker). The adapter is chosen at runtime from env; tests use a `devLog` no-op. **Supersedes the tier-3 / outbox passages in [ADR-0001](./0001-side-effects-architecture.md).**

> **Amended 2026-09-29 — an awaited publish when the job *is* the outcome.** Fire-and-forget (`.catch()` + warn) stays the default for side jobs whose loss is cosmetic (`blurhash`, `heic_transcode`). The exception: when the queued job **is** the operation's user-visible result and the user can retry, the producer awaits `queue.publish` **without** `.catch()`, so a broker failure fails the request loudly instead of silently dropping the job. Today that's `invite` and `resendInvite` in `src/lib/orpc/procedures/user.ts` (`email_user_invited`). The allowlist row from `inviteUser` is already committed by then, which is fine: the invite shows as pending and the admin retries with Resend.

> **Amended 2026-09-29. Pruned to the current template.** References to features the template removed (documents and the `image_thumbnail` / `pdf_thumbnail` topics with their `imageThumbnail` handler, the `document` procedures, the `realtime` effect, a link to a nonexistent ADR) were removed or replaced with current examples (the `heic_transcode` and `email_integration_sync_alert` topics, `confirmAvatarUpload`). The trigger config path is corrected to `vercel.queues.triggers`. One verification rule was widened to match the code: the `publish('blurhash'` producer check (Verification) now also admits the `heic_transcode` handler, which re-enqueues `blurhash` after transcoding — previously only oRPC procedure files were allowed. No decision changed.

> **Amended 2026-09-28 — one dispatcher, one outcome line, bounded retries.** Both consumers now call `dispatchQueueMessage(topic, message, meta)` (`src/lib/queue/index.ts`, contract in `src/lib/queue/dispatch.ts`) instead of their own switch/`Worker` wiring. Handlers are entries in a typed `QueueHandlerTable` (`{ [T in QueueTopic]: QueueHandler<T> }`, so a topic without a handler is a compile error) and receive `{ meta, log }` — a child logger already scoped to topic/messageId/deliveryCount plus the handler's `logFields(msg)`. Outcomes: return → `ok`; `PermanentQueueError` → `dropped` (ack); any other throw → `retry` (rethrown) until `deliveryCount >= QUEUE_MAX_DELIVERIES` (**5**), then `dropped` / `exhausted` (ack); unknown topic → `dropped` / `unknown_topic` (ack, previously silently acked). Each message logs exactly one `queue message` line (`topic, messageId, deliveryCount, outcome, reason?, durationMs, …logFields, error?`), never the payload. Why: `@vercel/queue` has **no max-delivery count and no dead-letter queue** — a throwing handler was retried silently until the message expired (default 24 h) with nothing in our logs, while dev BullMQ gave up after 3 attempts; prod consumer failures were invisible. The BullMQ producer's `attempts` now uses the same `QUEUE_MAX_DELIVERIES`. Adding a topic is **three** steps (see *How to add a new topic*).

> **Amended 2026-06-24, corrected 2026-07-16.** A fourth topic landed: **`email_user_invited`** (`{ to, inviteUrl, locale }`) — the first **email** topic. It is published from the `invite` / `resendInvite` oRPC procedures (`src/lib/orpc/procedures/user.ts`) — an ordinary oRPC-procedure producer like the others, not a Better Auth hook (an earlier version of this note said the invitation flow ran through Better Auth's `sendVerificationEmail`; it doesn't — see ADR-0017) — making user invitations tier-3 (delivery off the admin's request, with retry/backoff). Handler: `src/lib/queue/handlers/emailUserInvited.ts` (a thin `email.sendUserInvited(...)` — the link is built by the producer's `buildInviteUrl()`, which returns a plain `/login` URL, not a minted magic-link). Wired through all five places per *How to add a new topic*: the union/payload in `queue.ts`, the handler, the `vercel:queue` switch (`queueConsumer.ts`), the `vite.config.ts` trigger, and the dev `Worker` (`devQueueWorker.ts`). See [ADR-0008](./0008-email-architecture.md) (the email seam) and [ADR-0017](./0017-authentication.md) (the invitation flow).

> **Amended 2026-06-10.** Vercel Queues re-verified: it is **GA**, no longer public beta. Billing is per operation, metered in 4 KiB chunks, across five operation types (Send / Receive / Delete / Visibility change / Notify); operations are regionally priced against plan credits; sends with an idempotency key and push deliveries with max concurrency bill at 2× for that operation; functions invoked in push mode are billed as normal Fluid compute. Default message retention is 24 h (max 7 days) — which *simplifies* the swap path documented below: unprocessed messages for recomputable jobs like blurhash self-expire, so there is nothing to migrate. At ~20 users our volume is trivially inside Hobby plan credits. The "exits beta with surprising pricing" revisit trigger is retired and restated in measurable terms below. Sources: [vercel.com/docs/queues](https://vercel.com/docs/queues), [vercel.com/docs/queues/pricing](https://vercel.com/docs/queues/pricing).

---

## Context

[ADR-0006](./0006-file-storage.md) put avatars and other user files in Vercel Blob. That created the need for a `<canvas>`-style placeholder while the real image loads — a [blurhash](https://blurha.sh). Generating one is **expensive**: `sharp` decodes the bytes, downscales, and hands a pixel buffer to `blurhash`'s encoder. On a 5 MB JPEG that's hundreds of milliseconds, sometimes seconds, and it loads two heavy native modules (`sharp` is ~30 MB on disk; `blurhash` is small but allocates). Doing it inline inside `confirmAvatarUpload` would:

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
| Local dev with broker (`REDIS_URL` set) | `bullmqQueue` | Redis (docker `compose.yaml` `queue` service) | `scripts/devQueueWorker.ts` (`bun run dev:worker`) |
| Local dev without broker | `devLog` (no-op) | — | — (uploads succeed; blurhash skipped) |
| Tests (`VITEST=true`) | `devLog` | — | — |

The producer interface lives at `~/lib/effects/queue/` (alongside `email`, `storage`, `zaptec`, `elpris`); the consumer handler lives at `~/lib/queue/handlers/<topic>.ts`. Both Vercel Queues and the dev BullMQ worker call the **same** handler function — the wire-up is the only thing that differs.

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
export type QueueTopic =
  | 'blurhash'
  | 'email_user_invited'
  | 'heic_transcode'
  | 'email_integration_sync_alert'

export type QueuePayloadMap = {
  blurhash: { fileId: string; kind: 'avatar'; userId: string }
  email_user_invited: { to: string; inviteUrl: string; locale: Locale } // ADR-0017
  heic_transcode: { fileId: string; kind: 'avatar'; userId: string }
  email_integration_sync_alert: { to: string; source: IntegrationSource; /* … */ } // ADR-0019
}

export interface QueueEffects {
  publish<T extends QueueTopic>(topic: T, payload: QueuePayloadMap[T]): Promise<void>
}
```

> **Amended 2026-06-04, superseded.** `blurhash` is the canonical example throughout this ADR. A second topic, `image_thumbnail`, landed for a since-removed document-management feature and was removed along with it; the other current topics are `email_user_invited` (see the 2026-06-24 amendment above), `heic_transcode` and `email_integration_sync_alert` (ADR-0019).

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

- **Per-topic payload typing.** The `kind` discriminant (today only `'avatar'`, kept so a second image-bearing producer can extend the union) lives in the producer's type, not deferred to the row in storage. The handler dispatches on `kind` without re-querying.
- **Bundle isolation.** BullMQ stays out of the production Nitro bundle; `@vercel/queue` stays out of the local `tsx` worker. Each runtime ships only the adapter it actually uses.
- **Fire-and-forget on failure.** Callers `.catch()` the publish so an upload still succeeds if the broker is briefly unavailable — the worst case is a missing blurhash, not a failed upload. (Exception: a job that *is* the operation's outcome is awaited without `.catch()` — see the 2026-09-29 amendment.)

Canonical producer call sites:

```ts
// `confirmAvatarUpload` — src/lib/orpc/procedures/image.ts
await queue
  .publish('blurhash', { fileId: newRow.id, kind: 'avatar', userId: context.user.id })
  .catch((error) => {
    context.log.warn('failed to enqueue avatar blurhash', { fileId: newRow.id, error })
  })

// Same procedure, HEIC branch — enqueues `heic_transcode` instead; that handler
// publishes `blurhash` itself once the JPEG exists.
await queue
  .publish('heic_transcode', { fileId: newRow.id, kind: 'avatar', userId: context.user.id })
  .catch((error) => { /* log and continue */ })
```

### The handler contract — `src/lib/queue/handlers/<topic>.ts`

Handlers are *consumer-side code* and deliberately live outside `~/lib/effects/queue/` (which is *producer-side*). Both prod and dev consumers reach them through the same dispatcher (`~/lib/queue`) — that shared call site is the whole point.

```ts
// src/lib/queue/handlers/blurhash.ts
export async function handleBlurhashMessage(
  msg: QueuePayloadMap['blurhash'],
  { log }: QueueHandlerContext, // { meta, log } — log is pre-scoped by the dispatcher
): Promise<void>

export const blurhashHandler: QueueHandler<'blurhash'> = {
  handle: handleBlurhashMessage,
  logFields: (msg) => ({ kind: msg.kind, fileId: msg.fileId }),
}
```

Retry semantics are signalled, not configured per handler: return to ack, throw to retry (bounded by `QUEUE_MAX_DELIVERIES`), throw `PermanentQueueError` to drop immediately. See `src/lib/queue/dispatch.ts`.

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
    queues: {
      triggers: [
        { topic: 'blurhash' },
        { topic: 'email_user_invited' },
        { topic: 'heic_transcode' },
        { topic: 'email_integration_sync_alert' },
      ],
    },
  },
})
```

And the plugin itself is a one-liner over the shared dispatcher:

```ts
// server/plugins/queueConsumer.ts
export default definePlugin((nitro) => {
  nitro.hooks.hook('vercel:queue', async ({ message, metadata }) => {
    await dispatchQueueMessage(metadata.topicName, message, {
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
    })
  })
})
```

Vercel Queues runs on Fluid Compute (same region, same OIDC auth) — no env-var wiring is required. Redelivery delay uses Vercel's default; the number of attempts is capped by the dispatcher (Vercel has no cap of its own). Observe runs in **Vercel Runtime Logs** — filter by msg `"queue message"`.

### Development setup

Two halves: a broker (docker) and a worker process (separate terminal). With `REDIS_URL` unset, dev falls back to the `devLog` adapter — uploads still work, blurhash just isn't generated, which is a fine default when you don't want the broker running.

**1. The broker** — `compose.yaml` declares two services:

```yaml
queue:
  image: redis:7.4-alpine
  ports: ["14621:6379"]
  command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]
  volumes: [redis_data:/data]
  healthcheck: { test: ["CMD", "redis-cli", "ping"], ... }

queue-studio:
  profiles: [studio]       # opt-in via `bun run queue:studio`
  image: emirce/bullstudio:1.4.0
  ports: ["14604:4000"]
  environment: { REDIS_URL: redis://queue:6379 }
```

AOF (`appendfsync everysec`) means queued jobs survive `docker compose down`. `queue-studio` is profile-gated so it doesn't auto-start with `bun run dev:up`; activate via `bun run queue:studio` and visit `http://localhost:14604`.

**2. The worker** — `scripts/devQueueWorker.ts` creates one BullMQ `Worker` per key of the handler table, each calling the same `dispatchQueueMessage` the prod plugin uses:

```ts
const workers = (Object.keys(queueHandlers) as QueueTopic[]).map(
  (topic) =>
    new Worker(topic, (job) =>
      dispatchQueueMessage(topic, job.data, {
        messageId: job.id ?? 'local-unknown',
        deliveryCount: job.attemptsMade + 1,
      }),
      { connection: { url } },
    ),
)
```

BullMQ owns polling, ack, redelivery (`attempts: QUEUE_MAX_DELIVERIES`, `backoff: exponential @ 500ms` — configured on the producer adapter), and graceful shutdown on SIGINT/SIGTERM. A new topic needs no worker change.

**3. Three-terminal dev workflow** when you want the full path:

```sh
# Terminal 1 — DB + Redis
bun run dev:up

# Terminal 2 — local consumer
bun run dev:worker

# Terminal 3 — app
bun run dev

# Optional — BullMQ dashboard at http://localhost:14604
bun run queue:studio
```

To skip the queue path entirely (e.g. iterating on UI), blank out `REDIS_URL` and skip `bun run dev:worker`; the producer falls through to `devLog`, the upload procedure logs `queue publish (devLog)`, and the image renders without a placeholder. Note the current posture: `.env.example` ships `REDIS_URL=redis://localhost:14621` pre-filled, so a freshly copied `.env` opts *into* the BullMQ adapter — skipping the queue path is an opt-out, not the opt-in this section originally described.

### Test setup

`VITEST === 'true'` is checked **first** in `getAdapter()`, so every test routes through `devLog` regardless of any other env. No broker is started; no worker runs; nothing crosses a process boundary. The contract test in `src/lib/effects/queue/queue.test.ts` asserts only that `publish` resolves without throwing — exactly the property the producer's `.catch()` blocks rely on at the call site. Handler tests live next to the handler and import it directly without involving the seam — `src/lib/queue/handlers/heicTranscode.test.ts` is the existing example. The dispatcher's retry/drop/log contract is tested once, through its interface, in `src/lib/queue/dispatch.test.ts`.

This matches the rest of the `effects/` namespace: tests prove the *contract*, not the transport.

---

## Swappability: Vercel Queues → Redis in production

On record because the swap was an explicit design goal: Vercel Queues was in public beta when this ADR landed (GA since — see the 2026-06-10 amendment), and we want a documented exit if pricing, quotas, or features force one.

**Producer side is trivial.** The selector checks `REDIS_URL` *before* the `!VERCEL` check, so setting `REDIS_URL` in Vercel env (pointing at a managed Redis — Upstash, Render, etc.) is all it takes for producers to route through `bullmqQueue` in production. No code changes.

**Consumer side is the real work.** Vercel Functions don't host long-lived workers, so a BullMQ worker has to live somewhere persistent — Fly.io, Railway, Render, a small VM — pointing at the same Redis. The Nitro plugin in `server/plugins/queueConsumer.ts` becomes dead code under this configuration (or stays in place during cutover; it's a few lines).

**What to budget when the swap happens:**
- One managed-Redis account (Upstash has a free tier covering our scale).
- One worker host (Fly.io free tier covers it; the worker process is small).
- Migrating any unprocessed Vercel Queues messages — in practice nothing: messages self-expire at the default 24 h retention (max 7 days), and blurhash/transcodes are idempotent and recomputable, so unprocessed backlog can simply be left to expire.

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
- `grep -rn "publish('blurhash" src/` — every producer-side hit must be an oRPC procedure file (currently `src/lib/orpc/procedures/image.ts` for avatars) or the `heic_transcode` handler (`src/lib/queue/handlers/heicTranscode.ts`, which re-enqueues after transcoding); test files in `src/lib/effects/queue/` are also expected. No service, no auth hook, no React file.
- `grep -rn "vercel:queue" server/` — only `server/plugins/queueConsumer.ts` should match (no other hook subscribers).
- `grep -rn "dispatchQueueMessage" server/ scripts/ src/` — only `src/lib/queue/index.ts`, `server/plugins/queueConsumer.ts` and `scripts/devQueueWorker.ts`; no consumer calls a handler directly.
- `bun run test` — `src/lib/effects/queue/queue.test.ts` passes; selects the `devLog` adapter regardless of `REDIS_URL`.
- Manual smoke (dev, `REDIS_URL` unset + no worker): upload an avatar → 200; log shows `queue publish (devLog)`; avatar renders without a placeholder.
- Manual smoke (dev, `REDIS_URL` set + `bun run dev:worker` running): upload an avatar → 200; within a few seconds the worker logs `blurhash: stored` followed by a `queue message` line with `outcome: "ok"`, and the user row gains a `blurhash`. Don't look for jobs in Bull Studio (`:14604`) — the producer enqueues with `removeOnComplete: true` (`src/lib/effects/queue/adapters/bullmqQueue.ts`), and the dispatcher acks a message once it is dropped (permanent or exhausted), so BullMQ records it as completed and it vanishes too. The `queue message` log line is the record of every outcome.
- Manual smoke (preview deploy): upload an avatar in a preview URL → Vercel Runtime Logs show `queue publish` on the producer Function and `blurhash: stored` on the consumer Function.

---

## Critical files

- `src/lib/effects/queue/queue.ts` — `QueueEffects` interface, `QueueTopic`/`QueuePayloadMap` types, runtime adapter selector.
- `src/lib/effects/queue/adapters/vercelQueue.ts` — production adapter (`@vercel/queue` `send()`).
- `src/lib/effects/queue/adapters/bullmqQueue.ts` — local dev adapter (BullMQ `Queue` per topic).
- `src/lib/effects/queue/adapters/devLog.ts` — no-op adapter (tests + offline dev).
- `src/lib/effects/queue/queue.test.ts` — contract test.
- `src/lib/effects/index.ts` — re-exports `queue` alongside `email`, `storage`, `zaptec`, `elpris`.
- `src/lib/queue/handlers/blurhash.ts` — shared consumer handler (`blurhash` topic).
- `src/lib/queue/handlers/heicTranscode.ts` — shared consumer handler (`heic_transcode` topic). Producer is `confirmAvatarUpload` (`src/lib/orpc/procedures/image.ts`).
- `src/lib/queue/handlers/emailIntegrationSyncAlert.ts` — shared consumer handler (`email_integration_sync_alert` topic; ADR-0019). Producer is `runPulledSync` (`src/lib/integrations/runPulledSync.ts`).
- `src/lib/queue/handlers/emailUserInvited.ts` — shared consumer handler (`email_user_invited` topic; ADR-0017). Producer is the `invite` / `resendInvite` oRPC procedures (`src/lib/orpc/procedures/user.ts`).
- `src/lib/queue/dispatch.ts` / `src/lib/queue/index.ts` — the dispatcher (handler contract, outcome log line, delivery cap) and the handler table both consumers use.
- `server/plugins/queueConsumer.ts` — Vercel Queues consumer (Nitro `vercel:queue` hook).
- `scripts/devQueueWorker.ts` — local BullMQ consumer; run via `bun run dev:worker`.
- `compose.yaml` — `queue` and `queue-studio` services.
- `vite.config.ts` — Nitro plugin registration + `vercel.queues.triggers`.
- `.env.example` — ships `REDIS_URL=redis://localhost:14621` pre-filled (opt-out posture: blank it to fall back to `devLog`).
- `src/lib/orpc/procedures/image.ts` (`confirmAvatarUpload`) — current image producer call site.

---

## Consequences

**Positive**:
- CPU-heavy work moves off the request path; upload responses stay fast.
- Producer and consumer execute identical code in prod and dev — no "dev-only" branches in the handler.
- The seam is genuinely deep: three real adapters behind a one-method interface; tests prove the contract, not the transport.
- Swap to Redis-in-prod is unblocked at the producer layer; only the worker host is operational work.
- The `effects/` namespace stays the single seat for cross-system side effects (`email`, `storage`, `queue`, `zaptec`, `elpris`) — ADR-0001's discipline is preserved.

**Negative**:
- End-to-end blurhash exercise in dev requires Docker + a second terminal — friction when you want to test the full flow.
- Vercel Queues is a single-vendor managed dependency (GA since the 2026-06-10 amendment, which retired the beta-SLA concern) — still bounded by the swap escape hatch.
- Adding a new topic touches three places: the `QueueTopic` / `QueuePayloadMap` union (`queue.ts`), a handler file + its `queueHandlers` entry (enforced by the compiler), and a `vercel.queues.triggers` entry (`vite.config.ts`). Forgetting the trigger still fails silently in prod.

**Revisit triggers** — re-open this ADR if any of these change:
- Vercel Queues' per-operation billing (see the 2026-06-10 amendment) grows to break the free-tier-first guideline — not plausible at ~20 users, but kept as the measurable restatement of the retired "exits beta with surprising pricing" trigger.
- A second topic needs cross-topic ordering, fan-out, or scheduling that the current shape doesn't model cleanly.
- A future effect genuinely needs DB-atomic enqueue (outbox layered on the queue, per "Outbox is not dead, just dormant").
- The worker bundle grows enough that the dev `tsx` script approach becomes a build issue.

---

## How to add a new topic

1. Extend the `QueueTopic` union in `src/lib/effects/queue/queue.ts` and add the payload shape to `QueuePayloadMap`.
2. Create `src/lib/queue/handlers/<topic>.ts` exporting `handle<Topic>Message(msg, ctx)` and a `<topic>Handler: QueueHandler<'<topic>'>` (with `logFields` for its identifiers — never the payload), then add it to `queueHandlers` in `src/lib/queue/index.ts` (the compiler insists). Keep it idempotent; throw to retry, throw `PermanentQueueError` when a retry can't help.
3. Add a `{ topic: '<topic>' }` entry to `vercel.queues.triggers` in `vite.config.ts` — **mandatory**: a topic without a trigger is silently never delivered in prod (the publish succeeds and nothing consumes it). The dev worker picks the topic up from the handler table automatically.

Then call `queue.publish('<topic>', payload)` from the producer, after the service call succeeds, with `.catch()` for the fire-and-forget guarantee. No producer test is required beyond the existing contract test; add a handler test next to the handler if its logic warrants one.

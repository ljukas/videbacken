# ADR 0004 — Realtime Sync Architecture

- **Status**: Accepted
- **Date**: 2026-05-21
- **Deciders**: Lukas
- **Decision in one line**: Push state changes to every authenticated tab through a typed `realtime` effect — oRPC mutation procedures call `realtime.publish(event)` after the service commit, a single SSE procedure forwards events to subscribers, and one per-tab `useRealtimeSync()` hook turns each event into a `queryClient.invalidateQueries({ queryKey: orpc.<namespace>.key() })`. The bus is an in-process `MemoryPublisher` because we run as a single Vercel function instance.

> **Amended 2026-06-10.** Adoption is no longer single-entity: seven namespaces publish (`user`, `season`, `presence`, `share`, `document`, `folder`, `bin` — see `src/lib/effects/realtime/types.ts`). Two design-level additions below: **[Dispatch granularity](#dispatch-granularity)** — the `switch` in `useRealtimeSync.ts`, not blanket `orpc.<namespace>.key()`, is the invalidation contract — and the **sanctioned non-mutation publish sites** under [Where to publish](#where-to-publish--in-the-procedure-after-the-service-call) (the SSE handler for `presence.changed`; the `image_thumbnail` queue handler). Stale specifics fixed in place.

---

## Context

Oceanview is a multi-user app (10–20 owners + admins) where most screens read shared state — the user roster, the season grid, share assignments, the document library; boat-week scheduling still to come. When one admin mutates state in one tab, every other tab that's currently viewing affected data needs to refetch within a small number of hundreds of milliseconds without anyone reloading the page. The existing data layer (oRPC + TanStack Query, [ADR-0002](./0002-service-domain-architecture.md)) already knows how to refetch — it just needs to be told *when*.

The **user** entity adopted first (`src/lib/orpc/procedures/user.ts`; `user.changed` was the only variant when this was written). As of 2026-06 seven namespaces publish — `user`, `season`, `presence`, `share`, `document`, `folder`, `bin` (`src/lib/effects/realtime/types.ts`) — and the pattern spread exactly as intended: writing this down set the shape so each new entity owner didn't reinvent the event name, the publish site, or the dispatch hook.

The behaviour is also subtly in tension with [ADR-0001](./0001-side-effects-architecture.md) ("skip in-process pub/sub"). That tension is real and worth reconciling once, in writing, so future readers don't relitigate the same trade-off every time another entity adopts the pattern.

---

## Decision (TL;DR)

Server-push invalidation, end-to-end:

1. **Publisher** — every oRPC mutation procedure calls `await realtime.publish({ kind: '<namespace>.changed', ids: [...] })` **after** the service mutation succeeds and after any sync-critical side effect (e.g. session revoke).
2. **Bus** — the `realtime` effect (`src/lib/effects/realtime/`) wraps `@orpc/experimental-publisher`'s `MemoryPublisher` on a single `'event'` channel. In-process, single-instance.
3. **SSE handler** — `protectedProcedure` `realtime.events` (`src/lib/orpc/procedures/realtime.ts`) is an `async function*` with `.output(eventIterator(realtimeEventSchema))` — that combination flips oRPC's `RPCHandler` into SSE-encoder mode. It forwards `realtime.subscribe({ signal, log: context.log })` to the client. `signal` is wired by oRPC to both client disconnect and function shutdown.
4. **Subscriber hook** — `useRealtimeSync()` (`src/hooks/useRealtimeSync.ts`) is mounted **once** in `src/routes/_authenticated.tsx`. It opens a single SSE stream, iterates events, and `switch`es on `event.kind` to `queryClient.invalidateQueries({ queryKey: orpc.<namespace>.key() })`. Reconnects with `exponential-backoff` (1s → 30s cap, ×2, full jitter, infinite attempts, stop on `UNAUTHORIZED`).
5. **Event schema** — `realtimeEventSchema` in `src/lib/effects/realtime/types.ts` is a discriminated union on `kind`. `kind` is always `<namespace>.changed` where `<namespace>` is the top-level `appRouter` key the client should invalidate. `ids` is optional metadata carrying discriminator values — record ids, or share codes (e.g. `'A'`) for `share.changed` — reserved for future fine-grained patching; coarse invalidation ignores them.
6. **Echo suppression** — a mutation publishes with `{ source: context.user.id }`. The SSE handler does **not** deliver an event back to the actor who caused it (`shouldDeliver(source, self)` in `src/lib/effects/realtime/realtime.ts`). The actor's own tab already updated itself locally via its mutation's `onSuccess` invalidation / optimistic write — realtime exists to propagate **other** actors' changes. `source` rides a server-internal envelope (`{ event, source }`), never the wire schema. Sourceless publishes (presence transitions, background jobs) broadcast to everyone, including the actor.

This keeps the **interface** small (two functions on the effect, one event schema), the **implementation** swappable (in-memory today; Postgres `LISTEN/NOTIFY` or Redis later if we ever multi-instance), and the **locality** intact (the procedure reads top-to-bottom: validate → service → publish; the hook reads top-to-bottom: open → dispatch → reconnect).

---

## Why not the obvious alternatives

### A. Polling
- ➖ Wastes bandwidth proportional to `tabs × queries × frequency`. With ~20 users on a free tier, this isn't a cost problem but it's a UX problem — either too slow (30s interval) or wasteful (3s).
- ➖ No fan-out signal; clients refetch even when nothing changed.
- ➖ Doesn't compose with TanStack Query's existing invalidation primitives — every query would need its own polling config.
- **Verdict**: rejected. Server-push is cheaper and lower-latency.

### B. WebSockets
- ➕ Bidirectional, well-understood.
- ➖ Bidirectional capacity we don't need — only the server pushes here.
- ➖ Doesn't ride plain HTTP cleanly through Vercel fluid compute; SSE does, and oRPC has first-class `eventIterator` support that produces SSE on the same `/api/rpc` mount point we already use for everything else.
- ➖ More moving parts (heartbeats, frame protocol, sticky sessions).
- **Verdict**: rejected. SSE is the cheaper match for a one-way fan-out.

### C. Per-record fine-grained patches (apply event payload → patch React Query cache directly)
- ➕ Avoids the refetch round-trip.
- ➖ Premature. Coarse `invalidateQueries({ queryKey: orpc.<namespace>.key() })` is correct until a query is heavy enough that the refetch hurts. Today no query is heavy enough.
- ➖ Requires the event to carry the full new shape, which fights against the "thin event, fat refetch" model and forces the publisher to know what every consumer needs.
- **Verdict**: deferred. `ids` is reserved in the schema for the day this becomes worth doing; until then, dispatch ignores it.

### D. External pub/sub broker (Redis, Postgres `LISTEN/NOTIFY`, Vercel Queues)
- ➕ Required if we ever run more than one Vercel function instance, because in-memory pub/sub doesn't fan out across processes.
- ➖ Today we run a single instance; the broker buys nothing. Adding it now is speculative complexity.
- **Verdict**: deferred until [Revisit triggers](#revisit-triggers) fire. When it lands, only `src/lib/effects/realtime/adapters/` gains a new adapter — publish/subscribe call sites don't change.

---

## Why this isn't the in-process pub/sub that ADR-0001 forbade

[ADR-0001](./0001-side-effects-architecture.md) rejects in-process event buses, with most of the argument resting on: "decoupling between code units in the same monorepo is cosmetic", "fire-and-forget on Vercel is unsafe", "no durability". That all still applies — to the case ADR-0001 was about, which is *code-to-code decoupling inside one request lifecycle*. The textbook example: `user.deleted` fires → an `auditLog` listener and an `emailWelcomeAdmin` listener both run. ADR-0001's answer is: don't; call them directly from the procedure, behind the typed `effects/` seam.

Realtime sync is a different problem:

| Trait | ADR-0001's rejected pub/sub | Realtime sync |
|---|---|---|
| Producer and consumer in the same request lifecycle? | Yes — same call stack. | No — producer is a mutation request, consumer is a long-running SSE request held by a different tab (often a different user). |
| Number of consumers? | Almost always one. | One per open authenticated tab — genuinely N, and N grows with the user count. |
| Listener registration spread across the codebase? | Yes — that's the "hidden control flow" complaint. | No — exactly one subscriber type (`useRealtimeSync`), exactly one dispatch site. |
| Durability needed? | Sometimes — addressed by the outbox tier. | No — events lost across a disconnect are reconstructed by the next route observe (TanStack Query refetches stale queries automatically). |
| "Decoupling" benefit? | Cosmetic. | Real — the publisher can't call into the SSE response stream directly; pub/sub is the actual mechanism that decouples one request from another. |

So: ADR-0001 rejects pub/sub *between code units inside one process call stack*. Realtime sync uses pub/sub *between distinct request lifecycles inside one process*. Same word, different problem. The seam is genuine here in a way it isn't in ADR-0001's territory.

Since this was written, ADR-0001's **2026-06-04 amendment** formally sanctions `realtime` (and `presence`) as in-process effects under the same seam — the tension-resolution argued above is now codified on both sides.

---

## Architecture

### Three roles

```
┌─ tab A (admin) ──────┐                                       ┌─ tab B (user) ───────┐
│ mutation request     │                                       │ SSE request          │
│   procedure.update() │                                       │   procedure.events() │
│     userService.x()  │                                       │     subscribe()      │
│     realtime.publish ├──► MemoryPublisher (channel='event') ─┤     yield event      │
└──────────────────────┘                                       │     ...              │
                                                               │   useRealtimeSync    │
                                                               │     dispatch(event)  │
                                                               │     invalidateQueries│
                                                               │     refetch route    │
                                                               └──────────────────────┘
```

**Publisher** — oRPC mutation procedures. They already own the orchestration (validate → service → side effects); `realtime.publish(...)` is the last step.

**Bus** — `src/lib/effects/realtime/` (the `realtime` effect). Owns the in-memory publisher and the typed event schema. Two functions on the interface (`publish`, `subscribe`), one channel, one discriminated-union event type.

**Subscriber** — the SSE procedure on the server forwards events to a single `useRealtimeSync()` hook in the browser. The hook is mounted in `src/routes/_authenticated.tsx` so the connection lives for the entire authenticated session. The hook does **all** dispatch in one `switch` over `event.kind`.

### Where to publish — in the procedure, after the service call

A procedure that mutates state ends with the realtime publish:

```ts
update: adminProcedure
  .input(userInputSchema.extend({ id: z.uuid() }))
  .handler(async ({ input, context }) => {
    try {
      const updated = await userService.updateAsAdmin(context.user.id, input.id, { ... })
      context.log.info('admin updated user', { targetId: input.id, role: input.role })
      await realtime.publish({ kind: 'user.changed', ids: [updated.id] }, { source: context.user.id })
      return updated
    } catch (err) {
      rethrowAsORPC(err, 'update')
    }
  }),
```

Rules:
- Publish **after** the service call returns successfully — never before, never inside the service. Services are DB-only ([ADR-0002](./0002-service-domain-architecture.md)) and must not import the `realtime` effect.
- Publish **after** any sync-critical side effect that must succeed before clients see the change (the canonical example is `user.delete`'s revoke-then-publish ordering: `auth.api.revokeUserSessions` runs before the `user.changed` publish).
- Publish on **every** state-changing mutation for an opted-in entity, including create, update, delete, restore. Missing one publish means every client sees stale data until they navigate.
- Pass `{ source: context.user.id }` from mutation procedures so the actor's own tab isn't double-invalidated (see [Echo suppression](#echo-suppression)). Omit `source` **only** for broadcast-to-all publishes where there is no single acting user or every client (incl. the actor) must receive it: the two `presence.changed` publishes in the SSE handler, and the background thumbnail job (`src/lib/queue/handlers/imageThumbnail.ts`) — the uploader depends on that later echo to surface `thumbnailPathname`.
- **Sanctioned exceptions to "publish from mutation procedures":** the SSE handler itself (`realtime.events` in `src/lib/orpc/procedures/realtime.ts`) is the one publish site for `presence.changed` — presence state *is* the SSE subscription state, so there is no DB mutation to attach it to (the handler's own comment records this). The `image_thumbnail` queue handler publishes a sourceless `document.changed` once the rendered thumbnail is stored. The `blurhash` queue handler deliberately publishes **nothing** — blurhash is progressive enhancement, picked up on the next natural refetch rather than forcing one.

### Where to subscribe — once per authenticated tab

```ts
// src/routes/_authenticated.tsx
function AuthenticatedLayout() {
  useRealtimeSync()
  // ... layout shell
}
```

Rules:
- Exactly one `useRealtimeSync()` mount, in `_authenticated.tsx`. Don't add per-route subscriptions — one stream per tab is the contract.
- Public routes (`/login`, the auth callback) do **not** subscribe.
- The hook owns the reconnect loop; consumers never reach for the raw `client.realtime.events(...)` call.

### Event schema rules

```ts
// src/lib/effects/realtime/types.ts
export const realtimeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user.changed'), ids: z.array(z.string()).optional() }),
  // …season / presence / document / folder / share / bin variants elided —
  // see the file. Add per-entity variants here as they adopt.
])
```

- `kind` is always `<namespace>.changed`, where `<namespace>` is the top-level `appRouter` key the client should invalidate. Today seven variants exist (`user` / `season` / `presence` / `share` / `document` / `folder` / `bin`). A future entity follows the same shape: `booking.changed` → `orpc.booking.key()`. What "invalidate" means per event is defined by the dispatch switch — see [Dispatch granularity](#dispatch-granularity).
- `ids` carries discriminator values, not a payload — record ids for most namespaces, share codes (e.g. `'A'`) for `share.changed`. Coarse invalidation ignores them; the field exists so a future fine-grained variant can patch the cache without a schema break.
- One variant per entity is the default. Don't pre-split into `user.created` / `user.updated` / `user.deleted` — the client doesn't care which mutation happened, only that the namespace is dirty.
- **Compound publishes are fine when one mutation dirties more than one namespace.** A procedure may publish several events in sequence. `src/lib/orpc/procedures/folder.ts` does this: a folder rename/move/soft-delete/restore publishes both `folder.changed` *and* `document.changed`, because folder path changes flow into the denormalized document search haystack and a folder cascade soft-deletes its documents. The rule is still "thin event, fat refetch" per namespace — just emit one per dirtied namespace. The schema also carries cross-namespace coupling the other direction: `share.changed` is dispatched in the hook to invalidate both `orpc.share` and `orpc.user.listContacts`.
- **`bin.changed` is published only by mutations that move an item in or out of the admin bin** — soft-delete document/folder (enter), restore document/folder and hard-delete document (leave). These publish it *alongside* their `document.changed` / `folder.changed`. Crucially, upload / rename / move publish `document.changed` *without* `bin.changed`, so unrelated document edits don't mark the bin query stale. This is why the bin has its own event rather than piggybacking on `document.changed`.

### Dispatch granularity

"Invalidate the namespace" does **not** always mean blanket `orpc.<namespace>.key()`. The `switch` in `useRealtimeSync.ts` is the invalidation contract: each `case` decides which query keys an event dirties, and a case may narrow to sub-namespace keys or fan out to extra namespaces. The comment on each `case` documents *why* — treat it as part of the contract, not decoration. Three worked examples, all live in the switch today:

- **`document.changed`** invalidates `orpc.document.listDocuments`, `orpc.document.documentHistory`, and `orpc.documentSearch` — deliberately **not** `document.thumbnail`. Thumbnails are served from stable public URLs; refetching them would reload every tile. A newly rendered thumbnail is picked up naturally: the list refetch surfaces `thumbnailPathname`, which enables the tile's first thumbnail fetch. (The `documentSearch` coupling was added 2026-06-10 — uploads/renames/deletes add, rewrite, or remove search haystacks, so an open search palette must refetch too.)
- **`folder.changed`** fans out to `orpc.folder` plus `orpc.document.listDocuments`, `orpc.document.documentHistory`, and `orpc.documentSearch` — a folder change rewrites descendant paths and document haystacks, so document lists and search results shift. Thumbnails stay untouched for the same reason as above.
- **`share.changed`** invalidates `orpc.share` *and* `orpc.user.listContacts` — the Delägare table renders owned shares, so it must stay in sync with share assignments.

Blanket `key()` is the right default for a new entity; narrow or widen only with a reason, and write that reason as the `case` comment.

### Echo suppression

A mutation invalidates the actor's own tab twice without this: once via the mutation's local `onSuccess`/optimistic write, and again when the SSE stream echoes the same `<namespace>.changed` event back to the tab that caused it. The two near-simultaneous `invalidateQueries` calls race on the same key, and `invalidateQueries`' default `cancelRefetch: true` aborts the in-flight refetch — visible as a storm of `(canceled)` requests during e.g. a batch upload. It's also redundant work: realtime's job is to sync **other** actors' changes, not our own.

So the SSE handler suppresses self-echo. `source` rides a server-internal envelope (`RealtimeEnvelope = { event: RealtimeEvent; source?: string }`), not `realtimeEventSchema` — keeping a user id off the wire and the suppression policy out of the client. The handler reads its own `self = context.user.id` and yields only when `shouldDeliver(source, self)` (`src/lib/effects/realtime/realtime.ts`): deliver if `source` is undefined (broadcast) or differs from `self`.

```ts
const self = context.user.id
for await (const { event, source } of realtime.subscribe({ signal, log })) {
  if (shouldDeliver(source, self)) yield event
}
```

Granularity is **user-level** (not per-tab): `context.user.id` is already available on both the publish and subscribe sides, so no per-tab id / header plumbing is needed. This is safe because every mutation already refreshes the actor's own view locally (the convention in `src/lib/orpc/optimistic.ts`: realtime is a *second* safety net, not the primary updater).

### Why this is a deep module

In the architecture skill's vocabulary:

- **Interface** — two functions on `RealtimeEffects` (`publish(event, opts?: { source? })`, `subscribe(args: { signal?: AbortSignal; log: Logger }): AsyncIterable<RealtimeEnvelope>`) plus the typed event schema and the `shouldDeliver` policy helper. Stable; new entities extend the schema's discriminated union, not the interface.
- **Implementation** — `MemoryPublisher` channel routing, SSE encoding via `eventIterator`, `AbortSignal` teardown on disconnect and shutdown, reconnect-with-backoff and full jitter, coarse invalidation policy in the browser hook. All hidden.
- **Two seams** — the `RealtimeEffects` interface (real seam: in-memory today, broker-backed adapter tomorrow if multi-instance lands) and the event-schema enum (one variant per opted-in namespace).
- **Test surface = the interface** — `realtime.test.ts` exercises publish/subscribe/abort against the real `MemoryPublisher`. No mocks. The deletion test passes: removing this module would re-scatter `MemoryPublisher`, the SSE handler, the schema, the dispatch switch, and the reconnect loop across every entity's procedures and routes.

---

## Operational constraints

### Single-instance Vercel fluid compute

The in-memory `MemoryPublisher` works **only** because publisher and subscriber are in the same Node process. Vercel's fluid compute keeps a single instance warm under our load profile, so a mutation in tab A and the SSE handler serving tab B run inside the same process. If we ever scale to >1 instance — explicit horizontal scaling, region failover, or anything else that splits the process pool — events published on one instance are invisible to subscribers on others. That's a revisit trigger, not a current concern. The migration when it lands is: write a new adapter (Postgres `LISTEN/NOTIFY` is the cheapest first step — no new vendor) and point `realtime` at it. Publish and subscribe call sites don't change.

> The **presence** subsystem ([ADR-0011](./0011-presence-online-status-architecture.md)) rides this same bus and shares this exact assumption: its `presence.changed` variant is published from this ADR's SSE procedure on the `0→1` / `1→0` connection transitions, and its refcount store is in-process for the same reason `MemoryPublisher` is. When this single-instance assumption is broken, realtime and presence migrate to a distributed adapter together.

### Reconnection

The browser hook uses `exponential-backoff` with: starting delay 1s, ×2 multiplier, max delay 30s, full jitter, infinite attempts. Two reasons to stop the retry loop:
- The `AbortController` is aborted by the hook's cleanup (component unmount, logout).
- The server returns `UNAUTHORIZED` (the session expired or was revoked) — logged at `error` level and not retried.

All other failures (network drop, server restart, function cold-restart between deploys) retry until the next attempt succeeds. The reconnect is intentionally noisy at `warn` level in the browser logger so client crashes mid-stream show up in `/api/log`.

### Shutdown teardown

The server handler is `async function*`. oRPC wires `signal` to two sources: client disconnect (TCP RST or `AbortController` from the browser) and function shutdown (Vercel sending SIGTERM during a deploy). The handler's `try/finally` logs both ends:

```ts
context.log.info('realtime subscriber connected')
try {
  for await (const event of realtime.subscribe({ signal, log: context.log })) {
    yield event
  }
} finally {
  context.log.info('realtime subscriber disconnected')
}
```

### No durability — and that's fine

If a client disconnects, every event published during the gap is dropped. That's deliberate. TanStack Query's default behaviour refetches stale queries on the next observation (route mount, window focus). So the worst case from a missed event is: a user opens the route a second later than they would have, and the data is up-to-date by the time they look. No replay log needed.

This is the same reason no outbox tier (per [ADR-0001](./0001-side-effects-architecture.md)) is necessary here — there's no durability requirement to satisfy.

---

## How to add a new event kind

When an entity (e.g. a future `booking`) needs realtime sync:

1. **Extend the schema.** Add a variant to `realtimeEventSchema` in `src/lib/effects/realtime/types.ts`:
   ```ts
   z.object({ kind: z.literal('booking.changed'), ids: z.array(z.string()).optional() }),
   ```
   The `kind` literal must be `<namespace>.changed`, where `<namespace>` matches the top-level `appRouter` key.

2. **Add a dispatch case.** Extend the `switch` in `src/hooks/useRealtimeSync.ts`:
   ```ts
   case 'booking.changed':
     void queryClient.invalidateQueries({ queryKey: orpc.booking.key() })
     return
   ```
   Blanket `key()` is the default; narrow to sub-namespace keys or add extra namespaces only with a reason, written as the `case` comment (see [Dispatch granularity](#dispatch-granularity)).

3. **Publish from every mutation procedure** for that entity (`src/lib/orpc/procedures/booking.ts`):
   ```ts
   await realtime.publish({ kind: 'booking.changed', ids: [/* affected ids */] }, { source: context.user.id })
   ```
   After the service call returns. After any sync-critical side effect. Before returning to the caller. Pass `{ source: context.user.id }` so the actor's own tab isn't double-invalidated — omit it only for broadcast-to-all publishes (see [Echo suppression](#echo-suppression)).

4. **No DB, no migration, no schema.ts change.** The bus is in-memory; the channel is shared across all event kinds; the discriminated union does all the type-routing.

That's the whole recipe. No new files in `effects/realtime/`. No changes to the SSE handler. No changes to `_authenticated.tsx`.

---

## Critical files

- `src/lib/effects/realtime/realtime.ts` — `RealtimeEffects` interface, `realtime` export.
- `src/lib/effects/realtime/types.ts` — `realtimeEventSchema` discriminated union. **Extend here for new event kinds.**
- `src/lib/effects/realtime/adapters/inMemory.ts` — `MemoryPublisher` adapter on the `'event'` channel.
- `src/lib/effects/realtime/realtime.test.ts` — interface contract tests against the real `MemoryPublisher`.
- `src/lib/orpc/procedures/realtime.ts` — SSE handler (`realtime.events`).
- `src/lib/orpc/procedures/<entity>.ts` — publish sites (the publishes in `user.create` / `user.update` / `user.delete` / `user.restore` in `procedures/user.ts` are the canonical pattern).
- `src/lib/orpc/router.ts` — registers `realtime: realtimeRouter`.
- `src/hooks/useRealtimeSync.ts` — browser subscriber + dispatch + reconnect loop. **Extend the `switch` here for new event kinds.**
- `src/routes/_authenticated.tsx` — the single `useRealtimeSync()` mount.

---

## Verification

Adding a new event kind is correctly wired when:

- The new variant compiles cleanly in `realtimeEventSchema` — TypeScript narrows the `switch` and forces the new `case` in `useRealtimeSync`'s dispatch.
- `pnpm test` passes — no test change is required for new event kinds; the existing `realtime.test.ts` covers the publisher contract.
- Grep `src/lib/orpc/procedures/<entity>.ts` for every mutation handler — each one ends with `await realtime.publish({ kind: '<namespace>.changed', ids: [...] })`.
- `pnpm dev`, open the app in two tabs as an admin, mutate the entity in tab A — tab B's affected route refetches within a few hundred milliseconds with no manual reload.
- Disconnect the network on tab B briefly, then restore — the browser console logs `realtime connection lost` (warn) and `realtime subscription opened` (info); the next mutation propagates.

Drift checks for this ADR itself:
- Grep `'.changed'` across `src/lib/effects/realtime/types.ts`, `src/hooks/useRealtimeSync.ts`, and `src/lib/orpc/procedures/` — counts must agree (one schema variant ↔ one dispatch case ↔ one or more publish sites).
- Grep `src/lib/services/` for `realtime` — must return zero hits (services don't publish).
- Grep `src/routes/` for `useRealtimeSync` — must return exactly one hit, in `_authenticated.tsx`.

---

## Consequences

**Positive**
- Mutations in one tab become visible in every other authenticated tab within a few hundred milliseconds, with no client-side work per route.
- One named seat for the entire realtime pipeline — schema, bus, SSE handler, hook all colocated.
- New entities adopt in ~5 lines of code (schema variant + dispatch case + publish calls).
- The interface stays small: `publish` / `subscribe` plus the schema. The implementation can be swapped (e.g. Postgres `LISTEN/NOTIFY`) without touching any call site.

**Negative**
- Hard dependency on single-instance deployment. The day we scale horizontally, the in-memory adapter has to be replaced before realtime sync survives.
- Coarse invalidation can over-refetch when a screen displays unrelated rows from the same namespace. Acceptable today; revisit per-query if a refetch turns expensive.
- No durability — disconnected clients miss intermediate events. Recovered automatically by TanStack Query's stale-query refetch, but worth knowing.
- Echo suppression is user-level: a second tab opened by the **same** user no longer gets an instant realtime push from the first tab's mutations. It resyncs on window focus (`refetchOnWindowFocus`, default on) or `staleTime` expiry instead. Acceptable for a 10–20 user app; revisit if same-user multi-tab live-sync becomes a real need (the fix is per-tab `source` granularity, which adds a per-tab id + header).

---

## Revisit triggers

Re-open this ADR if any of these change:

- We run more than one Vercel function instance — explicit horizontal scaling, multi-region, sticky-session failover, anything that splits the process pool. The in-memory bus stops working at that point; swap in a Postgres `LISTEN/NOTIFY` or Redis adapter.
- A single query becomes expensive enough that coarse `invalidateQueries({ queryKey: orpc.<namespace>.key() })` causes a noticeable latency or load spike. Then the `ids` field starts earning its keep — dispatch reads it and patches specific entries instead of invalidating the whole namespace.
- An event needs to survive a client disconnect (e.g. "user must see this notification even if their tab was closed when it fired"). That's an outbox-tier problem ([ADR-0001](./0001-side-effects-architecture.md)), not a realtime-sync problem; the right answer is a durable side effect plus a per-user inbox query, not retrofitting durability onto this pipeline.
- The free tier of an external broker (Vercel Queues, Upstash Redis) starts looking cheaper than maintaining the in-memory + outbox split. Then the broker absorbs both responsibilities.

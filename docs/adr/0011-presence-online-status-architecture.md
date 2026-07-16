# ADR 0011 — Presence / Online-Status Architecture

- **Status**: Accepted
- **Date**: 2026-06-04
- **Deciders**: Lukas
- **Decision in one line**: Track who is online with a typed `presence` effect that is reference-counted off the SSE connection lifecycle — the realtime subscription procedure calls `presence.acquire(userId)` on connect and `presence.release(userId)` on disconnect, publishes a `presence.changed` realtime event only on the `0→1` and `1→0` transitions, and a single `presenceRouter.listOnline` read model feeds green "Ansluten" dots in the UI. The store is an in-process refcount `Map`, single-instance like the realtime bus it rides on.

---

## Context

[ADR-0004](./0004-realtime-sync-architecture.md) gave every authenticated tab a single SSE stream and an in-process `MemoryPublisher`. Presence is the natural companion feature: a co-ownership group of 10–20 people wants to see who else is currently looking at the boat's data — a green dot next to each owner in the owners list.

"Who is online" maps cleanly onto the realtime connection that already exists: **a user is online exactly while they hold at least one open SSE subscription**. No separate heartbeat, no polling, no `last_seen` column — the connection *is* the signal. The only wrinkle is multiple tabs: one user with three tabs opens three SSE streams, and we don't want three "user came online" broadcasts (nor a premature "went offline" when they close one of three). That is a **reference count**, and refcounting is the entire substance of this subsystem.

Presence is tightly coupled to ADR-0004 (it publishes through the same bus, depends on the same single-instance assumption) but is a **distinct concern**: its own typed effect, its own adapter seam, its own transition semantics, and its own read model. It earns a first-class ADR rather than a footnote in ADR-0004 — the same call already recorded when this was tracked as ADR debt (the `docs/adr-debt/` tracker has since been removed; this ADR superseded its only entry).

This ADR documents the subsystem as it ships today.

---

## Decision (TL;DR)

A typed **`presence` effect** (`src/lib/effects/presence/`) tracks online users by reference count, driven by the SSE lifecycle:

1. **Producer** — the realtime SSE procedure (`src/lib/orpc/procedures/realtime.ts`) calls `await presence.acquire(context.user.id)` when a subscription opens and `await presence.release(context.user.id)` in a `finally` when it closes (disconnect, navigation, or function shutdown).
2. **Transition-gated broadcast** — `acquire` returns `true` only on the `0→1` transition (user's *first* tab); `release` returns `true` only on the `1→0` transition (user's *last* tab). The procedure publishes `realtime.publish({ kind: 'presence.changed' })` **only when the boolean is true**. Intermediate tabs are silent.
3. **Read model** — `presenceRouter.listOnline` (`protectedProcedure`) returns `string[]` of online user IDs.
4. **Subscriber** — `useRealtimeSync` dispatches `presence.changed` → `queryClient.invalidateQueries({ queryKey: orpc.presence.key() })`. Consumers refetch `listOnline`, build a `Set`, and render a badge.
5. **Adapter** — `inMemoryPresence`, a module-singleton `Map<userId, number>`. In-process, single-instance, ephemeral. The interface is `async` so a future distributed adapter (Postgres `LISTEN/NOTIFY`, Redis) slots in without touching call sites.

```
tab A opens ─► realtime.events generator
              presence.acquire(A) ─► 0→1 = true ─► realtime.publish('presence.changed')
                                                       │ (in-process MemoryPublisher)
              other tabs' useRealtimeSync ◄────────────┘
              dispatch('presence.changed') ─► invalidate orpc.presence
              listOnline() ─► ['A', …] ─► <AvatarBadge> "Ansluten" lights up on A

tab A closes ─► generator finally
               presence.release(A) ─► 1→0 = true ─► publish('presence.changed') ─► dot clears
               (if A still has another tab open: 2→1 = false ─► no publish, dot stays)
```

This keeps the **interface** tiny (three functions), the **broadcast** quiet (one event per real transition, not per tab), and the **schema** coarse (the event carries no payload — clients refetch the snapshot).

---

## Why not the obvious alternatives

### A. A `last_seen` / `online` column updated by a heartbeat
- ➕ Survives multi-instance and restarts.
- ➖ Write amplification: every tab pinging every N seconds is a steady stream of `UPDATE`s for a 10–20 user app that mostly sits idle. Needs a cron/TTL sweep to expire stale rows (Vercel Hobby cron is 1/day — wrong tool, same problem ADR-0007 hit).
- ➖ Heartbeat presence is *approximate* ("seen in the last 30s"); the SSE connection is *exact* ("subscribed right now") and we already pay for the connection.
- **Verdict**: don't. The connection is a better signal than a timer, for free.

### B. Carry the changed user's `id` on the event / patch the cache fine-grained
- ➖ Premature. `presence.changed` with no payload + a full `listOnline()` refetch is trivially cheap at this scale (the response is a short array of IDs). Adding `ids` would force the publisher to know what each consumer caches and fight the "thin event, fat refetch" model ADR-0004 chose deliberately.
- **Verdict**: coarse invalidation, consistent with ADR-0004. Revisit only if `listOnline` ever gets expensive (it won't at 20 users).

### C. Fold presence into ADR-0004 (no separate effect)
- ➖ Presence has its own interface (`acquire`/`release`/`listOnline`), its own adapter, refcount/transition semantics, and a read-model procedure. Inlining the refcount into the SSE handler would bury real logic in a generator and make it untestable in isolation.
- **Verdict**: separate `presence` effect, separate ADR. It *uses* the realtime bus; it isn't *part* of it.

### D. "Last active" / away states (idle detection)
- ➖ A different feature. This subsystem answers "is a live connection open right now," not "was active in the last 5 minutes" or "tab is backgrounded." Idle/away detection would need client-side activity tracking and a richer state than a boolean.
- **Verdict**: out of scope. If wanted later, it's a revisit trigger, not a tweak.

---

## Architecture

### The effect interface — `src/lib/effects/presence/presence.ts`

```ts
export interface PresenceEffects {
  // Returns true iff the user transitioned offline → online (refcount 0 → 1).
  acquire(userId: string): Promise<boolean>
  // Returns true iff the user transitioned online → offline (refcount 1 → 0).
  release(userId: string): Promise<boolean>
  listOnline(): Promise<string[]>
}

export const presence: PresenceEffects = inMemoryPresence
```

It sits under `src/lib/effects/` alongside `email`, `storage`, `queue`, and `realtime`, and is re-exported from the effects barrel (`src/lib/effects/index.ts`). Like `realtime`, it is an **in-process effect** — it owns in-process state rather than an outside-world system (the "effects own the outside world" framing in [ADR-0001](./0001-side-effects-architecture.md) was amended 2026-06-04 to admit this second category).

### The adapter — `src/lib/effects/presence/adapters/inMemory.ts`

```ts
export function createInMemoryPresence(): PresenceEffects {
  const refCounts = new Map<string, number>()
  return {
    async acquire(userId) {
      const prev = refCounts.get(userId) ?? 0
      refCounts.set(userId, prev + 1)
      return prev === 0
    },
    async release(userId) {
      const prev = refCounts.get(userId) ?? 0
      if (prev <= 1) {
        refCounts.delete(userId)
        return prev === 1
      }
      refCounts.set(userId, prev - 1)
      return false
    },
    async listOnline() {
      return Array.from(refCounts.keys())
    },
  }
}

export const inMemoryPresence = createInMemoryPresence()
```

Properties that matter:

- **Refcount, not a boolean.** `Map<userId, number>` counts open subscriptions per user. The *transition* (`prev === 0` on acquire, `prev === 1` on release) is what gates the broadcast — this is the multi-tab fix.
- **Negative-safe and self-cleaning.** `release` on an unknown user (`prev === 0`) is a no-op returning `false`; at `prev <= 1` the key is deleted, so `listOnline` never reports a user at count 0 and counts can't drift negative.
- **`async` despite running synchronously.** The interface is a `Promise` contract on purpose: it is the seam where a distributed adapter (Postgres `LISTEN/NOTIFY` or Redis `SADD`/`SREM` with per-connection members) drops in for multi-instance without changing the SSE procedure or the read model.
- **Module-singleton.** Exactly one `Map` per process, shared by every SSE handler — the same in-process sharing the realtime `MemoryPublisher` relies on.
- **No TTL, no heartbeat, no logging, no imports** from other effects/services. Purely connect/disconnect refcounting.

### The producer — `src/lib/orpc/procedures/realtime.ts`

The SSE subscription generator owns both ends of the lifecycle (comments elided; the `shouldDeliver(source, self)` filter is ADR-0004's self-echo suppression, not presence):

```ts
events: protectedProcedure
  .route({ method: 'GET' })
  .output(eventIterator(realtimeEventSchema))
  .handler(async function* ({ context, signal }) {
    context.log.info('realtime subscriber connected')
    const self = context.user.id
    const becameOnline = await presence.acquire(self)
    try {
      if (becameOnline) await realtime.publish({ kind: 'presence.changed' })
      for await (const { event, source } of realtime.subscribe({ signal, log: context.log })) {
        if (shouldDeliver(source, self)) yield event
      }
    } finally {
      const becameOffline = await presence.release(self)
      if (becameOffline) await realtime.publish({ kind: 'presence.changed' })
      context.log.info('realtime subscriber disconnected')
    }
  })
```

The `try`/`finally` pairing is the correctness anchor, and the invariant is precise: **`release` runs iff `acquire` ran.** `acquire` is the last statement before the `try`; everything that can fail afterwards — including the post-`acquire` `presence.changed` publish — sits inside the `try`, so any exit path (client disconnect, network drop firing the `AbortSignal`, graceful function shutdown, or a throwing publish) reaches the `finally` and balances the refcount. Presence is therefore as reliable as the SSE teardown ADR-0004 already guarantees.

*(2026-06-10: the post-`acquire` publish originally ran between `acquire` and the `try`. A throw there — impossible with today's in-process `MemoryPublisher`, possible with a future distributed adapter — would have skipped the `finally` and leaked the refcount, pinning the user online forever. The publish was moved inside the `try`.)*

### The event — `src/lib/effects/realtime/types.ts`

`presence.changed` is one variant of the shared `realtimeEventSchema` discriminated union, and **carries no `ids`**:

```ts
z.object({ kind: z.literal('presence.changed') }),
```

It is a pure "the online set changed, refetch it" signal. (Contrast `user.changed` / `document.changed`, which carry optional `ids`.)

### The read model + subscriber

- `src/lib/orpc/procedures/presence.ts` — `presenceRouter.listOnline: protectedProcedure.handler(() => presence.listOnline())`, registered under the `presence` key in `src/lib/orpc/router.ts`.
- `src/hooks/useRealtimeSync.ts` — the dispatch `switch` has `case 'presence.changed': invalidateQueries({ queryKey: orpc.presence.key() })`. One subscriber per tab, mounted once in `_authenticated.tsx` (ADR-0004).

### The UI

*(Note 2026-06: `contacts.tsx` and `admin/users.tsx` were collapsed into a single owners route, and `ContactCard`/`UserCard` were removed in the process; the dot now renders from the shared table.)*

`src/routes/_authenticated/owners.tsx` prefetches `orpc.presence.listOnline.queryOptions()` in the loader (alongside its primary query). Both views — `ActiveOwners` and `DeletedOwners` (the admin **"Borttagna"** filter) — read it with `useSuspenseQuery`, build `new Set(onlineIds)`, and pass it as `onlineSet` into `OwnersTable` (`src/components/user/OwnersTable.tsx`), which derives `isOnline={onlineSet.has(row.original.id)}` per row. Online renders as an `<AvatarBadge>` (`src/components/ui/avatar.tsx`) with `bg-success`, an `animate-ping` pulse, and an `sr-only` Swedish label **"Ansluten"**. Because `DeletedOwners` intersects the same `listOnline` set, a deleted user whose session is still connected shows a presence dot in the "Borttagna" list too — intentional, not a leak.

### Why this is a deep module

- **Interface**: three functions (`acquire`, `release`, `listOnline`). Stable across backends.
- **Implementation**: refcount bookkeeping, the 0↔1 transition detection that makes multi-tab broadcasts quiet, negative-safety, and self-cleaning deletes. All hidden.
- **One real adapter, and that's enough** — unlike `email`/`storage` (which need a devLog twin to avoid hitting the outside world in tests), presence is pure in-memory, so the in-memory adapter *is* the test target. The deletion test passes: removing this module would scatter a hand-rolled `Map` + transition logic across the SSE handler and break testability.
- **Test surface = the adapter contract.** `presence.test.ts` exercises a fresh `createInMemoryPresence()` (not the singleton) across five cases: `0→1` only-true-once, `1→0` only-true-at-zero, unknown-user no-op, `listOnline` accuracy, and per-user isolation. No mocks.

---

## Operational constraints

### Single-instance Vercel fluid compute (shared with ADR-0004)

The refcount `Map` works **only** because every SSE handler runs in one Node process — the exact assumption ADR-0004's `MemoryPublisher` makes, for the same reason. If we ever run >1 instance (horizontal scaling, region failover, a split process pool), each instance has its own partial refcount and `listOnline` is wrong. This is a **shared revisit trigger**: the day realtime needs a distributed bus, presence needs a distributed store, and they migrate together. See ADR-0004's *Single-instance Vercel fluid compute* section — it is not restated here.

### Ephemeral by design

Presence state lives only in memory. A redeploy or cold-start resets every refcount to empty. That is correct for a live-connection signal: after a restart, clients' SSE streams reconnect (ADR-0004's backoff loop), each reconnect calls `acquire` again, and the online set rebuilds within seconds. The worst case is a brief window where a still-connected user reads as offline until their stream re-establishes — self-healing, no durability required. There is nothing to persist.

Two accepted side effects of this design: every cold start makes all N clients reconnect at once, and each user's `0→1` transition broadcasts `presence.changed`, so every connected client refetches `listOnline` once per broadcast — O(N²) refetches in the reconnect window, trivial at 20 users, with coalescing the broadcasts as the future fix if it ever matters. And a connecting tab's own `0→1` publish precedes its subscription being established, so a loader-fetched `listOnline` may not show the user's own dot until some later refetch — acceptable; always rendering self as online in the UI is the candidate fix if it ever annoys.

---

## Verification

This subsystem is correctly wired when:

- The `presence.changed` variant compiles in `realtimeEventSchema`, and TypeScript's exhaustive `switch` forces the matching `case` in `useRealtimeSync` — drop either and the build fails.
- `pnpm test` passes — `src/lib/effects/presence/presence.test.ts` covers the adapter contract; no other test change is needed.

Drift checks for this ADR itself:

- `grep -rn "presence.acquire\|presence.release" src/` — production hits only in `src/lib/orpc/procedures/realtime.ts` (one `acquire`, one `release`); the rest are `effects/presence/presence.test.ts` exercising its own `createInMemoryPresence()` instance. Presence is acquired/released **only** by the SSE lifecycle; nowhere else may mint or drop presence.
- `grep -rn "presence.changed" src/` — three load-bearing regions agree: the schema variant (`effects/realtime/types.ts`), the dispatch case (`hooks/useRealtimeSync.ts`), and the two publish sites (`procedures/realtime.ts`). The remaining hits are comments mentioning the event (`procedures/realtime.ts` header, `procedures/presence.ts`, `effects/presence/presence.ts`) — fine, but no new *code* hit may appear outside the three regions.
- `grep -rn "listOnline" src/` — the effect (`effects/presence/`: interface, adapter, tests), the procedure (`procedures/presence.ts`), and one consuming route: `owners.tsx` (loader prefetch plus the `ActiveOwners` and `DeletedOwners` views). No service reads it.
- `grep -rn "presence" src/lib/services/` — zero hits. Presence is an effect, not a service; services never touch it.

Manual smoke (`pnpm dev`):

1. Sign in as user A in two tabs and user B in one tab. B's owners list (`/owners`) shows A with a green "Ansluten" dot.
2. Close **one** of A's tabs — the dot stays (refcount 2→1, no broadcast).
3. Close A's **last** tab — within a few hundred milliseconds the dot clears on B (1→0 → `presence.changed` → invalidate → refetch).
4. Reopen A — the dot returns (0→1).

---

## Critical files

**New (the subsystem):**
- `src/lib/effects/presence/presence.ts` — `PresenceEffects` interface + singleton export.
- `src/lib/effects/presence/adapters/inMemory.ts` — refcount adapter (the substance).
- `src/lib/effects/presence/index.ts` — barrel.
- `src/lib/effects/presence/presence.test.ts` — adapter contract tests.
- `src/lib/orpc/procedures/presence.ts` — `presenceRouter.listOnline` read model.

**Touched by presence (owned elsewhere):**
- `src/lib/orpc/procedures/realtime.ts` — producer: `acquire`/`release` + transition-gated publish in the SSE generator (ADR-0004).
- `src/lib/effects/realtime/types.ts` — the `presence.changed` schema variant.
- `src/hooks/useRealtimeSync.ts` — the dispatch case.
- `src/lib/orpc/router.ts` — registers `presence`.
- `src/lib/effects/index.ts` — re-exports `presence`.
- `src/routes/_authenticated/owners.tsx` — consumer (loader prefetch; `ActiveOwners` + `DeletedOwners` views).
- `src/components/user/OwnersTable.tsx`, `src/components/ui/avatar.tsx` (`AvatarBadge`) — the "Ansluten" dot.

---

## Consequences

**Positive:**
- Online status is exact and free — derived from the SSE connection we already maintain, no heartbeat traffic, no DB writes, no cron.
- Multi-tab is handled correctly and quietly: one broadcast per real transition.
- Tiny, isolated, fully unit-tested seam; the read model is one line.
- Distributed migration is a pure adapter swap (the `async` interface already anticipates it), and it rides along with realtime's same migration.

**Negative:**
- In-memory and single-instance: multi-instance silently breaks `listOnline` until the adapter is swapped (shared revisit trigger with ADR-0004).
- Ephemeral: a redeploy blanks presence until clients reconnect (brief, self-healing).
- Live-connection only: no "last seen," no idle/away states.

## Revisit triggers

Re-open this ADR if any of these change:

- **We run more than one Vercel instance.** Shared trigger with ADR-0004 — both the realtime bus and the presence store move to a distributed adapter (Postgres `LISTEN/NOTIFY` cheapest first; Redis if it grows) together.
- **"Last seen" or away/idle states are wanted.** The refcount-only, binary-online model doesn't express them; that's a redesign, not an extension.
- **`listOnline` becomes expensive** (it won't at this scale) — only then consider putting `ids` on `presence.changed` for fine-grained cache patching instead of full refetch.

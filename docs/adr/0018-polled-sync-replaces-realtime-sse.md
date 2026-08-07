# ADR 0018 — Polled Sync Replaces Realtime SSE (and Presence)

- **Status**: Accepted
- **Date**: 2026-08-06
- **Deciders**: Lukas
- **Supersedes**: [ADR-0004](./0004-realtime-sync-architecture.md) (Realtime Sync), [ADR-0011](./0011-presence-online-status-architecture.md) (Presence / Online Status)
- **Decision in one line**: Delete the SSE realtime bus, the `realtime` and `presence` effects, and the `useRealtimeSync()` hook; propagate other users' changes with TanStack Query's existing refetch machinery — a 60 s `refetchInterval` on the one screen that needs live cross-user data, plus the default focus refetch everywhere else — because an open SSE stream holds a Vercel Fluid instance alive and bills 2 GB of provisioned memory for the entire connection, which took the production deployment offline.

---

## Context

On **2026-08-05** Vercel soft-blocked the production project. The block reason was unambiguous:

```json
"softBlock": {
  "blockedAt": 1785906964867,          // 2026-08-05T05:16:04Z
  "reason": "FAIR_USE_LIMITS_EXCEEDED",
  "blockedDueToOverageType": "fluidDuration"
}
```

`fluidDuration` is Vercel's **Provisioned Memory** meter. It was the only meter
that tripped — Active CPU and Invocations were nowhere near their allowances.

### Why an SSE stream is uniquely expensive on Fluid Compute

From [Vercel's Fluid pricing docs](https://vercel.com/docs/functions/usage-and-pricing):

> **Provisioned Memory** — Billed for the entire instance lifetime in GB-hours.
> Continues billing while handling requests, even during I/O operations. Memory
> is reserved for your function even when it's waiting for I/O. **Billing
> continues until the last in-flight request completes.**

ADR-0004's SSE handler was an `async function*` that stays suspended on the
event bus for the lifetime of the connection. To Vercel that is a **permanently
in-flight request**, so the instance never pauses and its 2 GB bills
continuously — even though Active CPU sits at ~zero the whole time, because the
generator is only ever awaiting.

Two properties of the implementation made it a hard 24/7 burn rather than an
occasional one:

- `useRealtimeSync()` was mounted in `src/routes/_authenticated.tsx`, so the
  stream ran on **every** authenticated route whether or not the screen showed
  anything realtime-driven, and for as long as any tab was left open.
- The reconnect loop used a 1 s starting backoff with infinite attempts, so when
  the 300 s `maxDuration` killed a stream the client immediately reopened it —
  a ~100 % duty cycle.

### The arithmetic

Hobby is hard-locked to **2 GB / 1 vCPU** ([docs](https://vercel.com/docs/functions/configuring-functions/memory):
"Hobby users cannot configure this size") with **360 GB-hrs/month** included.

| | |
|---|---|
| Budget in instance-hours | 360 GB-hr ÷ 2 GB = **180 hours/month** |
| One tab open 24/7 | 48 GB-hr/day → quota exhausted in **7.5 days** |
| Observed: project created → blocked | 16.4 days |
| Implied duty cycle | ≈ **11 hours/day** of a tab being open |

Eleven hours a day of somebody having the app open is *ordinary use of an
internal tool by one or two people*. There is no usage pattern short of "nobody
opens the app" that fits inside the allowance while SSE exists.

ADR-0004 rejected polling partly on the grounds that "with ~20 users on a free
tier, this isn't a cost problem." That was right about polling and wrong about
the alternative: the cost problem was on the **push** side all along. Push
converts a serverless app into an always-on server, and Fluid charges
always-on prices.

### What we actually lose

Very little, as it turned out:

- **Presence had no consumers.** `orpc.presence.listOnline` was never called
  from any component or route. The only reference to it in the codebase was
  `useRealtimeSync`'s own invalidation of `orpc.presence.key()`. The green
  "Ansluten" dots ADR-0011 was written for were never built. The whole
  subsystem was dead weight.
- **Every mutation already invalidates locally.** `InviteUserDialog`,
  `EditUserDialog`, `RevokeUserDialog`, `AvatarUpload`, `ProfileCard` and the
  `/users` route all call `queryClient.invalidateQueries` in `onSuccess` /
  `onSettled`. Echo suppression (`shouldDeliver`) existed precisely because the
  actor's own tab was already correct without the push. Realtime only ever
  served **other** users' tabs.

So the entire realtime subsystem existed to keep a second admin's `/users`
table fresh — one screen, one query.

### A correctness problem we were carrying anyway

ADR-0004 and ADR-0011 both rest on "single Vercel function instance"
(`realtime.ts`: *"Single-instance Vercel deployment, so no cross-process
fan-out is needed"*). Vercel's own guidance contradicts this directly:

> No instance affinity across connections. A reconnect — or a new deployment —
> may land on a different instance, so never keep durable state, presence,
> rooms, or pub/sub coordination in memory.

Fluid scales to multiple instances under concurrency, so a mutation handled on
instance A never reached subscribers on instance B, and presence would only
ever have listed the users who happened to share your instance. The design was
already silently lossy in production. Fixing that properly would have meant a
distributed bus (Postgres `LISTEN/NOTIFY` or Redis) — more moving parts, and
none of it addresses the memory bill, which is caused by the open connection
rather than by the bus behind it.

---

## Decision (TL;DR)

1. **Deleted** — `src/lib/effects/realtime/`, `src/lib/effects/presence/`,
   `src/lib/orpc/procedures/realtime.ts`, `src/lib/orpc/procedures/presence.ts`,
   `src/hooks/useRealtimeSync.ts`, the `realtime` / `presence` keys from
   `src/lib/orpc/router.ts` and `src/lib/effects/index.ts`, the
   `useRealtimeSync()` call in `src/routes/_authenticated.tsx`, and the
   `@orpc/experimental-publisher` dependency.
2. **All `realtime.publish(...)` call sites removed** — four in
   `src/lib/orpc/procedures/user.ts`, one in `procedures/image.ts`, two in
   `src/lib/queue/handlers/heicTranscode.ts`. Procedures are now: validate →
   service → effects, with no fan-out step.
3. **Cross-user freshness comes from TanStack Query.** The `/users` directory
   sets `refetchInterval: 60_000` on `orpc.user.list` — the same cadence and
   the same idiom the sensors tiles already use
   (`src/routes/_authenticated/sensors.tsx`). Everywhere else relies on the
   existing defaults in `src/router.tsx`: `staleTime: 20_000` plus
   TanStack Query's default `refetchOnWindowFocus`, so any tab that regains
   focus after 20 s refetches what it is showing.
4. **The actor's own tab is unchanged** — it was always served by the
   mutation's local invalidation, not by the bus.

### Cost of the replacement

A 60 s poll costs ~0.0033 GB-hr per tab-hour (60 invocations × ~100 ms × 2 GB)
against SSE's flat 2 GB-hr per tab-hour — roughly **600× cheaper**. At the
observed ~11 tab-hours/day that is about **1 GB-hr/month against the 360
allowance**, and ~20 k invocations/month against 1 M. Between polls the
instance genuinely pauses and billing stops: *"After all requests complete, the
instance is paused, and no CPU or memory charges apply until the next
invocation."*

---

## Consequences

- **Up to 60 s of staleness** on the `/users` directory for changes made by
  another admin, and up to a window-focus for everything else. For an internal
  tool with a handful of admins, this is a non-issue; it was never worth an
  always-on server.
- **No presence, and no cheap way back to it.** Presence was defined as "holds
  an open SSE subscription", and that definition is exactly the thing that
  cost too much. If online status is ever genuinely wanted, it needs a
  different substrate — a `last_seen_at` column stamped by ordinary requests
  and read with a staleness window — not a connection-lifetime refcount.
- **The `heic_transcode` queue handler no longer notifies the uploader.** The
  tab picks up the finished (or failed) avatar on its next `user.me` refetch.
- **`ADR-0001`'s "skip in-process pub/sub" guidance is no longer in tension
  with anything** — the exception ADR-0004 carved out is gone.

## If realtime is ever needed again

Do not reintroduce SSE on Vercel Functions without pricing it first. The
options, in rough order of cost:

1. **Shorter poll intervals** on specific queries — still orders of magnitude
   cheaper than a held connection, and enough for most "feels live" needs.
2. **Pro plan + SSE**, budgeting ~$19/month per always-on instance at `arn1`
   ($0.0133/GB-hr × 2 GB × 720 h). Fluid's optimized concurrency means many
   users share one instance, so this is a floor rather than a per-user slope.
3. **A managed realtime service** (e.g. Supabase Realtime, which we already pay
   for via the database) so the held connection lives somewhere that charges
   for connections rather than for reserved function memory.

Whichever path, the in-memory bus does not come back: it was never correct
across instances.

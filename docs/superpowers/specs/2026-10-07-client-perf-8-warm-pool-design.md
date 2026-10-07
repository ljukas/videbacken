# Design — client performance step 8: keep pooled connections warm

Roadmap: [client performance](../roadmaps/2026-10-05-client-performance.md), step 8. Decision recorded as an
amendment to [ADR-0025 §5](../../adr/0025-deferred-route-loading.md#5-many-reads-per-page-merge-per-concern-not-per-transport).

## Why

Checkpoint 3 found that every navigation's burst starts from an empty pool: `poolTotal` 0 at the start, `poolOpened`
1–4. `pg` closes a connection after 10 s idle (`idleTimeoutMillis`, its default), and the app's traffic arrives in
bursts and polls further apart than that.

## What the evidence says

**Prod**, 30 h of `rpc timing` logs (2026-10-06 04:55 to 2026-10-07 09:01 UTC, 614 requests, de-duplicated by
request id). "Cold" means the request found the pool empty and opened a connection; "warm" means it found an idle
connection and opened none.

| | `findActiveById` (a request's first query) p50 / p90 | the same, lone requests only (none within 400 ms) |
|---|---|---|
| cold (361 requests) | 21 / 61 ms | 21 / 32 ms (170) |
| warm (196 requests) | 4 / 5 ms | 4 / 5 ms (51) |

- **68% of requests opened a connection.** Opening one costs ~17 ms on a lone request, and more inside a burst,
  where several open at once.
- **Per procedure, cold vs warm `totalMs` p50 / p90:** `sensor/series` 39 / 152 vs 13 / 18; `sensor/listDevices`
  39 / 141 vs 16 / 21; `tariff/list` 85 / 156 vs 11 / 20; `evCharging/syncStatuses` 34 / 154 vs 15 / 61.
- **Why the pool is always empty.** The most common gap between requests is 60 s (p50 and p75 of gaps over 2 s):
  the polls. A navigation a few seconds after another finds the pool warm; anything after 10 s doesn't.
- **A burst needs 1–3 connections.** Of 280 bursts (requests less than 1.5 s apart), the peak connection count
  (`poolTotal + poolOpened`) was 1 in 218, 2 in 5, 3 in 55 and 4 in 2.

**Vercel's guidance** ([connection pooling with Functions](https://vercel.com/kb/guide/connection-pooling-with-functions)):
"Idle connection timeouts don't run while suspended, so connections remain open until either the VM shuts down or
the database forcibly closes them." It recommends a short idle timeout plus `attachDatabasePool`, and to "keep the
**minimum** pool size to 1".

## Decision

**The pool keeps a warm minimum of 3 connections (`min: 3`).** pg-pool (3.14, installed) never closes an idle client
while the pool holds `min` or fewer; its idle timer re-checks the count when it fires, so a burst that opened 4
settles at 3. The 10 s `idleTimeoutMillis` still trims anything above 3. Three covers 278 of the 280 measured bursts.

- **Still no `attachDatabasePool`.** It `waitUntil`s ~10 s after every query, which bills each 60 s poll's instance
  ~100× longer (ADR-0018), and it closes idle connections before suspension, the opposite of this step.
- **The cost: up to 3 Supavisor client connections per suspended instance**, held until the VM shuts down or the
  pooler drops them. The pooler's client limit is 200 on Supabase's smallest compute
  ([pooling and limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits)), and
  this app runs a handful of instances. In transaction mode an idle client holds no Postgres connection.
- **The risk: a held connection is dead after a long suspension.** Supavisor sends idle clients a heartbeat every
  60 s ([client heartbeat](https://supabase.com/changelog/20195-supavisor-v1-1-2-allow-list-and-client-heartbeat-interval)).
  A frozen instance can't acknowledge it, so after a long enough suspension (on the order of 15 min, Linux's TCP
  retransmission give-up; inferred, not measured) the pooler drops the connection, and the next write on it gets a
  reset. That would hurt more than one retried read:
  - **Up to 3 failures per resumed instance.** pg-pool doesn't check an idle client before handing it out.
  - **A bounce to `/login`.** `src/lib/getSession.ts` returns `null` on any error, and `_authenticated.tsx` then
    redirects. After a long absence the cookie cache (5 min) has expired, so the first page load hits the DB.
  - **An instance crash.** drizzle's `db.transaction` checks out a client with no `'error'` listener (pg-pool removes
    its own on checkout), and pg emits `'error'` when the socket dies: an uncaught exception, and Vercel retires the
    instance. Before this step a checkout almost never got a socket older than 10 s.

  Found in the adversarial review of the first commit; the owner chose (2026-10-07) to guard against it in this step.

### Guards

- **A wall-clock idle cap at checkout: 5 min** (`POOL_MAX_IDLE_AGE_MS`). `WarmPool` (`src/lib/db/warmPool.ts`), a
  small `Pool` subclass, records when each client is released (the pool's `release` event). Its `connect()`
  discards an idle client released longer ago than the cap and takes or opens another. pg-pool's `query()` checks
  out through `this.connect`, so drizzle's plain queries and its transactions both pass through it. A timer can't do
  this: timers are frozen during suspension and, after resume, fire only after the request has already checked out.
  5 min keeps the 60 s polls and a session's navigations warm and stays well inside the ~15 min window; after a
  longer absence the request pays one connection open, as before this step. Production only, with `min`. In tests
  the pinned connection carries `SET search_path`, so it must never be discarded.
- **An `'error'` listener on every client** (`pool.on('connect', …)`). A dead socket inside a transaction then fails
  that request (pg rejects the pending query, which the request's handler logs) instead of crashing the instance.
  The listener only keeps the event from being unhandled; the failed query is the record. This is in every mode: the
  hazard is older than this step.
- **The timing line shows the guard.** `WarmPool` reports each checkout of an idle connection (`onIdleCheckout`),
  and `watchPool` adds `poolExpired` (connections discarded as too old) and `poolReuseIdleMs` (the longest a reused
  connection had sat idle; instance-wide, the oldest reuse during the request) to the `rpc timing` line. A dead-connection error can then be read against its
  connection's age, which turns the inferred 5 min bound into a measured one.
- **Not guarded: a pooler that closes a connection during a short freeze** (a Supavisor deploy or restart). The
  connection is younger than the cap and fails on reuse. Rare; the damage is `getSession` returning `null` on any DB
  error (a bounce to `/login`). That is older than this step and an auth concern, so it is a follow-up bugfix, not
  part of this step.
- **Not guarded: a silently dropped socket** (no reset). Its query waits for `query_timeout` (30 s), and drizzle's
  release after a timed-out transaction returns the client to the pool. Low likelihood if the path answers with a
  reset; recorded as a follow-up, not built.

### Rejected

- **A longer `idleTimeoutMillis` (~90 s, past the poll).** It keeps up to 10 connections, and since idle timers don't
  run while suspended, up to 10 can leak per instance, with the same dead-socket risk.
- **Record and drop.** ~17 ms per lone request isn't felt, but a burst's p90 is 50–130 ms above warm, and 68% of
  requests pay it.

## Change

- **`src/lib/db/warmPool.ts` (new).** `WarmPool` (above) and its `maxIdleAgeMillis` and `onIdleCheckout` options.
- **`src/lib/db/index.ts`.** The pool is a `WarmPool`. Its options move into an exported builder, so they can be
  tested without the app's singleton pool:
  - in production (`NODE_ENV === 'production'`, which the Vercel runtime sets): `connectionTimeoutMillis` 10 s,
    `query_timeout` 30 s (unchanged), `min: 3` and `maxIdleAgeMillis` 5 min;
  - in dev: the same, without `min`. The Vite dev server re-evaluates `src/lib/db/index.ts` when a module it imports
    changes (a schema file), creating a new pool. The old pool's idle connections close after 10 s today; with a
    `min` they would stay open, leaking 3 local Postgres connections per edit;
  - under `TEST_SCHEMA`: the pinned `max: 1`, `idleTimeoutMillis: 0` pool, unchanged, with no `min`.
- The comment under `watchPool` that says connections left idle on a suspended instance "are closed by the pooler,
  as before" is replaced with the new rule and its cost.
- Every client gets an `'error'` listener on `connect` (above).
- **`watchPool` and `src/routes/api/rpc/$.ts`:** `poolExpired` and `poolReuseIdleMs` on the timing line.
- No change to `max` (10), `keepAlive` or Supavisor settings.

## Tests (node project)

- **The builder:** `min: 3`, the 5 min cap and the timeouts in production; the timeouts and no `min` in dev; the pinned options
  under `TEST_SCHEMA`, with no `min`.
- **The pg-pool behaviour we rely on:** a real `Pool` built from the non-test options against the local Postgres,
  with `idleTimeoutMillis` shortened to 50 ms, checks out 4 connections at once, releases them, and settles at
  `totalCount` 3 (`idleCount` 3) after the timeout. A pg-pool upgrade that changes `min` fails CI. The test ends
  the pool.
- **`WarmPool`** (real connections, `Date` faked): a client released longer ago than the cap is discarded at
  checkout (a new backend `processID`, the stale one removed), through both `connect()` and `query()`; one released
  within the cap is reused.
- **The listener:** an `'error'` emitted on a checked-out client of the app's pool doesn't throw.
- **Telemetry:** `onIdleCheckout` reports each idle checkout's age and whether it expired; `watchPool` reports
  `poolReuseIdleMs` (fake `Date`).

## Docs

- **ADR-0025 §5 amendment:** the warm minimum, why not `attachDatabasePool`, the leak bound, and its guards (idle cap,
  `'error'` listener, telemetry).
- **Roadmap:** row 8 gets its plan and PR; step 8 notes hold the baseline above; checkpoint 8 is defined (below).

## Checkpoint 8 (prod)

About 24 h after the deploy, read the `rpc timing` lines the same way (de-duplicated by request id) and compare with
the baseline above:

- **Share of requests that open a connection:** 68% now. Passes below ~30%. New instances (deploys, scale-out) still
  open their first connections, and pg-pool reuses the most recently released connection first, so lone polls keep
  only one of the three warm: a navigation after a poll-only stretch of over 5 min discards the other two.
- **A lone request's first query (`findActiveById`) p50:** 21 ms now, expected near 4.
- **Burst p90 per procedure** (the table above): recorded, no threshold.
- **`poolExpired` and `poolReuseIdleMs`:** recorded. How often the cap fires, and the oldest connection reused.
- **No failed request from a dead connection:** search all runtime log lines, not only `rpc timing` ones (SSR page
  loads go through the in-process client, which writes no `orpc handler error` and no timing line). No error (or
  `cause`, since drizzle wraps the driver's error) that is `Connection terminated unexpectedly` or `ECONNRESET`, no
  `getSession failed` warning, and no `uncaughtException`. Any one fails the checkpoint and goes to the bugfix
  workflow, with its request's `poolReuseIdleMs` when it has an `rpc timing` line. An `idle postgres client error`
  warning alone isn't a failure (a discarded dead connection can log one as it closes); read it against
  `poolExpired`.

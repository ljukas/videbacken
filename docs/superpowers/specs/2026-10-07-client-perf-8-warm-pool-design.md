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
- **The risk: a held connection is dead after a long suspension.** If the pooler or a NAT on the path dropped it
  while the instance was frozen, the next query on it is expected to get a reset (a fast error, not a 30 s
  `query_timeout` hang). That request returns a 500. TanStack Query retries a failed read on the client (no override
  in `src/router.tsx`); a mutation isn't retried. No retry is built for this up front: checkpoint 8 looks for these
  errors on prod, and if they appear, the fix is a bugfix (a retry on a dead checkout, or a lower `min`).

### Rejected

- **A longer `idleTimeoutMillis` (~90 s, past the poll).** It keeps up to 10 connections, and since idle timers don't
  run while suspended, up to 10 can leak per instance, with the same dead-socket risk.
- **Record and drop.** ~17 ms per lone request isn't felt, but a burst's p90 is 50–130 ms above warm, and 68% of
  requests pay it.

## Change

- **`src/lib/db/index.ts`.** The `Pool` options move into an exported builder, so they can be tested without the
  app's singleton pool:
  - outside tests: `connectionTimeoutMillis` 10 s, `query_timeout` 30 s (unchanged) and `min: 3`;
  - under `TEST_SCHEMA`: the pinned `max: 1`, `idleTimeoutMillis: 0` pool, unchanged, with no `min`.
- The comment under `watchPool` that says connections left idle on a suspended instance "are closed by the pooler,
  as before" is replaced with the new rule and its cost.
- No change to `max` (10), `keepAlive`, the timing line, or Supavisor settings.

## Tests (node project)

- **The builder:** `min: 3` and the timeouts outside tests; the pinned options under `TEST_SCHEMA`, with no `min`.
- **The pg-pool behaviour we rely on:** a real `Pool` built from the non-test options against the local Postgres,
  with `idleTimeoutMillis` shortened to 50 ms, checks out 4 connections at once, releases them, and settles at
  `totalCount` 3 (`idleCount` 3) after the timeout. A pg-pool upgrade that changes `min` fails CI. The test ends
  the pool.

## Docs

- **ADR-0025 §5 amendment:** the warm minimum, why not `attachDatabasePool`, and the leak bound.
- **Roadmap:** row 8 gets its plan and PR; step 8 notes hold the baseline above; checkpoint 8 is defined (below).

## Checkpoint 8 (prod)

About 24 h after the deploy, read the `rpc timing` lines the same way (de-duplicated by request id) and compare with
the baseline above:

- **Share of requests that open a connection:** 68% now. Passes below ~30%. New instances (deploys, scale-out) still
  open their first connections.
- **A lone request's first query (`findActiveById`) p50:** 21 ms now, expected near 4.
- **Burst p90 per procedure** (the table above): recorded, no threshold.
- **Dead connections: none.** No `idle postgres client error` warnings, and no `orpc handler error` line whose
  error (or its `cause`, since drizzle wraps the driver's error) is `Connection terminated unexpectedly` or
  `ECONNRESET`. Any such error fails the checkpoint and goes to the bugfix workflow.

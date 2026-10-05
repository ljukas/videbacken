# Design — client performance step 3: fewer, cheaper reads per page

Roadmap: [client performance](../roadmaps/2026-10-05-client-performance.md), step 3. Decision recorded in
[ADR-0025 §5](../../adr/0025-deferred-route-loading.md#5-many-reads-per-page-merge-per-concern-not-per-transport).

## Why this step changed shape

The roadmap framed step 3 as "one procedure for the Datakällor panel *or* app-wide oRPC batching", against a
baseline of 19 requests per admin `/charging` load. That baseline is stale. #90 moved the Datakällor panel to the
admin-only `/charging/settings`. On `main` at `7b96625`:

| Page (admin, client navigation) | oRPC requests |
|---|---|
| `/charging` | 9: `overview`, `sessions`, `costOverview`, `tariff.list`, 3× `syncStatus`, then `sessionCosts` (waits on `sessions`), `liveStatus` |
| `/charging/settings` | 11: 4× `syncStatus`, 4× `recentRuns`, `vehicleRecordCoverage`, `vehicleStateLatest`, `tariff.list` |

The owner asked for the best practice for loading a page made of many separate reads, not for batching as such.

## What the evidence says

**Prod** (5 h of `rpc timing` logs on 2026-10-05, 600 requests, de-duplicated by request id):

| Requests starting within 400 ms | `findActiveById` p50 / p90 / max |
|---|---|
| 1 (alone) | 5 / 30 / 81 ms |
| 4–6 | 21 / 41 / 111 ms |
| 7+ | 12 / 77 / 120 ms |

- A one-row `syncStatus` takes 8–15 ms alone and 100–144 ms inside a `/charging/settings` load. On small reads, the
  per-request auth lookup is most of the cost.
- Even requests that arrive alone reach 30–81 ms at p90. That points at opening a new pooled connection: `pg`'s
  default pool closes a connection after 10 s idle, and this app's traffic is bursty. Queueing behind the 10
  connections explains the rest.
- `sessionCosts` starts only after `sessions` lands, about 240 ms into a `/charging` load.

**Research** (sources in the step's PR description):

- **On HTTP/2 and HTTP/3 the request count barely matters to the browser.** There is one connection, with compressed
  headers. oRPC's own docs say batching is "often less useful than it once was". The cost of N requests lands on the
  server: N auth checks and N connection checkouts.
- **TanStack's guidance** is to keep queries granular (one per thing a component shows), and to shape the response on
  the server where data really is one concern. That covers a dependent waterfall too, which the Query docs fix by
  "restructur[ing] your API so you can fetch both … in a single query". The standard pattern for status polling is one
  aggregated health read.
- **Buffered batching has head-of-line blocking.** The slowest call holds every result (`liveStatus` takes up to 6 s).
  Streaming batching avoids that, but it is unverified on our Vercel setup. It also needs per-call timing logs and a
  shared auth lookup to pay off.
- **Revealing together vs. one at a time.** Loading boundaries shouldn't be more granular than the loading sequence
  users should see (react.dev). Group related sections that land within about 300 ms; let slow, independent parts
  arrive on their own. Our plain-`useQuery` sections can't group today. That belongs to step 7 (layout shifts).
- **Auth.** The standard safe pattern is a check once per HTTP request, memoized inside it. A cross-request cache of
  the user lookup would weaken the instant revoke that `findActiveById` exists for (ADR-0017).

## Design

### 1. One health read for every source: `evCharging.syncStatuses`

- **Shape.** A `protectedProcedure` with no input. It returns `Record<IntegrationSource, IntegrationHealth>`.
- **Service.** `integrationSyncService.getAllHealth({ now, includeAdminDetail })` does one `SELECT` over
  `integration_sync` (≤ 4 rows). It maps every source through the existing `toHealth`, so a source with no row yet
  gets the same "never synced" health as today.
- **Access.**
  - `includeAdminDetail` comes from `context.user.role`, as today, so a member never sees `adminDetail`.
  - Members could already read every source's health through `syncStatus({ source })`, so access doesn't widen.
- **Consumers.**
  - Every consumer moves to this one query and picks its source with `select`. That covers `/charging`'s alerts,
    the settings tiles, economy, patterns and the energy page.
  - A shared helper (`healthQuery(source)` in `components/evCharging/`) builds those options. One cache entry then
    serves every page.
- **Polling.** One poll for all sources:
  - every 5 s while any source is pending (`syncNow.isPendingFor`) or `running`;
  - otherwise every 60 s;
  - members get a plain 60 s, as today.

  This extends `healthPoll` to look at every source in the record.
- **Removed.** The old `syncStatus` procedure and its key go, so there is only one way to read health. `syncNow`
  keeps its per-source input.

### 2. Recent runs for every source in one read

- **`recentRuns`.** Becomes `adminProcedure` with input `{ limit }` (1–50, default 20). It returns
  `Record<IntegrationSource, RunRow[]>`.
- **Service.** `listRecentRunsBySource({ limit })` is one SQL query. It does a `LATERAL` join of the four sources
  against `integration_sync_run`, ordered by `started_at desc` and limited to `limit`, so each source reads only its
  top rows from the existing `integration_sync_run_source_started_idx` (`source, started_at desc`). There is no
  schema change.
- **Settings page.** Its four runs queries become one.

### 3. Sessions and their costs in one procedure

- **`evCharging.sessions`.** Returns the page as today plus `costs`, the page's `SessionCost[]`. The client-side
  `sessionCosts` query goes, along with the procedure.
- **Cost failures stay isolated** (ADR-0020: missing ≠ 0 kr).
  - Inside the procedure, `getSessionCosts` runs after `listSessions` in a `try/catch`.
  - On a throw it logs a warning and returns `costs: null`. The cost column then renders exactly as it does today
    when the `sessionCosts` query fails: no placeholder, just the dash.
  - A session missing a price stays a per-row result inside `costs`, as now.
- **Timings.**
  - `sessionsMs` covers the whole call.
  - The existing `sessions*` sub-timings stay.
  - The cost part records under the existing `cost*` prefix, with `sessionCostsMs` for its total.
- **What changes for the user.**
  - The session list and its cost column now land together, after about 40 ms more at p50 (200 ms at p90).
  - On a first load the costs are in the SSR HTML (the query was already critical). Deferring them and the
    hydration rule that came with it are no longer needed.
  - The ~240 ms client waterfall goes. Paging keeps `keepPreviousData`.

### 4. Auth looked up once per HTTP request

- **What's memoized.**
  - `sessionMiddleware` keeps its `auth.api.getSession` promise on a request-scoped object.
  - `requireAuth` keeps its `findActiveById(userId)` promise, keyed by user id.
  - Every call within the same HTTP request reuses them.
- **Where the object comes from.**
  - `/api/rpc/$`: the handler creates one per request and passes it in the context, like `timings`.
  - SSR in-process client (`orpc/client.ts`): a module-level `WeakMap<Request, …>` keyed on `getRequest()`, so all
    of one SSR request's loader calls share it, and it is garbage-collected with the request.
  - Tests and anything else that builds a context without it: no memo, today's behaviour.
- **Effect.**
  - An SSR load of `/charging` does 1 `getSession` and 1 `findActiveById` instead of about 7 each.
  - Client RPCs are one call per HTTP request, so nothing changes for them. The memo is the hook a future
    transport batch would use.
- **Security.** Unchanged. Revocation is still checked on every HTTP request. The memo never outlives one request,
  and a rejected promise isn't retried within it.
- **Timings.** Only the call that actually ran the lookup records `getSessionMs` and `findActiveByIdMs`. A reused
  one records nothing.

### 5. Pool gauges in the timing line

- **New fields.** `/api/rpc`'s `rpc timing` line gains the pool's state at request start: `poolTotal`, `poolIdle`
  and `poolWaiting` (`pg`'s `totalCount`, `idleCount`, `waitingCount`).
- **How.** `src/lib/db` exports a `poolStats()` read. The rpc route reads it, which keeps DB access out of routes;
  it is a counter read, not a query.
- **Why not fix the pool now.** Checkpoint 3 reads these gauges and decides between connection setup (fix: keep
  connections warm longer) and queueing (fix: pool size). Either fix is a small follow-up row on the roadmap, not
  this PR. The pool's idle and connection settings interact with Supavisor and Fluid suspension (see the comment
  in `src/lib/db/index.ts`), so they need the evidence first.

## Not in this step

- **Transport batching.** Parked. Revisit only if the post-step gauges still show a server cost that batching would
  remove.
- **Revealing related sections together.** Step 7, alongside the layout shifts.
- **Merging `vehicleRecordCoverage` and `vehicleStateLatest`.** Two tiny admin reads, deferred on the settings page;
  not worth a new shape.

## Expected result (checkpoint 3)

- An admin `/charging` client navigation makes **6** oRPC requests (from 9), with no `sessionCosts` waterfall.
- `/charging/settings` makes **5** (from 11).
- An SSR `/charging` load runs one `findActiveById`. Checking it needs a temporary debug log or a local count; prod
  logs don't time SSR calls. The plan's verification task checks it locally.
- Prod `rpc timing` lines carry the pool gauges, and the checkpoint records what they show.

## Testing

- **Service tests** (test-first, colocated): `getAllHealth` (all four sources, missing rows, admin detail stripped)
  and `listRecentRunsBySource` (per-source limit, ordering, empty sources).
- **Procedure tests:**
  - `syncStatuses` access, and `adminDetail` hidden for a member;
  - `recentRuns` admin-only, with its new shape;
  - `sessions` returns `costs`, and returns `costs: null` with sessions intact when costing throws;
  - the timings above.
- **Context tests:** within one request object, `getSession` and `findActiveById` run once across several calls; a
  new request runs them again; a revoked user is still rejected on the next request.
- **Browser tests:** re-point the seeded query keys (`syncStatuses`, `recentRuns`, the `sessions` result with
  `costs`), and keep the pending and failure cases for the alerts, tiles and cost column.
- **Live:** count requests in the network panel on `/charging` and `/charging/settings` (local prod build), then on
  prod at the checkpoint.

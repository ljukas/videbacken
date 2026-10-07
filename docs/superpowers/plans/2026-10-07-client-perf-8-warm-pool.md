# Client performance step 8: keep pooled connections warm (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
> House rule: after each task's commit, two adversarial reviewers (paired per task) start from the assumption that
> the task is wrong and not up to spec. Fix or rule on every finding before the next task.

**Goal:** In production, the Postgres pool keeps up to 3 idle connections open between requests (`min: 3`), so a
poll or a navigation's burst finds a warm connection instead of opening one (~17 ms each, more inside a burst).

**Architecture:** `src/lib/db/index.ts` builds its `Pool` options through a new exported, pure `poolOptions()`, so the
options are testable without the app's singleton pool. Production adds `min: 3`; dev and tests don't. Nothing else
changes: `max` stays 10, `idleTimeoutMillis` stays pg's 10 s default (it now only trims connections above 3), and
there is still no `attachDatabasePool`. ADR-0025 §5 gets an amendment; the roadmap gets row 8's plan, notes and
checkpoint.

**Tech stack:** `pg` 8.23.0 / `pg-pool` 3.14.0 (its `min` option: an idle client is not closed while the pool holds
`min` or fewer; the idle timer re-checks the count when it fires), Vitest node project against the local Postgres
(:14620), bun.

**Spec:** [`docs/superpowers/specs/2026-10-07-client-perf-8-warm-pool-design.md`](../specs/2026-10-07-client-perf-8-warm-pool-design.md)

**Baseline:** measured for the spec on 2026-10-07 from 30 h of prod logs, with `main` at `1014be6` (nothing since
touches the pool). It is the comparison for checkpoint 8, so no separate re-measure task.

## Global Constraints

- `min: 3`, production only (`NODE_ENV === 'production'`). Dev: no `min`. Tests (`TEST_SCHEMA`): the pinned
  `max: 1, idleTimeoutMillis: 0` pool, unchanged, no `min`.
- `connectionTimeoutMillis: 10_000` and `query_timeout: 30_000` unchanged in every mode.
- No `attachDatabasePool`, no change to `max`, `idleTimeoutMillis` (outside tests), `keepAlive`, the timing line or
  Supavisor settings. No retry.
- Comments in the codebase's voice: short, say *why*, cite the ADR.
- Conventional Commits, one hat per commit. PR title: `perf(db): keep three pooled connections warm` (≤72 chars).

## Review Focus

1. **Dev server edits** (a schema file changed under `bun run dev`): the old module's pool must not keep connections
   open forever. Expected: dev has no `min`, so its idle connections still close after 10 s. Pinned by Task 1's dev
   builder test.
2. **The test pool** (every node test runs on one pinned connection with `SET search_path`): it must stay exactly
   `max: 1, idleTimeoutMillis: 0` with no `min`. Pinned by Task 1's `TEST_SCHEMA` builder test, and by the whole node
   suite passing.
3. **A burst that opened more than 3** (4 at once, seen twice in 280 bursts): it settles back at 3, not 4 and not 0.
   Pinned by Task 1's real-pool test.
4. **Production actually gets `min`** (the Vercel runtime and the Nitro build): `NODE_ENV` must read `production` in
   the built server. Checked in Task 1 Step 7 against the built `.output/server`, and on prod by checkpoint 8
   (`poolTotal` > 0 at the start of requests).
5. **A dead held connection after a long suspension:** not testable locally (it needs a frozen Fluid instance).
   Checkpoint 8 looks for it on prod; if it appears, it's a bugfix (spec, "The risk").

---

### Task 1: `poolOptions()` with a production warm minimum

**Files:**
- Modify: `src/lib/db/index.ts` (the `new Pool({...})` call at lines 27–37 and the comment block at lines 76–79)
- Test: `src/lib/db/index.test.ts`

**Interfaces:**
- Consumes: `PoolConfig` (type) and `Pool` from `pg`; `resolvePooledUrl()` from `./connectionString` (unchanged).
- Produces: `export const POOL_WARM_MIN = 3` and
  `export function poolOptions(connectionString: string, mode: { test: boolean; production: boolean }): PoolConfig`
  from `~/lib/db`. Task 2's docs name both.

**Reviewers:** `code-reviewer` (agent) + a `general-purpose` agent that loads `supabase-postgres-best-practices` and
judges the pool settings against Supavisor transaction mode and Fluid suspension.

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/db/index.test.ts` with:

```ts
import { Pool, type PoolClient } from 'pg'
import { expect, test } from 'vitest'
import { __testClient, POOL_WARM_MIN, poolOptions } from '~/lib/db'

// A dropped reply or a half-open socket must fail fast, not hang the request
// until Vercel's 300 s timeout (the /charging 504s). node-postgres waits
// forever by default, both for a connection and for a query's reply.
test('the pool gives up on a stalled connection or query', () => {
  const options = __testClient?.options
  expect(options?.connectionTimeoutMillis).toBe(10_000)
  expect(options?.query_timeout).toBe(30_000)
})

const url = 'postgres://u:p@localhost:5432/db'

// Production keeps a warm minimum between requests (ADR-0025 §5, step 8): the
// polls are 60 s apart, and pg's 10 s idle timeout emptied the pool before each.
test('production keeps a warm minimum of three connections', () => {
  expect(poolOptions(url, { test: false, production: true })).toEqual({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    min: 3,
  })
  expect(POOL_WARM_MIN).toBe(3)
})

// The dev server re-creates the pool when a module db/index imports changes; a
// warm minimum would keep each old pool's connections open forever.
test('dev keeps no warm minimum', () => {
  expect(poolOptions(url, { test: false, production: false })).toEqual({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  })
})

// Tests pin one connection that never idles out, so `SET search_path` holds.
test('tests pin one connection that never idles out, whatever NODE_ENV says', () => {
  expect(poolOptions(url, { test: true, production: true })).toEqual({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    max: 1,
    idleTimeoutMillis: 0,
  })
})

// The pg-pool behaviour the warm minimum relies on: an idle client isn't closed
// while the pool holds `min` or fewer, and the idle timer re-checks the count
// when it fires, so a burst that opened 4 settles at 3. A pg-pool upgrade that
// changes this fails here. Real connections to the local Postgres.
test('a production pool settles at the warm minimum after a burst', async () => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is set for the node tests (vite.config.ts)')
  const pool = new Pool({
    ...poolOptions(connectionString, { test: false, production: true }),
    idleTimeoutMillis: 50,
  })
  try {
    const clients: PoolClient[] = await Promise.all(
      Array.from({ length: POOL_WARM_MIN + 1 }, () => pool.connect()),
    )
    for (const client of clients) client.release()
    expect(pool.totalCount).toBe(POOL_WARM_MIN + 1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(pool.totalCount).toBe(POOL_WARM_MIN)
    expect(pool.idleCount).toBe(POOL_WARM_MIN)
  } finally {
    await pool.end()
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run db:up && bunx vitest run src/lib/db/index.test.ts`
(If another vitest process is running, wait until `pgrep -fl vitest` shows none: two runs collide on the shared
local DB.)
Expected: FAIL. TypeScript/vitest reports `POOL_WARM_MIN` and `poolOptions` are not exported from `~/lib/db`
(`poolOptions is not a function`).

- [ ] **Step 3: Implement `poolOptions()` and use it**

In `src/lib/db/index.ts`, change the import to `import { Pool, type PoolConfig } from 'pg'`, and replace the block
from `// In tests: pin to one connection…` through the end of the `new Pool({ … })` call with:

```ts
// Connections a production instance keeps open between requests (ADR-0025 §5,
// roadmap step 8). pg's 10 s idle timeout emptied the pool before every 60 s
// poll and most navigations, and opening one costs ~17 ms alone, more inside a
// burst. 3 covers 278 of 280 measured bursts. pg-pool never closes an idle
// client while the pool holds `min` or fewer; the timeout still trims the rest.
export const POOL_WARM_MIN = 3

/**
 * The pool's options.
 * - Everywhere: fail fast instead of waiting forever (node-postgres's default).
 *   A stalled connect or pool checkout errors after 10 s, a query whose reply
 *   never comes after 30 s — well inside Vercel's 300 s function timeout.
 *   Inside a transaction a timed-out query leaves its client busy, so the
 *   rollback can still wait; outside one the client is discarded.
 * - Production: a warm minimum (above). Not in dev: the dev server re-creates
 *   this module's pool when a module it imports changes, and a minimum would
 *   keep every old pool's connections open.
 * - Tests: pin to one connection that never idles out, so the `SET
 *   search_path` issued in `test/setup.ts` persists across every drizzle query
 *   and transaction. Local tests run against a plain Postgres container (see
 *   compose.yaml + vite.config.ts), so there's no pooler: connections are
 *   direct sessions and the single pinned connection keeps the SET alive.
 */
export function poolOptions(
  connectionString: string,
  mode: { test: boolean; production: boolean },
): PoolConfig {
  const base = { connectionString, connectionTimeoutMillis: 10_000, query_timeout: 30_000 }
  if (mode.test) return { ...base, max: 1, idleTimeoutMillis: 0 }
  return mode.production ? { ...base, min: POOL_WARM_MIN } : base
}

const pool = new Pool(
  poolOptions(connectionString, {
    test: Boolean(process.env.TEST_SCHEMA),
    production: process.env.NODE_ENV === 'production',
  }),
)
```

Keep the node-postgres-vs-postgres.js comment above it as it is (it explains the driver, not the options).

Then replace the comment block after `watchPool` (currently ending "Connections left idle on a suspended instance are
closed by the pooler, as before.") with:

```ts
// Deliberately no `attachDatabasePool` (@vercel/functions): it `waitUntil`s
// idleTimeoutMillis + 100 ms (~10 s) after every query, so each ~100 ms poll
// would keep its Fluid instance billed ~100x longer (ADR-0018), and it closes
// idle connections before suspension, the opposite of the warm minimum. Idle
// timers don't run on a suspended instance, so up to POOL_WARM_MIN connections
// stay open through suspension: that many Supavisor clients per instance (an
// idle client holds no Postgres connection in transaction mode).
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/db/index.test.ts src/lib/services/dbPool`
Expected: PASS, 5 tests in `index.test.ts` and the 4 `dbPool` tests.

- [ ] **Step 5: Lint and types**

Run: `bun run check && bun run check:ci && bun run typecheck`
Expected: no errors; commit anything `check` rewrote.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/index.ts src/lib/db/index.test.ts
git commit -m "perf(db): keep three pooled connections warm in production"
```

- [ ] **Step 7: Check that the built server reads production**

Run: `bun run build`, then
`grep -rl "POOL_WARM_MIN\|min: 3\|NODE_ENV" .output/server/chunks | head` and open the chunk that holds
`poolOptions`. Expected: either `process.env.NODE_ENV === "production"` (read at runtime; Vercel's runtime sets
`NODE_ENV=production`) or a constant `true` / `"production" === "production"` in its place. If the build replaced it
with `"development"` or `false`, stop and report: the warm minimum would never reach prod.

---

### Task 1b: guards against a dead held connection (added after Task 1's review)

> As shipped (7e43cd7 and the final-review fix), `WarmPoolConfig` also takes `onIdleCheckout`, and `watchPool`, the
> `rpc timing` line (`src/routes/api/rpc/$.ts`) and `dbPool.test.ts` gained `poolExpired` / `poolReuseIdleMs`, plus
> a `pool connection expired` log line. This supersedes the Global Constraints' "no change to … the timing line" and
> Review Focus 5's "not testable locally": the guards are unit-tested; only a real dead socket is left to prod.

Ruling (owner, 2026-10-07): the review of Task 1 found that a held connection is likely dead after a long
suspension, and that it can crash an instance (an uncaught `'error'` on a transaction's client) or bounce a user to
`/login` (`getSession` returns `null` on a DB error). See the spec's "The risk" and "Guards".

**Files:**
- Create: `src/lib/db/warmPool.ts`, `src/lib/db/warmPool.test.ts`
- Modify: `src/lib/db/index.ts` (use `WarmPool`, `POOL_MAX_IDLE_AGE_MS` in `poolOptions`, the `connect` listener),
  `src/lib/db/index.test.ts`

**Interfaces:**
- Produces: `export class WarmPool extends Pool` with `constructor(config?: WarmPoolConfig)`, where
  `WarmPoolConfig = PoolConfig & { maxIdleAgeMillis?: number }`; `export const POOL_MAX_IDLE_AGE_MS = 5 * 60_000`
  from `~/lib/db`; `poolOptions()` now returns `WarmPoolConfig`, adding `maxIdleAgeMillis: POOL_MAX_IDLE_AGE_MS` in
  production only.

**Reviewers:** `code-reviewer` + the `supabase-postgres-best-practices` reviewer (as Task 1).

- [ ] **Step 1: failing tests.** `warmPool.test.ts` (real local Postgres, `vi.useFakeTimers({ toFake: ['Date'] })`
  so sockets are untouched): a client released longer ago than `maxIdleAgeMillis` is discarded at `connect()` (a
  different `processID`, `totalCount` 1); the same through `pool.query('select pg_backend_pid() as pid')`; a client
  released within the cap is reused (same `processID`). `index.test.ts`: the production builder expectation gains
  `maxIdleAgeMillis: 300_000` (dev and test unchanged); an `'error'` emitted on a checked-out client of
  `__testClient` doesn't throw.
- [ ] **Step 2:** `bunx vitest run src/lib/db` → FAIL (no `warmPool` module; the emit throws "Unhandled error").
- [ ] **Step 3:** implement `WarmPool` (record `Date.now()` on the pool's `release` event in a `WeakMap`; `connect()`
  supports the promise and callback forms, loops `super.connect()` and `release(err)`s a client older than the cap);
  make the app's pool a `WarmPool`; add `pool.on('connect', (client) => client.on('error', () => {}))` with a comment
  (the failed query is the record).
- [ ] **Step 4:** `bunx vitest run src/lib/db src/lib/services/dbPool` → PASS. `bun run check && bun run check:ci &&
  bun run typecheck` → clean.
- [ ] **Step 5:** commit `perf(db): discard pooled connections idle over 5 min, never crash on one`.

---

### Task 2: Record the decision and the checkpoint

> As shipped, the ADR and roadmap text below was extended for Task 1b's guards, the timing-line fields and a
> checkpoint rule that searches all runtime logs (see the committed docs; the blocks here are the original draft).

**Files:**
- Modify: `docs/adr/0025-deferred-route-loading.md` (end of §5, after the "**Where the line is.**" paragraph; and
  the Consequences list)
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md` (row 8, the Checkpoints list, a new
  "Step 8 notes" section at the end)

**Interfaces:**
- Consumes: `POOL_WARM_MIN` and `poolOptions()` from Task 1 (named in the ADR text).
- Produces: checkpoint 8's definition, which the post-merge session runs.

**Reviewers:** `code-reviewer` (agent; ADR adherence, accuracy against the diff) + a `general-purpose` agent that
checks every number in the new text against the spec and the roadmap's checkpoint 3 notes.

- [ ] **Step 1: ADR-0025 §5 amendment**

Insert after the "**Where the line is.**" paragraph (before `### 6.`):

```markdown
*Amendment, 2026-10-07 (roadmap step 8; design in
[the step 8 spec](../superpowers/specs/2026-10-07-client-perf-8-warm-pool-design.md)).* **A production instance keeps
3 pooled connections warm** (`min: 3`, `POOL_WARM_MIN` in `src/lib/db/index.ts`). The timing line showed every burst
starting from an empty pool. pg closes a connection after 10 s idle, and the polls are 60 s apart. 68% of requests
opened a connection: a lone request's first query took 21 ms p50 that way, against 4 ms on a warm one.

- **Why 3:** 278 of 280 measured bursts peaked at 3 connections or fewer. The 10 s idle timeout still trims the rest.
- **Why not `attachDatabasePool`:** it `waitUntil`s ~10 s after every query, which bills each poll's instance far
  longer (ADR-0018), and it closes idle connections before suspension.
- **The cost:** idle timers don't run on a suspended instance, so up to 3 Supavisor clients per instance stay open
  until the VM shuts down or the pooler drops them. In transaction mode they hold no Postgres connection.
- **The risk, and its guards:** a held connection is likely dead after a long suspension (the pooler's 60 s
  heartbeats go unanswered while the instance is frozen). Handed out, it would fail its request, could bounce a user
  to `/login` (`getSession` treats a DB error as no session), and inside a transaction would crash the instance (an
  unhandled `'error'`). So `WarmPool` discards, at checkout, an idle connection released more than 5 min ago by the
  wall clock (`POOL_MAX_IDLE_AGE_MS`; timers can't, since they're frozen during suspension), and every client gets
  an `'error'` listener. Checkpoint 8 still watches for dead connections.
- **Production only.** The dev server re-creates the pool when a module it imports changes, and a minimum would keep
  each old pool's connections open. Tests keep their pinned single connection.
```

And add to the Consequences list, after the "Fewer requests block…" bullet:

```markdown
- **Polls and navigations find a warm connection** (§5, step 8): up to 3 per production instance, held through
  suspension.
```

- [ ] **Step 2: Roadmap row 8**

Replace row 8's line in the Status table with:

```markdown
| 8 | Keep pooled connections warm between navigations (`poolOpened` 1–4 per burst; pg's 10 s idle timeout empties the pool): `min: 3` in production (ADR-0025 §5 amendment); see [notes](#step-8-notes) | [plan](../plans/2026-10-07-client-perf-8-warm-pool.md) | [#NNN](https://github.com/ljukas/videbacken/pull/NNN) | PR open | — |
```

(`NNN` is the PR number; fill it in once the PR exists, Phase 7.)

- [ ] **Step 3: Checkpoint 8 in the Checkpoints list**

After item 7, add:

```markdown
8. **After step 8 (prod).** About 24 h after the deploy, read the `rpc timing` lines (de-duplicated by request id)
   and compare with the [step 8 baseline](#step-8-notes):
   - the share of requests that open a connection (`poolOpened` > 0): 68% before, passes below ~30%;
   - a lone request's first query (`findActiveByIdMs`, no other request within 400 ms) p50: 21 ms before, expected
     near 4;
   - burst p90 per procedure: recorded, no threshold;
   - **no dead connections:** no `idle postgres client error` or `getSession failed` warning, no `uncaughtException`,
     and no `orpc handler error` whose error (or its `cause`) is `Connection terminated unexpectedly` or `ECONNRESET`. Any one fails the checkpoint and goes to
     the bugfix workflow.
```

- [ ] **Step 4: Step 8 notes**

Append at the end of the roadmap:

```markdown
## Step 8 notes

Design: [spec](../specs/2026-10-07-client-perf-8-warm-pool-design.md). Decided with the owner on 2026-10-07: a warm
minimum (`min: 3`) over a longer idle timeout or no change, no retry up front, verified on prod.

**Baseline** (prod, 30 h of `rpc timing` logs, 2026-10-06 04:55 to 2026-10-07 09:01 UTC, 614 requests, de-duplicated
by request id). Cold: the request found the pool empty and opened a connection. Warm: it found an idle one.

| | `findActiveById` p50 / p90 | lone requests only |
|---|---|---|
| cold (361) | 21 / 61 ms | 21 / 32 ms (170) |
| warm (196) | 4 / 5 ms | 4 / 5 ms (51) |

| Procedure | cold `totalMs` p50 / p90 | warm |
|---|---|---|
| `sensor/series` | 39 / 152 | 13 / 18 |
| `sensor/listDevices` | 39 / 141 | 16 / 21 |
| `tariff/list` | 85 / 156 | 11 / 20 |
| `evCharging/syncStatuses` | 34 / 154 | 15 / 61 |

- 68% of requests opened a connection. The most common gap between requests is 60 s (the polls).
- Peak connections per burst (280 bursts, requests under 1.5 s apart): 1 in 218, 2 in 5, 3 in 55, 4 in 2.
- How to pull the logs: `vercel logs` caps a call at 5,000 lines and repeats each line many times, so fetch in
  one-hour windows (`--since`/`--until`) with `--environment production --no-branch -q "rpc timing" --json --limit 5000`, then
  de-duplicate by `requestId`.
```

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0025-deferred-route-loading.md docs/superpowers/roadmaps/2026-10-05-client-performance.md
git commit -m "docs(perf): record step 8's warm pool and its checkpoint"
```

---

## After the tasks

1. **Branch review (Phase 5):** `code-reviewer` + a general correctness pass over the whole diff. No schema, service
   or auth change, so no `migration-guard`, `test-completeness` or security pass.
2. **Pre-PR gate (Phase 6):** `bun run check`, `bun run check:ci`, `bun run build`, `bun run db:up && bun run
   db:migrate`, `bun run test`, the sv/en key check (`docs/feature-workflow.md` § Pre-PR gate). No UI change, so no
   browser check.
3. **Ship (Phase 7):** PR `perf(db): keep three pooled connections warm`, body per `.github/PULL_REQUEST_TEMPLATE.md`
   (why, ADR-0025 §5 link, the baseline table, the risk and checkpoint 8). Fill in row 8's PR link in a follow-up
   commit on the branch. Stop there: merge is the owner's call, and checkpoint 8 runs in a later session about 24 h
   after the deploy.

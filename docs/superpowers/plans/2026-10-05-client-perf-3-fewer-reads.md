# Client performance step 3 — fewer, cheaper reads per page: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
> House rule: after each task's commit, two adversarial reviewers (paired below) start from the assumption that the
> task is wrong. Fix or rule on every finding before the next task.

**Goal:** Cut `/charging` from 9 to 6 oRPC requests and `/charging/settings` from 11 to 5, with no `sessionCosts`
waterfall. Look auth up once per HTTP request. Log the DB pool's state on every RPC.

**Architecture:**
- Reads that are one concern become one procedure. Each page picks its part:
  - `syncStatuses` returns every source's health;
  - `recentRuns` returns every source's runs;
  - `sessions` carries its page's costs.
- Queries stay granular per concern, and no transport batching is added.
- The auth middlewares memoize their lookups on a per-HTTP-request object:
  - `/api/rpc` creates one per request;
  - SSR's in-process client keys one on the `Request`.
- The `rpc timing` line gains `poolTotal`, `poolIdle` and `poolWaiting`.

**Tech stack:** oRPC 1.14.8, TanStack Query 5 / Router / Start, Drizzle 0.45 (`node-postgres`), Vitest (node +
browser projects), bun.

**Spec:** `docs/superpowers/specs/2026-10-05-client-perf-3-fewer-reads-design.md`.
**Decision:** ADR-0025 §5 (in this branch).

## Global constraints

- Work in the worktree `.claude/worktrees/perf-fewer-reads`, on branch `perf/fewer-reads-per-page`. Never `cd` to
  the main checkout.
- Services own DB access (ADR-0002). Procedures are thin glue. Log via `~/lib/logger` (`context.log`), never
  `console.*`. Heavier work records `context.timings` sub-timings.
- Client code may only `import type` from services. Shared values live in client-safe modules
  (`~/lib/integrationHealth`).
- Never hold a connection open (ADR-0018). Freshness comes from `refetchInterval` and focus refetch.
- Revocation is still checked on every HTTP request (ADR-0017). The auth memo never outlives one request.
- Cost: missing ≠ 0 kr (ADR-0020). A cost failure shows the dash, never 0 kr.
- No schema change and no migration.
- User-facing text is Paraglide (sv source + en). This step adds no new strings. If a string is removed, remove it
  from both files.
- Conventional Commits, ≤ 72 characters, imperative. End each commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Don't run vitest at the same time as a reviewer does. The shared local DB collides; reviewers must not run
  vitest.

## Review focus

1. **A run on any source switches every health observer to 5 s polling.** The lease caps this at 5 min. Pinned in
   Task 3 (`healthPoll.test.ts`: one running source among four gives 5 s).
2. **Costing throws.** The session rows still render, `costs` is `null`, and the column shows the dash, not a
   placeholder or 0 kr. Pinned in Task 5 by a procedure test, plus the kept `SessionList` test for a row missing
   from loaded costs.
3. **A member reading the merged health never gets any source's `adminDetail`.** Pinned in Task 2 (procedure test
   over all four sources).
4. **A user revoked between two requests is rejected on the second, despite the memo.** A rejected `getSession` is
   shared within one request and never cached across requests. Pinned in Task 6.
5. **A source with no `integration_sync` row** reads as `never_synced`, and its runs are `[]`, not a missing key.
   Pinned in Tasks 2 and 4.

## File map

| File | Change |
|---|---|
| `src/lib/services/integrationSync/integrationSync.ts` (+ `.test.ts`) | `getAllHealth`, `listRecentRunsBySource` |
| `src/lib/orpc/procedures/evCharging.ts` (+ `.test.ts`) | `syncStatuses` (replaces `syncStatus`); `recentRuns` returns a record; `sessions` returns `costs`; `sessionCosts` removed |
| `src/lib/orpc/procedures/tariff.test.ts` | drop the `sessionCosts` cases |
| `src/components/evCharging/syncHealth.ts` (new) | `syncHealthQuery`, `SourceHealth` type |
| `src/components/evCharging/healthPoll.ts` (+ `.test.ts`) | polls on any source's `running` |
| `src/components/evCharging/{SyncHealthAlert,SyncRunsDialog,SyncSourceTile,SyncSourcesPanel,CredentialExpiryAlert,RecentRunsTable,SessionList}.tsx` (+ browser tests) | type imports only (and SessionList's cost type) |
| `src/components/energy/energyQueries.ts` | drop `emaldoHealthQuery` |
| `src/routes/_authenticated/charging/{index,settings,economy,patterns}.tsx`, `energy/index.tsx` | use the merged reads |
| `src/routes/_authenticated/charging/{-vehicleScopePages,-settingsPage}.browser.test.tsx`, `energy/-energyPage.browser.test.tsx` | re-seed the new keys |
| `test/browser/syncHealth.ts` (new) | `seedSourcesHealth` helper |
| `src/lib/orpc/context.ts` (+ `.test.ts`) | `AuthMemo`, `createAuthMemo`, `authMemoFor`, memoized middlewares |
| `src/routes/api/rpc/$.ts`, `src/lib/orpc/client.ts` | pass an `authMemo`; pool gauges in the timing line |
| `src/lib/db/index.ts` (+ `poolStats.test.ts`) | `poolStats()` |
| `docs/superpowers/roadmaps/2026-10-05-client-performance.md` | step 3 row, baseline, checkpoint 3 |

## Reviewer pairings

| Task | Reviewer A | Reviewer B |
|---|---|---|
| 1 Baseline + roadmap | `code-reviewer` (docs accuracy vs. spec) | — (docs only) |
| 2 Merged health read | `code-reviewer` | `test-completeness` |
| 3 Health consumers | `code-reviewer` | general-purpose loading `vercel-react-best-practices` + `web-design-guidelines` |
| 4 Runs per source | `code-reviewer` | `test-completeness` |
| 5 Sessions with costs | `code-reviewer` | general-purpose loading `vercel-react-best-practices` + `web-design-guidelines` |
| 6 Auth memo | `code-reviewer` | general-purpose loading `better-auth-security-best-practices` |
| 7 Pool gauges | `code-reviewer` | `test-completeness` |

---

### Task 1: Set up, re-measure the baseline, update the roadmap

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md`

**Interfaces:** none.

- [ ] **Step 1: Prepare the worktree**

```bash
cd /Users/lukas/prog/videbacken/.claude/worktrees/perf-fewer-reads
bun install
cp ../../../.env .env && cp ../../../.env.local .env.local
grep -c DATABASE_URL .env.local   # must print 0 (CLAUDE.md gotcha: never prod DATABASE_URL locally)
bun run dev:up                     # db + queue + mail + storage, migrates
```

- [ ] **Step 2: Count today's requests per client navigation (local)**

Start a dev server on a spare port: `BETTER_AUTH_URL=http://localhost:14610 bunx vite dev --port 14610 --strictPort`
(run in the background). Then put this script in the session scratchpad as `countRpc.ts`, and run it from the
worktree. It reaches `playwright` through the worktree's `node_modules`.

```ts
// countRpc.ts: sign in through Mailpit, then count /api/rpc requests per client navigation.
import { chromium } from 'playwright'

const BASE = 'http://localhost:14610'
const email = process.env.ADMIN_EMAIL // first address of INITIAL_ADMIN_EMAILS in .env
if (!email) throw new Error('set ADMIN_EMAIL')
const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
await page.goto(`${BASE}/login`)
await page.waitForLoadState('load')
await page.waitForTimeout(4000) // hydration: an earlier click submits the form as a GET
await page.getByLabel('E-post').fill(email)
await page.getByRole('button', { name: 'Skicka inloggningslänk' }).click()
let link: string | undefined
for (let i = 0; i < 30 && !link; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const list = await (await fetch('http://localhost:14602/api/v1/messages')).json()
  const msg = list.messages?.find((m: { To: { Address: string }[] }) =>
    m.To.some((t) => t.Address === email),
  )
  if (msg) {
    const full = await (await fetch(`http://localhost:14602/api/v1/message/${msg.ID}`)).json()
    link = full.Text.match(/https?:\/\/\S*verify\S*/)?.[0]
  }
}
if (!link) throw new Error('no magic link')
await page.goto(link)
await page.waitForTimeout(3000)

async function count(label: string, href: string) {
  const paths: string[] = []
  const onRequest = (req: { url(): string }) => {
    if (req.url().includes('/api/rpc')) paths.push(new URL(req.url()).pathname.replace('/api/rpc/', ''))
  }
  page.on('request', onRequest)
  await page.locator(`a[href="${href}"]`).first().click()
  await page.waitForTimeout(4000)
  page.off('request', onRequest)
  console.log(`${label}: ${paths.length} — ${paths.sort().join(' ')}`)
}
await page.goto(`${BASE}/users`) // start elsewhere, fully loaded, so the next pages are client navigations
await page.waitForTimeout(4000)
await count('/charging', '/charging')
await page.goto(`${BASE}/users`)
await page.waitForTimeout(4000)
await count('/charging/settings', '/charging/settings')
await browser.close()
```

Run: `ADMIN_EMAIL=<address> bun <scratchpad>/countRpc.ts`

Expected, give or take a stale `user/me`:
- `/charging`: 9 requests (`overview`, `sessions`, `costOverview`, `tariff/list`, 3× `syncStatus`, `sessionCosts`,
  `liveStatus`).
- `/charging/settings`: 11.

Write the actual numbers down; Step 3 records them.

- [ ] **Step 3: Update the roadmap**

In `docs/superpowers/roadmaps/2026-10-05-client-performance.md`:

1. Replace row 3 with:
   `| 3 | Fewer, cheaper reads per page (ADR-0025 §5): merge reads per concern (sources' health, runs, sessions + costs), auth looked up once per HTTP request, pool gauges in the timing line | [plan](../plans/2026-10-05-client-perf-3-fewer-reads.md) | — | in progress | — |`
2. Replace checkpoint 3 with:
   > **After step 3 (prod).** An admin `/charging` client navigation makes 6 oRPC requests and `/charging/settings`
   > 5, with no `sessionCosts` waterfall (re-measured baseline in [step 3 notes](#step-3-notes)). The `rpc timing`
   > lines carry `poolTotal`, `poolIdle` and `poolWaiting`. Record what a navigation's burst shows. If the gauges
   > point at opening connections or at queueing, add the pool fix as a new row; otherwise close it.
3. Replace the body of `## Step 3 notes` with:
   - a short paragraph saying the step was re-shaped (#90 moved Datakällor off `/charging`; batching was decided
     against, see ADR-0025 §5 and the spec);
   - the Step 2 counts ("Re-measured 2026-10-05 on `main` at `7b96625`");
   - the prod burst table from the spec's "What the evidence says".

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/roadmaps/2026-10-05-client-performance.md docs/superpowers/plans/2026-10-05-client-perf-3-fewer-reads.md
git commit -m "docs(perf): plan step 3 and re-measure its baseline"
```

---

### Task 2: One health read for every source (service + procedure)

**Files:**
- Modify: `src/lib/services/integrationSync/integrationSync.ts` (after `getHealth`, ~line 230)
- Test: `src/lib/services/integrationSync/integrationSync.test.ts`
- Modify: `src/lib/orpc/procedures/evCharging.ts` (beside `syncStatus`, ~line 172)
- Test: `src/lib/orpc/procedures/evCharging.test.ts`

**Interfaces:**
- Produces: `getAllHealth({ now: Date; includeAdminDetail: boolean }): Promise<Record<IntegrationSource,
  IntegrationHealth>>`.
- Produces: procedure `evCharging.syncStatuses` (protected, no input) → `Record<IntegrationSource,
  IntegrationHealth>`.
- `syncStatus` stays until Task 3 removes it.

- [ ] **Step 1: Write the failing service tests** (append to `integrationSync.test.ts`, and add `getAllHealth` to
  its import list)

```ts
test('getAllHealth reads every source at once; a source with no row is never_synced', async () => {
  await acquire(T0) // Zaptec has a row, with a live lease
  const all = await getAllHealth({ now: at(1000), includeAdminDetail: false })
  expect(Object.keys(all).sort()).toEqual(['elpris', 'emaldo', 'skoda', 'zaptec'])
  expect(all.zaptec).toEqual(
    await getHealth('zaptec', { now: at(1000), includeAdminDetail: false }),
  )
  expect(all.zaptec.running).toBe(true)
  for (const source of ['elpris', 'skoda', 'emaldo'] as const)
    expect(all[source]).toMatchObject({ source, state: 'never_synced', running: false })
})

test('getAllHealth includes adminDetail only when asked', async () => {
  const member = await getAllHealth({ now: T0, includeAdminDetail: false })
  const admin = await getAllHealth({ now: T0, includeAdminDetail: true })
  for (const health of Object.values(member)) expect(health.adminDetail).toBeNull()
  for (const health of Object.values(admin))
    expect(health.adminDetail).toEqual({ lastErrorMessage: null, credentialExpiry: null })
})
```

- [ ] **Step 2: Run them; they fail**

Run: `bunx vitest run src/lib/services/integrationSync/integrationSync.test.ts -t getAllHealth`
Expected: FAIL, `getAllHealth` is not exported.

- [ ] **Step 3: Implement** (in `integrationSync.ts`; add `INTEGRATION_SOURCES` as a **value** import from
  `~/lib/integrationHealth`)

```ts
// Every source's health in one read (≤ 4 rows): the pages show several sources
// at once and poll them together (ADR-0025 §5). A source without a row yet
// reads as never synced, as in `getHealth`.
export async function getAllHealth({
  now,
  includeAdminDetail,
}: {
  now: Date
  includeAdminDetail: boolean
}): Promise<Record<IntegrationSource, IntegrationHealth>> {
  const rows = await db.select().from(integrationSync)
  const bySource = new Map(rows.map((row) => [row.source, row]))
  return Object.fromEntries(
    INTEGRATION_SOURCES.map((source) => [
      source,
      toHealth(source, bySource.get(source), now, includeAdminDetail),
    ]),
  ) as Record<IntegrationSource, IntegrationHealth>
}
```

- [ ] **Step 4: Run the service tests; they pass**

Run: `bunx vitest run src/lib/services/integrationSync/integrationSync.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Write the failing procedure tests** (append to `evCharging.test.ts`)

```ts
test('syncStatuses rejects an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.syncStatuses, undefined, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('syncStatuses hides every source’s adminDetail from a member', async () => {
  await signIn('user')
  const all = await call(evChargingRouter.syncStatuses, undefined, { context: baseContext() })
  expect(Object.keys(all).sort()).toEqual(['elpris', 'emaldo', 'skoda', 'zaptec'])
  for (const health of Object.values(all)) expect(health.adminDetail).toBeNull()
})

test('syncStatuses gives an admin each source’s own state and detail', async () => {
  await signIn('admin')
  await call(evChargingRouter.syncNow, { source: 'elpris' }, { context: baseContext() })
  const all = await call(evChargingRouter.syncStatuses, undefined, { context: baseContext() })
  expect(all.elpris).toMatchObject({ source: 'elpris', state: 'not_configured' })
  expect(all.zaptec).toMatchObject({ source: 'zaptec', state: 'never_synced' })
  expect(all.skoda.adminDetail).toEqual({ lastErrorMessage: null, credentialExpiry: null })
})
```

- [ ] **Step 6: Run them; they fail**

Run: `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts -t syncStatuses`
Expected: FAIL, `syncStatuses` is undefined on the router.

- [ ] **Step 7: Implement the procedure** (in `evCharging.ts`, right after `syncStatus`)

```ts
  // Every source's health in one read: the pages show several sources' alerts
  // and tiles, and poll them together (ADR-0025 §5). Same rule as `syncStatus`:
  // `adminDetail` follows the caller's own role, never client input.
  syncStatuses: protectedProcedure.handler(({ context }) =>
    integrationSyncService.getAllHealth({
      now: new Date(),
      includeAdminDetail: context.user.role === 'admin',
    }),
  ),
```

- [ ] **Step 8: Run the procedure tests; they pass**

Run: `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
bun run check
git add src/lib/services/integrationSync src/lib/orpc/procedures/evCharging.ts src/lib/orpc/procedures/evCharging.test.ts
git commit -m "feat(charging): read every source's sync health in one call"
```

---

### Task 3: Every page reads health through `syncStatuses`; remove `syncStatus`

**Files:**
- Create: `src/components/evCharging/syncHealth.ts`, `test/browser/syncHealth.ts`
- Modify: `src/components/evCharging/healthPoll.ts` (+ `healthPoll.test.ts`)
- Modify: `src/routes/_authenticated/charging/{index,settings,economy,patterns}.tsx`, `src/routes/_authenticated/energy/index.tsx`, `src/components/energy/energyQueries.ts`
- Modify (type only): `src/components/evCharging/{SyncHealthAlert,SyncRunsDialog,SyncSourceTile,SyncSourcesPanel,CredentialExpiryAlert}.tsx` and their `*.browser.test.tsx`
- Modify: `src/lib/orpc/procedures/evCharging.ts` (delete `syncStatus`) + `evCharging.test.ts`
- Modify: `src/routes/_authenticated/charging/{-vehicleScopePages,-settingsPage}.browser.test.tsx`, `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`

**Interfaces:**
- Consumes: `evCharging.syncStatuses` (Task 2).
- Produces: `syncHealthQuery` (query options for `syncStatuses`). `type SourceHealth =
  RouterOutputs['evCharging']['syncStatuses'][IntegrationSource]`.
- Produces: `healthPoll(pending: boolean)` now reads a record of sources.
- Produces: `seedSourcesHealth(qc, overrides?)` for browser tests.

- [ ] **Step 1: Update `healthPoll.test.ts` to the record shape** (it fails first)

```ts
import { expect, test } from 'vitest'
import { healthPoll } from './healthPoll'

type H = { running: boolean }
const q = (data?: Record<string, H>) => ({ state: { data } })
const idle = { zaptec: { running: false }, elpris: { running: false } }

test('polls every 5 s while this tab has a sync pending', () => {
  expect(healthPoll(true)(q(idle))).toBe(5_000)
})
test('polls every 5 s while the server says any source is running', () => {
  expect(healthPoll(false)(q({ ...idle, emaldo: { running: true } }))).toBe(5_000)
})
test('polls every minute otherwise', () => {
  expect(healthPoll(false)(q(idle))).toBe(60_000)
})
test('polls every minute with no data yet', () => {
  expect(healthPoll(false)(q())).toBe(60_000)
})
```

Run: `bunx vitest run src/components/evCharging/healthPoll.test.ts`
Expected: FAIL (the second test: today's poll reads `data.running` on the record, which is `undefined`).

- [ ] **Step 2: Implement `healthPoll` and the shared query**

`src/components/evCharging/healthPoll.ts`:

```ts
// Sync health polls every minute; every 5 s while a run is in flight — seen by
// the server (`running` on any source, a cron run included) or started from
// this tab and not seen yet — so "Synkar…" and the progress bar follow the run
// and clear soon after it ends (a run's lease lasts at most 5 min). One poll
// covers every source: they're one read (ADR-0025 §5).
export const healthPoll =
  (pending: boolean) =>
  (query: { state: { data?: Partial<Record<string, { running: boolean }>> } }) =>
    pending || Object.values(query.state.data ?? {}).some((health) => health?.running)
      ? 5_000
      : 60_000
```

`src/components/evCharging/syncHealth.ts`:

```ts
import type { IntegrationSource } from '~/lib/integrationHealth'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'

/** One source's sync health, as the pages read it. */
export type SourceHealth = RouterOutputs['evCharging']['syncStatuses'][IntegrationSource]

// Every source's health in one read (ADR-0025 §5): one cache entry shared by
// every page, polled by the page that shows it. A page reads its sources with
// `data?.[source]`.
export const syncHealthQuery = orpc.evCharging.syncStatuses.queryOptions()
```

Run: `bunx vitest run src/components/evCharging/healthPoll.test.ts`. Expected: PASS.

- [ ] **Step 3: Point the components' types at `SourceHealth`**

In `SyncHealthAlert.tsx`, `SyncRunsDialog.tsx`, `SyncSourceTile.tsx`, `SyncSourcesPanel.tsx` and their
`*.browser.test.tsx`, replace `type Health = RouterOutputs['evCharging']['syncStatus']` with
`import type { SourceHealth as Health } from './syncHealth'`. Drop the `RouterOutputs` import if it is now unused.

In `CredentialExpiryAlert.tsx`, replace `RouterOutputs['evCharging']['syncStatus']['adminDetail']` with
`SourceHealth['adminDetail']`, imported the same way.

These are type-only edits; `bun run typecheck` must still pass after Step 7.

- [ ] **Step 4: `/charging` (`src/routes/_authenticated/charging/index.tsx`)**

1. Delete the `pricesHealthQuery` and `skodaHealthQuery` constants and their comments (lines ~60–64).
2. In the loader's `critical`, replace `orpc.evCharging.syncStatus.queryOptions(), admin && pricesHealthQuery,
   admin && skodaHealthQuery` with `syncHealthQuery`. Keep the comment above it, reworded for one read:
   ```ts
        // Every source's health (one read) drives the alerts at the top: awaited on
        // the server, so a first load renders them in place. On a client navigation
        // a failing source's alert can appear a moment later (rare, and it needs attention).
        syncHealthQuery,
   ```
   If `admin` (and then `user`) are now unused in the loader, remove them.
3. Replace the three health `useQuery` calls (`healthResult`, `pricesHealthResult`, `skodaHealthResult`) and the
   three `const … = ….data` lines with:
   ```ts
  // Every source's health in one read. Members see only Zaptec's alert, polled
  // at a plain minute; admins also follow "Synkar…" on any source (ADR-0018: polled).
  const healthResult = useQuery({
    ...syncHealthQuery,
    refetchInterval: isAdmin
      ? healthPoll(INTEGRATION_SOURCES.some((source) => syncNow.isPendingFor(source)))
      : 60_000,
  })
  const health = healthResult.data?.zaptec
  // Admin-only until prices are shown on the page (see the alerts below).
  const pricesHealth = isAdmin ? healthResult.data?.elpris : undefined
  const skodaHealth = isAdmin ? healthResult.data?.skoda : undefined
   ```
   Keep `const live = useLiveStatus()` where it is. Imports: add `syncHealthQuery` from
   `~/components/evCharging/syncHealth`, and `INTEGRATION_SOURCES` from `~/lib/integrationHealth`.

- [ ] **Step 5: `/charging/settings` (`settings.tsx`)**

1. Delete `healthQueries`. In the loader's `critical`, use `[syncHealthQuery, orpc.tariff.list.queryOptions()]`.
2. Replace the four health `useQuery` calls, the four `…Health` consts and `sourcesPending` with:
   ```ts
  // Every source's state in one read, polled together (ADR-0018: polled), so a
  // tile's "running" state (a cron run seen mid-flight) clears on its own.
  const healthResult = useQuery({
    ...syncHealthQuery,
    refetchInterval: healthPoll(INTEGRATION_SOURCES.some((source) => syncNow.isPendingFor(source))),
  })
  const sourcesHealth = healthResult.data
  // Datakällor waits for the sources' state: a tile without one would read
  // "Okänd status", which is not the same as still loading (ADR-0016).
  const sourcesPending = firstLoadPending(healthResult)
   ```
3. In the panel's `entries`, use `sourcesHealth?.zaptec`, `sourcesHealth?.elpris`, `sourcesHealth?.skoda` and
   `sourcesHealth?.emaldo`. The Škoda details' `keyExpiry` becomes
   `sourcesHealth?.skoda?.adminDetail?.credentialExpiry ?? null`.

- [ ] **Step 6: Economy, patterns, energy**

- `economy.tsx`:
  - Delete `pricesHealthQuery`. The loader's `critical` becomes `[economyQuery(deps.year, deps.vehicle),
    syncHealthQuery]`.
  - Replace the two health `useQuery` calls with:
    ```ts
  // Every source's health (one read); this page shows Zaptec's and the price feed's.
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.zaptec
  const pricesHealth = sourcesHealth?.elpris
    ```
- `patterns.tsx`:
  - The loader's `critical` swaps `orpc.evCharging.syncStatus.queryOptions()` for `syncHealthQuery`.
  - The component reads it as `const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval:
    60_000 })` and `const health = sourcesHealth?.zaptec`.
- `energy/index.tsx`:
  - The loader's `critical` becomes `[energyOverviewQuery(year), syncHealthQuery]`.
  - The component reads it as `const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval:
    60_000 })` and `const health = sourcesHealth?.emaldo`.
  - Delete `emaldoHealthQuery` from `src/components/energy/energyQueries.ts`, along with its import.

- [ ] **Step 7: Delete the `syncStatus` procedure and its tests**

1. In `evCharging.ts`, delete `syncStatus` and its comment. Move the comment's last sentence ("`includeAdminDetail`
   is a flag derived from the caller's own role, never trusted client input (ADR-0002 amendment)…") onto
   `syncStatuses`. `sourceInput` stays: `syncNow` uses it.
2. In `evCharging.test.ts`:
   - Delete `syncStatus rejects an unauthenticated caller`, `…hides adminDetail…`, `…exposes adminDetail…` and
     `syncStatus rejects an unknown source`.
   - In `syncStatus and recentRuns take a source` and `syncStatus and recentRuns take emaldo`, read health through
     `syncStatuses` (`(await call(evChargingRouter.syncStatuses, undefined, { context: baseContext() })).elpris`),
     and rename each to `syncStatuses and recentRuns …`. Leave their `recentRuns` parts alone; Task 4 rewrites them.

Run: `bun run typecheck`
Expected: errors only in the browser tests (next step), none in `src/` app code.

- [ ] **Step 8: Re-seed the browser tests**

Create `test/browser/syncHealth.ts`:

```ts
import type { QueryClient } from '@tanstack/react-query'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'

const okHealth = (source: IntegrationSource) => ({
  source,
  state: 'ok',
  running: false,
  progress: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
})

/** Seeds the pages' one health read: every source ok, unless overridden (merged over ok). */
export function seedSourcesHealth(
  qc: QueryClient,
  overrides: Partial<Record<IntegrationSource, Record<string, unknown>>> = {},
) {
  qc.setQueryData(
    syncHealthQuery.queryKey,
    Object.fromEntries(
      INTEGRATION_SOURCES.map((source) => [source, { ...okHealth(source), ...overrides[source] }]),
    ) as never,
  )
}
```

Then, in each of the three page tests, replace every use of the old keys:

| Old | New |
|---|---|
| `seedShell` / `seed` setting four `syncStatus` keys with `health(source)` | `seedSourcesHealth(qc)` (drop the `health` helper if it's unused) |
| `qc.setQueryData(<syncStatus skoda key>, { …failing… })` | `seedSourcesHealth(qc, { skoda: { …failing… } })` |
| `pendingForever(qc, <any syncStatus key>)` | `pendingForever(qc, syncHealthQuery.queryKey)` |
| energy: `qc.setQueryData(emaldoHealthQuery.queryKey, X)` | `seedSourcesHealth(qc, { emaldo: X })` (or no override for ok) |
| energy: `qc.removeQueries({ queryKey: emaldoHealthQuery.queryKey })` | `qc.removeQueries({ queryKey: syncHealthQuery.queryKey })` |

Check: `git grep -n "syncStatus\b\|emaldoHealthQuery" src test` prints nothing.

- [ ] **Step 9: Run everything touched**

```bash
bun run typecheck
bunx vitest run src/lib/orpc/procedures/evCharging.test.ts src/components/evCharging/healthPoll.test.ts
bunx vitest run --project browser src/routes/_authenticated src/components/evCharging src/components/energy
```
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
bun run check
git add -A src test
git commit -m "perf(charging): read every source's health with one shared query"
```

---

### Task 4: Every source's recent runs in one read

**Files:**
- Modify: `src/lib/services/integrationSync/integrationSync.ts` (after `listRecentRuns`) + its test
- Modify: `src/lib/orpc/procedures/evCharging.ts` (`recentRuns`) + `evCharging.test.ts`
- Modify: `src/routes/_authenticated/charging/settings.tsx`, `src/components/evCharging/RecentRunsTable.tsx` (type), `-settingsPage.browser.test.tsx`

**Interfaces:**
- Produces: `listRecentRunsBySource({ limit: number }): Promise<Record<IntegrationSource, RunRow[]>>`, newest first
  per source. `listRecentRuns` stays (the sync tests use it).
- Produces: procedure `recentRuns` (admin, input `{ limit?: 1–50, default 20 }`) →
  `Record<IntegrationSource, RunRow[]>`.

- [ ] **Step 1: Write the failing service tests**

```ts
test('listRecentRunsBySource returns each source’s newest runs, at most `limit` each', async () => {
  // Three Zaptec runs and one elpris run, a second apart.
  for (const [i, source] of (['zaptec', 'zaptec', 'zaptec', 'elpris'] as const).entries()) {
    const lease = await beginAttempt(source, { now: at(i * 1000) })
    if (!lease.acquired) throw new Error('expected the lease')
    await recordOutcome(source, ok, {
      attemptId: lease.attemptId,
      trigger: 'cron',
      startedAt: at(i * 1000),
      now: at(i * 1000 + 500),
    })
  }
  const runs = await listRecentRunsBySource({ limit: 2 })
  expect(Object.keys(runs).sort()).toEqual(['elpris', 'emaldo', 'skoda', 'zaptec'])
  expect(runs.zaptec.map((r) => r.startedAt)).toEqual([at(2000), at(1000)])
  expect(runs.elpris.map((r) => r.startedAt)).toEqual([at(3000)])
  expect(runs.skoda).toEqual([])
  expect(runs.emaldo).toEqual([])
  // Same row shape as the single-source read.
  expect(runs.zaptec[0]).toEqual((await listRecentRuns('zaptec', { limit: 1 }))[0])
})
```

(Add `listRecentRunsBySource` to the test's import list.)

Run: `bunx vitest run src/lib/services/integrationSync/integrationSync.test.ts -t listRecentRunsBySource`
Expected: FAIL, not exported.

- [ ] **Step 2: Implement it.** Use one `LATERAL` query. Check the exact `innerJoinLateral` syntax for Drizzle 0.45
  in Context7 (`/drizzle-team/drizzle-orm-docs`, "lateral join") before writing it. Expected shape:

```ts
// Each source's last `limit` runs, newest first, in one query (the settings
// page's histories, ADR-0025 §5): for each source's sync row, a LATERAL
// subquery reads that source's top runs off integration_sync_run_source_started_idx.
// A source without a sync row has never run, so it gets [].
export async function listRecentRunsBySource({
  limit,
}: {
  limit: number
}): Promise<Record<IntegrationSource, RunRow[]>> {
  const recent = db
    .select({
      id: integrationSyncRun.id,
      trigger: integrationSyncRun.trigger,
      startedAt: integrationSyncRun.startedAt,
      finishedAt: integrationSyncRun.finishedAt,
      durationMs: integrationSyncRun.durationMs,
      outcome: integrationSyncRun.outcome,
      errorCode: integrationSyncRun.errorCode,
      errorMessage: integrationSyncRun.errorMessage,
      upserted: integrationSyncRun.upserted,
      sessionsSeen: integrationSyncRun.sessionsSeen,
      pages: integrationSyncRun.pages,
    })
    .from(integrationSyncRun)
    .where(eq(integrationSyncRun.source, integrationSync.source))
    .orderBy(desc(integrationSyncRun.startedAt))
    .limit(limit)
    .as('recent')
  const rows = await db
    .select({ source: integrationSync.source, run: recent })
    .from(integrationSync)
    .innerJoinLateral(recent, sql`true`)
  const bySource = Object.fromEntries(
    INTEGRATION_SOURCES.map((source) => [source, [] as RunRow[]]),
  ) as Record<IntegrationSource, RunRow[]>
  for (const { source, run } of rows) {
    bySource[source as IntegrationSource]?.push(toRunRow(run))
  }
  return bySource
}
```

Extract the mapping that `listRecentRuns` does today into `toRunRow(r)`, and use it in both functions (DRY):

```ts
type RunSelect = Omit<RunRow, 'trigger' | 'outcome' | 'errorCode'> & {
  trigger: string
  outcome: string
  errorCode: string | null
}
const toRunRow = (r: RunSelect): RunRow => ({
  ...r,
  trigger: r.trigger as SyncTrigger,
  outcome: r.outcome as RunRow['outcome'],
  errorCode: r.errorCode as IntegrationErrorCode | null,
})
```

The lateral rows come back in an unspecified order across sources. Within a source, `ORDER BY` inside the subquery
gives no ordering guarantee once joined. So sort each source's array by `startedAt` descending before returning
(`bySource[s].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())`). If Drizzle can't select a nested
subquery object (`run: recent`), select the columns flat (`id: recent.id`, …) and build the row in the loop.

Run the service tests. Expected: PASS.

- [ ] **Step 3: Rewrite the procedure tests** (in `evCharging.test.ts`)

- `recentRuns rejects an unauthenticated caller` / `…is forbidden for a non-admin user`: keep, with input
  `{ limit: 20 }`.
- `recentRuns returns the (empty) run history for an admin` becomes:
  ```ts
  const runs = await call(evChargingRouter.recentRuns, {}, { context: baseContext() })
  expect(runs).toEqual({ zaptec: [], elpris: [], skoda: [], emaldo: [] })
  ```
- In `syncStatuses and recentRuns take a source`, the runs part becomes:
  ```ts
  const runs = await call(evChargingRouter.recentRuns, {}, { context: baseContext() })
  expect(runs.elpris).toHaveLength(1)
  expect(runs.elpris[0]).toMatchObject({ trigger: 'admin', errorCode: 'not_configured' })
  // Only the price sync ran, so Zaptec's history is empty.
  expect(runs.zaptec).toHaveLength(0)
  ```
- The emaldo variant: `expect(runs.emaldo).toHaveLength(1)` with the same `toMatchObject`.
- Add one test: `recentRuns rejects a limit outside 1–50` (`{ limit: 0 }` and `{ limit: 51 }` both reject with
  `BAD_REQUEST`).

Run them. Expected: FAIL (the old procedure still returns an array).

- [ ] **Step 4: Implement the procedure**

```ts
  // Each source's last runs in one read (the settings page's histories, ADR-0025 §5).
  recentRuns: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }))
    .handler(({ input }) =>
      integrationSyncService.listRecentRunsBySource({ limit: input.limit }),
    ),
```

Run the procedure tests. Expected: PASS.

- [ ] **Step 5: Settings page**

```ts
const runsQuery = orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } })
```

- Replace `runsQueries`. In the loader's `deferred`, use `[runsQuery, vehicleCoverageQuery, vehicleLatestQuery]`.
- In the component, replace the four runs `useQuery`s with four `select` observers of the one query. They share one
  cache entry and one fetch, and each keeps the full query result that `RunsQuery` expects (`data`,
  `errorUpdateCount`, `refetch`, …):
  ```ts
  // Every source's history is one read; each tile reads its own slice, and a
  // failed read shows on each history with its retry.
  const zaptecRuns = useQuery({ ...runsQuery, select: (runs) => runs.zaptec })
  const pricesRuns = useQuery({ ...runsQuery, select: (runs) => runs.elpris })
  const skodaRuns = useQuery({ ...runsQuery, select: (runs) => runs.skoda })
  const emaldoRuns = useQuery({ ...runsQuery, select: (runs) => runs.emaldo })
  ```
- `RecentRunsTable.tsx`: `export type Run = RouterOutputs['evCharging']['recentRuns'][IntegrationSource][number]`
  (import `IntegrationSource` as a type).

- [ ] **Step 6: Re-seed `-settingsPage.browser.test.tsx`**

- The four per-source runs keys become one:
  `qc.setQueryData(runsKey, { zaptec: [], elpris: [], skoda: [], emaldo: [] })`, with
  `const runsKey = orpc.evCharging.recentRuns.queryOptions({ input: { limit: 20 } }).queryKey`.
- Seed it only when `opts.adminReads !== false`.
- The member test's `getQueryState(...)` assertion uses `runsKey`.

Run:
```bash
bun run typecheck
bunx vitest run src/lib/services/integrationSync src/lib/orpc/procedures/evCharging.test.ts
bunx vitest run --project browser src/routes/_authenticated/charging src/components/evCharging
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
bun run check
git add -A src test
git commit -m "perf(charging): read every source's recent runs in one call"
```

---

### Task 5: Sessions carry their page's costs; remove `sessionCosts`

**Files:**
- Modify: `src/lib/orpc/procedures/evCharging.ts` (`sessions`, `sessionCosts`) + `evCharging.test.ts`
- Modify: `src/lib/orpc/procedures/tariff.test.ts`
- Modify: `src/routes/_authenticated/charging/index.tsx`, `src/components/evCharging/SessionList.tsx` (+ `SessionList.browser.test.tsx`), `-vehicleScopePages.browser.test.tsx`

**Interfaces:**
- Produces: `evCharging.sessions` → `SessionPage & { costs: SessionCost[] | null }`. `SessionCost` is from
  `~/lib/evCharging/costing`. `null` means costing failed.
- Removes: `evCharging.sessionCosts`.
- Timings: `sessionsMs` (whole call), `sessionsCountMs`, `sessionCostsMs` (cost part), and `cost*` sub-timings
  (`costEnergyMs`, `costMixMs`, …).

- [ ] **Step 1: Write the failing procedure tests** (in `evCharging.test.ts`)

1. Change `sessions returns an empty first page…` to expect
   `{ sessions: [], total: 0, page: 1, pageSize: 10, costs: [] }`.
2. Change the test around line 674 (it called `sessionCosts` for `row.id`) to read the cost from the page:
   ```ts
  const listTimings: Record<string, number> = {}
  const listed = await call(
    evChargingRouter.sessions,
    { page: 1, pageSize: 10 },
    { context: { ...baseContext(), timings: listTimings } },
  )
  const listedCost = listed.costs?.find((c) => c.sessionId === row.id)
  expect(listedCost?.totalSek).toBeCloseTo(result.cost.totalSek, 9)
  expect(listTimings).toMatchObject({ costMixMs: expect.any(Number), sessionCostsMs: expect.any(Number) })
   ```
3. Delete `sessionCosts takes at most one page of ids`.
4. Add a test for a cost failure. Add `import * as costing from '~/lib/evCharging/costing'` at the top:
   ```ts
test('sessions keeps its rows when costing fails: costs is null, never 0 kr', async () => {
  await signIn('user')
  await insertSession() // helper further down this file; hoist the call below its declaration if needed
  vi.spyOn(costing, 'getSessionCosts').mockRejectedValueOnce(new Error('prices down'))
  const page = await call(
    evChargingRouter.sessions,
    { page: 1, pageSize: 10 },
    { context: baseContext() },
  )
  expect(page.sessions).toHaveLength(1)
  expect(page.costs).toBeNull()
})
   ```
   Place this test after `insertSession`'s declaration, since it uses that helper. If the spy doesn't intercept
   (the procedure's named import was not rewritten), use `vi.mock('~/lib/evCharging/costing', async (orig) =>
   ({ ...(await orig()), getSessionCosts: vi.fn(…) }))` scoped to a separate test file
   `src/lib/orpc/procedures/sessionsCostFailure.test.ts` instead.

In `tariff.test.ts`:
- `costOverview and sessionCosts are readable…` becomes `costOverview is readable by users and records cost
  sub-timings`; delete its two `sessionCosts` calls.
- In `cost procedures reject anonymous callers and out-of-range input`, delete the `tooMany` / `sessionCosts` lines.

Run: `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts src/lib/orpc/procedures/tariff.test.ts`
Expected: FAIL (`costs` is missing; `sessionCosts` is still defined, which is fine).

- [ ] **Step 2: Implement** (in `evCharging.ts`: replace `sessions`' handler, delete `sessionCosts`; import
  `type SessionCost` from `~/lib/evCharging/costing`)

```ts
  // One page of the session list (count + page + peaks → `sessionsCountMs`
  // beside the whole call's `sessionsMs`), with the page's cash cost (stored
  // solar/battery mix: `cost*`, total `sessionCostsMs`). One read, so the list
  // never waits on a second round trip (ADR-0025 §5). A cost failure keeps the
  // rows: `costs` is null and the cost column shows its dash (ADR-0020: never
  // 0 kr). A page past the end comes back as the last page, with its number in `page`.
  sessions: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1).max(MAX_SESSION_PAGE),
        pageSize: sessionPageSize,
        vehicle: vehicleInput,
      }),
    )
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const timings: SessionListTimings = {}
      const page = await evChargingService.listSessions({
        page: input.page,
        pageSize: input.pageSize,
        vehicle: input.vehicle,
        timings,
      })
      const costStart = performance.now()
      const costTimings: CostTimings = {}
      let costs: SessionCost[] | null
      try {
        costs = await getSessionCosts({
          sessionIds: page.sessions.map((s) => s.id),
          timings: costTimings,
        })
      } catch (error) {
        context.log.warn('session costs failed; the list shows none', { error })
        costs = null
      }
      if (context.timings) {
        context.timings.sessionCostsMs = Math.round(performance.now() - costStart)
        context.timings.sessionsMs = Math.round(performance.now() - startedAt)
      }
      recordPrefixedTimings(context.timings, 'sessions', timings)
      recordPrefixedTimings(context.timings, 'cost', costTimings)
      return { ...page, costs }
    }),
```

`MAX_SESSION_PAGE_SIZE` may now be unused in this file; remove its import if so.

Run the two procedure test files. Expected: PASS.

- [ ] **Step 3: `/charging` page**

In `index.tsx`:
1. Delete `sessionCostsQuery`. Delete the loader's tail after `await loadRouteData(...)` (the
   `environmentManager.isServer()` check and the costs prefetch), and its comment. Drop `environmentManager` from
   the import if it is now unused. In the loader's opening comment, change "The sessions' costs are deferred
   (below)." to "The sessions bring their costs."
2. Replace `sessionIds`, `sessionCostsResult`, `sessionCostList`, `sessionCostsPending` and the `sessionCosts`
   `useMemo` with:
   ```ts
  // The cost column for the rows on screen: each page brings its own costs
  // (null when costing failed: the column's dash, never 0 kr — ADR-0020).
  const sessionCosts = useMemo(
    () => new Map(shownSessions?.costs?.map((c) => [c.sessionId, c])),
    [shownSessions],
  )
   ```
   and pass `costs={showCost ? { byId: sessionCosts, pending: false } : undefined}` to `SessionList`.
3. `SessionList.tsx` and `SessionList.browser.test.tsx`: `type SessionCost` becomes
   `NonNullable<RouterOutputs['evCharging']['sessions']['costs']>[number]`.
4. Run `git grep -n "pending" src/components/evCharging/SessionList.tsx` and `git grep -n "<SessionList"`. If every
   call site now passes `pending: false`, remove:
   - the `pending` field;
   - `SessionCostCell`'s placeholder branch and its `Skeleton` import;
   - the `charging_sessions_cost_loading` key from both `messages/sv.json` and `messages/en.json`;
   - the browser test case that covers that placeholder.

   Otherwise leave them.

- [ ] **Step 4: Re-seed `-vehicleScopePages.browser.test.tsx`**

- `seedSessionsPage` adds `costs: []` to the seeded page. Do the same for every other seeded `sessions` value: grep
  `evCharging.sessions.queryOptions` in the file.
- In `Översikt: ?page=2 … prefetch` (≈ line 790), delete the `sessionCosts` `toContain` expectation.
- The UI side of a cost failure needs no new page test. `costs: null` becomes an empty `byId` map, and
  `SessionList.browser.test.tsx` already pins that a row missing from loaded costs shows the dash with
  `m.charging_sessions_cost_unknown()` ("a session missing from loaded costs (e.g. the query failed) says the cost
  is missing", ≈ line 183). Keep that test. If Step 3 removed `pending`, it no longer passes `pending`.

Run:
```bash
bun run typecheck
bunx vitest run --project browser src/routes/_authenticated/charging src/components/evCharging
```
Expected: PASS. Then run `git grep -n "sessionCosts" src test` and confirm it prints nothing.

- [ ] **Step 5: Commit**

```bash
bun run check
git add -A src test messages
git commit -m "perf(charging): load each session page with its costs in one call"
```

---

### Task 6: Look auth up once per HTTP request

**Files:**
- Modify: `src/lib/orpc/context.ts`, `src/routes/api/rpc/$.ts`, `src/lib/orpc/client.ts`
- Test: `src/lib/orpc/context.test.ts`

**Interfaces:**
- Produces:
  - `type AuthMemo = { session?: Promise<Session>; activeUsers: Map<string, Promise<UserRow | null>> }`;
  - `createAuthMemo(): AuthMemo`;
  - `authMemoFor(request: Request): AuthMemo`;
  - the optional `authMemo` field on the base context.

- [ ] **Step 1: Write the failing tests** (append to `context.test.ts`; import `createAuthMemo` and `authMemoFor`
  from `./context`, `* as userService` from `~/lib/services/user`, and `eq` from `drizzle-orm`)

```ts
async function activeUser(role: 'user' | 'admin' = 'user') {
  const [row] = await db
    .insert(user)
    .values({ name: 'Memo', email: `memo-${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role })
  return row
}

test('one HTTP request looks the session and the user up once, however many calls it makes', async () => {
  await activeUser()
  const getSession = vi.mocked(auth.api.getSession)
  const findActiveById = vi.spyOn(userService, 'findActiveById')
  const authMemo = createAuthMemo()
  await call(echo, undefined, { context: { ...baseContext(), authMemo } })
  await call(adminEcho, undefined, { context: { ...baseContext(), authMemo } }).catch(() => {})
  await call(echo, undefined, { context: { ...baseContext(), authMemo } })
  expect(getSession).toHaveBeenCalledTimes(1)
  expect(findActiveById).toHaveBeenCalledTimes(1)
  // The next request looks both up again.
  await call(echo, undefined, { context: { ...baseContext(), authMemo: createAuthMemo() } })
  expect(getSession).toHaveBeenCalledTimes(2)
  expect(findActiveById).toHaveBeenCalledTimes(2)
})

test('a user revoked between two requests is rejected on the second', async () => {
  const row = await activeUser()
  await expect(
    call(echo, undefined, { context: { ...baseContext(), authMemo: createAuthMemo() } }),
  ).resolves.toBe('ok')
  await db.update(user).set({ deletedAt: new Date() }).where(eq(user.id, row.id))
  await expect(
    call(echo, undefined, { context: { ...baseContext(), authMemo: createAuthMemo() } }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('a failed session lookup fails every call of that request, and the next request retries', async () => {
  await activeUser()
  vi.mocked(auth.api.getSession).mockRejectedValueOnce(new Error('auth down'))
  const authMemo = createAuthMemo()
  await expect(call(echo, undefined, { context: { ...baseContext(), authMemo } })).rejects.toThrow()
  await expect(call(echo, undefined, { context: { ...baseContext(), authMemo } })).rejects.toThrow()
  await expect(
    call(echo, undefined, { context: { ...baseContext(), authMemo: createAuthMemo() } }),
  ).resolves.toBe('ok')
})

test('without a memo every call looks up (tests, scripts)', async () => {
  await activeUser()
  const findActiveById = vi.spyOn(userService, 'findActiveById')
  await call(echo, undefined, { context: baseContext() })
  await call(echo, undefined, { context: baseContext() })
  expect(findActiveById).toHaveBeenCalledTimes(2)
})

test('only the call that ran a lookup records its timing', async () => {
  await activeUser()
  const authMemo = createAuthMemo()
  const first: Record<string, number> = {}
  const second: Record<string, number> = {}
  await call(echo, undefined, { context: { ...baseContext(), authMemo, timings: first } })
  await call(echo, undefined, { context: { ...baseContext(), authMemo, timings: second } })
  expect(first).toMatchObject({ getSessionMs: expect.any(Number), findActiveByIdMs: expect.any(Number) })
  expect(second).toEqual({})
})

test('authMemoFor gives every call of one SSR request the same memo', () => {
  const a = new Request('http://localhost/charging')
  const b = new Request('http://localhost/charging')
  expect(authMemoFor(a)).toBe(authMemoFor(a))
  expect(authMemoFor(a)).not.toBe(authMemoFor(b))
})
```

Run: `bunx vitest run src/lib/orpc/context.test.ts`
Expected: FAIL (`createAuthMemo` is not exported).

- [ ] **Step 2: Implement in `context.ts`**

```ts
type ActiveUser = Awaited<ReturnType<typeof userService.findActiveById>>

// The auth lookups of one HTTP request, shared by every procedure call it
// makes (an SSR render's loader calls run in-process, several per request).
// It never outlives the request, so a revoked user is still rejected on the
// next one (ADR-0017); a cross-request cache would delay that (ADR-0025 §5).
// A failed lookup stays failed for the rest of its request.
export type AuthMemo = {
  session?: Promise<Session>
  activeUsers: Map<string, Promise<ActiveUser>>
}

export const createAuthMemo = (): AuthMemo => ({ activeUsers: new Map() })

// SSR's in-process client builds a context per call; the incoming Request
// is what one render's calls share. Weak, so a memo goes with its request.
const ssrMemos = new WeakMap<Request, AuthMemo>()
export function authMemoFor(request: Request): AuthMemo {
  let memo = ssrMemos.get(request)
  if (!memo) {
    memo = createAuthMemo()
    ssrMemos.set(request, memo)
  }
  return memo
}
```

Add `authMemo?: AuthMemo` to `base`'s context type. Then:

```ts
const sessionMiddleware = base.middleware(async ({ context, next }) => {
  const memo = context.authMemo
  const cached = memo?.session
  const startedAt = performance.now()
  const pending = cached ?? auth.api.getSession({ headers: context.headers })
  if (memo && !cached) memo.session = pending
  const data = await pending
  // Timed only by the call that ran it: a reused lookup cost nothing.
  if (context.timings && !cached)
    context.timings.getSessionMs = Math.round(performance.now() - startedAt)
  // … unchanged: user, log, next({ context: { session, user, log } })
})
```

In `requireAuth`, add `authMemo?: AuthMemo` to its `$context<…>`, and replace the lookup with:

```ts
    const memo = context.authMemo
    const cached = memo?.activeUsers.get(context.user.id)
    const startedAt = performance.now()
    const pending = cached ?? userService.findActiveById(context.user.id)
    if (memo && !cached) memo.activeUsers.set(context.user.id, pending)
    const activeUser = await pending
    if (context.timings && !cached)
      context.timings.findActiveByIdMs = Math.round(performance.now() - startedAt)
```

Keep the long comment above it, and add one line: "Memoized per HTTP request (`authMemo`), never across requests."

- [ ] **Step 3: Pass a memo from both entry points**

- `src/routes/api/rpc/$.ts`: `context: { headers: request.headers, log, requestId, timings, authMemo:
  createAuthMemo() }`, importing `createAuthMemo` from `~/lib/orpc/context`.
- `src/lib/orpc/client.ts`, in the server branch's `context`:
  ```ts
        // One render's calls share one auth lookup (ADR-0025 §5).
        return { headers: request.headers, log, requestId, authMemo: authMemoFor(request) }
  ```
  Import `authMemoFor` from `./context`. The router (`./router`) already imports it on the server; check that
  `bun run build` doesn't pull it into a client chunk (Task 8 Step 2 greps the client output).

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/lib/orpc` → PASS. Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/orpc src/routes/api/rpc
git commit -m "perf(auth): look up the session once per HTTP request"
```

---

### Task 7: Pool gauges in the `rpc timing` line

**Files:**
- Modify: `src/lib/db/index.ts`, `src/routes/api/rpc/$.ts`
- Test: `src/lib/db/poolStats.test.ts` (new)

**Interfaces:**
- Produces: `poolStats(): { poolTotal: number; poolIdle: number; poolWaiting: number }`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest'
import { db, poolStats } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'

setupDatabase()

test('poolStats reports the pool’s connections and waiters', async () => {
  await db.select().from(user).limit(1)
  const stats = poolStats()
  expect(stats).toEqual({
    poolTotal: expect.any(Number),
    poolIdle: expect.any(Number),
    poolWaiting: expect.any(Number),
  })
  // The query above opened (and released) the pinned test connection.
  expect(stats.poolTotal).toBeGreaterThanOrEqual(1)
  expect(stats.poolWaiting).toBe(0)
})
```

Run: `bunx vitest run src/lib/db/poolStats.test.ts`. Expected: FAIL (`poolStats` is not exported).

- [ ] **Step 2: Implement** (in `src/lib/db/index.ts`, after `pool.on('error', …)`)

```ts
// The pool's state for the `rpc timing` line (ADR-0025 §5): at a request's
// start, how many connections are open, idle, and how many checkouts wait.
// A burst that opens connections (total < 10, idle 0) and one that queues
// (waiting > 0) need different fixes. Counters only — not a query.
export const poolStats = () => ({
  poolTotal: pool.totalCount,
  poolIdle: pool.idleCount,
  poolWaiting: pool.waitingCount,
})
```

In `src/routes/api/rpc/$.ts`, read it before `handler.handle`, and spread it into the log line after `...timings`:

```ts
        // The pool as this request found it (ADR-0025 §5): connecting vs waiting.
        const pool = poolStats()
        …
          ...timings,
          ...pool,
```

Update the `rpc timing` comment to mention the pool fields. Import `poolStats` from `~/lib/db`. This is the one
`~/lib/db` import in a route; it reads counters, not data, which the spec agreed.

- [ ] **Step 3: Run**

Run: `bunx vitest run src/lib/db/poolStats.test.ts` → PASS. Then `bun run typecheck` → clean.

- [ ] **Step 4: Commit**

```bash
bun run check
git add src/lib/db src/routes/api/rpc
git commit -m "perf(rpc): log the DB pool's state with each RPC timing"
```

---

### Task 8: Verify end to end, update the roadmap, open the PR

- [ ] **Step 1: Pre-PR gate** (`docs/feature-workflow.md`): `bun run check`, `bun run check:ci`, `bun run build`,
  `bun run db:up && bun run db:migrate`, `bun run test`, and the sv/en key check. Every one must pass; paste the
  output into the PR.

- [ ] **Step 2: The client bundle doesn't carry server auth**

Run: `grep -l "findActiveById\|authMemoFor\|ssrMemos" .output/public/assets/*.js || echo "none in client chunks"`
Expected: `none in client chunks`.

- [ ] **Step 3: Request counts after the change**

Re-run Task 1's `countRpc.ts` against a dev server started from this branch.
Expected:
- `/charging`: 6 (`overview`, `sessions`, `costOverview`, `tariff/list`, `syncStatuses`, `liveStatus`).
- `/charging/settings`: 5 (`syncStatuses`, `tariff/list`, `recentRuns`, `vehicleRecordCoverage`,
  `vehicleStateLatest`).
- Plus `user/me` if stale.

- [ ] **Step 4: One auth lookup per SSR load (temporary probe, not committed)**

1. Add `context.log.info('auth probe: getSession ran')` inside the `!cached` path of `sessionMiddleware`, and
   `…findActiveById ran` in `requireAuth`.
2. Start the dev server and save the signed-in `storageState` from `countRpc.ts` (`await
   ctx.storageState({ path })`).
3. Load `http://localhost:14610/charging` as a full page load (`page.goto`), and count the probe lines in the
   server output for that request.

Expected: 1 of each for the in-process loader calls. `beforeLoad`'s `getSession` server function is separate and
not counted. Remove the probe and confirm `git diff` is clean.

- [ ] **Step 5: Live UI check** (desktop 1280, tablet 768, mobile 375; light and dark)

Check, as an admin:
- `/charging`: alerts, totals, the session list with its cost column, and paging to page 2 (rows dim, then show
  costs).
- `/charging/settings`: every tile, one history overlay, "Synka nu" switching tiles to "Synkar…" and back.
- `/charging/economy`, `/charging/patterns`, `/energy`: the health lines and alerts.

Then as a member, check that `/charging` shows only Zaptec's alert.

The layout is unchanged, so no `bones:capture` is needed. If any skeleton looks off, compare it with `main` before
re-capturing.

- [ ] **Step 6: Roadmap row** → `PR open` with the PR link (after Step 7 creates it). Commit
  `docs(perf): link step 3's PR`.

- [ ] **Step 7: Open the PR** with `.github/PULL_REQUEST_TEMPLATE.md`. Title: `perf(charging): fewer, cheaper
  reads per page`. The body:
  - links ADR-0025 §5, the spec and the plan;
  - lists the research sources from the spec's evidence (the step-3 research brief: TanStack request waterfalls,
    TkDodo, the oRPC batch docs, the tRPC links, react.dev Suspense, NN/g, Vercel Fluid pricing, node-postgres
    pool);
  - says that there is no migration;
  - pastes the Step 1 and Step 3 outputs.

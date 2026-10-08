# Server latency step 5: a paged economy session list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/charging/economy` loads its tiles and charts from `evCharging/economy` and its session table from a new
server-paged `evCharging/economySessions` (slim rows); both session lists prefetch pages from their pagination
controls.

**Architecture:** Parallel change. First add the paged read model and procedure beside today's. Then switch the
route and the table to them, and only then remove `sessions` from the overview. Prefetching lives in the shared
`SessionPagination`, plus a small hook that eagerly fetches the next page. `/charging` wires both.

**Tech Stack:** oRPC + TanStack Query (`queryOptions`, `prefetchQuery`, `keepPreviousData`), TanStack Router
(`loaderDeps`, `location.search`), Vitest node project (per-test Postgres schema) and browser project.

**Spec:** [`docs/superpowers/specs/2026-10-08-economy-paged-sessions-design.md`](../specs/2026-10-08-economy-paged-sessions-design.md).
Roadmap: [server latency](../roadmaps/2026-10-07-server-latency.md), row 5. One session, one PR. PR title:
`perf(charging): page the economy session list on the server`.

## Global Constraints

- **Paging.** `page` and `size` never become `loaderDeps`. The loader reads them from `location.search` with
  `sessionPagingSearch.parse` (ADR-0025, as `/charging`).
- **Procedures.** Reads are `protectedProcedure`. Heavier work records `context.timings` sub-timings, prefixed
  `economySessions`.
- **Imports.** Client code may only `import type` from services. Shared row types and pure mappers go in the
  client-safe `src/lib/evCharging/economy/`.
- **Copy.** User-facing text comes from Paraglide (`messages/{sv,en}.json`). Reuse existing keys; no new copy is
  planned.
- **Money (ADR-0020).** Never render kronor for an incomplete cost: `actualSek` is null then, and the table shows
  "—".
- **Layout.** Every screen is responsive. Check desktop, tablet and mobile live (browser tests have no `app.css`).
- **Commits.** Conventional Commits ≤ 72 chars, one hat per commit, ending with the session's Co-Authored-By line.
- **Tests.** Before any `vitest` run, `pgrep -fl vitest` must be empty: concurrent runs collide on the shared DB.
  Reviewers never run vitest.

## Review Focus

1. **A year or scope switch while on page 3.** The list resets to page 1, keeps the old rows dimmed, and never
   shows another scope's rows as this one's after a failed load. Owned by Task 3, which copies `/charging`'s
   `lastLoaded` rule.
2. **A shared or stale `?page=99`.** It serves the last page, and the pagination shows that page, not 99. Owned by
   Task 1 (read model) and Task 3 (render from the served `page`).
3. **The list loads but the overview fails, or the other way round.** Each shows its own alert. A failed list never
   reads as "no sessions". Owned by Task 3.
4. **Hovering the current page, an ellipsis or a disabled arrow.** No prefetch. Hovering the same page twice
   within 20 s makes no new request. Owned by Task 5.
5. **The last page.** The eager next-page prefetch does nothing past the end and on a placeholder. Owned by Task 5.

---

### Task 0: Isolate, verify main, re-measure the baseline

**Files:** none committed. A throwaway `.measure-economy.ts` in the worktree root is deleted afterwards.

- [ ] **Step 1: Worktree.** `superpowers:using-git-worktrees` (native `EnterWorktree`). Branch
  `perf/economy-paged-sessions` from `origin/main`. Copy `.env` from the main checkout (never `.env.local`). Run
  `bun install`.
- [ ] **Step 2: Verify main still matches the plan.**
  - `getEconomyOverview` in `src/lib/evCharging/chargingEconomy.ts` returns `sessions: rows.toReversed()`.
  - `EconomySessionsCard` in `src/routes/_authenticated/charging/economy.tsx` slices with `pageSlice`.
  - `SessionPagination` has no `prefetchPage` prop.
- [ ] **Step 3: Local payload baseline.** Write the throwaway script:

```ts
// .measure-economy.ts — throwaway, never commit
import { gzipSync } from 'node:zlib'
import { getEconomyOverview } from '~/lib/evCharging/chargingEconomy'

const kb = (x: unknown) => {
  const s = JSON.stringify(x)
  return `${(s.length / 1024).toFixed(1)} KB (gz ${(gzipSync(s).length / 1024).toFixed(1)})`
}
const o = await getEconomyOverview({ year: 2026, now: new Date('2026-10-08T08:00:00Z') })
console.log(`economy ${kb(o)}; sessions ${o.sessions.length}`)
process.exit(0)
```

  Run `LOG_LEVEL=error bun run ./.measure-economy.ts`. Record the result; on 2026-10-08 it was 227.6 KB (gz 21.4)
  for 208 sessions. Keep the script for Task 6.
- [ ] **Step 4: Prod baseline.** Record the last 24 h of `evCharging/economy` `rpc timing` lines from Vercel runtime
  logs (project `prj_8MG0PGBp5OCoa09qvHSkWVt9EjEg`, team `team_ipjl15fK8NbQoalWg86ZAb7o`): `totalMs` and the
  `economy*Ms` sub-timings. The owner's DevTools showed 12.8 kB and 363 ms.

### Task 1: The paged read model

**Files:**
- Create: `src/lib/evCharging/economy/listRow.ts`, `src/lib/evCharging/economy/listRow.test.ts`
- Modify: `src/lib/evCharging/economy/index.ts` (export), `src/lib/evCharging/chargingEconomy.ts`,
  `src/lib/evCharging/chargingEconomy.test.ts`

**Interfaces:**
- Produces (client-safe, `~/lib/evCharging/economy`):
  - `type EconomyListRow`
  - `toEconomyListRow(session: ListRowSession, economy: SessionEconomy): EconomyListRow`
- Produces (server, `~/lib/evCharging/chargingEconomy`):
  - `type EconomySessionsTimings = { energyMs?; tariffMs?; slotsMs?; computeMs? }`
  - `type EconomySessionsPage = { page: number; pageSize: number; total: number; rows: EconomyListRow[] }`
  - `getEconomySessions(input: { year?: number; now?: Date; vehicle?: VehicleScope; page: number; pageSize: number; timings?: EconomySessionsTimings }): Promise<EconomySessionsPage>`

- [ ] **Step 1: Write the failing pure test** (`src/lib/evCharging/economy/listRow.test.ts`):

```ts
import { expect, test } from 'vitest'
import { emptyTotals } from '~/lib/evCharging/cost'
import { toEconomyListRow } from './listRow'
import type { SessionEconomy } from './types'

const session = {
  sessionId: 's1',
  startAt: new Date('2026-09-05T19:10:00Z'),
  endAt: new Date('2026-09-06T05:02:00Z'),
  energyKwh: 32.1,
  vehicle: 'ours' as const,
}
const totals = (totalSek: number) => ({ ...emptyTotals(), kwh: 10, gridKwh: 10, fullKwh: 10, totalSek })
const base = { paidSpotOre: 40, windowAvgSpotOre: 55 }

test('a compared session keeps the four figures the table shows, and the spread', () => {
  const economy: SessionEconomy = {
    ...base,
    actual: totals(41.2),
    actualComplete: true,
    excluded: null,
    counterfactual: {
      immediate: totals(53.6),
      optimal: totals(38),
      dearest: totals(70),
      score: 0.9,
      savedVsImmediateSek: 12.4,
      leftOnTableSek: 3.2,
    },
  }
  expect(toEconomyListRow(session, economy)).toEqual({
    sessionId: 's1',
    startAt: session.startAt,
    endAt: session.endAt,
    vehicle: 'ours',
    kwh: 32.1,
    actualSek: 41.2,
    excluded: null,
    counterfactual: { savedVsImmediateSek: 12.4, leftOnTableSek: 3.2, score: 0.9, spreadSek: 32 },
  })
})

test('an incomplete actual is null, never partial kronor', () => {
  const economy: SessionEconomy = {
    ...base,
    actual: totals(17.5),
    actualComplete: false,
    excluded: 'no_price',
    counterfactual: null,
  }
  expect(toEconomyListRow(session, economy)).toMatchObject({
    actualSek: null,
    excluded: 'no_price',
    counterfactual: null,
  })
})

test('an excluded no_hourly session keeps its complete (estimated) actual', () => {
  const economy: SessionEconomy = {
    ...base,
    actual: totals(20),
    actualComplete: true,
    excluded: 'no_hourly',
    counterfactual: null,
  }
  expect(toEconomyListRow(session, economy)).toMatchObject({ actualSek: 20, excluded: 'no_hourly' })
})
```

- [ ] **Step 2: Run it and see it fail.** Run `bunx vitest run src/lib/evCharging/economy/listRow.test.ts`.
  Expected: FAIL, cannot resolve `./listRow`.
- [ ] **Step 3: Implement** `src/lib/evCharging/economy/listRow.ts`:

```ts
// The economy session table's row: only what EconomySessionTable renders
// (server latency step 5). Client-safe: the procedure returns it and the
// table types against it.
import type { Vehicle } from '~/lib/evCharging/vehicle'
import type { EconomyExclusion, SessionEconomy } from './types'

export type EconomyListRow = {
  sessionId: string
  startAt: Date
  endAt: Date
  vehicle: Vehicle
  /** The session's `energyKwh`, as SessionList shows it. */
  kwh: number
  /** The actual cost, SEK; null unless every kWh is priced (ADR-0020: never partial kronor). */
  actualSek: number | null
  excluded: EconomyExclusion | null
  counterfactual: {
    savedVsImmediateSek: number
    leftOnTableSek: number
    score: number | null
    /** dearest − optimal total, SEK: the "no spread" label's figure when `score` is null. */
    spreadSek: number
  } | null
}

/** The fields of a counted session the row needs (structural: no service import). */
export type ListRowSession = {
  sessionId: string
  startAt: Date
  endAt: Date
  energyKwh: number
  vehicle: Vehicle
}

export function toEconomyListRow(s: ListRowSession, economy: SessionEconomy): EconomyListRow {
  const cf = economy.counterfactual
  return {
    sessionId: s.sessionId,
    startAt: s.startAt,
    endAt: s.endAt,
    vehicle: s.vehicle,
    kwh: s.energyKwh,
    actualSek: economy.actualComplete ? economy.actual.totalSek : null,
    excluded: economy.excluded,
    counterfactual: cf && {
      savedVsImmediateSek: cf.savedVsImmediateSek,
      leftOnTableSek: cf.leftOnTableSek,
      score: cf.score,
      spreadSek: cf.dearest.totalSek - cf.optimal.totalSek,
    },
  }
}
```

  Add `export * from './listRow'` to `src/lib/evCharging/economy/index.ts`, keeping the barrel's alphabetical order.
- [ ] **Step 4: Run it and see it pass.** Same command. Expected: 3 passed.
- [ ] **Step 5: Write the failing read-model tests.** Append to `src/lib/evCharging/chargingEconomy.test.ts`,
  reusing its `session()`, `seedPrices()`, `NOW` and `unit()`, and adding `getEconomySessions` to the import from
  `./chargingEconomy`:

```ts
test('economy sessions: one page newest first, the total, and the last page for one past the end', async () => {
  const ids: string[] = []
  for (let day = 10; day < 22; day++) {
    ids.push(await session(`2026-09-${day}T08:00:00Z`, `2026-09-${day}T09:00:00Z`, 5))
  }
  await session('2025-09-10T08:00:00Z', '2025-09-10T09:00:00Z', 5) // another year
  const newestFirst = [...ids].reverse()
  const first = await getEconomySessions({ year: 2026, now: NOW, page: 1, pageSize: 10 })
  expect(first).toMatchObject({ page: 1, pageSize: 10, total: 12 })
  expect(first.rows.map((r) => r.sessionId)).toEqual(newestFirst.slice(0, 10))
  const second = await getEconomySessions({ year: 2026, now: NOW, page: 2, pageSize: 10 })
  expect(second.rows.map((r) => r.sessionId)).toEqual(newestFirst.slice(10))
  const past = await getEconomySessions({ year: 2026, now: NOW, page: 99, pageSize: 10 })
  expect(past).toMatchObject({ page: 2, total: 12 })
  expect(past.rows.map((r) => r.sessionId)).toEqual(newestFirst.slice(10))
})

test('economy sessions: an empty year is page 1 of nothing', async () => {
  expect(await getEconomySessions({ year: 2026, now: NOW, page: 3, pageSize: 10 })).toEqual({
    page: 1,
    pageSize: 10,
    total: 0,
    rows: [],
  })
})

test('economy sessions: a row carries the same figures as the session’s own analysis', async () => {
  await seedPrices()
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  const [{ rows }, detail] = await Promise.all([
    getEconomySessions({ year: 2026, now: NOW, page: 1, pageSize: 10 }),
    getSessionEconomy({ sessionId: id }),
  ])
  const cf = detail.economy.counterfactual
  expect(rows[0].actualSek).toBeCloseTo(detail.economy.actual.totalSek, 9)
  expect(rows[0].counterfactual).toEqual({
    savedVsImmediateSek: cf?.savedVsImmediateSek,
    leftOnTableSek: cf?.leftOnTableSek,
    score: cf?.score,
    spreadSek: (cf?.dearest.totalSek ?? 0) - (cf?.optimal.totalSek ?? 0),
  })
  expect(rows[0].counterfactual?.leftOnTableSek).toBeCloseTo(10 * (unit(3) - unit(1)))
})

test('economy sessions: a session on a day without prices has no kronor and no comparison', async () => {
  await tariffService.create(TARIFF)
  await session('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', 4, [
    ['2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', 4],
  ])
  const { rows } = await getEconomySessions({ year: 2026, now: NOW, page: 1, pageSize: 10 })
  expect(rows[0]).toMatchObject({ actualSek: null, excluded: 'no_price', counterfactual: null })
})

test('economy sessions follow the vehicle scope and default to the current year', async () => {
  const ours = await session('2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z', 10)
  const guest = await session('2026-09-11T10:00:00Z', '2026-09-11T11:00:00Z', 4, [], {
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const ids = async (vehicle?: 'ours' | 'other' | 'all') =>
    (await getEconomySessions({ now: NOW, vehicle, page: 1, pageSize: 10 })).rows.map((r) => [
      r.sessionId,
      r.vehicle,
    ])
  expect(await ids('ours')).toEqual([[ours, 'ours']])
  expect(await ids('other')).toEqual([[guest, 'other']])
  expect(await ids()).toEqual([
    [guest, 'other'],
    [ours, 'ours'],
  ])
})

test('economy sessions fill their timings sink', async () => {
  await session('2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z', 10)
  const timings: Record<string, number> = {}
  await getEconomySessions({ now: NOW, page: 1, pageSize: 10, timings })
  expect(timings).toMatchObject({
    energyMs: expect.any(Number),
    tariffMs: expect.any(Number),
    slotsMs: expect.any(Number),
    computeMs: expect.any(Number),
  })
})
```

- [ ] **Step 6: Run them and see them fail.** Run `pgrep -fl vitest` (must be empty), then
  `bunx vitest run src/lib/evCharging/chargingEconomy.test.ts`. Expected: the six new tests FAIL
  (`getEconomySessions` is not exported); the rest pass.
- [ ] **Step 7: Implement** in `src/lib/evCharging/chargingEconomy.ts`:
  - Import `pageSlice` from `~/lib/evCharging/paging`, and `toEconomyListRow` and `type EconomyListRow` from
    `~/lib/evCharging/economy`.
  - Extract the year filter so both reads share it.
  - Use `sessionsOfYear` in `getEconomyOverview` (`const inYear = sessionsOfYear(all, year)`), and add the new read:

```ts
/** The counted sessions of Stockholm `year`, by start, in `all`'s order (oldest first). */
function sessionsOfYear(all: SessionEnergy[], year: number): SessionEnergy[] {
  return all.filter((s) => stockholmYearMonth(s.startAt.getTime()).year === year)
}

export type EconomySessionsTimings = {
  energyMs?: number
  tariffMs?: number
  slotsMs?: number
  computeMs?: number
}

export type EconomySessionsPage = {
  /** The page served: one past the end comes back as the last. */
  page: number
  pageSize: number
  /** The year's counted sessions in scope. */
  total: number
  /** The page's sessions, newest first. */
  rows: EconomyListRow[]
}

/**
 * One page of /charging/economy's session table (server latency step 5): the
 * year's counted sessions in scope, newest first, analyzed only for the page.
 * The tiles and charts come from getEconomyOverview, which still analyzes the
 * whole year.
 */
export async function getEconomySessions(input: {
  year?: number
  now?: Date
  vehicle?: VehicleScope
  page: number
  pageSize: number
  timings?: EconomySessionsTimings
}): Promise<EconomySessionsPage> {
  const t = input.timings
  const year = input.year ?? stockholmYearMonth((input.now ?? new Date()).getTime()).year
  const [all, tariffsAsc] = await Promise.all([
    timed(t, 'energyMs', () => listSessionEnergy({ all: true, vehicle: input.vehicle })),
    timed(t, 'tariffMs', loadTariffs),
  ])
  const newestFirst = sessionsOfYear(all, year).toReversed()
  const { rows: onPage, page } = pageSlice(newestFirst, input.page, input.pageSize)
  const sessions = onPage.map(toEconomySession)
  const slots = await timed(t, 'slotsMs', () =>
    listSlotsOverlapping(SPOT_ZONE, sessions.map(economyWindow)),
  )
  const computeStart = performance.now()
  const index = new SlotIndex(slots)
  const rows = onPage.map((s, i) =>
    toEconomyListRow(s, analyzeSession(sessions[i], index, tariffsAsc).economy),
  )
  if (t) t.computeMs = Math.round(performance.now() - computeStart)
  return { page, pageSize: input.pageSize, total: newestFirst.length, rows }
}
```

  An empty page needs no special case: `listSlotsOverlapping` returns `[]` for no ranges without a query. The
  empty-year test pins it.
- [ ] **Step 8: Run them and see them pass.** Same command. Expected: all pass, the old tests unchanged.
- [ ] **Step 9: Commit.**

```bash
git add src/lib/evCharging/economy/listRow.ts src/lib/evCharging/economy/listRow.test.ts \
  src/lib/evCharging/economy/index.ts src/lib/evCharging/chargingEconomy.ts \
  src/lib/evCharging/chargingEconomy.test.ts
git commit -m "feat(charging): add a paged read of the economy sessions"
```

**Reviewers** (feature-workflow pairings, service layer): `code-reviewer` and `test-completeness`.

### Task 2: The `economySessions` procedure

**Files:**
- Modify: `src/lib/orpc/procedures/evCharging.ts` (after `economy`)
- Test: `src/lib/orpc/procedures/evCharging.test.ts`

**Interfaces:**
- Consumes: `getEconomySessions` and `EconomySessionsTimings` (Task 1).
- Produces: `evCharging.economySessions`, with input `{ year?: number; vehicle?: VehicleScope; page: number;
  pageSize: SessionPageSize }` and output `EconomySessionsPage`. On the client:
  `RouterOutputs['evCharging']['economySessions']`.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/orpc/procedures/evCharging.test.ts`; it already has
  `signIn`, `baseContext`, `insertSession` and `MAX_SESSION_PAGE`):

```ts
test('economySessions rejects an unauthenticated caller', async () => {
  await expect(
    call(evChargingRouter.economySessions, { page: 1, pageSize: 10 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('economySessions serves a page and records its sub-timings', async () => {
  await signIn('user')
  for (let day = 10; day < 22; day++) {
    await insertSession({
      startAt: new Date(`2026-05-${day}T08:00:00Z`),
      endAt: new Date(`2026-05-${day}T09:00:00Z`),
    })
  }
  const context = { ...baseContext(), timings: {} as Record<string, number> }
  const result = await call(
    evChargingRouter.economySessions,
    { year: 2026, page: MAX_SESSION_PAGE, pageSize: 10 },
    { context },
  )
  expect(result).toMatchObject({ page: 2, pageSize: 10, total: 12 })
  expect(result.rows).toHaveLength(2)
  expect(context.timings).toMatchObject({
    economySessionsEnergyMs: expect.any(Number),
    economySessionsComputeMs: expect.any(Number),
  })
})

test('economySessions rejects a page size it does not offer, and an out-of-range page or year', async () => {
  await signIn('user')
  for (const input of [
    { page: 1, pageSize: 7 },
    { page: 0, pageSize: 10 },
    { page: MAX_SESSION_PAGE + 1, pageSize: 10 },
    { year: 1999, page: 1, pageSize: 10 },
  ]) {
    await expect(
      call(evChargingRouter.economySessions, input as never, { context: baseContext() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
})
```

  `insertSession` defaults to 5 kWh on charger `charger-veh`, so these sessions are counted.
- [ ] **Step 2: Run them and see them fail.** Run `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts`.
  Expected: the three new tests FAIL (`economySessions` is undefined).
- [ ] **Step 3: Implement.** Add `type EconomySessionsTimings` and `getEconomySessions` to the import from
  `~/lib/evCharging/chargingEconomy`, then add the procedure after `economy`:

```ts
  // One page of /charging/economy's session table (server latency step 5):
  // the slim rows the table renders, analyzed for the page only. A page past
  // the end comes back as the last page, with its number in `page`.
  economySessions: protectedProcedure
    .input(
      z.object({
        year: yearInput,
        vehicle: vehicleInput,
        page: z.number().int().min(1).max(MAX_SESSION_PAGE),
        pageSize: sessionPageSize,
      }),
    )
    .handler(async ({ input, context }) => {
      const timings: EconomySessionsTimings = {}
      const result = await getEconomySessions({ ...input, timings })
      recordPrefixedTimings(context.timings, 'economySessions', timings)
      return result
    }),
```

- [ ] **Step 4: Run them and see them pass.** Same command. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(charging): serve the economy session list a page at a time"`

**Reviewers** (procedure / permission boundary): `code-reviewer`, and a reviewer loading
`better-auth-security-best-practices`. It should check that the new read is `protectedProcedure`, that the input is
bounded, and that the vehicle scope can't widen what a user sees.

### Task 3: The route and the table read the paged list

**Files:**
- Modify: `src/routes/_authenticated/charging/economy.tsx`, `src/components/evCharging/EconomySessionTable.tsx`
- Test: `src/components/evCharging/EconomySessionTable.browser.test.tsx`,
  `src/routes/_authenticated/charging/-vehicleScope.browser.test.tsx`

**Interfaces:**
- Consumes: `orpc.evCharging.economySessions` (Task 2), `EconomyListRow` (Task 1).
- Produces:
  - `EconomySessionTable` takes `sessions: EconomyListRow[]`.
  - The route defines `economySessionsQuery(year, vehicle, page, pageSize)`. Task 5 uses it.

- [ ] **Step 1: Update the table's test fixture first** (it must fail to type-check against the old row). In
  `EconomySessionTable.browser.test.tsx`, replace the `Row` type, `cost` and `row()`:

```ts
import type { EconomyListRow } from '~/lib/evCharging/economy'

// `over` may flip a row to excluded (excluded + counterfactual: null together).
const row = (over: Partial<EconomyListRow> = {}): EconomyListRow => ({
  sessionId: '11111111-1111-4111-8111-111111111111',
  startAt: new Date('2026-09-05T19:10:00Z'),
  endAt: new Date('2026-09-06T05:02:00Z'),
  kwh: 32.1,
  actualSek: 41.2,
  vehicle: 'ours',
  excluded: null,
  counterfactual: { score: 0.9, savedVsImmediateSek: 12.4, leftOnTableSek: 3.2, spreadSek: 32 },
  ...over,
})
```

  - In "an excluded session with a partial actual", replace `actualComplete: false, actual: cost(17.5)` with
    `actualSek: null`. Keep the assertion that "17,50" never renders by also asserting the cell is "—".
  - The no-spread tests (`score: null`) keep `spreadSek: 32` from `row()`: 70 − 38 as before, so the expected
    "32,00 kr" text is unchanged.
  - Drop the now-unused `emptyTotals` import.
- [ ] **Step 2: Run them and see them fail.** Run `bunx tsc --noEmit -p .`. Expected: type errors in
  `EconomySessionTable.tsx` (`actualComplete`, `actual`, `cf.dearest` don't exist on `EconomyListRow`).
- [ ] **Step 3: Switch the table** (`EconomySessionTable.tsx`):
  - `type Row = EconomyListRow`, imported as a type from `~/lib/evCharging/economy`, replacing the `RouterOutputs`
    path.
  - `noSpread` takes the row's counterfactual:
    `m.charging_economy_tile_no_spread({ spread: formatSek(cf.spreadSek, 2) })`.
  - The actual cell renders `r.actualSek !== null ? <Estimated …>{formatSek(r.actualSek, 2)}</Estimated> : <Unknown …/>`.
  - The rest is unchanged.
- [ ] **Step 4: Switch the route** (`economy.tsx`):
  - Add the query factory next to `economyQuery`:

```ts
const economySessionsQuery = (
  year: number | undefined,
  vehicle: VehicleScope,
  page: number,
  pageSize: SessionPageSize,
) => orpc.evCharging.economySessions.queryOptions({ input: { year, vehicle, page, pageSize } })
```

  - Rewrite the loader to read the list's page outside the deps, as `/charging` does:

```ts
  // The list's page and size are deliberately not loader deps: a dep change
  // blocks the navigation on this whole loader, so a page click would freeze on
  // the old page. Read here, SSR and a shared link still render the page the
  // URL asks for; a page click is the list's own query (see /charging).
  loader: ({ context: { queryClient }, deps, location }) => {
    const paging = sessionPagingSearch.parse(location.search)
    return loadRouteData(queryClient, {
      critical: [
        economyQuery(deps.year, deps.vehicle),
        economySessionsQuery(
          deps.year,
          deps.vehicle,
          paging.page ?? 1,
          paging.size ?? DEFAULT_SESSION_PAGE_SIZE,
        ),
        syncHealthQuery,
      ],
    })
  },
```

  - Update the `searchSchema` comment: the page now loads only the table's page.
  - Replace `<EconomySessionsCard sessions={economy.sessions} stale={stale} />` with
    `<EconomySessionsCard year={year} vehicle={vehicle} />`.
  - Rewrite `EconomySessionsCard` to own its query. It copies `/charging`'s rule (`index.tsx`, the `lastLoaded`
    block): the last page that loaded in this scope stays, under the error alert, after a failure. The scope is
    year + vehicle.

```tsx
// The year's sessions, newest first, one page at a time from the server
// (economySessions). Its own query and component, so a page click re-renders
// only this card. Another page or scope keeps the current rows, dimmed, until
// the next ones land; after a failed read only this scope's last page stays,
// under the alert (the rule /charging's list follows).
function EconomySessionsCard({ year, vehicle }: { year: number | undefined; vehicle: VehicleScope }) {
  const headingId = useId()
  const page = Route.useSearch({ select: (s) => s.page ?? 1 })
  const pageSize = Route.useSearch({ select: (s) => s.size ?? DEFAULT_SESSION_PAGE_SIZE })
  const list = useQuery({
    ...economySessionsQuery(year, vehicle, page, pageSize),
    placeholderData: keepPreviousData,
  })
  const scope = `${year ?? 'current'}:${vehicle}`
  const [lastLoaded, setLastLoaded] = useState(() =>
    list.data && !list.isPlaceholderData ? { scope, data: list.data } : undefined,
  )
  if (list.data && !list.isPlaceholderData && list.data !== lastLoaded?.data) {
    setLastLoaded({ scope, data: list.data })
  }
  const lastInScope = lastLoaded?.scope === scope ? lastLoaded.data : undefined
  const shown = loadFailed(list) ? lastInScope : (list.data ?? lastInScope)
  const stale = list.data === undefined || list.isPlaceholderData
  const paging = useSessionPaging<z.infer<typeof searchSchema>>(Route.useNavigate())

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <h2
            id={headingId}
            ref={paging.headingRef}
            tabIndex={-1}
            className="scroll-mt-4 rounded-sm font-medium text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {m.charging_economy_sessions_title()}
          </h2>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <LoadErrorAlert title={m.charging_sessions_error_title()} query={list} />
          <SectionSkeleton
            name="charging-economy-sessions"
            loading={firstLoadPending(list)}
            fallbackHeight="24rem"
          >
            {shown ? (
              <div
                aria-busy={stale && !loadFailed(list)}
                className={cn('flex flex-col gap-3 transition-opacity', stale && 'opacity-60')}
              >
                <EconomySessionTable sessions={shown.rows} labelledBy={headingId} />
                {/* Inert while another page or scope loads: a click on the old
                    page's controls would page from the wrong place. */}
                <div inert={stale}>
                  <SessionPagination
                    page={shown.page}
                    pageSize={shown.pageSize}
                    total={shown.total}
                    onPageChange={paging.setPage}
                    onPageSizeChange={paging.setPageSize}
                  />
                </div>
              </div>
            ) : null}
          </SectionSkeleton>
        </CardContent>
      </Card>
    </section>
  )
}
```

  - Remove the now-unused `pageSlice` import and the `EconomyRow` type.
  - Add the `SessionPageSize` type import.
  - `useState` stays imported (the card still uses it).
- [ ] **Step 5: The loader test.** In `-vehicleScope.browser.test.tsx`:
  - Change the economy row of the second `test.each` to `['economy', Economy, ['economy', 'economySessions']]`.
    `scoped()` matches the quoted procedure name, so `"economy"` won't match `"economySessions"`.
  - Add a case reading the list page from the URL:

```ts
test('economy: the session list’s page and size come from the URL, not the deps', async () => {
  const keys = await runLoader(Economy as unknown as RouteLike, { page: 3, size: 25 })
  const list = scoped(keys, 'economySessions')
  expect(list).toHaveLength(1)
  expect(list[0]).toContain('"page":3')
  expect(list[0]).toContain('"pageSize":25')
})
```

- [ ] **Step 6: Run the checks.**
  - `bunx tsc --noEmit -p .`. Expected: clean. (`economy.sessions` still exists, so nothing else breaks yet.)
  - `pgrep -fl vitest`, then
    `bunx vitest run --project browser src/components/evCharging/EconomySessionTable.browser.test.tsx src/routes/_authenticated/charging/-vehicleScope.browser.test.tsx`.
    Expected: all pass.
- [ ] **Step 7: Capture the list's skeleton.**
  - With the dev server on :14610 (see `scripts/captureBones.ts`), run
    `bun run bones:capture /charging/economy`.
  - Switch the card to `bones={chargingEconomySessionsBones}`
    (`import chargingEconomySessionsBones from '~/bones/charging-economy-sessions.bones.json'`) and drop `name`.
  - The page's own skeleton (`charging-economy`) now captures without the table, so commit both regenerated files.
  - `test/sectionSkeletonBones.test.ts` must pass.
- [ ] **Step 8: Commit.** `git commit -m "feat(charging): load the economy table from the paged list"`

**Reviewers** (UI component / route): `code-reviewer`, and a reviewer loading `web-design-guidelines` +
`vercel-react-best-practices`. They should look hardest at Review Focus 1–3.

### Task 4: Remove `sessions` from the economy overview (contract)

**Files:**
- Modify: `src/lib/evCharging/chargingEconomy.ts`, `src/lib/evCharging/chargingEconomy.test.ts`

**Interfaces:**
- Produces: `EconomyOverview = { year; years; tiles; months }`. `EconomySessionRow` is deleted if nothing imports it
  any more (check with `grep -rn EconomySessionRow src`).

- [ ] **Step 1: Move the tests that read rows to the paged read.** In `chargingEconomy.test.ts`, every
  `getEconomyOverview(…).sessions` read becomes `getEconomySessions({ …same year/now/vehicle…, page: 1, pageSize: 50 }).rows`:

| Test | Today | After |
|---|---|---|
| "the optimum uses window slots outside the charged hours" | reads `cf.optimal.totalSek` | asserts `cf?.spreadSek` against `(10 * unit(3)) - (10 * unit(1))` and keeps the `leftOnTableSek` assertion |
| "the actual cost equals the session list’s cost" | reads `sessions[0].actual.totalSek` and `.fullKwh` | asserts `rows[0].actualSek` against `cost.totalSek`; the `fullKwh` parity stays covered by `getSessionCosts`' own tests, so drop that line |
| "only counted sessions of the selected year, newest first" | asserts row ids | asserts `rows.map((r) => r.sessionId)`; the month and tile assertions stay on the overview |
| "economy overview follows the vehicle scope" | the `rows()` helper reads `.sessions` | the helper reads `getEconomySessions(…).rows`; the tile assertions stay |
| "a stored mix changes only the cash cost … economy overview stay grid-only" | compares `sessions[0].actual` | compares `getEconomySessions(…).rows[0].actualSek` before and after the mix |

  Run `grep -n "\.sessions" src/lib/evCharging/chargingEconomy.test.ts` afterwards. Any remaining hit must be a
  `tiles.sessions` or month `sessions` count.
- [ ] **Step 2: Add the contract assertion** to the test "only counted sessions of the selected year…":

```ts
  expect(o).not.toHaveProperty('sessions')
```

- [ ] **Step 3: Run it and see it fail.** Run `bunx vitest run src/lib/evCharging/chargingEconomy.test.ts`.
  Expected: only the new `not.toHaveProperty('sessions')` assertion fails.
- [ ] **Step 4: Remove `sessions`** from `EconomyOverview` and from `getEconomyOverview`'s return. The `rows` it
  builds are still needed for `rowsByMonth` and `tiles`, so keep building them, typed locally. Then delete
  `EconomySessionRow` if the grep finds no other user, and update the module comment.
- [ ] **Step 5: Run the checks.**
  - `bunx tsc --noEmit -p .`: clean.
  - `bunx vitest run src/lib/evCharging/chargingEconomy.test.ts src/lib/orpc/procedures/evCharging.test.ts`: all
    pass.
- [ ] **Step 6: Commit.** `git commit -m "refactor(charging): drop the session rows from the economy overview"`

**Reviewers** (service layer): `code-reviewer` and `test-completeness`. Both must confirm that no assertion was
lost in the move, only re-pointed.

### Task 5: Prefetch pages from the pagination controls

**Files:**
- Create: `src/hooks/useNextPagePrefetch.ts`
- Modify: `src/components/evCharging/SessionPagination.tsx`,
  `src/routes/_authenticated/charging/economy.tsx`, `src/routes/_authenticated/charging/index.tsx`
- Test: `src/components/evCharging/SessionPagination.browser.test.tsx`

**Interfaces:**
- Produces:
  - `SessionPagination`'s new optional prop `prefetchPage?: (page: number) => void`.
  - `useNextPagePrefetch(list: { data?: { page: number; pageSize: number; total: number }; isPlaceholderData: boolean }, prefetchPage: (page: number) => void): void`.

- [ ] **Step 1: Write the failing tests** (append to `SessionPagination.browser.test.tsx`; add `userEvent` from
  `vitest/browser` to the imports):

```ts
test('prefetches a page when its number or arrow is hovered, focused or touched', async () => {
  const prefetchPage = vi.fn()
  const screen = await render(
    <SessionPagination
      page={2}
      pageSize={10}
      total={214}
      onPageChange={noop}
      onPageSizeChange={noop}
      prefetchPage={prefetchPage}
    />,
  )
  await userEvent.hover(screen.getByRole('button', page(3)))
  expect(prefetchPage).toHaveBeenLastCalledWith(3)
  screen.getByRole('button', { name: m.charging_sessions_pagination_next() }).element().focus()
  expect(prefetchPage).toHaveBeenLastCalledWith(3)
  screen
    .getByRole('button', { name: m.charging_sessions_pagination_previous() })
    .element()
    .dispatchEvent(new TouchEvent('touchstart', { bubbles: true }))
  expect(prefetchPage).toHaveBeenLastCalledWith(1)
})

test('never prefetches the current page or past either end', async () => {
  const prefetchPage = vi.fn()
  const screen = await render(
    <SessionPagination
      page={1}
      pageSize={10}
      total={14}
      onPageChange={noop}
      onPageSizeChange={noop}
      prefetchPage={prefetchPage}
    />,
  )
  await userEvent.hover(screen.getByRole('button', page(1)))
  screen.getByRole('button', { name: m.charging_sessions_pagination_previous() }).element().focus()
  expect(prefetchPage).not.toHaveBeenCalled()
  await userEvent.hover(screen.getByRole('button', page(2)))
  expect(prefetchPage).toHaveBeenCalledWith(2)
})
```

  The number buttons are `hidden sm:list-item` in the app, but browser tests have no `app.css`, so they render.
  The file's existing tests already click `page(3)` and `page(2)`.
- [ ] **Step 2: Run them and see them fail.** Run
  `bunx vitest run --project browser src/components/evCharging/SessionPagination.browser.test.tsx`. Expected: the
  two new tests FAIL (`prefetchPage` is never called).
- [ ] **Step 3: Implement in `SessionPagination.tsx`.**
  - Add the `prefetchPage` prop with a doc comment: called with a page a control points at, on hover, focus or
    touch, so the click finds it loaded. Never for the current page or past either end.
  - Define, inside the component:

```ts
  // Hover, keyboard focus and a finger's touch-down all come before the click.
  const intent = (target: number) =>
    prefetchPage && target !== current && target >= 1 && target <= count
      ? {
          onPointerEnter: () => prefetchPage(target),
          onFocus: () => prefetchPage(target),
          onTouchStart: () => prefetchPage(target),
        }
      : {}
```

  - Spread `{...intent(item)}` on each page-number `<Button>`.
  - Give `StepButton` an `intent` prop of type `ReturnType<typeof intent>` and spread it on its `<Button>`. Pass
    `intent={intent(current - 1)}` to previous and `intent={intent(current + 1)}` to next.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: all pass, the old tests unchanged.
- [ ] **Step 5: The eager next-page hook** (`src/hooks/useNextPagePrefetch.ts`):

```ts
import { useEffect } from 'react'

// Once a session list's page has landed (not a placeholder), fetch the page
// after it, so "next" is instant on a phone too, where nothing hovers. One small
// request per page viewed; prefetchQuery skips it while that page is fresh.
export function useNextPagePrefetch(
  list: { data?: { page: number; pageSize: number; total: number }; isPlaceholderData: boolean },
  prefetchPage: (page: number) => void,
): void {
  const { data, isPlaceholderData } = list
  useEffect(() => {
    if (!data || isPlaceholderData) return
    if (data.page * data.pageSize < data.total) prefetchPage(data.page + 1)
  }, [data, isPlaceholderData, prefetchPage])
}
```

- [ ] **Step 6: Wire both routes.**
  - In `economy.tsx`'s `EconomySessionsCard`:

```ts
  const queryClient = useQueryClient()
  const prefetchPage = useCallback(
    (p: number) => void queryClient.prefetchQuery(economySessionsQuery(year, vehicle, p, pageSize)),
    [queryClient, year, vehicle, pageSize],
  )
  useNextPagePrefetch(list, prefetchPage)
```

  - Pass `prefetchPage={prefetchPage}` to its `SessionPagination`.
  - In `index.tsx`'s `ChargingPage`, wire the same way with
    `sessionsQuery(p, sessionPageSize, vehicle)`, `useNextPagePrefetch(sessions, prefetchPage)` and the prop.
  - Import `useQueryClient` from `@tanstack/react-query`, `useCallback` from React, and the hook from
    `~/hooks/useNextPagePrefetch`.
- [ ] **Step 7: Run the checks.**
  - `bunx tsc --noEmit -p .`.
  - `pgrep -fl vitest`, then `bunx vitest run --project browser src/components/evCharging src/routes/_authenticated/charging`.
  - Expected: clean, and all pass.
- [ ] **Step 8: Commit.** `git commit -m "perf(charging): prefetch session pages from the pagination controls"`

**Reviewers** (UI component / route): `code-reviewer`, and a reviewer loading `web-design-guidelines` +
`vercel-react-best-practices`, focused on Review Focus 4–5. Also: no prefetch storm on fast pointer sweeps
(`prefetchQuery` de-duplicates in-flight and fresh queries), and touch targets unchanged.

### Task 6: Measure, verify, ship

- [ ] **Step 1: Re-measure.** Point `.measure-economy.ts` at the new reads and log both sizes:
  `getEconomyOverview({ year: 2026, now })` and `getEconomySessions({ year: 2026, now, page: 1, pageSize: 10 })`.
  Target: ≤ 2 KB gzip together, against Task 0's 21.4 KB. Delete the script.
- [ ] **Step 2: Branch review (Phase 5).** Run `code-reviewer`, a general correctness pass told to look for behavior
  that moved (Review Focus 1–5), and `test-completeness`. Fix or rule on every finding in this PR.
- [ ] **Step 3: Pre-PR gate** (`docs/feature-workflow.md` → Pre-PR gate): `bun run check`, `bun run check:ci`,
  `bun run build`, `bun run test` (after `pgrep -fl vitest` is empty), and the sv/en key check.
- [ ] **Step 4: Live check.** Run the dev server (`bun run dev`, signed in; see the memory note on Playwright +
  Mailpit if the Chrome extension is down). At desktop, tablet and mobile widths, on `/charging/economy` and
  `/charging`:
  - Hovering a page number, then clicking it, shows the page with no new `economySessions` / `sessions` request in
    the Network tab.
  - After a page lands, the next page's request has already happened.
  - A year or scope switch on page 3 dims, then lands on page 1.
  - A shared `?page=3` full load renders page 3.
  - With the network offline, a page click shows the list's alert and keeps the last page.
- [ ] **Step 5: Roadmap and PR.**
  - Roadmap row 5: plan link, PR, `PR open`.
  - Open the PR with the template. Title: `perf(charging): page the economy session list on the server`. Include
    the before/after sizes and the live-check notes.
  - Stop. Checkpoint 5 (roadmap) runs after merge.

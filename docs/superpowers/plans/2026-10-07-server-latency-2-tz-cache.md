# Server latency step 2: cache the Stockholm day/month per UTC hour

Roadmap: [server latency](../roadmaps/2026-10-07-server-latency.md), row 2. One session, one PR.

**Hat:** behavior-preserving performance change. Follow `docs/refactor-workflow.md` from Phase 3 (Isolate). The safety
net goes in first, as its own commit, before the change. PR title: `perf(time): cache the Stockholm day and month per UTC hour`.

## Why

`costComputeMs` on `evCharging/costOverview` is 53–159 ms on prod, and `economyComputeMs` on `evCharging/economy` is
75–77 ms. These are synchronous CPU, so they block the instance's other requests (that is why `sensor/series` waited
~200 ms in the 2026-10-07 burst). A local CPU profile of `getCostOverview` put ~9 of its ~13 ms in `@date-fns/tz`'s
`tzOffset`, i.e. `Intl.DateTimeFormat.format`. The callers are `stockholmDayOf` (tariff day of every priced slot) and
`stockholmYearMonth` (month bucket of every piece), both in `src/lib/time/stockholm.ts`, once or more per 15-min
piece:

- cost: `src/lib/evCharging/cost/priceIntervals.ts` (`priceBought`, battery use-day), `src/lib/evCharging/costing.ts`
  (month buckets)
- economy: `src/lib/evCharging/economy/schedule.ts`, `economy/sessionEconomy.ts`, `src/lib/evCharging/chargingEconomy.ts`
- patterns: `src/lib/evCharging/patterns/{pieces,patterns,calendar}.ts`

## Design

Memoize `stockholmDayOf(ms)` and `stockholmYearMonth(ms)` **inside `src/lib/time/stockholm.ts`**, keyed by the UTC
hour `Math.floor(ms / 3_600_000)`. Every caller gets faster, and no caller changes.

- **Why exact.** Europe/Stockholm's offset is +01:00 or +02:00. Both are whole hours, and DST switches at 01:00 UTC
  (02:00→03:00 CET in March, 03:00→02:00 CEST in October), which is a UTC hour boundary. Each UTC hour therefore maps
  to exactly one Stockholm calendar day, month and year. That holds for every instant the app stores (2023 onward);
  Sweden's last non-whole-hour offset was local mean time before 1879.
- **Bounded.** Use a plain `Map<number, …>` cleared when it passes a cap (e.g. 50 000 hours ≈ 5.7 years). This is not
  an LRU: all-time pricing touches ~10–20k distinct hours today. The module is client-safe, so the cache also exists
  in the browser, where it is harmless.
- `stockholmYearMonth` returns an object, so cache a frozen `{ year, month }` or return a fresh copy; check that no
  caller mutates it.
- Leave the other helpers alone: `stockholmDayBounds`, `addDays` and friends are not per-piece hot.
- Reuse first (CLAUDE.md): check whether `@date-fns/tz` has a built-in offset cache worth enabling, using its current
  docs via Context7. If it does and it gets the same win, prefer it and say so in the PR.

## Tasks

### Task 0: Verify main and re-measure the baseline

1. `git log origin/main -5`; confirm `src/lib/time/stockholm.ts` still defines `stockholmDayOf` through `formatISO(…, { in: tz(…) })` and `stockholmYearMonth` through `inStockholm(ms)`.
2. Local baseline (the local DB has more charging data than prod). From the worktree, write a throwaway script in the
   repo root (path aliases resolve there) and delete it afterwards:
   ```ts
   // .bench-cost.ts — throwaway, never commit
   import { getCostOverview } from '~/lib/evCharging/costing'
   for (let i = 0; i < 8; i++) {
     const timings: Record<string, number> = {}
     await getCostOverview({ timings })
     console.log(JSON.stringify(timings))
   }
   process.exit(0)
   ```
   Run with `LOG_LEVEL=error bun run ./.bench-cost.ts`; record the warm `computeMs` (2026-10-07: 13–15 ms). For a profile:
   `bun --cpu-prof --cpu-prof-dir=<scratchpad>/prof ./.bench-cost.ts`, then sum self time by function. `format` and
   `tzOffset` dominated.
3. Prod baseline from Vercel runtime logs (`rpc timing`, procedure `evCharging/costOverview` and `evCharging/economy`):
   note `costComputeMs` / `economyComputeMs` over the last 24 h.

### Task 1: Safety net (commit before the change)

In `src/lib/time/stockholm.test.ts` (node project, no DB), add a characterization test that compares the helpers
against a reference computed without any cache, using `Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' })`
parts. Run it at 15-minute steps across 2023-01-01 → 2028-01-01 UTC, which spans every DST switch. Add explicit cases:

- the instants around both 2026 switches: 2026-03-29 00:59/01:00/01:59 UTC and 2026-10-25 00:59/01:00/01:59 UTC;
- New Year in CET (31 Dec 22:59 / 23:00 UTC), plus month ends on both offsets;
- the last ms of an hour (`h*3600000 + 3599999`) and its first ms;
- calling the same hour twice returns equal values, and mutating a returned `stockholmYearMonth` result (if it is a
  copy) does not change the next call.

It must pass on the current code. Commit: `test(time): pin Stockholm day/month across DST before caching`.

Reviewers: `code-reviewer` + a reviewer told to hunt DST/time-zone edge cases the test misses.

### Task 2: The cache

Implement the design in `src/lib/time/stockholm.ts`, with a short comment giving the whole-hour argument. Task 1's tests
stay green unchanged. Add a test that the cache stays bounded: past the cap, the results stay correct.

Commit: `perf(time): cache the Stockholm day and month per UTC hour`.

Reviewers: `code-reviewer` + a skeptical reviewer that starts from "the cache returns a wrong day somewhere". It
should look at DST, negative or pre-1970 `ms`, `NaN`, and shared mutable results.

### Task 3: Measure, then ship

1. Re-run Task 0's local bench and profile, and record before/after `computeMs` in the PR. Target: at least half.
2. Pre-PR gate (`docs/feature-workflow.md` → Pre-PR gate). Before `bun run test`, check that `pgrep -fl vitest` is empty.
3. Update the roadmap row 2: plan link, PR, `PR open`. Open the PR with the before/after numbers. Stop; checkpoint 2
   (roadmap) runs after merge.

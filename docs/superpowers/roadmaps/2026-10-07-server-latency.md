# Roadmap — server latency

Control document for the server-side latency work that came out of the 2026-10-07 investigation (below): hovering
the sidebar prefetches ~11 RPCs, and two of them (`sensor/series`, `evCharging/costOverview`) stood out in DevTools.
**One step = one session = one PR.** Each step writes its own plan, or a short in-chat design if it is bounded, at the
start of its session.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | `Server-Timing` header on every response: `queue` (Vercel edge → our code, from `x-vercel-id`), `app` (our code → response headers) and, for a signed-in `/api/rpc` caller, the `rpc timing` line's sub-timings + pool gauges; `queueMs` on the log line | bounded (in-chat design) | [#137](https://github.com/ljukas/videbacken/pull/137) | checkpoint passed | 2026-10-07: prod RPC and SSR responses carry the header (`/login`: `queue;dur=22, app;dur=29.5`); `rpc timing` lines carry `queueMs`. Warm `queue` is 20–35 ms; a cold instance started mid-burst shows ~800 ms, now row 4. See [checkpoint 1 result](#checkpoint-1-result). |
| 2 | Cache the Stockholm day/month per UTC hour in the cost pricing (`stockholmDayOf` / `stockholmYearMonth` are ~70% of `costComputeMs`; Stockholm's offset is always whole hours) | [plan](../plans/2026-10-07-server-latency-2-tz-cache.md) | [#139](https://github.com/ljukas/videbacken/pull/139) | checkpoint passed | 2026-10-08: prod `costComputeMs` median 73 → 26.5 (−64%); repeat visits 68–84 → 21–25. `economyComputeMs` 72–100 → 13–27. `/charging` figures unchanged (owner). See [checkpoint 2 result](#checkpoint-2-result). |
| 3 | Store priced cost totals per session and month, written after each derive, spot-price sync and tariff edit by the existing TS pricing (one implementation); `costOverview` and the sessions list read sums. Amends ADR-0020 (cost on read → on write); needs the schema-design review | [spec](../specs/2026-10-11-session-cost-store-design.md), [plan](../plans/2026-10-11-server-latency-3-session-cost-store.md) | [#154](https://github.com/ljukas/videbacken/pull/154) | PR open | — |
| 4 | Cold instances in a burst: when Vercel starts an extra instance for a navigation's burst, its requests show `queue` ~800 ms plus ~260 ms of first-request work before the handler (`app` minus `rpc`). Find what the boot and first-request load cost (function bundle, module init) and what Fluid offers against scale-out cold starts | — | — | needs shaping | — |
| 5 | Split `evCharging/economy`: the page (tiles, months, years) and a server-paged session list (`economySessions`, slim rows), both keyed by year + scope; `SessionPagination` prefetches pages on hover/focus/touch and the next page eagerly (on `/charging` too). `economy` is 12.8 kB gzip on prod, 97% session rows the page doesn't show | [spec](../specs/2026-10-08-economy-paged-sessions-design.md), [plan](../plans/2026-10-08-server-latency-5-economy-paged-sessions.md) | [#143](https://github.com/ljukas/videbacken/pull/143) | checkpoint passed | 2026-10-11: `economy` + `economySessions` 2.7 kB in DevTools (12.8 before); hovered and next pages render with no request on the click; `economySessions` `totalMs` 24–31 warm against `economy`'s 245. See [checkpoint 5 result](#checkpoint-5-result). |
| 6 | `economyDailySpotMs` (56–247 ms on prod): `dailyAverageSpot` converted and grouped every slot of the year (24 764 rows, 50 ms in prod `EXPLAIN ANALYZE` on 2026-10-11, all buffer hits: CPU). Now each day's average is stored in `spot_price_day`, written by `replaceDay` in the same transaction as the slots (its only writer) and backfilled by migration; `dailyAverageSpot` reads ~255 rows by PK, and the sync's stored-days probe reads the same table, so a day missing its row is re-fetched. Amends ADR-0020 | [spec](../specs/2026-10-11-spot-price-day-design.md), [plan](../plans/2026-10-11-server-latency-6-spot-price-day.md) | [#148](https://github.com/ljukas/videbacken/pull/148) | checkpoint passed | 2026-10-11: prod `economyDailySpotMs` 5–7 (56–247 before); `economy` `totalMs` 43–57 warm (181 median before). Every stored day equals the old aggregate exactly; figures unchanged (owner). See [checkpoint 6 result](#checkpoint-6-result). |

Order (owner, 2026-10-08): checkpoint 2 (passed), then 5 (checkpoint passed), then 6 (checkpoint passed), then 3 (2026-10-11). Row 4 follows unless reordered.

The warm pool (keep three pooled connections; removes most `poolOpened` spikes) is client-performance step 8,
[#135](https://github.com/ljukas/videbacken/pull/135), merged 2026-10-07; its checkpoint lives in
[that roadmap](./2026-10-05-client-performance.md).

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`. `needs shaping` means
the step needs a brainstorm before its plan.

## How a session runs a step

1. Read this roadmap. Find the first step whose status isn't `checkpoint passed`.
   - If it is `merged` but its checkpoint hasn't passed, **run the checkpoint, don't start the next step**.
2. No plan yet? Shape it (`superpowers:brainstorming`), then plan it, starting with a task that re-measures the
   baseline on current `main`.
3. Follow `docs/feature-workflow.md` (or `refactor-workflow.md`) from **Phase 3 (Isolate)**.
4. In the same PR, update this roadmap's row; after merge, `merged`.
5. Stop at the end of the step.

## Checkpoints (real-world gates)

1. **After step 1 (prod).** In DevTools on prod, an `/api/rpc` request that ran an authenticated procedure (not a batch) shows, in its Timing tab, `queue`, `app`, `rpc`, its
   sub-timings and `pool`; an SSR page shows `queue` and `app`. Vercel passes the header through (check the preview
   first). `rpc timing` log lines carry `queueMs`. Record what a sidebar-hover burst shows for `sensor/series` and
   `costOverview`: does `queue` explain the gap between DevTools time and `totalMs`?
2. **After step 2 (prod).** `costComputeMs` on `evCharging/costOverview` (baseline below: usually 65–100 ms, up to 159)
   drops by at least half; the cost figures on `/charging` are unchanged. Also read `economyComputeMs` on
   `evCharging/economy` (75–77 ms at checkpoint 1): if it uses the same Stockholm helpers it should drop too.
3. **After step 3 (prod).** Warm `costOverview` `totalMs` ≤ 40 ms (117–125 at checkpoint 2) with
   `costStaleSessions` 0 and no `costSlots`/`costMix`/`costCompute` on the line; `sessionCostsMs` on `sessions`
   drops by a similar amount. Navigate, don't reload (a reload renders `costOverview` during SSR). The read-only
   `scripts/checkSessionCosts.ts` against prod finds no current session off by more than 1e-9, and a
   `session costs repriced` line follows the first syncs after the deploy. The `/charging` figures are unchanged
   (owner). Baseline before the deploy (prod `rpc timing`, 72 h to 2026-10-11 18:45 UTC, min / median / max):
   `costOverview` n = 7, `totalMs` 70 / 145 / 461, `costSlotsMs` 26 / 30 / 168, `costMixMs` 29 / 57 / 83,
   `costComputeMs` 10 / 30 / 41 (current code, n = 2: `totalMs` 85–109); `sessions` n = 32, `totalMs`
   36 / 46 / 252, `sessionCostsMs` 12 / 19.5 / 89 (current code 18–27). Details in the
   [spec](../specs/2026-10-11-session-cost-store-design.md#checkpoint-3-prod).
5. **After step 5 (prod).** In DevTools, `economy` + `economySessions` together are under 3 kB in the Size column
   (12.8 kB before); a hovered or next page renders with no new request; `economySessions`'s `totalMs` is well under
   `economy`'s. Details in the [spec](../specs/2026-10-08-economy-paged-sessions-design.md#checkpoint-5-prod).
   Baseline before the deploy: prod `evCharging/economy` `rpc timing`, 2026-10-07 18:50 → 2026-10-08 09:00 UTC,
   10 calls, `totalMs` 94 / 181 / 433 (min / median / max; 433 a cold start), `economyDailySpotMs` 56 / 89.5 / 170.
   Locally (208 sessions in 2026) the default page went from 21.4 kB gzip to 1.6 kB (`economy` 0.8 +
   `economySessions` 0.9).
6. **After step 6 (prod).** `economyDailySpotMs` on `evCharging/economy` is ≤ 10 ms warm (56–247 before; 205 of 245
   at checkpoint 5), and `economy`'s `totalMs` drops by about as much (navigate, don't reload). The
   `/charging/economy` figures are unchanged (owner). A read-only SELECT shows a `spot_price_day` row for every
   Stockholm day in `spot_price`, each equal to the old aggregate within 1e-12 (the query in the
   [plan](../plans/2026-10-11-server-latency-6-spot-price-day.md), Task 1 Step 6). Details in the
   [spec](../specs/2026-10-11-spot-price-day-design.md#checkpoint-6-prod). Before the deploy: prod `EXPLAIN ANALYZE`
   of the old query 50.3 ms (seq scan + sort of 24 764 slots into 258 days); locally `dailyAverageSpot` for 2026
   went from 17–22 ms to ~1 ms warm (239 days).

## Checkpoint 1 result

2026-10-07, after the #137 deploy. The owner navigated `/charging` and refreshed; prod `rpc timing` lines:

- **17:32:01, first navigation.** The burst landed on two instances.
  - The warm one (`poolTotal` 3) ran `sessions`, `costOverview`, `timeline`, `energy/overview`, `economy`. Their
    `queueMs` was 6–29, except `costOverview` at 124: waiting behind the others on the same instance.
  - A new one ran `tariff/list`, `overview`, `syncStatuses`, `patterns`. Their `queueMs` was 547–828 and their pool
    started empty (`opened` 1–3). On `syncStatuses` the header read `app;dur=380.5` against `rpc;dur=117`: ~260 ms of
    first-request work before the RPC handler started. Cold instances are a cost of their own, so they are row 4.
- **17:32:50, refresh.** Everything was warm: `queueMs` 20–34.
  - `costOverview` took 185 ms: `costCompute` 84 and `costSlots`/`costMix` 49/34, with no connection opened. The
    second query round stays slow with a warm pool, and only step 3 removes it.
  - `economy` took 161 ms, with `economyCompute` 77 and `economyDailySpot` 56.
- `/login` SSR on prod: `queue;dur=22, app;dur=29.5`, then `queue;dur=25, app;dur=7.9`.

## Checkpoint 2 result

2026-10-08, after the #139 deploy (live from 2026-10-07 18:50 UTC). Prod `rpc timing` lines for
`evCharging/costOverview`:

| | Calls | `costComputeMs` | Median |
|---|---|---|---|
| Before (2026-10-06 17:53 → 2026-10-07 17:34) | 42 | 53–159 | 73 |
| After, everything | 10 | 18–53 | 26.5 |
| After, owner returning to `/charging` 3× (08:50–08:54) | 4 | 21–25 | 23 |

- **Passed:** the median dropped 64%. Repeat visits dropped from 68–84 ms (checkpoint 1's refreshes) to 21–25 ms.
- **`economy`:** `economyComputeMs` 72–100 → 13–27 (6 calls).
- **Figures:** the owner checked `/charging`: it looks like before. #139 had already shown the cost and economy
  overviews byte-identical locally for 2024–26.
- **What is left:**
  - The first call on a fresh instance still costs more: `costComputeMs` 37–53, and `sessions` 30 against 0–1 warm.
    That is first-request work, so it belongs to row 4.
  - `costOverview`'s `totalMs` is now 117–125 when warm. Most of that is the two query rounds (`costSlots` +
    `costMix`, 29–60 ms each), which only step 3 removes.
- **Measuring tip:** a page refresh renders `costOverview` during SSR, because it is critical in the `/charging`
  loader. That call never reaches `/api/rpc`, so it logs no `rpc timing` line. To get lines, navigate in the
  browser: leave the page, wait out the 20 s `staleTime`, then come back.

## Checkpoint 5 result

2026-10-11, after the #143 deploy (merged 08:10 UTC, live ~08:16). The owner opened `/charging/economy` from the
sidebar with DevTools open, then paged through the session list.

| | Before | After |
|---|---|---|
| DevTools Size, `economy` + `economySessions` | 12.8 kB | 2.7 kB (1.1 + 1.6) |
| `economy` `totalMs` | 94 / 181 / 433 (n = 10) | 245 (n = 1) |
| `economySessions` `totalMs` | — | 24–31 warm (n = 7); 79 on a second instance that opened a connection |

- **Passed:** the payload is under 3 kB; hovering page 2, 3 and on and then clicking renders at once, with no
  request on the click (owner). The next page arrives right after each page (~1.6 kB, ~60 ms).
- **`economySessions`** spends its time on the year's session energy (`economySessionsEnergyMs` 12–20) and tariffs
  (4–26); slots and compute for one page are 4–7 and 0–5 ms.
- **`economy` is no faster:** 205 of its 245 ms was `economyDailySpotMs`, the full-year slot grouping that step 6
  removes. This step shrank the payload, not the compute.
- `/charging` after a reload makes one `sessions` request (2.4 kB): the eager next page.

## Checkpoint 6 result

2026-10-11, after the #148 deploy (merged 11:20 UTC, live 11:21). Read on deploy `78611db` (#151, which carries
#148). The owner hard-reloaded another page, then opened `/charging/economy` from the sidebar three times.

| | Before | After (17:12, 17:13, 17:13 UTC) |
|---|---|---|
| `economyDailySpotMs` | 56 / 89.5 / 170 (n = 10); 205 at checkpoint 5 | 7, 6, 5 |
| `economy` `totalMs` | 94 / 181 / 433 (n = 10); 245 at checkpoint 5 | 177, 57, 43 |

- **Passed:** the daily spot read is at most 7 ms, and warm `economy` calls take 43–57 ms. The first call (177)
  opened two connections and spent 101 ms in `economySlotsMs`; warm, that read is 15–29 ms.
- **Figures:** the owner checked `/charging/economy`: unchanged, and fast.
- **Backfill:** a read-only SELECT on prod (the plan's Task 1 Step 6 query) found 258 Stockholm days in
  `spot_price` and 258 `spot_price_day` rows: none missing, none different, max difference 0 (not just within 1e-12).
- **Measuring tip:** an `economy` line at 12:05 UTC still showed `economyDailySpotMs` 226. It came from deploy
  `57640b6` (#144), which a tab opened before the deploy was still using. Check a line's `deploymentId` against the
  commit before reading it as post-deploy.
- **What is left:** `economySlotsMs` (15–29 warm, 101 cold) and `economyYearsMs` (8–10 warm) are now the largest
  parts of `economy`; neither is a step yet.

## Baseline (2026-10-07)

From prod `rpc timing` lines, 72 h before the warm-pool deploy, all in `arn1`:

- `sensor/series`: `totalMs` 10–24 warm; spikes of 100–190 always with `poolOpened: 1`. In the screenshot's burst
  (14:19:33 UTC) DevTools showed 334 ms while `totalMs` was 24: the request reached Vercel (x-vercel-id stamp
  `…72833`) before `costOverview` (`…72843`) but its handler started only after `costOverview` finished on the same
  instance. About 200 ms passed before our code ran, which no log could show (step 1).
- `evCharging/costOverview`: `totalMs` 150–390. `costComputeMs` 53–159 (usually 65–100), synchronous CPU that blocks
  the instance's event loop. Two query rounds (sessions/tariffs/house start, then slots/mix) of 20–150 ms each;
  the slow ones coincide with `poolOpened` 2–4.
- A local CPU profile of `getCostOverview` (298 sessions, more than prod's 188) puts ~9 of its ~13 ms compute in
  `@date-fns/tz`'s `tzOffset` (`Intl.DateTimeFormat.format`), called once or more per priced 15-min piece.
  `bucketStartMs` and `tariffAt` are each under 0.2 ms. Prod's compute is ~5× local.

# Roadmap — server latency

Control document for the server-side latency work that came out of the 2026-10-07 investigation (below): hovering
the sidebar prefetches ~11 RPCs, and two of them (`sensor/series`, `evCharging/costOverview`) stood out in DevTools.
**One step = one session = one PR.** Each step writes its own plan, or a short in-chat design if it is bounded, at the
start of its session.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | `Server-Timing` header on every response: `queue` (Vercel edge → our code, from `x-vercel-id`), `app` (our code → response headers) and, for a signed-in `/api/rpc` caller, the `rpc timing` line's sub-timings + pool gauges; `queueMs` on the log line | bounded (in-chat design) | [#137](https://github.com/ljukas/videbacken/pull/137) | checkpoint passed | 2026-10-07: prod RPC and SSR responses carry the header (`/login`: `queue;dur=22, app;dur=29.5`); `rpc timing` lines carry `queueMs`. Warm `queue` is 20–35 ms; a cold instance started mid-burst shows ~800 ms, now row 4. See [checkpoint 1 result](#checkpoint-1-result). |
| 2 | Cache the Stockholm day/month per UTC hour in the cost pricing (`stockholmDayOf` / `stockholmYearMonth` are ~70% of `costComputeMs`; Stockholm's offset is always whole hours) | — | — | not started | — |
| 3 | Store priced cost totals per session and month, written after each derive, spot-price sync and tariff edit by the existing TS pricing (one implementation); `costOverview` and the sessions list read sums. Amends ADR-0020 (cost on read → on write); needs the schema-design review | — | — | needs shaping | — |
| 4 | Cold instances in a burst: when Vercel starts an extra instance for a navigation's burst, its requests show `queue` ~800 ms plus ~260 ms of first-request work before the handler (`app` minus `rpc`). Find what the boot and first-request load cost (function bundle, module init) and what Fluid offers against scale-out cold starts | — | — | needs shaping | — |

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
3. **After step 3 (prod).** Defined when the step is shaped.

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

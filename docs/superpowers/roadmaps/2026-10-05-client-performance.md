# Roadmap — client performance

Control document for the client-performance work that came out of the 2026-10-05 audit (below). The navigation
design is [ADR-0025](../../adr/0025-deferred-route-loading.md). **One step = one session = one PR.**

Unlike earlier roadmaps, only step 1's plan is written up front. Each later step writes its own plan, and any short
design it needs, at the start of its session, because steps 3–6 depend on what the earlier ones measure.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | Deferred route loading on the charging pages (ADR-0025: loader helper, cached session guard, boneyard-js spike + section skeletons on `/charging`, economy, patterns; the session page keeps its awaited not-found check) | [plan](../plans/2026-10-05-client-perf-1-deferred-charging.md) | [#89](https://github.com/ljukas/videbacken/pull/89) | checkpoint passed | 2026-10-05: the owner confirmed the drag is gone on the phone. Prod logs show 0 `/_serverFn` calls since the #89 deploy (230 in the 6 h before), across `/charging`, economy, patterns, `/sensors` and `/users`. Small layout shifts seen, now step 7. |
| 2 | Same pattern on `/sensors` and `/users` | [plan](../plans/2026-10-05-client-perf-2-deferred-sensors-users.md) | [#93](https://github.com/ljukas/videbacken/pull/93) | checkpoint passed | 2026-10-05: the owner confirmed on the phone that `/sensors` (including a range switch) and `/users` no longer drag. Prod logs since the #93 deploy show one `getSession` server-function call across the session's navigations: the cached guard's refresh, not one per navigation. |
| 3 | Fewer requests per `/charging` load: one procedure for the Datakällor panel *or* app-wide oRPC batching (decided in its session; see [notes](#step-3-notes)) | — | — | needs shaping | — |
| 4 | Bundle: phone fields out of the global form hook; lazy-load the admin-only dialogs on `/charging`; one bones registry per page group (since step 2, `/sensors` and `/users` load ~23 KB gz of charging bones) | — | — | not started | — |
| 5 | Replace recharts with visx (refactor-workflow) | — | — | not started | — |
| 6 | Small items: load exifreader on file pick, find what pulls `jose` into the upload chunk, preload the body font | — | — | not started | — |
| 7 | Layout shifts after deferred loading: the owner points out where (seen after step 1); see [notes](#step-7-notes) | — | — | needs shaping | — |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`. `needs shaping` means
the step needs a short brainstorm before its plan.

## How a session runs a step

1. Read this roadmap and ADR-0025. Find the first step whose status isn't `checkpoint passed`.
   - If it is `merged` but its checkpoint hasn't passed, **run the checkpoint, don't start the next step**. Record the
     result here (in a small `docs(perf): …` PR, or in the next step's PR if the owner says so).
2. No plan yet? Write it first (`superpowers:writing-plans`), starting with a task that re-measures the step's
   baseline on current `main`. Shape it first if the status says `needs shaping`.
3. Follow `docs/feature-workflow.md` (or `refactor-workflow.md` for step 5) from **Phase 3 (Isolate)**.
4. In the same PR, update this roadmap's row (PR link, `PR open`); after merge, `merged`.
5. Stop at the end of the step. Don't start the next one in the same session.

## Checkpoints (real-world gates)

1. **After step 1 (prod).** The owner navigates `/charging` ↔ economy ↔ patterns ↔ a session on their phone and the
   drag is gone. Prod `rpc timing` logs show no `getSession` server-function call per client navigation, and a
   revisit within the stale window fires no blocking request.
2. **After step 2 (prod).** Same check on `/sensors` and `/users`.
3. **After step 3 (prod).** One `/charging` load (admin) makes at most half of today's 19 requests (see baseline),
   and `findActiveById` within that load stays under ~20 ms.
4. **After step 4 (build).** The form chunk no longer contains `country-flag-icons` or `libphonenumber-js` except on
   pages with a phone field. `/charging` adds at most ~245 KB gz beyond the entry (from ~361 after step 1, which
   added ~27 KB gz of skeleton bones). `/sensors` and `/users` load only their own bones.
5. **After step 5 (prod).** Owner reviews every converted chart live. recharts, redux, immer and decimal.js-light are
   gone from the build.
6. **After step 6 (build).** The upload chunk shrinks, and the font preload shows in the SSR `<head>`.
7. **After step 7 (prod).** The owner reviews the spots they reported, live on prod, and they no longer shift.

## Baseline (audit, 2026-10-05, `main` at `99fa206`)

How it was measured: a production `vite build --sourcemap`, `source-map-explorer` per chunk, a static-import closure
per route chunk, and 24 h of prod `rpc timing` logs. Re-run the same way to compare.

**JS each page adds beyond the shared entry** (entry 168 KB gz, plus 76 KB for the signed-in shell):

| Page | Adds (gz) | Biggest parts |
|---|---|---|
| `/charging` | 335 KB | form 123 (country-flag-icons 232 + libphonenumber 154 raw), recharts chunk 84, command/sheet |
| `/sensors` | 291 KB | form 123, recharts 84 |
| `/account/profile` | 252 KB | form 123, AvatarUpload 72 (exifreader 114, jose 68, bowser 37 raw) |
| `/users` | 207 KB | form 123, table-core 18 |
| `/charging/patterns` | 180 KB | recharts + visx |
| `/charging/economy` | 174 KB | recharts |
| `/charging/sessions/$id` | 91 KB | visx |
| `/`, `/account`, `/admin` | ~2 KB | — |

**Requests on one admin `/charging` load:** 19. These were `getSession` ×3 (server function), `overview`,
`costOverview`, `sessions`, `sessionCosts`, `tariff/list`, `syncStatus` ×4, `recentRuns` ×4,
`vehicleRecordCoverage`, `vehicleStateLatest`, `liveStatus`.

**Server times (prod `totalMs`):**

| Procedure | Time |
|---|---|
| `economy` | 381 |
| `costOverview` | 283–335 |
| `sessionCosts` | 193–306 (waits on `sessions`, 49–150) |
| `patterns` | ~196 |
| `overview` | ~160 |
| `timeline` | ~157 |
| `liveStatus` | 14–353, once 3,596 (Zaptec login); never waited on |

`findActiveById` takes 3–5 ms alone but 90–141 ms inside one navigation's parallel burst.

**Already fine:**
- Devtools are stripped from the prod build.
- Every route is its own chunk, and hover preload is on.
- Fonts are self-hosted variable woff2.

## Step 3 notes

oRPC batching is already wired (`BatchLinkPlugin` in `src/lib/orpc/client.ts`, `BatchHandlerPlugin` in
`src/routes/api/rpc/$.ts`). It's limited to a `document.thumbnail` procedure left over from the template, which
doesn't exist here. Enabling it for queries is a few lines, but two things need deciding:

- **Timings.** Today a batch request logs only the last inner call's sub-timings (`context.timings` is shared), so
  batching needs per-call timing first.
- **Per-call auth.** Batching doesn't remove the user lookup each inner call does.

A single `evCharging.sources` read for the Datakällor panel removes 10 calls and their lookups outright, and turns
its four 60 s polls into one.

## Step 7 notes

The owner saw small layout shifts after step 1 and will show where. Start from their list, not from guesses. Known
candidates, for comparison only:

- **Skeletons between capture widths.** A section that reflows between two capture keys replays the lower key's
  layout, so the page moves once when the data lands (ADR-0025 §4 known limits, measured for Datakällor, economy and
  patterns).
- **Sensor tiles by count.** The `sensors-tiles` bones were captured with two sensors. With a different number of
  sensors, the tiles reflow once on load.
- **Alerts on a client navigation.** A failing source's alert can appear a moment after the page and push the
  content down once (ADR-0025 §1, accepted).

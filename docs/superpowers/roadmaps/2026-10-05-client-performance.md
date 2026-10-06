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
| 3 | Fewer, cheaper reads per page (ADR-0025 §5): merge reads per concern (sources' health, runs, sessions + costs), auth looked up once per HTTP request, pool gauges in the timing line | [plan](../plans/2026-10-05-client-perf-3-fewer-reads.md) | [#98](https://github.com/ljukas/videbacken/pull/98) | checkpoint passed | 2026-10-05/06: an admin `/charging` client navigation made 6 oRPC requests (5 plus a cached `syncStatuses`) with no `sessionCosts` waterfall; `/charging/settings` made 5 (a stale `user/me` refresh not counted). Every burst started from an empty pool and opened connections (`poolOpened` 1 per request on settings, 2–4 on `/charging` bursts), so the pool fix is row 8. See [notes](#checkpoint-3-result). |
| 4 | Bundle (ADR-0025 §6): phone fields out of the global form hook; admin-only dialogs (`/charging/settings`, `/sensors`, `/users`) load on first open; each page imports its own bones, no registry (since step 2, `/sensors` and `/users` loaded ~23 KB gz of charging bones). See [notes](#step-4-notes) | [plan](../plans/2026-10-05-client-perf-4-bundle.md) | [#104](https://github.com/ljukas/videbacken/pull/104) | PR open | — |
| 5 | Replace recharts with visx (refactor-workflow) | — | — | not started | — |
| 6 | Small items: load exifreader on file pick, find what pulls `jose` into the upload chunk, preload the body font, re-merge the shell's chunks split by step 4's lazy dialogs (rolldown `codeSplitting.groups`; shell 248 → 253 KB gz, +9 modulepreloads, same modules; measure `/login` too) | — | — | not started | — |
| 7 | Layout shifts after deferred loading: the owner points out where (seen after step 1); see [notes](#step-7-notes) | — | — | needs shaping | — |
| 8 | Keep pooled connections warm between navigations (`poolOpened` 1–4 per burst; pg's 10 s idle timeout empties the pool); see [checkpoint 3](#checkpoint-3-result) | — | — | needs shaping | — |

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
3. **After step 3 (prod).** An admin `/charging` client navigation makes 6 oRPC requests and `/charging/settings`
   5, with no `sessionCosts` waterfall (re-measured baseline in [step 3 notes](#step-3-notes); a stale `user/me`
   refresh isn't counted). The `rpc timing`
   lines carry the pool's start state (`poolTotal`, `poolIdle`, `poolWaiting`) and what it did during the request
   (`poolOpened`, `poolPeakWaiting`; read these). Record what a navigation's burst shows. If they point at opening
   connections (`poolOpened` > 0) or at queueing (`poolPeakWaiting` > 0), add the pool fix as a new row; otherwise the
   checkpoint passes without one. Only the app's pool shows here, not Supavisor's own queue.
   A small `poolPeakWaiting` (1–2) doesn't mean a full pool: pg-pool queues a checkout for one tick whenever an idle
   client exists (its `connect()` pushes to the pending queue and pulses on `nextTick`). Read it against `poolTotal`.
   Result: [checkpoint 3 result](#checkpoint-3-result).
4. **After step 4 (build).** Run `bun run bundle:measure` on `main` after the merge. Its per-page `packages:` and
   `bones:` lines must show:
   - `country-flag-icons` only on `/account/profile`. The `/users` invite and edit dialogs also carry it, in chunks
     that load on first open, so no page's line lists them.
   - `libphonenumber-js` only on `/account/profile` and `/users`. The users table formats numbers through
     `react-phone-number-input/input`, the entry without flags.
   - `@tanstack/form-core` on none of `/sensors`, `/users` or `/charging/settings`. Their admin dialogs load on first
     open.
   - Each page's `bones:` line lists only its own captures: `/charging` charging-chart, charging-sessions,
     charging-totals; `/charging/settings` charging-sources, charging-tariffs; economy charging-economy; patterns
     charging-patterns, charging-timeline; `/energy` energy-chart, energy-tiles; `/sensors` sensors-hum-chart,
     sensors-temp-chart, sensors-tiles; `/users` users-table; the session page and `/account/profile` none.
   - Page totals (KB gz) no higher than step 4's final measurement: entry + shell 253; `/charging` 161,
     `/charging/settings` 41, economy 159, patterns 171, `/charging/sessions/$id` 66, `/energy` 152, `/sensors` 123,
     `/users` 72, `/account/profile` 212.
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

**Requests on one admin `/charging` load:** 19 (stale since #90 moved the Datakällor reads to `/charging/settings`; see [step 3 notes](#step-3-notes)). These were `getSession` ×3 (server function), `overview`,
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

Re-shaped in its session ([spec](../specs/2026-10-05-client-perf-3-fewer-reads-design.md),
[ADR-0025 §5](../../adr/0025-deferred-route-loading.md#5-many-reads-per-page-merge-per-concern-not-per-transport)).
#90 had already moved the Datakällor panel off `/charging`, and the owner asked for the best practice for a page of
many reads rather than batching as such. The research and the prod logs pointed at merging reads per concern and
looking auth up once per request. Transport batching was decided against: in buffered mode the slowest call holds
every result, and streaming mode is unverified on Vercel.

**Re-measured 2026-10-05 on `main` at `7b96625`** (local dev, one admin client navigation each, from `/users`):

| Page | oRPC requests |
|---|---|
| `/charging` | 9: `overview`, `sessions`, `costOverview`, `tariff/list`, 3× `syncStatus`, `sessionCosts` (after `sessions`), `liveStatus` |
| `/charging/settings` | 11: 4× `syncStatus`, 4× `recentRuns`, `vehicleRecordCoverage`, `vehicleStateLatest`, `tariff/list` |

**Prod bursts** (5 h of `rpc timing` logs on 2026-10-05, 600 requests, de-duplicated by request id):

| Requests starting within 400 ms | `findActiveById` p50 / p90 / max |
|---|---|
| 1 (alone) | 5 / 30 / 81 ms |
| 4–6 | 21 / 41 / 111 ms |
| 7+ | 12 / 77 / 120 ms |

A one-row `syncStatus` takes 8–15 ms alone and 100–144 ms inside a `/charging/settings` load. Even lone requests
reach 30–81 ms at p90, which points at opening pooled connections after `pg`'s 10 s idle timeout. That is why
checkpoint 3 reads the new pool gauges before any pool change.

### Checkpoint 3 result

Prod `rpc timing` lines since the #98 deploy (2026-10-05 18:52 UTC), de-duplicated by request id and grouped into
bursts:

| Navigation | oRPC requests | Pool |
|---|---|---|
| `/charging`, 2026-10-05 19:38 UTC | 6: `overview`, `sessions`, `costOverview`, `tariff/list`, `liveStatus`, plus a cached `syncStatuses`. No `sessionCosts` waterfall | `poolTotal` 0 at the start; `poolOpened` 2–4 on its bursts |
| `/charging/settings`, 2026-10-06 04:55 and 05:00 UTC | 5 each: `syncStatuses`, `recentRuns`, `vehicleRecordCoverage`, `vehicleStateLatest`, `tariff/list` (a stale `user/me` refresh not counted) | `poolTotal` 0 at the start; `poolOpened` 1 per request |

- **Request counts pass.** `/charging` went from 9 to 6 and `/charging/settings` from 11 to 5.
- **Every burst opens connections.** Each starts from an empty pool, because pg's 10 s idle timeout closes them
  between navigations. `poolOpened` > 0, so per the checkpoint rule the pool fix is row 8.
- **`poolPeakWaiting` 0–2 isn't a full pool.** At most 4 of 10 connections were open. pg-pool queues a checkout for
  one tick whenever an idle client exists: its `connect()` pushes to the pending queue when `_idle.length` is
  non-zero, then pulses on `nextTick`.

## Step 4 notes

**Baseline, re-measured on `main` at `157dd61`** (prod build; KB gz each page adds beyond the entry, 172, and the
signed-in shell, 77; the two parts are rounded separately, so the tables' 248 is their 249):

| Page | Adds | Form chunk (123) | Bones + boneyard (26) | Bones it uses |
|---|---|---|---|---|
| `/charging` | 179 | — | ✓ | ~3.5 KB |
| `/charging/settings` | 200 | ✓ tariff + import dialogs | ✓ | ~2.6 KB |
| `/charging/economy` | 178 | — | ✓ | ~3 KB |
| `/charging/patterns` | 181 | — | ✓ | ~10.6 KB |
| `/energy` | 172 | — | ✓ | ~1.5 KB |
| `/sensors` | 278 | ✓ admin edit dialog | ✓ | ~1.2 KB |
| `/users` | 187 | ✓ admin invite/edit dialogs | ✓ | ~0.8 KB |
| `/account/profile` | 211 | ✓ phone field | — | — |

The form chunk, raw: country-flag-icons 227 KB, libphonenumber-js 150, @tanstack/form-core 56,
react-phone-number-input 38. All bones together: ~21 KB gz.

**The row's "admin dialogs on `/charging`" was stale.** #90 had moved them to `/charging/settings`, and `/charging`
no longer loaded the form chunk at all. The step lazy-loaded the admin dialogs on `/charging/settings`, `/sensors`
and `/users` instead.

**Final measurement** (`bun run bundle:measure` on the step's branch, 2026-10-06; KB gz beyond the entry + shell):

| Page | Before | After | Packages | Bones |
|---|---:|---:|---|---|
| entry + signed-in shell | 248 | 253 | | |
| `/charging` | 179 | 161 | boneyard-js | charging-chart, charging-sessions, charging-totals |
| `/charging/settings` | 200 | 41 | boneyard-js | charging-sources, charging-tariffs |
| `/charging/economy` | 178 | 159 | boneyard-js | charging-economy |
| `/charging/patterns` | 181 | 171 | boneyard-js | charging-patterns, charging-timeline |
| `/charging/sessions/$id` | — | 66 | — | — |
| `/energy` | 172 | 152 | boneyard-js | energy-chart, energy-tiles |
| `/sensors` | 278 | 123 | boneyard-js | sensors-hum-chart, sensors-temp-chart, sensors-tiles |
| `/users` | 187 | 72 | libphonenumber-js, boneyard-js | users-table |
| `/account/profile` | 211 | 212 | libphonenumber-js, country-flag-icons, @tanstack/form-core | — |

This meets checkpoint 4 on the branch; the checkpoint re-runs it on `main` after the merge. Live, a member's
`/users` and `/sensors` fetched no form, dialog or `PhoneField` chunk at desktop, tablet and phone widths (only
`/users`' table formatter, below). An admin fetches them when the browser goes idle.

**The shell grew 5 KB gz without gaining code** (248 → 253). Its 437 modules are unchanged. But each lazy dialog,
and `PhoneField`'s own entry, is a new dynamic entry, and rolldown groups modules into chunks by the entries that
reach them. So modules the shell shares with those entries (Radix primitives, cmdk, `button`, `dialog`,
floating-ui …) split into more, smaller chunks: about +5 KB gz of per-chunk gzip overhead (+1.3 KB when `PhoneField` became its own entry, +3.3 KB when the lazy dialogs did, same 437 modules throughout) and 9 more `modulepreload`
requests on every signed-in page. A rolldown chunk group (`codeSplitting.groups`) could merge them back. That is a
step-6 item, since it needs its own measurement, `/login` included (ADR-0025 §6).

**`/users` keeps `libphonenumber-js`** (~39 KB gz, the `getInternationalPhoneNumberPrefix` chunk). The users table
formats each stored number with `formatPhoneNumberIntl`, now imported from `react-phone-number-input/input`, so the
country flags are gone but the number metadata stays. A lighter formatter would need its own change.

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

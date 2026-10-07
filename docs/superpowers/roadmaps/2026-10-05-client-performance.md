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
| 4 | Bundle (ADR-0025 §6): phone fields out of the global form hook; admin-only dialogs (`/charging/settings`, `/sensors`, `/users`) load on first open; each page imports its own bones, no registry (since step 2, `/sensors` and `/users` loaded ~23 KB gz of charging bones). See [notes](#step-4-notes) | [plan](../plans/2026-10-05-client-perf-4-bundle.md) | [#104](https://github.com/ljukas/videbacken/pull/104) | checkpoint passed | 2026-10-06, `main` at `17fb518`: every `packages:` and `bones:` criterion holds. Totals are within 1–2 KB of the bar per page; the shell is 257 against 253, all of it from #102 and #103 merging in (see [checkpoint 4 result](#checkpoint-4-result)). |
| 5a | Bar charts on visx (refactor-workflow): a shared visx bar-chart module, tests moved off recharts' classes, HourOfDay, Monthly, Economy and Spot converted. `/charging`, economy and patterns drop recharts | [plan](../plans/2026-10-06-client-perf-5a-visx-bar-charts.md) | [#111](https://github.com/ljukas/videbacken/pull/111) | checkpoint passed | Covered by checkpoint 5 (see [step 5a notes](#step-5a-notes)). |
| 5b | The Energi month chart on the bar module (selection, keyboard, export below the axis, hover outline) | [plan](../plans/2026-10-06-client-perf-5b-energi-chart.md) | [#115](https://github.com/ljukas/videbacken/pull/115) | checkpoint passed | Covered by checkpoint 5 (see [step 5b notes](#step-5b-notes)). |
| 5c | ClimateChart on visx lines; recharts, `ui/chart.tsx` and the old `ChartFrame` deleted; checkpoint 5 | [plan](../plans/2026-10-06-client-perf-5c-climate-chart.md) | [#118](https://github.com/ljukas/videbacken/pull/118) | checkpoint passed | 2026-10-06: the owner reviewed the converted charts live on prod and they look good. On `main` at `b63da3b`, no page's `packages:` line lists recharts, redux, immer or decimal.js-light, and `bun.lock` has none of them. See [checkpoint 5 result](#checkpoint-5-result). |
| 6 | Small items: load exifreader on file pick, find what pulls `jose` into the upload chunk, preload the body font, re-merge the shell's chunks split by step 4's lazy dialogs (rolldown `codeSplitting.groups`; shell 248 → 253 KB gz, +9 modulepreloads, same modules; measure `/login` too), keep route search parsing out of the shell (`/energy`'s month parsing puts `date-fns` + `@date-fns/tz` there, see [checkpoint 4 result](#checkpoint-4-result)) (search parsing: recorded, not changed) | [plan](../plans/2026-10-06-client-perf-6-small-items.md) | [#127](https://github.com/ljukas/videbacken/pull/127) | checkpoint passed | 2026-10-07, `main` at `a409a97`: no exifreader, `@vercel/blob` or jose on `/account/profile` or `/onboarding` (AvatarUpload 72 → 10 KB gz), the prod SSR `<head>` of `/login` carries the Switzer preload, and the prod build's chunk check passed. Against `main` just before #127, no page grew. Against the step notes' final column, 5 figures read 0.3–2 above; the rebuilt branch head reads the same as `main`. See [checkpoint 6 result](#checkpoint-6-result). |
| 7 | Layout shifts after deferred loading: the owner points out where (seen after step 1); see [notes](#step-7-notes) | — | — (no change needed) | checkpoint passed | 2026-10-07: the owner navigated the app and found no layout shifts left. Other PRs and design changes since step 1 had already fixed the ones they saw, so the step needed no PR of its own. See [checkpoint 7 result](#checkpoint-7-result). |
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
5. **After step 5c (prod).** Steps 5a and 5b have no checkpoint of their own; each PR is reviewed live at three widths before merge. Owner reviews every converted chart live. recharts, redux, immer and decimal.js-light are
   gone from the build.
6. **After step 6 (build).** Run `bun run bundle:measure` on `main` after the merge (final figures in
   [step 6 notes](#step-6-notes)):
   - `/account/profile` and `/onboarding` list none of exifreader, @vercel/blob or jose.
   - No page above step 6's final measurement: entry 176.2, entry + shell 252, `/charging` 84, `/charging/settings` 44 (43.4 unrounded),
     economy 77, patterns 76, `/charging/sessions/$id` 65, `/energy` 72, `/sensors` 48, `/users` 73,
     `/account/profile` 151, `/login` 85.9, `/onboarding` 85.6, `/signed-in` 31.5. Compare the printed values:
     signed-in pages print integers, signed-out pages one decimal.
   - `bun run build` and `bun run bundle:measure` print `chunk cycles: none`, and the build's chunk check reports
     that the entry reaches no chunk group.
   - The SSR `<head>` of `/login` carries the Switzer preload.
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

### Checkpoint 4 result

Measured 2026-10-06 with `bun run bundle:measure` on `main` at `17fb518`, which is #104 plus #102 (credentials on
the settings page) and #103 (the Energi month picker).

- **Packages: pass.** `country-flag-icons` is only on `/account/profile`. `libphonenumber-js` is only on
  `/account/profile` and `/users`. No `@tanstack/form-core` on `/sensors`, `/users` or `/charging/settings`.
- **Bones: pass.** Each page lists only its own captures. `/charging/settings` also lists `charging-grid`, #102's
  new section.
- **Totals (KB gz):**

  | | Step 4 final | `main` |
  |---|---|---|
  | entry + shell | 253 | 257 |
  | `/charging` | 161 | 160 |
  | `/charging/settings` | 41 | 43 (#102's grid card + its bones) |
  | economy | 159 | 158 |
  | patterns | 171 | 170 |
  | `/charging/sessions/$id` | 66 | 64 |
  | `/energy` | 152 | 148 |
  | `/sensors` | 123 | 123 |
  | `/users` | 72 | 73 |
  | `/account/profile` | 212 | 213 |

**The shell's +4 KB is new code from #102 and #103, not a step-4 regression.** A source-map diff of the entry +
shell closure, between step 4's final commit (`895b686`, 437 modules) and `main` (453), shows only additions:
- `date-fns` (`addDays`, `startOfMonth`, `formatISO`, …), `@date-fns/tz`, `src/lib/time/stockholm.ts`,
  `src/lib/houseEnergy/period.ts` and `energy/index.tsx?tsr-shared=1`, all from #103. The `/energy` route's
  `validateSearch` parses the month, and TanStack keeps a route's search parsing in the eagerly loaded route tree.
- `src/lib/integrationCredentials.ts`, from #102: the settings route's search schema reads `CREDENTIAL_SOURCES`.

Keeping search parsing out of the shell (a lighter parser, or one with no time-zone library) is added to step 6.

## Step 5a notes

**Bundle** (`bun run bundle:measure`, KB gz each page adds beyond the entry + shell, which stays 257):

| Page | `main` (`5edaa9f`) | 5a |
|---|---:|---:|
| `/charging` | 160 | 83 |
| `/charging/economy` | 158 | 76 |
| `/charging/patterns` | 170 | 83 |
| `/charging/sessions/$id` | 64 | 65 |
| `/energy` | 148 | 148 (recharts until 5b) |
| `/sensors` | 123 | 124 (recharts until 5c) |

The recharts chunk (81–84 KB gz) is gone from the three charging pages. `ChartPopover` (12) is now a shared chunk with
the visx primitives, so the session page gained 1 KB from regrouping.

**What 5a changed for a viewer, on purpose (owner-approved):**
- **Keyboard:** each chart is still one Tab stop, but as a named `role="group"` (the SessionPriceChart idiom), not
  recharts' unnamed `role="application"`. ←/→/Home/End walk the months, Escape and Tab-out close the card, each step
  is announced in a polite, atomic live region, and the focus ring is visible.
- **The tooltip** keeps its card look and rows but sits above the month (ChartPopover's mechanics), not beside the
  cursor. Focus no longer shows January by itself; the first → does.

**Accepted drift, to review live:** y ticks may differ by a step (d3's nice ticks), and a narrow chart's x labels
thin greedily from the first while keeping the last, so the kept subset can be uneven (as recharts'
`preserveStartEnd`). 5a meant integer axes to keep recharts' five ticks, but they didn't: d3 gave them 6-7. They
match recharts only since 5b's fix (`a517922`, see [step 5b notes](#step-5b-notes)), which also restores the
charging charts' integer axes.

**Bones not recaptured in 5a.** The chart frames keep their heights (260 px; the hour chart 220), with the legend
inside the frame as before, so the captured skeletons still match the page's layout. A recapture from local data
picked up data-only drift elsewhere on the pages (the patterns timeline, the economy table rows) and turned the
charts' sr-only nodes into dot bones, so it is left for 5c, with `.sr-only` excluded in `boneyard.config.json`.

**Follow-ups found in review (not in 5a):**
- An sr-only data table for Monthly, Economy and Spot. NVDA/JAWS in browse mode don't pass arrows to a group, and
  mobile screen readers have no arrows. Today's recharts charts give them nothing either.
- Announce "no data" when the keyboard lands on an empty month, and show the keyboard hint visibly on focus without a
  layout shift.
- Opt the pill charts (heatmap, calendar, session) into `followScroll`. Their tooltip drifts from its mark when a
  scroll container moves (pre-existing).
- Re-measure the axis labels once the web font loads (`getStringWidth` caches the fallback font's widths).

## Step 5b notes

**Bundle** (`bun run bundle:measure`, KB gz each page adds beyond the entry + shell). The plan's baseline is `main` at
`3862039`. #112 (the energy flow diagram, `2745e0f`) merged during the step and grew `/energy`'s own chunk, so the PR is
also measured against `2745e0f`:

| Page | `main` (`3862039`) | `main` (`2745e0f`) | 5b |
|---|---:|---:|---:|
| entry + shell | 257 | 257 | 257 |
| `/energy` | 149 (chart 81, energy 17, line 9, step 5, TotalsTiles 5) | 155 (chart 81, energy 25, line 9, step 5, format 5) | 72 (energy 16, ChartPopover 12, line 9, MetricToggle 5, format 5) |
| `/charging` | 83 | 83 | 83 |
| `/charging/economy` | 76 | 77 | 77 |
| `/charging/patterns` | 83 | 84 | 85 |
| `/charging/sessions/$id` | 65 | 65 | 65 |
| `/sensors` | 124 (chart 81) | 124 (chart 81) | 121 (sensors 90: recharts now in the page's own chunk, until 5c) |

The recharts `chart` chunk (81) is gone from `/energy`: 155 → 72 KB gz against `2745e0f` (−83). `/energy`'s packages
line stays `boneyard-js`. The charging pages move by at most 1 KB, from the bar module's new options.

**Integer y axes reproduce recharts' ticks again.** The fix `a517922` ports recharts' nice-tick rule (five ticks, no
decimals) for `yIntegers` axes. The Energi y ticks matched `main` live for all three metrics at 1280, 768 and 375 px:
Solel 0-1 000 by 250, Nät −650-1 950 by 650, Förbrukning 0-2 000 by 500. The fix also restores recharts' ticks on the
charging charts with integer axes, which 5a had changed to d3's 6-7.

**Accepted differences (owner-approved 2026-10-06; state them in the PR):**
1. Hovering a month's label now outlines the month and opens its card (the label was clickable but showed nothing).
2. The switch to initials is measured (`labelsFit`) instead of a fixed 36 px column, so full labels stay down to
   about a 27-30 px column.
3. A mouse click focuses the chart group (the ring shows for keyboard focus only, `focus-visible`). The old
   `onMouseDown preventDefault` only kept recharts' keyboard mode off January.
4. The screen-reader announcement starts with the short label ("apr.") before the card's "April ...".

**Live check** (local data, 1280, 768 and 375 px, side by side with `main`): the bars, legend, colours, ticks, tick
font (13 px), card rows and their 4 px spacing, the gap line's wrapping, Nät's export below the zero line, selection by
click, label and Enter, and the empty-year state match. A month without readings can't be selected, and from the
keyboard it gets the dashed outline. At 375 px the labels are initials and the first and last months' cards and
outlines stay inside the window. The x labels sit about 4 px lower and the plot about 2 px further right than
recharts' (the shared axis margins from 5a).

**Follow-ups found in review and the live check (not in 5b):**
- Space right after Tab scrolls the page, because nothing is outlined yet. recharts selected January there. The
  first → outlines January, as in 5a. Decide whether Space should do nothing instead.
- The zero line is painted over the bars. Hide it when 0 is outside a pinned `yDomain`.
- Measure the full label widths only when `shortCategory` is set (HourOfDay measures 24 labels it never uses).
- `X_AXIS_H` is fixed at 30 px, which fits 13 px ticks. Revisit it in the app-wide type pass.
- An outline left over from a shrunk `rows` can reappear if the rows grow back (cosmetic).
- Tests to add: blur clearing the outline, Enter and Space with no selection, the `e.repeat` guard, and a floored
  negative segment in a diverging stack.
- The group's name repeats the section heading. It could name the metric too.
- Bones are not recaptured in 5b (as in 5a). The recapture is in 5c.

## Step 5c notes

**Baseline** (`bun run bundle:measure` on `main` at `a8c684e`, KB gz each page adds beyond the entry + shell). The
`/sensors` page carries recharts in its own chunk (`sensors` 90):

| Page | Before 5c |
|---|---:|
| entry + shell | 258 |
| `/charging` | 84 |
| `/charging/settings` | 44 |
| `/charging/economy` | 77 |
| `/charging/patterns` | 85 |
| `/charging/sessions/$id` | 65 |
| `/energy` | 72 |
| `/sensors` | 121 (sensors 90, line 9, step 5, format 4, SectionSkeleton 4) |
| `/users` | 73 |
| `/account/profile` | 213 |

`bun.lock` lines matching `"recharts`, `"redux`, `"immer`, `"decimal.js-light` or `"@reduxjs`: 9.

**Accepted differences (owner-approved 2026-10-06; state them in the PR):**
1. Round time ticks. Ticks fall on round local times (24 h: every 3/6/12 h; 1 w: midnights; 1 m: Mondays; 3 m to 6 m:
   the 1st and 16th or month starts; 1 y and all: month starts every 1 to 3 months, all: up to 12), the finest that
   fits. Labels: 24 h `HH:mm`, 1 w the short weekday ("tis"), longer ranges the short date ("1 okt."). recharts
   divided the span into five equal parts at odd times (15:20, 22:16, 05:13 ...).
2. A dot on each card row's reading. recharts drew its 4 px active dot only on the line that owned the hovered x; now
   each visible device listed in the card gets one, on its own nearest reading, so the dots match the rows.
3. Every device hidden. recharts drew no tick labels but four grid lines. Now the time axis keeps its ticks (the time
   domain spans hidden devices by design), and there is no y axis label or grid line (no value range).

**After 5c** (`bun run bundle:measure` on the branch, KB gz each page adds beyond the entry + shell):

| Page | Before 5c | 5c |
|---|---:|---:|
| entry + shell | 258 | 258 |
| `/charging` | 84 | 84 |
| `/charging/settings` | 44 | 44 |
| `/charging/economy` | 77 | 77 |
| `/charging/patterns` | 85 | 76 |
| `/charging/sessions/$id` | 65 | 65 |
| `/energy` | 72 | 72 |
| `/sensors` | 121 | 48 (ChartPopover 21, sensors 9, format 4, SectionSkeleton 4, ChartParts 3) |
| `/users` | 73 | 73 |
| `/account/profile` | 213 | 213 |

`/sensors` drops 73 KB gz (121 to 48). No page's `packages:` line lists recharts, redux, immer or
decimal.js-light. `bun.lock` has 0 lines matching `"recharts`, `"redux`, `"immer`, `"decimal.js-light` or
`"@reduxjs` (9 before). `/charging/patterns` is 9 KB lower than the baseline; the other pages and the shell are
unchanged.

**More differences from `main` (state them in the PR):**
- The legend is sorted by display name, as recharts sorted it. The plan first said roster order.
- The time axis has finer `fallbacks`, so a short span (a new sensor on 1 y or all) is never left without ticks.
- The hover line and dots paint over the lines and axes, as recharts did.
- A mouse pointer leaving the plot clears the announcement.
- `touch-action: pan-y` on the plot disables pinch-zoom over it (as on the bar charts).
- With every device hidden the y axis line goes too, and the plot widens to the left.
- `ChartLegend` wraps and spans the full width (the 5a component), unlike shadcn's legend.
- The x tick labels sit about 3.5 px lower than recharts' (the shared axis convention, as 5b noted).
- The hover card sits above the dots, not beside the cursor.
- The plot starts about 2 px further right, so the snap point can differ by one reading from `main`.
- An x label that would run past the svg shifts inward just enough, and its tick mark stays on its time (recharts'
  `preserveEnd` shifted the last label the same way). This fixes the end-label clipping the live check found (the
  "1 okt." label cut by 2 to 3 px on all and on 1 y at 1280 px). The first label shifts the same way, and the
  labels' spacing is judged after the shift, so a shifted label never crowds its neighbour.

**Live check** (local data, 1280, 768 and 375 px, plus 320 px for 24 h, 1 w and 1 y, side by side with `main`):
the lines, colours, legend, grid, axis lines, tick marks and y labels match, and the card rows and values match. Time
ticks are round and never crowd at 320 px. Dots, Tab and the arrow keys, Home and End, Escape, a range switch with a
card open and the hidden-devices state behave as planned. A lifted finger keeps the card and a tap elsewhere closes it.

### Checkpoint 5 result

Recorded 2026-10-06, `main` at `b63da3b` (#118 merged, plus the docs-only #119).

- **Live: pass.** The owner reviewed the converted charts live on prod and they look good.
- **Build: pass.** `bun run bundle:measure` matches the branch's numbers: `/sensors` 48, patterns 76, the shell 258 KB gz,
  and no page's `packages:` line lists recharts, redux, immer or decimal.js-light. `bun.lock` has 0 lines for them, or
  for `@reduxjs`, `react-redux` and `victory-vendor`. No source map in `.output/public` points into those packages.
  A text search of the JS for "immer" matches only boneyard's `shimmer` animation.
- **Phone: pass.** The owner checked a horizontal touch drag on a real phone: it scrubs through the readings. The
  `pointercancel` seen in Chromium's touch emulation (on the bar charts too) is an emulation artefact, not a bug.

**Follow-ups found in review and the live check (not in 5c):**
- `BarChart`'s mouse leave doesn't clear its keyboard announcement; `ClimateChart`'s does. Match them.
- Cover the `makeTimeAxis` formats for 3 m, 6 m and all, and locale handling.
- Pin the spacing tests: a tick-count assertion for the month-end spacing, a length floor for the spring-forward
  case, and an assertion beyond `< 2` for the 1-day 1 y case.
- Tidy the tests: two hover tests overlap on `toHaveLength(2)`, a `readingTimes` fixture with shared rows, a test that modifier keys pass through, and
  the y-tick comment that says "two decimals".
- Stale recharts mentions: comments in the `ClimateChart` tests and `docs/bugfix-workflow.md:36`.
- A poll that changes the announced time's rows re-reads the live region (the bar chart does the same).
- The same-time early return in `onPointer` skips `setAnnounced(null)` (harmless, the same content).

## Step 6 notes

**Baseline, `main` at `4376917`** (prod build, `bun run bundle:measure`; KB gz, each page beyond the entry and the
signed-in shell, signed-out pages beyond the entry only). The final column is the step's branch head.

| Page | Baseline | Final | Notes |
|---|---:|---:|---|
| entry alone | 176.4 | 176.2 | 24 chunks at baseline |
| entry + signed-in shell | 258 | 252 | shell chunks beyond the entry: 28 before, 13 after |
| `/charging` | 84 | 84 | |
| `/charging/settings` | 44 | 43 | 43.5 → 43.4 unrounded |
| `/charging/economy` | 77 | 77 | |
| `/charging/patterns` | 76 | 76 | |
| `/charging/sessions/$id` | 65 | 65 | |
| `/energy` | 72 | 72 | |
| `/sensors` | 48 | 48 | |
| `/users` | 73 | 73 | |
| `/account/profile` | 213 | 151 | AvatarUpload chunk 72 → 10 |
| `/login` | 88.4 | 85.9 | |
| `/onboarding` | 150.0 | 85.6 | also renders AvatarUpload |
| `/signed-in` | 34.0 | 31.5 | |

Task 4 re-measured the branch before the groups at entry 176.5 and `/onboarding` 88.1; the tuning table below uses those.

**Upload modules load on pick.** `AvatarUpload` imports `exifreader` and the Vercel Blob client with one `import()`
pair. A click on the upload button starts it (the OS picker takes seconds), and `handleFile` awaits it. The busy state
starts at the pick, so the button is disabled while the chunk loads. A chunk that fails to load shows the localized
upload error. `/account/profile` went 213 → 151. `/onboarding` went 150.0 → 88.0 with the upload change alone, then 85.6 with the chunk groups. The AvatarUpload chunk is 10 KB gz,
not the ~5 the plan guessed, because `bowser` (36 KB raw) stays inlined in it.

**Where `jose` came from.** `@vercel/blob/client`'s shared chunk imports `getVercelOidcToken` from `@vercel/oidc`.
That package's browser entry (`dist/index-browser.js`) is CommonJS and `require`s `verify-vercel-oidc-token`, which
requires all of `jose`, so nothing tree-shakes (raw: exifreader 344 KB, `@vercel/oidc` + `jose` 146, `@vercel/blob`
81, `bowser` 36). That holds for the locked `@vercel/blob` 2.6.1 and `@vercel/oidc` 3.8.0. Checked on npm 2026-10-06: `@vercel/oidc` 4.0.0's browser entry still requires `jose`, and `@vercel/blob` 2.8.1 still depends on `^3.6.1`.
Patching a dependency is out (owner rule), so the fix is to load it only on upload.

**Body font preload.** `src/lib/fonts.ts` holds the Switzer URL, and `__root.tsx` renders the preload `<link>`. A node
test checks that `app.css`'s `@font-face` uses the same URL and that the file exists, since a mismatch downloads the
font twice. The SSR HTML of `/login` carries
`<link rel="preload" href="/fonts/switzer/Switzer-Variable.woff2" as="font" type="font/woff2" crossorigin="anonymous"/>`,
and the live check fetched the font once with no "preloaded but not used" warning. The heading font isn't preloaded.

**Chunk groups.** Two rolldown groups for the client build only (`config/clientChunkGroups.ts`, wired through
`environments.client` in `vite.config.ts`; `/build/` is gitignored, so the file isn't under `build/`): `shell` for the
modules only the signed-in shell uses and `ui` for those it shares with the signed-out pages. The rule is that no
grouped module may be reachable from the entry. Tuning, one measured configuration after another (KB gz):

| Config | entry | entry + shell | `/login` | `/onboarding` | `/signed-in` | Chunk cycles |
|---|---:|---:|---:|---:|---:|---|
| before the groups | 176.5 | 258 | 88.4 | 88.1 | 34.0 | none |
| c1: the plan's prototype | 176.2 | 251 | 84.6 | 96.1 | 49.1 | `button` ↔ `ui` ↔ `blurhash-image`, `_authenticated` ↔ `shell` |
| c2: better-auth chain and `authClient` out of `ui` | 176.2 | 251 | 85.0 | 84.6 | 37.6 | the same two |
| c3: also out of `ui`: what `/signed-in` didn't load on `main` (avatar, spinner, input, input-group, image sizes, blurhash, unpic, react-avatar, react-visually-hidden) | 176.2 | 252 | 85.7 | 85.4 | 31.4 | `button` ↔ `ui`, `_authenticated` ↔ `shell`; `/login` crashes |
| **c4 (final):** c3 without `class-variance-authority`, with lucide's `menu` icon in `shell` | **176.2** | **252** | **85.9** | **85.6** | **31.5** | none |

Every signed-in page is at or below its baseline in every configuration, to one decimal as well as rounded (unchanged pages moved by 0.2 KB at most). The
plan's prototype broke the no-growth rule on the signed-out pages: a page that loads one module of `ui` loads all of
it, so `/onboarding` and `/signed-in` pulled in code they never used. The tuning took those modules out of `ui`, which
is now exactly what the shell shares with `/signed-in`, the smallest signed-out page.

**The crash the numbers didn't show.** The c3 build passed every size target and the whole test suite, but `/login`
failed on hydration with `TypeError: i is not a function` in `button-*.js`. With `includeDependenciesRecursively:
false`, rolldown no longer keeps the chunk graph acyclic (its type docs recommend `strictExecutionOrder`, which would
wrap every module in the client build). `ui` imported the Radix primitives from `button`'s chunk, `button`'s chunk
imported `cva` back from `ui`, and `button` ran first, so `cva` was still undefined. A second cycle,
`_authenticated` ↔ `shell`, came from `sidebar.tsx`'s `menu` icon staying in the layout chunk. That one crossed only at render
time and was harmless at init, but it is the same trap and only signed-in pages load it. Both were broken by choosing what goes in each group, not by `strictExecutionOrder`.

**Cycle guard.** Nothing in the tests or the sizes sees such a cycle, so the build does:
- `scripts/chunkGraph.ts` reads the client chunks' static import graph (shared with `measureBundle.ts`) and finds
  cycles (`chunkCycles`, Tarjan).
- `scripts/checkChunkCycles.ts` runs after `vite build` in both `build` (so CI's `Check (build)` fails) and
  `vercel-build`, since a squash-merge of two green PRs can form a cycle on `main` that no PR's CI saw. It checks the
  newer of `.output/public/assets` (node-server preset) and `.vercel/output/static/assets` (Vercel preset), and exits
  1 on a cycle or when the entry's static closure reaches a `shell-*` or `ui-*` chunk (the group names come from
  `config/clientChunkGroups.ts`). It fails closed: no build dir, no chunks or no entry chunk is a failure, never a
  pass. Putting the c3 configuration back reproduced the two cycles with the same chunk hashes and failed the build;
  grouping an entry-only module (`@tanstack/history`) in `ui` failed the entry rule alone.
- `bun run bundle:measure` prints a `chunk cycles:` line under `entry:`.
- Only static imports count. A cycle through a dynamic `import()` is safe at init.

**`modulepreload` counts**, prod builds of `main` and the branch, headless, local data, load + 4 s (modulepreloads /
JS requests):

| Page | `main` | Branch |
|---|---|---|
| `/charging` | 86 / 88 | 71 / 73 |
| `/users` | 85 / 87 | 70 / 72 |
| `/login` (signed out) | 47 / 49 | 41 / 43 |

On the branch at 1280 and 375 px: `/charging` renders, the sidebar opens and closes at 375 px, Cmd+K opens the palette
and `/users`' lazy invite dialog opens, with no page errors. A tooltip wasn't exercised, since `/charging` has no
tooltip trigger in its default state. On `/account/profile`, no exif or client-upload chunk loads before the pick, and
after picking a PNG both load and the "Profilbilden uppdaterad" toast shows (local presigned-PUT path). A Vercel Blob
upload, the prod transport, is only exercised on the preview deployment.

**Item 5, search parsing out of the shell: recorded, not changed** (owner, 2026-10-06). The cause isn't search
parsing. It is the `/energy` loader: `energyOverviewQueryFor` → `stockholmYearMonth` pulls `date-fns` and
`@date-fns/tz` into the entry, about 2 KB gz, which every page that formats dates loads anyway. The general fix
(TanStack's `codeSplittingOptions` with `defaultBehavior: [['loader', 'component'], …]`, which moves loaders out of the
route tree) was prototyped: entry 176.4 → 170.6 and shell total 258 → 255, but every page grew 2–3 KB gz, and a cold
client navigation's queries would start only after the route chunk arrives, against ADR-0025 §1. A narrow `Intl` fix
goes against the date-fns preference. So loaders stay in the route tree, and their imports stay in the entry.

### Checkpoint 6 result

Recorded 2026-10-07. `main` is at `a409a97` (#127, merged after #125 and #128). Prod runs that commit
(`videbacken-q21pu20d2`).

- **Upload chunk: pass.** Neither `/account/profile` nor `/onboarding` lists exifreader, `@vercel/blob` or jose in its
  `packages:` line. `AvatarUpload` is 10 KB gz on both (72 before).
- **Font preload: pass.** The prod SSR HTML of `/login`, from `curl https://app.lukaslindqvist.se/login`, has
  `<link rel="preload" href="/fonts/switzer/Switzer-Variable.woff2" as="font" type="font/woff2" crossorigin="anonymous"/>`
  in its `<head>`, and the font serves (`font/woff2`, 43,220 bytes).
- **Chunk check: pass.** `bun run bundle:measure` prints `chunk cycles: none`. The prod `vercel-build` log prints
  `checking .vercel/output/static/assets` and then
  `chunk cycles: none; the entry reaches no chunk group (131 client chunks)`.
- **Sizes: nothing grew.** It doesn't match the final column, though. Table in KB gz; each page counts beyond the entry
  and the shell, and the signed-out pages beyond the entry only. The pre-#127 build was measured with `a409a97`'s
  `measureBundle.ts`, because the older script had no `entry:` line and no signed-out pages.

  | Page | Step notes' final | `main` before #127 (`96737f7`) | Branch head rebuilt (`8e6e312`) | `main` (`a409a97`) |
  |---|---:|---:|---:|---:|
  | entry alone | 176.2 | 176.7 | 176.5 | 176.5 |
  | entry + shell | 252 | 258 | 253 | 253 |
  | `/charging` | 84 | 84 | 84 | 84 |
  | `/charging/settings` | 43 | 44 | 43 | 43 |
  | economy | 77 | 78 | 78 | 78 |
  | patterns | 76 | 77 | 77 | 77 |
  | `/charging/sessions/$id` | 65 | 65 | 65 | 65 |
  | `/energy` | 72 | 74 | 74 | 74 |
  | `/sensors` | 48 | 48 | 48 | 48 |
  | `/users` | 73 | 73 | 73 | 73 |
  | `/account/profile` | 151 | 213 | 151 | 151 |
  | `/login` | 85.9 | 88.4 | 85.9 | 85.9 |
  | `/onboarding` | 85.6 | 150.0 | 85.6 | 85.6 |
  | `/signed-in` | 31.5 | 34.0 | 31.5 | 31.5 |

  The criterion compares against the final column, and five figures there read 0.3–2 KB lower than on `main`: the
  entry, the shell, economy, patterns and `/energy`. #127
  didn't cause the gap. Its branch head, rebuilt today with the same lockfile, reads exactly what `main` does. `main`
  just before #127 already had economy 78, patterns 77 and `/energy` 74, and #127 changed none of the three. The final
  column most likely predates the branch's last rebase onto `10e0e08`, which brought in #124 (the battery page): its
  `/energy` 72 is the step's own baseline from before #124. Against `main` just before #127, the step took 5 KB gz off the shell, 62 off `/account/profile`, 64
  off `/onboarding`, 2.5 off `/login` and `/signed-in`, and 1 off `/charging/settings`. No page grew.

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
- **Patterns timeline bones.** The recapture in 5c shrank the `charging-timeline` skeleton from 754 to 328 px at
  desktop, because local data has fewer sessions than at the last capture. On prod the Sessioner card can be taller
  than its skeleton, so it shifts once on load.
- **Economy gap.** The economy section's loaded height is 24 px taller than its bones at 375 and 1280 px (the lead
  paragraph's `gap-6`; already so at 1280 before 5c).

### Checkpoint 7 result

Recorded 2026-10-07, `main` at `1adf584`.

- **Live: pass.** Asked for the spots, the owner said the shifts had already been fixed by other PRs and changes to
  the design, and navigating the app turned up none. Step 7 needed no PR of its own.
- **Not checked one by one.** The owner's check was a general navigation of the app, so the candidates above were
  not each re-measured. If one of them comes back, fix it under the bugfix workflow, not as a new roadmap step.

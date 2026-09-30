# EV charging Phase 3 — when we charge — design

Status: agreed 2026-09-30. Scope + research: [scope map](./2026-09-28-ev-charging-scope-map.md) ("Phase 3").
Builds on: [Phase 1 design](./2026-09-28-ev-charging-phase1-design.md), [Phase 2 design](./2026-09-29-ev-charging-phase2-design.md), ADR-0019, ADR-0020.
Visual reference (approved layout, synthetic data): local-only mockup `.superpowers/brainstorm/22167-1790758957/content/patterns-page.html` (git-excluded, not committed — Biome lints HTML).

## Intent

Answer at a glance, on phone and desktop: **when do we plug in, when does the car actually draw power, and how
long does it sit plugged in idle?** Descriptive only — no cost (Phase 4) and no ours-vs-guests split (Phase 5).
Read-only for everyone signed in, like the rest of `/charging`; there is nothing to mutate.

## Decisions (agreed with the owner)

| # | Decision |
|---|---|
| 1 | Views live on a **new sub-route `/charging/patterns`**, not appended to `/charging` (already long). The two pages share a tab bar. |
| 2 | **Session timeline = one row per session** for a chosen month, on a shared **00:00 → 24:00** axis (the plug-in's Stockholm day). Charging segments solid, plugged-in-idle segments faint. *Amended after the owner's live review, 2026-09-30:* the first cut used 12:00 → 12:00, but charging is mostly daytime/solar, and that axis pushed pre-noon plug-ins to the right edge. |
| 3 | Weekday × hour heatmap + hour-of-day histogram default to **kWh** with a **"Inkopplad" toggle** (hours plugged in per slot). The calendar is always kWh. |
| 4 | **Narrow SQL fetch → pure TS aggregation on the server** (the Phase 2 cost-model split). Not SQL `GROUP BY` per view, not raw intervals to the browser. |
| 5 | **No schema change.** Everything derives from `ev_charge_session` + `ev_charge_interval` under `countedSessionFilter()`. |
| 6 | Sessions **without intervals** count toward plugged-in hours and daily kWh (window + total are known) but are **excluded from hourly kWh** — never spread as a guess (ADR-0020 "missing ≠ 0"). The count is returned and noted in the UI. |
| 7 | Charging inside a partial hour is **estimated** from the session's peak kW and labelled as such. |
| 8 | **No ADR** — these are design details under existing decisions (ADR-0019/0020), not new seams. |

## Data facts this relies on (from the Phase 0 probe + `src/lib/effects/zaptec/parse.ts`)

- `energyDetails` is per-interval and hour-aligned: points at session start, every `:00`, and session end. `toIntervals`
  pairs them into `[start, end)` intervals whose kWh sums to the session's `energy`.
- **Zero-kWh intervals are stored** — an hour plugged in without drawing power is a real row with `energy_kwh = 0`.
  That is what makes idle time visible at hourly resolution.
- `start_at` / `end_at` of the session are plug-in / plug-out (the session window). Resolution of *when inside an hour*
  charging started/stopped is not available.
- ~100 counted sessions and ~1–2k interval rows per year → fetching a year's intervals is cheap.

---

## Read model

### Pure module `src/lib/evCharging/patterns/` (client-safe, dependency-light)

No `db` import; types are shared with the client (CLAUDE.md "client code may only `import type` from services").
Time math via the existing Stockholm helpers in `src/lib/time/stockholm.ts` (built on `@date-fns/tz`) — extend them
there if a helper is missing (e.g. Stockholm hour-of-day / ISO weekday of an instant), never hand-roll offsets.

Inputs (what the service fetches):

```ts
type PatternSession = {
  id: string
  startAt: Date
  endAt: Date
  energyKwh: number
  intervals: { startAt: Date; endAt: Date; energyKwh: number }[] // may be empty
}
```

Building blocks:

- **`splitByStockholmHour(from, to)`** → `{ hourStart: Date; weekday: 0–6 (Mon = 0); hour: 0–23; day: 'YYYY-MM-DD'; ms }[]`.
  Splits any span at Stockholm clock-hour boundaries. DST-aware: the fall-back day has two `02` hours (both bucket
  into hour 2), the spring-forward day has no `02`. Intervals from offline / unreliable-clock sessions go through the
  same function — it never assumes hour alignment.
- **kWh of an interval** is pro-rated by time across the pieces it splits into.
- **Plugged-in time** comes from the **session window** `[startAt, endAt)`, not the intervals, so it also covers
  interval-less sessions.

Aggregates:

```ts
type Slot = { kwh: number; pluggedHours: number }

type ChargingPatterns = {
  year: number
  years: number[]                 // same list + clamping as the overview (OVERVIEW_MIN/MAX_YEAR)
  weekdayHour: Slot[][]           // [7][24], Monday first, Stockholm time
  hourOfDay: Slot[]               // [24], weekdayHour collapsed
  daily: { day: string; kwh: number; sessions: number }[] // only days with energy or a session start
  months: { month: number; kwh: number; sessions: number }[] // 12 rows, for the calendar month headers
  unhourlySessions: number        // counted sessions in the year without intervals
}
```

- `daily.kwh`: interval kWh bucketed by Stockholm day of each piece; an interval-less session adds its whole
  `energyKwh` to the day of its `startAt` (same fallback rule as the overview's monthly totals). An overnight session
  therefore splits its kWh across both days.
- `daily.sessions` and `months.sessions`: by the session's own `startAt` day/month (matches the overview's counting).
- `months.kwh` must equal the overview's monthly kWh for the same year (same bucketing rules) — asserted in a service
  test so the two pages can never disagree.
- Year scope: pieces whose Stockholm day falls in the selected year. A session crossing New Year contributes to both
  years' views.

Timeline:

```ts
type TimelineSegment = { startAt: Date; endAt: Date; kind: 'charging' | 'idle' }
type TimelineSession = {
  id: string
  startAt: Date
  endAt: Date
  energyKwh: number
  chargingHours: number          // sum of charging segments (estimated)
  segments: TimelineSegment[]    // ordered, contiguous, cover [startAt, endAt)
  hourly: boolean                // false → session has no intervals (rule 5)
}
type ChargingTimeline = { year: number; month: number; months: number[]; sessions: TimelineSession[] }
```

Segment rules (`toSegments(session)`):

1. **Peak kW** = max over intervals of `energyKwh / hours` among intervals at least 50 minutes long (full hours; the
   partial first/last hour under-reads). No such interval → peak = max over all intervals.
2. An interval with `energyKwh < 0.05` → one `idle` segment over the whole interval.
3. Otherwise charging duration `c = min(intervalHours, energyKwh / peakKw)`. If `c ≥ 0.95 × intervalHours` the whole
   interval is `charging`; else `charging` for `[start, start + c)` then `idle` for the rest. (Charging at the start
   of the hour matches the Enyaq's end-of-charge taper and a scheduled start on the hour.)
4. Adjacent segments of the same kind merge.
5. **Interval-less session**: a single segment with `kind: 'idle'` over the window and `hourly: false`; the UI draws
   the plugged-in bar with a "ingen timdata" marker instead of guessing where charging happened.
6. Gaps between the session window and its first/last interval (clock quirks) are `idle`.

`months` (in `ChargingTimeline`) = the months of `year` that have at least one counted session, for the stepper.
Default month when the URL has none: the latest entry in `months`, else the current month.

### Service `src/lib/services/evCharging/patterns.ts`

- `getChargingPatterns({ year?, now? })` and `getChargingTimeline({ year?, month?, now? })`.
- One narrow fetch each: counted sessions (`countedSessionFilter()`) whose window overlaps the year / month range,
  using a sargable `start_at` range (widened by one day at the start so a session that began the previous evening is
  included — no `extract()` in `WHERE`), plus their intervals in a second query (`session_id IN (…)`, served by the
  `ev_charge_interval` primary key). Then call the pure module.
- `years` reuses the overview's `distinctCountedYears()` (export it from `overview.ts` rather than duplicating).
- Exported from `services/evCharging/index.ts`. No domain errors — both are plain reads with validated input.

### Procedures (`src/lib/orpc/procedures/evCharging.ts`)

- `evCharging.patterns` — `protectedProcedure`, input `{ year?: int in [OVERVIEW_MIN_YEAR, OVERVIEW_MAX_YEAR] }`.
- `evCharging.timeline` — `protectedProcedure`, input `{ year?: same bounds, month?: int 1–12 }`.
- Both record `context.timings.fetchMs` and `context.timings.aggregateMs`.
- Freshness: hourly data → no `refetchInterval`; focus refetch + `syncNow` invalidation (ADR-0018). `useSyncNow`
  already invalidates `orpc.evCharging.key()`, which covers both new procedures — no change needed.

---

## UI

### Routing

- Preparatory refactor: `src/routes/_authenticated/charging.tsx` → `src/routes/_authenticated/charging/index.tsx`
  (no parent layout; both pages are leaves). `routeTree.gen.ts` regenerated, never edited.
- New `src/routes/_authenticated/charging/patterns.tsx` → `/charging/patterns` (English path).
- Sidebar: unchanged single "Laddning" item — `AppSidebar` matches with `fuzzy: true`, so it stays active on both.
- Command palette (`src/components/command/commands.ts`): add a "Laddmönster" entry → `/charging/patterns`.
- Search params (zod, `.catch(undefined)` like `/charging`): `year`, `metric: 'kwh' | 'plugged'`, `month: 1–12`.
  Year/month/metric changes use `replace: true, resetScroll: false`.
- Loader: `prefetchQuery` for `patterns(year)` and `timeline(year, month)` (a failed read shows the load-error alert
  instead of replacing the page) + `ensureQueryData` for the Zaptec `syncStatus` (for the heading's "Senast synkad" and
  the health alert). `keepPreviousData` on year/month changes.

### Components (`src/components/evCharging/`)

| Component | Notes |
|---|---|
| `ChargingTabs` | Links "Översikt" / "Mönster" with `aria-current="page"`; used on both pages under `ChargingHeading`. Not Radix `Tabs` (they switch routes, not in-page state). |
| `MetricToggle` | Generic kWh / Inkopplad toggle (also replaces /charging's kWh ↔ kr toggle); sits in the heatmap card header and drives the heatmap + hour chart. |
| `WeekdayHourHeatmap` | A `<table>` (row/col headers, sr-only cell values). ≥ sm: 7 rows × 24 cols; < sm: **transposed** 24 rows × 7 cols so it never scrolls horizontally. Colour = a `d3-scale` `scaleQuantile` over the **non-zero** values → **5 distinct steps** (≈ 20 / 40 / 60 / 80 / 100 % `--brand` mixed into `--card`, `color-mix(in oklab, …)`); thresholds are snapped to real values and deduplicated, so fewer distinct values give fewer (never empty) steps, the top one always full `--brand`. Zero = `--muted` with a `--border` stroke. *Amended 2026-09-30:* the first cut's `scaleSqrt` ramp made most cells look alike. Legend: "mindre ●●●●●● mer" (zero swatch + the steps), no numbers at all; the ranges live only in the aria-label (owner feedback 2026-09-30). Tooltip (shadcn `tooltip`) on hover/focus: "tis 21–22 · 38,4 kWh" / "… · 2,5 h inkopplad". |
| `HourOfDayChart` | Recharts `BarChart`, 24 bars, styled like `MonthlyChart`; tick every 3 h (6 h on mobile). |
| `ChargingCalendar` | 12 mini month grids (Mon first), responsive 6 / 4 / 3 / 2 columns; header = month name (a link setting `?month=`) + month kWh; future days hatched; same quantile colour scale as the heatmap (over daily kWh) and the same legend; tooltip "fre 5 sep · 32,1 kWh · 1 session". |
| `SessionTimeline` | Month stepper `‹ september 2026 ›` (bounded by `months`). Axis 00 → 24 with ticks every 3 h and a faint night band (00–06 and 22–24 of the row's day). One row per session: label "fre 5 sep · 21:10–07:02 · 32,1 kWh" + "laddar 3,2 h av 10,0 h inkopplad"; track with idle (faint brand) under charging (solid brand) segments. Row window = 00:00 → 24:00 of the session's Stockholm start day (`stockholmDayBounds(stockholmDayOf(start))`), so a row never starts clipped; a session ending after that midnight is clipped with a `›` marker and its summary says "fortsätter efter midnatt" (the footnote "› fortsätter efter midnatt" shows only when some row is clipped). A DST day (23 / 25 h) is mapped onto the same width: the bars and the night band sit at their true instants, the fixed 3 h ticks may drift by ≤ 1 h (accepted). The label always shows real times; the ≥ 640 px label column is ~240 px so a full label stays on one line. < sm: label above the track. Legend + footnote: "Zaptec rapporterar energi per timme; när laddningen startar och slutar inom en timme är uppskattat." Interval-less rows: plugged-in bar only + "ingen timdata". |

Page order (top → bottom), inside `PageContainer`: `ChargingHeading` → `ChargingTabs` → `SyncHealthAlert` (Zaptec) →
controls row (metric toggle, `YearSelector`) → heatmap card → histogram card → calendar card → timeline card.

### Feedback (ADR-0016)

- Year with no counted sessions → one shared `Empty` in place of the four cards.
- Month with no sessions → `Empty`-style row inside the timeline card (the stepper stays).
- `unhourlySessions > 0` and metric kWh → a muted note under the heatmap: "{n} sessioner saknar timdata och ingår inte i
  timvyerna." (plural message; not shown for Inkopplad, where those sessions do count).
- A patterns or timeline read that fails with nothing to show → the shared destructive `Alert` with a retry button.
- Stale/errored sync → the existing `SyncHealthAlert`; data stays visible.

### i18n

All strings in `messages/sv.json` (source of truth) + `messages/en.json` (key-complete), prefix `charging_patterns_*`.
Weekday and month names come from `Intl.DateTimeFormat` with the active locale, not message keys.

---

## Delivery: three PRs, in order (two skeptical reviewers after each task)

| PR | Title | Scope |
|---|---|---|
| **A** | `refactor(charging): move the charging page under charging/` | File move + route tree regen + any test/import paths. No behavior change. |
| **B** | `feat(charging): add charging pattern and timeline read models` | Stockholm helper additions, pure `evCharging/patterns/`, `patterns.ts` service, the two procedures + timings. No UI caller yet. |
| **C** | `feat(charging): show when we charge on /charging/patterns` | Route, `ChargingTabs` (both pages), the four views, toggle, stepper, empty states, command-palette entry, i18n. |

## Testing

- **Pure module (test-first, node project):** hour split on a fall-back day (two `02` hours) and a spring-forward day
  (no `02`); a midnight-crossing session splits `daily` kWh across both days; partial first/last hours pro-rate;
  zero-kWh intervals → `idle` and still count in `pluggedHours`; interval-less sessions → counted in
  `unhourlySessions`, excluded from hourly kWh, included in `daily`; peak-kW estimate capped at interval length;
  a session with no ≥ 50-min interval falls back to the max over all intervals; segments are contiguous and cover
  the window; adjacent same-kind segments merge.
- **Service (`setupDatabase()`):** `countedSessionFilter()` honoured (noise, voided, replaced excluded); year and
  month ranges include a session that started the previous evening; a session crossing New Year appears in both
  years; `months.kwh` equals `getOverview().months` kWh for the same fixture.
- **Procedures:** input bounds (year/month out of range rejected), `protectedProcedure` (anonymous → unauthorized).
- **Components (browser project):** heatmap transposes below `sm`; timeline clips with chevrons; interval-less row
  shows "ingen timdata"; empty month; `unhourlySessions` note; metric toggle switches the heatmap + histogram; the
  `clientSafe.browser.test.tsx` guard covers the new client-safe module.
- **Live (Phase 6):** desktop / tablet / mobile against the local stack with `ZAPTEC_ADAPTER=fake` (the local DB is
  empty), compared with the mockup.

## Accepted gaps / deferred

- Within-hour timing is estimated (decision 7); exact start/stop needs Zaptec charger-state history we don't store.
- No per-vehicle split (Phase 5) and no price overlay (Phase 4).
- The 00:00 → 24:00 axis is fixed (it replaced the first cut's 12:00 → 12:00 after the owner's live review); a data-driven axis origin (quietest hour) is deferred until the fixed one proves wrong. Overnight sessions are clipped at midnight rather than wrapped onto a second row.
- No "all time" / rolling-12-months range — year only, matching `/charging`.

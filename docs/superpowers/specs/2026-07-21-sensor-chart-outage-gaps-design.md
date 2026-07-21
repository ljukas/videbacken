# Climate chart outage gaps — design

**Date:** 2026-07-21
**Status:** approved (pending spec review)
**Supersedes the chart-rendering half of:** `2026-07-18-sensor-climate-graphs-design.md`
**Builds on:** PR #8 (`connectNulls={true}` interim fix, now on `main`)

## Problem

The `/sensors` climate chart draws one line per device from server-side
time-bucketed averages. Two production realities break the original rendering:

1. **Sensors interleave.** The battery Shelly sensors report on independent
   schedules and rarely share a bucket. The wide-format pivot (`toChartRows`)
   keys rows on the *union* of all timestamps, so most rows carry one device's
   value and `null` for the rest.
2. **Sparse, bursty cadence.** A sensor emits at most ~1 reading / 2h, and a
   silence of **up to ~10h is normal** (the device sleeps and wakes on change).

The original `connectNulls={false}` treated every `null` as a gap, so with (1)
every point was isolated and **no lines rendered at all** (the reported bug).
PR #8 flipped it to `connectNulls={true}`, which fixed rendering but **bridges
genuine outages** with a straight interpolation — a real regression for a
monitoring tool, because a dead sensor looks like a healthy continuous line.

The root cause is that `null` is **overloaded**: in the wide-pivot it means both
"another device's timestamp" (structural) and "this device was silent" (real).
Recharts' boolean `connectNulls` cannot distinguish the two.

## Goal

Connect a device's readings across **normal** silence (incl. the ~10h sleeps),
but show a **visible break** when a device was silent long enough to count as
down — without an absolute hard-coded duration.

## Decision summary

| Decision | Choice |
|---|---|
| Representation | **Per-device series**: each `<Line>` gets its own `data` array; `null` means *only* a real outage. |
| Break trigger | Silence longer than **K × bucketWidth**, with **K = 4**. |
| Fine ranges | **Connect-all** when the bucket is finer than the cadence (the 24h range) — never break. |
| Break visual | A plain gap (line stops and resumes) + a **dot** on any reading left isolated. |
| Threshold source | Server returns the resolved `bucketSec`; the client computes `K × bucketSec`. |
| X-axis domain | Unchanged — data-bounded (`dataMin`/`dataMax`). |

## The core insight

`connectNulls={false}` was the right *intent* ("break on a gap") applied to the
wrong *data*. Once each line carries only its own readings, the only `null`s are
break-markers we insert at real outages — so `connectNulls={false}` becomes
correct again: connect real readings, break at real outages.

## Threshold rule (adaptive, no fixed floor)

For a range with resolved bucket width `bucketSec` and reporting cadence
`CADENCE_SEC` (~2h):

```
maxConnectGapSec = bucketSec < CADENCE_SEC ? Infinity : K * bucketSec   // K = 4
```

- `bucketSec < CADENCE_SEC` is true **only for the 24h range** (10-min buckets),
  where empty buckets are normal sparseness, not silence → connect-all.
- Otherwise a device silent for more than `K × bucketSec` reads as down → break.

Resulting per-range behavior (K = 4, cadence ~2h):

| Range | Bucket | maxConnectGap | Break after silence of | Normal ≤10h gap |
|---|---|---|---|---|
| 24h | 10 min | ∞ (connect-all) | never | connects |
| 1m | 3 h | 12 h | > 12 h | connects |
| 3m | 12 h | 48 h | > 2 days | connects |
| 6m / 1y | 1 day | 4 days | > 4 days | connects |
| all | day/week | 4 × bucket | > 4 buckets | connects |

K = 4 is the smallest whole multiple that clears the 10h-normal silence on the
tightest breaking range (1m: 4 × 3h = 12h > 10h). It is a single tunable
constant; there is no per-range magic number and no absolute floor.

## Data flow & components

### 1. Server — `getSeries` returns `bucketSec`

`src/lib/services/sensor/sensor.ts`. Return `{ buckets, bucketSec }`. The client
needs the resolved bucket width to compute the threshold and cannot derive it
for the `all` range (its width is data-dependent). `resolveWindow` already
computes `bucketSec`; thread it through the return value. When there are no
buckets, return the `bucketSec` that *would* apply (or `0`/window default — the
client only uses it when buckets exist). Update the oRPC procedure's inferred
output type accordingly; no input change.

### 2. Client reshape — `toDeviceSeries` (replaces `toChartRows`)

`src/lib/sensor/chartData.ts` (client-safe; types-only imports — no service
values, per the client-bundle constraint).

```ts
export type SeriesPoint = { t: number; v: number | null; isolated?: boolean }
export type DeviceSeries = { id: string; points: SeriesPoint[] }

toDeviceSeries(
  buckets: Buckets,
  metric: 'temp' | 'hum',
  opts: { bucketSec: number; maxGapBuckets: number; cadenceSec: number },
): DeviceSeries[]
```

For each device that appears in any bucket:
- Collect its **non-null** readings in ascending `t`.
- Compute `maxConnectGapSec` per the rule above.
- Walk consecutive readings; when `Δt > maxConnectGapSec`, insert a single
  break-marker `{ t: <midpoint of the two>, v: null }` so Recharts breaks the
  line (a null y-value with `connectNulls={false}` splits the path).
- Mark a reading `isolated: true` when it has **no** connected neighbour (both
  sides are a break or the series edge) — used for the dot.

`colorForIndex` / `DEVICE_COLORS` stay as-is.

### 3. `ClimateChart` — per-`<Line>` data

`src/components/sensor/ClimateChart.tsx`. Props change from a shared `rows` array
to per-device series:

```ts
type ClimateChartDevice = {
  id: string; displayName: string; color: string; hidden?: boolean
  points: SeriesPoint[]
}
```

Each device renders:

```tsx
<Line
  data={d.points}
  dataKey="v"
  type="monotone"
  stroke={`var(--color-${d.id})`}
  connectNulls={false}          // breaks at our inserted null markers
  dot={/* render only for isolated points */}
  strokeWidth={2}
  isAnimationActive={false}
  hide={d.hidden}
/>
```

- **connectNulls={false}** — the only `null`s are intentional breaks.
- **Isolated-point dots** — a small dot for any point marked `isolated` (a lone
  reading, or a short resumption between two breaks) so data is never invisible.
  Prefer a `dot` render predicate keyed on `payload.isolated`; if Recharts makes
  that awkward, fall back to a small always-on dot only for series whose points
  are all isolated. (Verify against the installed component.)
- `ChartContainer` `config` (the `--color-<id>` CSS vars), legend, tooltip,
  colors, and `isAnimationActive={false}` are preserved.

### 4. Route wiring

`src/routes/_authenticated/sensors.tsx`. Build `chartDevices` with `points` from
`toDeviceSeries(buckets, metric, { bucketSec, maxGapBuckets: 4, cadenceSec })`
inside the existing `useMemo`s (one per metric). `bucketSec` comes from the
series response. Everything else (range selector, toggles, tiles, polling)
unchanged.

## Constants

- `MAX_GAP_BUCKETS = 4` and `CADENCE_SEC = 2 * 3600` live in the client-safe
  `~/lib/sensor/range.ts` (or a sibling), documented with the rationale, so both
  are tunable in one place without touching the db-importing service module.

## Edge cases

- **Single reading in window** → one point, `isolated` → dot (today's behavior,
  preserved).
- **Device with no readings in window** → empty series → nothing drawn.
- **Hidden device** → `hide` on the line (unchanged).
- **All-null metric for a present device** (e.g. humidity missing) → no non-null
  points → nothing drawn for that metric.
- **`all` range** → `bucketSec` from server (daily/weekly); rule applies normally.

## Verify during implementation (not assumed)

- **Tooltip**: with per-series data on disjoint timestamps, Recharts' shared
  (`axis`) tooltip hover behavior may differ. Drive it in the browser; adjust
  (e.g. tooltip `trigger`/`shared`) only if it regresses.
- **Dot render predicate**: confirm the `dot` callback receives `payload` with
  our `isolated` flag in Recharts 3.8.0; adjust per the installed API.
- **X-axis domain** with per-series data stays `dataMin`/`dataMax` (data-bounded,
  as today) — not widened to the full window.

## Out of scope

- Widening the x-axis to the full selected window.
- Changing bucket widths, polling, tiles, webhook ingest, or admin ops.
- Configurable/per-device cadence (single `CADENCE_SEC` constant for now).
- Dashed "interpolated" connectors across breaks (plain gap chosen).

## Testing (TDD)

**Unit — `toDeviceSeries` (`chartData.test.ts`, node):**
- inserts a break only when `Δt > maxConnectGap` (below → connected).
- 24h/fine range (`bucketSec < cadence`) → connect-all, never breaks.
- marks lone / break-flanked readings `isolated`.
- empty buckets → `[]`; single reading → one isolated point.
- humidity vs temperature metric selection.

**Browser — `ClimateChart.browser.test.tsx`:**
- a real outage (Δt beyond threshold) renders **two** segments with a gap
  (path has ≥2 `M` sub-paths).
- normal cadence renders **one** continuous segment (single `M`, contains `L`/`C`).
- interleaved sensors still each draw a continuous line (regression from PR #8).
- a single-reading device still shows a dot.

## Rollout

Standard branch → PR → squash-merge. Verify on the Vercel preview / prod 24h and
a longer range against real data before/after.

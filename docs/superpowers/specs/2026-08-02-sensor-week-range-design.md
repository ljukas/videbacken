# Sensor climate graphs: a 1-week range

**Date:** 2026-08-02
**Status:** Approved

## Problem

The climate page (`/sensors`) jumps from `24h` straight to `1m`. A day is too
short to see a weather swing play out; a month buckets at 3h and spans 30 days,
so a single week is squeezed into a quarter of the axis. There is no view that
answers "what did the house do this week?".

## Solution

Add a `1w` range between `24h` and `1m`. It is a new entry in the existing range
enum plus one row in the service's fixed-range table — no new query, component,
or procedure.

### Range key

`'1w'`, following the `1m`/`1y` naming already in `SERIES_RANGES`
(`src/lib/sensor/range.ts`), placed between `'24h'` and `'1m'`.

Adding it to that one array covers three consumers for free: the oRPC input
schema (`z.enum(SERIES_RANGES)` in `procedures/sensor.ts`), the route's search
schema (`sensors.tsx`), and the `Record<SeriesRange, …>` maps — TypeScript
flags every map that still needs a `1w` entry.

`range.ts` must stay dependency-free: it is imported by the browser bundle, and
a runtime import of the service pulls `~/lib/db` → `postgres` → `Buffer` and
crashes the page. Guarded by `src/lib/sensor/clientSafe.browser.test.tsx`.

### Window and bucket width

One new row in `FIXED_RANGES` (`src/lib/services/sensor/sensor.ts`):

```ts
'1w': { windowSec: 7 * DAY_SEC, bucketSec: 2 * 3600 }, // 2 h → ~84 pts
```

2h is chosen to equal `CADENCE_SEC` (sensors emit at most ~1 reading / 2h). Two
consequences, both wanted:

1. **~one reading per bucket.** ~84 points across the week (~12/day), with
   almost no averaging loss — the line shows the readings themselves.
2. **Outage gaps still render.** `toDeviceSeries` disables break markers when
   `bucketSec < cadenceSec` (empty buckets are then normal sparseness, as on the
   24h range). At `bucketSec === cadenceSec` the comparison is false, so breaks
   stay on with a threshold of `MAX_GAP_BUCKETS × 2h = 8h` of silence. A 1h
   bucket would have silently turned outage gaps off for this range only.

This equality is load-bearing and currently unguarded, so it gets its own test.

`resolveWindow` and `queryBucketAverages` are already range-generic; neither
changes.

### Labels

New message key `sensors_range_1w` — sv `"1 vecka"`, en `"1 week"`. Wired into
`RANGE_LABEL` and `ORDER` in `src/components/sensor/RangeSelector.tsx`.

Swedish abbreviates the other units ("1 mån", "1 år"), but a bare "1 v" reads as
a week *number* in Swedish, so the word is spelled out.

### X-axis and tooltip format

`makeTickFormatter` (`sensors.tsx`) currently branches 24h vs everything else. It
gains a middle branch:

| range | format | example |
|---|---|---|
| `24h` | `{ hour, minute }` | `14:20` |
| `1w` | `{ weekday: 'short', hour, minute }` | `tis 14:00` |
| rest | `{ month: 'short', day: 'numeric' }` | `2 aug` |

At 2h resolution a day holds ~12 points; the bare short date would label all of
them identically — in the tooltip header too, since both the axis and the
tooltip use this one formatter.

### Polling

`POLLED_RANGES` becomes `['24h', '1w', '1m']`. A new reading visibly moves a 2h
bucket, so the same 60s refetch that serves 24h and 1m applies.

## Testing

Tests are written before the implementation.

- `src/lib/services/sensor/series.test.ts`
  - `1w` buckets by 2h: two readings inside one 2h bucket are averaged, a third
    in the next bucket stays separate.
  - the 7-day window excludes an older reading and keeps one inside it.
  - `bucketSec` is 7200 for `1w` (extends the existing resolved-width test).
- `src/lib/sensor/chartData.test.ts`
  - `bucketSec === cadenceSec` still inserts a break marker after >8h of
    silence — pins the boundary the bucket choice depends on.
- `src/components/sensor/RangeSelector.browser.test.tsx`
  - the `1w` option renders and reports `'1w'` when picked.

No change needed in `procedures/sensor.test.ts` — the input schema derives from
the enum.

## Out of scope

No DB migration (readings are stored raw; bucketing is query-time). No ADR
change. No new component, service, procedure, or effect.

## Verification

`bun run i18n:compile` (required before `m.sensors_range_1w` exists), then
`bun run check`, `bun run build`, `bun run test`.

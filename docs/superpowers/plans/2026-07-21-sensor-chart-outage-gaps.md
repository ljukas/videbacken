# Climate Chart Outage Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw each sensor's line continuous across normal (≤~10h) silence but with a visible break across genuine outages, replacing the blunt `connectNulls={true}` shipped in PR #8.

**Architecture:** Give each Recharts `<Line>` its **own `data` array** (per-device series) so a `null` means exactly one thing — a real outage — inserted as a break marker only when a device was silent longer than an adaptive threshold. `connectNulls={false}` then connects real readings and breaks at markers. Isolated readings render as dots.

**Tech Stack:** TanStack Start, oRPC, Drizzle/Postgres, Recharts 3.8.0, shadcn chart wrapper, Vitest (node + browser/Playwright).

**Spec:** `docs/superpowers/specs/2026-07-21-sensor-chart-outage-gaps-design.md`

## Global Constraints

_Every task's requirements implicitly include this section._

- **Recharts is locked at `3.8.0`** — verified behaviors: a `<Line>` with its own `data` renders from that data; the numeric axis domain spans all series' own data; a custom `dot` element receives `{ cx, cy, payload, ... }` and may return `null`.
- **Client-bundle safety:** client modules (`~/lib/sensor/*`, routes, components) may only `import type` from `~/lib/services/*`. Importing a service *value* pulls `db → postgres → Buffer` into the browser and crashes it. `~/lib/sensor/range.ts` and `~/lib/sensor/chartData.ts` stay value-import-free of the service.
- **All DB access through services** (`src/lib/services/sensor/`). No `db.*` in routes/components.
- **Logging** via `~/lib/logger/` only; never `console.*`.
- **Every screen responsive**; no fixed pixel widths (chart height stays the existing inline `260`).
- No new user-facing copy is introduced (the break is purely visual), so **no `messages/*.json` changes**.
- **Conventional Commits** (`<type>(<scope>): <subject>` ≤72 chars, imperative).
- **Commits in this workstream are unsigned** — use `git -c commit.gpgsign=false commit --no-gpg-sign …`.
- **TDD**: write the failing test, watch it fail, minimal code, watch it pass, commit.

## File Structure

- `src/lib/services/sensor/sensor.ts` — `getSeries` additively returns `bucketSec`.
- `src/lib/services/sensor/series.test.ts` — add `bucketSec` assertions.
- `src/lib/sensor/range.ts` — add `MAX_GAP_BUCKETS`, `CADENCE_SEC` (client-safe constants).
- `src/lib/sensor/chartData.ts` — add `SeriesPoint`, `DeviceSeries`, `toDeviceSeries`; later remove `toChartRows`/`ChartRow`.
- `src/lib/sensor/chartData.test.ts` — add `toDeviceSeries` tests; later remove `toChartRows` tests.
- `src/components/sensor/ClimateChart.tsx` — per-`<Line>` data + `IsolatedDot`.
- `src/components/sensor/ClimateChart.browser.test.tsx` — rewrite for the per-device `points` API.
- `src/routes/_authenticated/sensors.tsx` — build per-metric chart devices from `toDeviceSeries` + `bucketSec`.

---

### Task 1: Server returns the resolved bucket width

**Files:**
- Modify: `src/lib/services/sensor/sensor.ts` (`getSeries`, ~line 268-282)
- Test: `src/lib/services/sensor/series.test.ts`

**Interfaces:**
- Produces: `getSeries(...) : Promise<{ buckets: SeriesBucket[]; bucketSec: number }>` — `bucketSec` is the resolved bucket width in seconds (`0` when there is nothing to show). The client needs it because the `all` range's width is data-dependent and can't be derived client-side.

- [ ] **Step 1: Write the failing tests** (append to `series.test.ts`)

```ts
test('getSeries returns the resolved bucket width', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa40')
  await db.insert(sensorReading).values({
    deviceId: d,
    temperatureC: 20,
    recordedAt: new Date('2026-07-18T11:00:00Z'),
  })
  expect((await getSeries({ range: '24h', now })).bucketSec).toBe(600) // 10 min
  expect((await getSeries({ range: '1m', now })).bucketSec).toBe(10800) // 3 h
})

test('getSeries returns bucketSec 0 when there is nothing to show', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  expect((await getSeries({ range: 'all', now })).bucketSec).toBe(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:node -- series`
Expected: FAIL — the two new tests error/assert (`bucketSec` is `undefined`).

- [ ] **Step 3: Implement** — replace the body of `getSeries` (keep the signature comment above it):

```ts
export async function getSeries(input: {
  range: SeriesRange
  deviceIds?: string[]
  now?: Date
}): Promise<{ buckets: SeriesBucket[]; bucketSec: number }> {
  const now = input.now ?? new Date()
  // Explicit empty selection = no devices → empty (distinct from undefined = all).
  if (input.deviceIds?.length === 0) return { buckets: [], bucketSec: 0 }

  const filter = deviceFilter(input.deviceIds)
  const win = await resolveWindow(input.range, now, filter)
  if (!win) return { buckets: [], bucketSec: 0 }

  return {
    buckets: toBuckets(await queryBucketAverages(win, now, filter)),
    bucketSec: win.bucketSec,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test:node -- series`
Expected: PASS (all series tests, incl. the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/sensor/sensor.ts src/lib/services/sensor/series.test.ts
git -c commit.gpgsign=false commit --no-gpg-sign -m "feat(sensors): return bucketSec from getSeries"
```

---

### Task 2: `toDeviceSeries` reshape + gap constants

**Files:**
- Modify: `src/lib/sensor/range.ts` (append constants)
- Modify: `src/lib/sensor/chartData.ts` (add types + `toDeviceSeries`; keep `toChartRows` for now)
- Test: `src/lib/sensor/chartData.test.ts` (append a `toDeviceSeries` describe block; keep existing blocks)

**Interfaces:**
- Consumes: `RouterOutputs['sensor']['series']['buckets']` (each bucket `{ t: number; perDevice: Record<string, { tempAvg: number|null; humAvg: number|null }> }`).
- Produces:
  - `MAX_GAP_BUCKETS = 4`, `CADENCE_SEC = 7200` (from `~/lib/sensor/range.ts`).
  - `type SeriesPoint = { t: number; isolated?: boolean; [deviceId: string]: number | null | boolean | undefined }` — the device's value lives under its own id key (so the chart's `<Line dataKey={id}>` and the shadcn config-by-id keep working); `v: null` under that key is a break marker.
  - `type DeviceSeries = { id: string; points: SeriesPoint[] }`.
  - `toDeviceSeries(buckets, metric: 'temp'|'hum', opts: { bucketSec: number; maxGapBuckets: number; cadenceSec: number }) : DeviceSeries[]`.

- [ ] **Step 1: Add the constants** to the end of `src/lib/sensor/range.ts`:

```ts
// Chart gap-break tuning (client-safe; imported by chartData + the /sensors route).
// A device is drawn as one continuous line across silence up to MAX_GAP_BUCKETS
// bucket-widths; a longer silence renders as a visible break. On ranges whose
// bucket is finer than CADENCE_SEC (only 24h), empty buckets are normal
// sparseness, so the line connects across the whole window (never breaks).
export const MAX_GAP_BUCKETS = 4
export const CADENCE_SEC = 2 * 3600 // sensors emit at most ~1 reading / 2h
```

- [ ] **Step 2: Write the failing tests** — append to `src/lib/sensor/chartData.test.ts`. Also add `toDeviceSeries` to the import from `./chartData`.

```ts
// opts that put us in "break" mode: bucketSec >= cadenceSec → maxGapSec = 2.
const BREAK = { bucketSec: 1, cadenceSec: 1, maxGapBuckets: 2 }
// opts finer than the cadence (the 24h case) → connect across any gap.
const CONNECT_ALL = { bucketSec: 1, cadenceSec: 5, maxGapBuckets: 2 }

function bucket(
  t: number,
  perDevice: Record<string, { tempAvg: number | null; humAvg: number | null }>,
): SeriesBucket {
  return { t, perDevice }
}

describe('toDeviceSeries', () => {
  it('connects readings within the gap threshold', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(2, { a: { tempAvg: 21, humAvg: 41 } }), // Δ2, not > 2 → connected
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      { id: 'a', points: [{ t: 0, a: 20 }, { t: 2, a: 21 }] },
    ])
  })

  it('inserts a break marker when silence exceeds the threshold', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(5, { a: { tempAvg: 25, humAvg: 45 } }), // Δ5 > 2 → break
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 20, isolated: true },
          { t: 2.5, a: null },
          { t: 5, a: 25, isolated: true },
        ],
      },
    ])
  })

  it('connects across any gap when the bucket is finer than the cadence (24h)', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(100, { a: { tempAvg: 21, humAvg: 41 } }),
    ]
    expect(toDeviceSeries(buckets, 'temp', CONNECT_ALL)).toEqual([
      { id: 'a', points: [{ t: 0, a: 20 }, { t: 100, a: 21 }] },
    ])
  })

  it('marks a lone reading isolated so it renders a dot', () => {
    expect(toDeviceSeries([bucket(5, { a: { tempAvg: 20, humAvg: 40 } })], 'temp', BREAK)).toEqual([
      { id: 'a', points: [{ t: 5, a: 20, isolated: true }] },
    ])
  })

  it('skips a null metric reading (no point at that bucket)', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: null, humAvg: 40 } }),
      bucket(1, { a: { tempAvg: 21, humAvg: 41 } }),
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      { id: 'a', points: [{ t: 1, a: 21, isolated: true }] },
    ])
  })

  it('keeps devices in first-appearance order', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 1, humAvg: 0 } }),
      bucket(1, { b: { tempAvg: 2, humAvg: 0 }, a: { tempAvg: 3, humAvg: 0 } }),
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('selects the humidity metric', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 20, humAvg: 40 } }),
      bucket(1, { a: { tempAvg: 21, humAvg: 41 } }),
    ]
    expect(toDeviceSeries(buckets, 'hum', BREAK)).toEqual([
      { id: 'a', points: [{ t: 0, a: 40 }, { t: 1, a: 41 }] },
    ])
  })

  it('breaks a device into two connected clusters around an outage', () => {
    const buckets = [
      bucket(0, { a: { tempAvg: 10, humAvg: 0 } }),
      bucket(1, { a: { tempAvg: 11, humAvg: 0 } }), // cluster 1
      bucket(9, { a: { tempAvg: 12, humAvg: 0 } }), // Δ8 > 2 → break before
      bucket(10, { a: { tempAvg: 13, humAvg: 0 } }), // cluster 2
    ]
    expect(toDeviceSeries(buckets, 'temp', BREAK)).toEqual([
      {
        id: 'a',
        points: [
          { t: 0, a: 10 },
          { t: 1, a: 11 },
          { t: 5, a: null },
          { t: 9, a: 12 },
          { t: 10, a: 13 },
        ],
      },
    ])
  })

  it('returns an empty array for no buckets', () => {
    expect(toDeviceSeries([], 'temp', BREAK)).toEqual([])
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun run test:node -- chartData`
Expected: FAIL — `toDeviceSeries` is not exported.

- [ ] **Step 4: Implement `toDeviceSeries`** — add to `src/lib/sensor/chartData.ts` below the existing `ChartRow`/`toChartRows` (leave those in place for now):

```ts
export type SeriesPoint = {
  t: number
  isolated?: boolean
  // The device's value lives under its own id key (matching the <Line dataKey>),
  // so shadcn's config-by-id (colors, legend labels) keeps working. `null` under
  // that key is an outage break marker.
  [deviceId: string]: number | null | boolean | undefined
}
export type DeviceSeries = { id: string; points: SeriesPoint[] }

// Reshape server buckets into one series per device for Recharts' per-<Line>
// `data`. Each device carries only its OWN readings, so a null means exactly one
// thing — a real outage — which we insert as a break marker only when a device was
// silent longer than the threshold. The chart uses connectNulls={false}, so it
// connects real readings and breaks at markers. A reading with no connected
// neighbour is flagged `isolated` so the chart shows a dot instead of nothing.
export function toDeviceSeries(
  buckets: Buckets,
  metric: 'temp' | 'hum',
  opts: { bucketSec: number; maxGapBuckets: number; cadenceSec: number },
): DeviceSeries[] {
  const key = metric === 'temp' ? 'tempAvg' : 'humAvg'

  // Devices in stable first-appearance order (buckets are ascending by t).
  const ids: string[] = []
  const seen = new Set<string>()
  for (const b of buckets) {
    for (const id of Object.keys(b.perDevice)) {
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  }

  // When the bucket is finer than the reporting cadence (the 24h range), empty
  // buckets are normal sparseness → never break (connect across the window).
  const maxGapSec =
    opts.bucketSec < opts.cadenceSec
      ? Number.POSITIVE_INFINITY
      : opts.maxGapBuckets * opts.bucketSec

  return ids.map((id) => {
    const readings: { t: number; v: number }[] = []
    for (const b of buckets) {
      const v = b.perDevice[id]?.[key]
      if (v != null) readings.push({ t: b.t, v })
    }

    const points: SeriesPoint[] = []
    for (let i = 0; i < readings.length; i++) {
      const prev = readings[i - 1]
      const cur = readings[i]
      const next = readings[i + 1]
      const brokeBefore = prev ? cur.t - prev.t > maxGapSec : true
      const brokeAfter = next ? next.t - cur.t > maxGapSec : true
      if (prev && cur.t - prev.t > maxGapSec) {
        points.push({ t: (prev.t + cur.t) / 2, [id]: null })
      }
      points.push(
        brokeBefore && brokeAfter
          ? { t: cur.t, [id]: cur.v, isolated: true }
          : { t: cur.t, [id]: cur.v },
      )
    }
    return { id, points }
  })
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun run test:node -- chartData`
Expected: PASS (existing `toChartRows`/`colorForIndex` blocks + new `toDeviceSeries` block).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sensor/range.ts src/lib/sensor/chartData.ts src/lib/sensor/chartData.test.ts
git -c commit.gpgsign=false commit --no-gpg-sign -m "feat(sensors): add per-device series reshape with outage breaks"
```

---

### Task 3: Per-`<Line>` data + isolated dots in ClimateChart, wired through the route

**Files:**
- Modify: `src/components/sensor/ClimateChart.tsx` (full component rewrite of the render)
- Modify: `src/components/sensor/ClimateChart.browser.test.tsx` (rewrite for the new API)
- Modify: `src/routes/_authenticated/sensors.tsx` (feed per-metric device series)

**Interfaces:**
- Consumes: `SeriesPoint`, `DeviceSeries`, `toDeviceSeries`, `colorForIndex` (Task 2); `MAX_GAP_BUCKETS`, `CADENCE_SEC` (Task 2); `bucketSec` from `orpc.sensor.series` (Task 1).
- Produces: `ClimateChart` prop `devices: ClimateChartDevice[]` where `ClimateChartDevice = { id; displayName; color; hidden?; points: SeriesPoint[] }` (the `rows` prop is removed).

- [ ] **Step 1: Rewrite the browser tests** — replace the entire body of `ClimateChart.browser.test.tsx` with:

```tsx
import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ClimateChart } from './ClimateChart'

test('renders one line per visible device with stable per-device colors', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          { id: 'a', displayName: 'NW corner', color: 'var(--chart-1)', points: [{ t: 1, a: 20 }, { t: 2, a: 21 }] },
          { id: 'b', displayName: 'Kitchen', color: 'var(--chart-2)', points: [{ t: 1, b: 25 }, { t: 2, b: 26 }] },
          { id: 'c', displayName: 'Boiler', color: 'var(--chart-3)', hidden: true, points: [{ t: 1, c: 30 }, { t: 2, c: 31 }] },
        ]}
        unit="°C"
        formatTick={(t) => new Date(t).toISOString()}
      />
    </div>,
  )

  await expect.element(screen.getByText('NW corner')).toBeVisible()

  // Two visible devices → two distinct line curves; the hidden one renders none.
  await vi.waitFor(() => {
    const curves = screen.container.querySelectorAll('.recharts-line-curve')
    expect(curves.length).toBe(2)
    for (const curve of curves) expect(curve.getAttribute('d') ?? '').toMatch(/[CL]/)
  })

  const style = screen.container.querySelector('style')?.textContent ?? ''
  expect(style).toContain('--color-a: var(--chart-1)')
  expect(style).toContain('--color-b: var(--chart-2)')
})

test('breaks the line at an outage marker while keeping each cluster connected', async () => {
  // A device offline mid-window: a null break marker separates two clusters. With
  // connectNulls off, the path splits into two move-to sub-paths (a visible gap),
  // and neither cluster endpoint is isolated, so no dots.
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          {
            id: 'a',
            displayName: 'Sensor A',
            color: 'var(--chart-1)',
            points: [{ t: 0, a: 20 }, { t: 1, a: 21 }, { t: 5, a: null }, { t: 9, a: 22 }, { t: 10, a: 23 }],
          },
        ]}
        unit="°C"
        formatTick={(t) => String(t)}
      />
    </div>,
  )

  await vi.waitFor(() => {
    const d = screen.container.querySelector('.recharts-line-curve')?.getAttribute('d') ?? ''
    expect((d.match(/M/gi) || []).length).toBe(2) // two segments, gap between
    expect(d).toMatch(/[CL]/) // each cluster is a real drawn segment
    expect(screen.container.querySelectorAll('.recharts-dot').length).toBe(0)
  })
})

test('renders a dot for an isolated reading so it is not invisible', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          { id: 'a', displayName: 'Sensor A', color: 'var(--chart-1)', points: [{ t: 5, a: 20, isolated: true }] },
          { id: 'b', displayName: 'Sensor B', color: 'var(--chart-2)', points: [{ t: 1, b: 30 }, { t: 2, b: 31 }] },
        ]}
        unit="°C"
        formatTick={(t) => String(t)}
      />
    </div>,
  )

  // Only the isolated reading draws a dot; the continuous line draws none.
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('.recharts-dot').length).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:components -- ClimateChart`
Expected: FAIL — type error / the component still expects `rows` and a per-`d.id` dataKey; the outage + isolated-dot behaviors don't exist yet.

- [ ] **Step 3: Rewrite `ClimateChart.tsx`** — replace the whole file with:

```tsx
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { SeriesPoint } from '~/lib/sensor/chartData'

export type ClimateChartDevice = {
  id: string
  displayName: string
  // Stable color assigned by the parent from the FULL device roster, so a device
  // keeps its color regardless of which siblings are toggled off.
  color: string
  hidden?: boolean
  // This device's own readings (ascending t) with outage break markers already
  // inserted by toDeviceSeries — `<id>: null` is a real gap, not structural noise.
  points: SeriesPoint[]
}

type Props = {
  devices: ClimateChartDevice[]
  unit: string // "°C" | "%"
  formatTick: (t: number) => string // range-aware x-axis time formatter
}

// A dot only for a reading with no connected neighbour (a lone reading, or a short
// resumption between two outages); otherwise the line already shows the point and
// dots would clutter a dense trace. Recharts clones this element per point,
// injecting cx/cy/payload; `color` is supplied per-<Line> so the dot matches.
function IsolatedDot(props: {
  cx?: number
  cy?: number
  color?: string
  payload?: SeriesPoint
}) {
  const { cx, cy, color, payload } = props
  if (!payload?.isolated || cx == null || cy == null) return null
  return <circle className="recharts-dot" cx={cx} cy={cy} r={3} fill={color} stroke={color} />
}

// Presentational multi-line chart (one colored line per device). Each line reads
// its own `data`, so nulls are only intentional outage breaks (connectNulls off).
// Data fetching + reshape live in the route.
export function ClimateChart({ devices, unit, formatTick }: Props) {
  const config: ChartConfig = Object.fromEntries(
    devices.map((d) => [d.id, { label: d.displayName, color: d.color }]),
  )
  return (
    // Height is inline (not a Tailwind class) so the chart has a measurable box
    // even before CSS loads / in the (Tailwind-less) browser-test env; width stays
    // responsive via the block-level container filling its parent.
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: 260 }}>
      <LineChart margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(t) => formatTick(Number(t))}
          tickMargin={8}
          minTickGap={32}
        />
        <YAxis width={44} unit={unit} tickMargin={4} domain={['auto', 'auto']} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => formatTick(Number(items?.[0]?.payload?.t))}
              // Custom row: device name on the left, value + unit on the right.
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-6">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: item.color }}
                    />
                    {name}
                  </span>
                  <span className="font-medium font-mono text-foreground tabular-nums">
                    {typeof value === 'number' ? value.toFixed(1) : value}
                    <span className="ml-0.5 font-sans text-muted-foreground">{unit}</span>
                  </span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {devices.map((d) => (
          <Line
            key={d.id}
            data={d.points}
            dataKey={d.id}
            name={d.displayName}
            hide={d.hidden}
            type="monotone"
            stroke={`var(--color-${d.id})`}
            dot={<IsolatedDot color={`var(--color-${d.id})`} />}
            strokeWidth={2}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
```

- [ ] **Step 4: Wire the route** — in `src/routes/_authenticated/sensors.tsx`:

Update imports:

```tsx
import { colorForIndex, type DeviceSeries, toDeviceSeries } from '~/lib/sensor/chartData'
import { CADENCE_SEC, MAX_GAP_BUCKETS, SERIES_RANGES, type SeriesRange } from '~/lib/sensor/range'
```

Replace the `buckets`/`tempRows`/`humRows`/`chartDevices` block (currently ~line 88-106) with:

```tsx
  const buckets = series?.buckets ?? []
  const bucketSec = series?.bucketSec ?? 0
  const formatTick = useMemo(() => makeTickFormatter(range), [range])

  // Colors derive from the FULL roster position (stable order from the service), so
  // a device keeps its color regardless of which siblings are toggled off. Each
  // metric gets its own per-device series (with outage breaks); hidden devices stay
  // in the list (their line is `hide`-d) so colors never shift.
  const toChartDevices = (deviceSeries: DeviceSeries[]) => {
    const byId = new Map(deviceSeries.map((s) => [s.id, s.points]))
    return devices.map((d, i) => ({
      id: d.id,
      displayName: d.displayName,
      color: colorForIndex(i),
      hidden: hidden.has(d.id),
      points: byId.get(d.id) ?? [],
    }))
  }
  const tempDevices = useMemo(
    () =>
      toChartDevices(
        toDeviceSeries(buckets, 'temp', { bucketSec, maxGapBuckets: MAX_GAP_BUCKETS, cadenceSec: CADENCE_SEC }),
      ),
    // toChartDevices closes over `devices` + `hidden`; both are in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, bucketSec, devices, hidden],
  )
  const humDevices = useMemo(
    () =>
      toChartDevices(
        toDeviceSeries(buckets, 'hum', { bucketSec, maxGapBuckets: MAX_GAP_BUCKETS, cadenceSec: CADENCE_SEC }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, bucketSec, devices, hidden],
  )

  const toggleDevices = devices.map((d, i) => ({
    id: d.id,
    displayName: d.displayName,
    color: colorForIndex(i),
  }))
  const editingDevice = deviceId ? devices.find((d) => d.id === deviceId) : undefined
```

Update the two `<ClimateChart>` usages (currently ~line 147, 151):

```tsx
      <ChartSection title={m.sensors_temp_chart_title()} hasData={hasData}>
        <ClimateChart devices={tempDevices} unit="°C" formatTick={formatTick} />
      </ChartSection>

      <ChartSection title={m.sensors_humidity_chart_title()} hasData={hasData}>
        <ClimateChart devices={humDevices} unit="%" formatTick={formatTick} />
      </ChartSection>
```

> Note: `biome` is the linter here, not eslint; the `eslint-disable` comments are harmless and match the intent. If biome flags them as unused, delete those two comment lines — the deps are already correct.

- [ ] **Step 5: Run to verify component tests pass**

Run: `bun run test:components -- ClimateChart`
Expected: PASS (all three tests).

- [ ] **Step 6: Typecheck the whole app**

Run: `bunx tsc --noEmit`
Expected: exit 0 (the route + component compile against the new API).

- [ ] **Step 7: Commit**

```bash
git add src/components/sensor/ClimateChart.tsx src/components/sensor/ClimateChart.browser.test.tsx src/routes/_authenticated/sensors.tsx
git -c commit.gpgsign=false commit --no-gpg-sign -m "feat(sensors): render per-device lines with outage breaks and isolated-point dots"
```

---

### Task 4: Remove the dead wide-format path + full verification

**Files:**
- Modify: `src/lib/sensor/chartData.ts` (remove `ChartRow` + `toChartRows`)
- Modify: `src/lib/sensor/chartData.test.ts` (remove the `toChartRows` describe block)

**Interfaces:** none produced; this removes `toChartRows`/`ChartRow` (now unused after Task 3).

- [ ] **Step 1: Confirm nothing still imports the old API**

Run: `grep -rn "toChartRows\|ChartRow" src`
Expected: only `src/lib/sensor/chartData.ts` and `src/lib/sensor/chartData.test.ts` (both edited below). If any other file appears, it was missed in Task 3 — fix it first.

- [ ] **Step 2: Remove `toChartRows` + `ChartRow`** from `chartData.ts` — delete the `export type ChartRow = …` line and the entire `export function toChartRows(…) { … }` block (leave `DEVICE_COLORS`, `colorForIndex`, `SeriesPoint`, `DeviceSeries`, `toDeviceSeries` intact).

- [ ] **Step 3: Remove the `toChartRows` tests** from `chartData.test.ts` — delete the whole `describe('toChartRows', …)` block and drop `toChartRows` from the `./chartData` import (keep `colorForIndex`, `DEVICE_COLORS`, `toDeviceSeries`). The `SeriesBucket` type import stays (used by the `bucket()` helper).

- [ ] **Step 4: Run the node suite**

Run: `bun run test:node -- chartData`
Expected: PASS (`toDeviceSeries` + `colorForIndex` only).

- [ ] **Step 5: Full verification**

Run each; all must pass:
```bash
bunx tsc --noEmit                 # exit 0
bun run check:ci                  # exit 0 (pre-existing nursery infos are non-blocking)
bun run test:components           # all browser tests pass
bun run test:node                 # all node tests pass (needs local Postgres: bun run db:up)
bun run build                     # vite build + tsc, clean
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/sensor/chartData.ts src/lib/sensor/chartData.test.ts
git -c commit.gpgsign=false commit --no-gpg-sign -m "refactor(sensors): drop the unused wide-format chart reshape"
```

---

## Self-Review (author)

- **Spec coverage:** per-device series (T2/T3), adaptive `K×bucket` + connect-all-on-24h (T2 `maxGapSec`), server `bucketSec` (T1), isolated dots (T2 flag + T3 `IsolatedDot`), constants in `range.ts` (T2), plain-gap visual (T3 `connectNulls={false}`), x-axis stays `dataMin`/`dataMax` (T3). All covered.
- **Type consistency:** `toDeviceSeries` signature, `SeriesPoint`/`DeviceSeries`, and `ClimateChartDevice.points` match across T2/T3/route. `bucketSec` return type matches T1 producer and route consumer.
- **Verify-in-browser (post-implementation, before PR):** tooltip hover with per-series disjoint timestamps; that `IsolatedDot` receives `payload` in 3.8.0 (the browser test in T3-step-5 already asserts the dot renders, which fails loudly if `payload.isolated` isn't delivered).

## Rollout

- Branch: `feat/sensor-chart-outage-gaps` (already created off `main`).
- After Task 4: run the two **adversarial code reviewers** (as before) on the diff, address findings, then open a PR against `main`. Verify on the Vercel preview / prod 24h (connects) and a longer range (breaks on a real outage) against real data.

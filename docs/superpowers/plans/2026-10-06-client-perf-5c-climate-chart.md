# Client performance step 5c: the Klimat charts on visx, recharts deleted (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
> House rule: after each task's commit, two adversarial reviewers (paired per task) start from the assumption that
> the task is wrong and changed behaviour. Fix or rule on every finding before the next task.

**Goal:** `ClimateChart` (the two `/sensors` charts) draws with visx, so nothing imports recharts any more; recharts,
`ui/chart.tsx` and `evCharging/ChartFrame.tsx` are deleted, the bones that 5a and 5b deferred are recaptured, and
checkpoint 5 can run after the merge.

**Architecture:**
- Safety net first: the ClimateChart and `/sensors` route tests move onto `test/browser/chartDom.ts` and stay green on
  recharts before any chart code changes.
- `ClimateChart.tsx` draws itself with visx (no shared `LineChart` module: it is the only line chart, so a generic one
  fails the deletion test). Its pure geometry lives in `src/components/sensor/climateLayout.ts` (the time ticks, the
  reading times hover and the keys snap to); the y scale and the card's rows keep using `src/lib/sensor/chartData.ts`.
- The axis look BarChart and ClimateChart share (recharts' margins, tick sizes, #666, label measuring) moves out of
  `BarChart.tsx` into `src/components/chart/axis.ts`.
- The time axis gets round ticks (owner's choice): `makeTimeAxis(range, locale)` in `src/lib/sensor/tickFormat.ts`
  lists each range's candidate d3-time intervals and its label format; the chart takes the finest interval whose
  labels fit.
- The keyboard follows 5a's idiom: one named `role="group"` Tab stop; ←/→ step through every reading time of the
  visible devices (owner's choice), Home/End jump to the ends, each step opens the card and is announced.

**Tech stack:** React 19, visx 4.0.0 (`@visx/axis`, `@visx/curve`, `@visx/grid`, `@visx/group`, `@visx/responsive`,
`@visx/shape`, `@visx/text`, `@visx/tooltip` via `ChartPopover`), d3-scale 4, d3-array 3, d3-time 3.1.0, Vitest 5
(node + browser projects), bun, boneyard-js 1.10. No new dependencies; `recharts` is removed.

**Design:** agreed in chat on 2026-10-06 (no separate spec, as in 5a and 5b). The owner chose round time ticks over
recharts' equal divisions, and arrow keys that step through each reading over fixed steps.
**Roadmap:** `docs/superpowers/roadmaps/2026-10-05-client-performance.md`, step 5c. 5a (#111) and 5b (#115) are merged.

## Global constraints

- Work in the worktree `.claude/worktrees/perf-climate-chart` on branch `refactor/climate-chart-visx`. Never `cd` to
  the main checkout.
- **Refactor: one hat per commit.** No commit changes what a viewer sees or can do, except the 5a conventions (named
  `role="group"` keyboard stop with a live region, the card in a `ChartPopover`) and the accepted differences below.
  Any other difference found on the way is a bug in the swap.
- Behaviour to preserve (measured live on `main` at `8767a5d`, 2026-10-06):
  - one monotone line (`curveMonotoneX`) per **visible** device, 2 px, in the device's colour; a hidden device draws
    nothing;
  - a line breaks at an outage marker (`<id>: null`); a reading flagged `isolated` gets a 3 px dot in its colour;
    no other dots while idle;
  - the time axis spans every device, hidden ones included (`timeDomain`); the y axis spans only the visible ones
    (`valueRange` → `niceYScale`), labels `value.toFixed(decimals) + unit` (`-10°C`, `45%`), sized to its labels;
  - axis lines and tick marks #666 (6 px ticks on both axes, unlike BarChart's hidden ones), 12 px labels in
    `var(--muted-foreground)`, horizontal grid lines only (`var(--border)` at 0.5 opacity);
  - 260 px high in total (inline style), the legend inside that height, under the plot, listing **every** device,
    hidden ones included, sorted by display name (recharts' legend sorts by value);
  - hover: the pointer snaps to a reading time, a vertical cursor line (`var(--border)`), the nearest-reading card
    (`nearestReadings` within `CADENCE_SEC`): a header from `formatTick`, one row per visible device with its own
    time when it differs from the header, the value `toFixed(1)` + unit; the card's look (`text-xs`, border, shadow)
    is ChartPopover's `card` variant, which has the same classes as today's tooltip box;
  - no SVG `<title>` (the section's `<h2>` names the chart), no animation.
- `formatTick` keeps formatting the card header (1 w stays "tis 14:00" there). The axis labels come from
  `makeTimeAxis`.
- One new user-facing string, `sensors_chart_keyboard_hint` (sv source of truth + en), added in Task 5.
- Logging via `~/lib/logger`, never `console.*`. Biome must pass (`bun run check:ci`).
- File naming: React component files PascalCase, everything else camelCase.
- `src/bones/*.bones.json` is generated: only `bun run bones:capture` writes it (Task 7).
- Conventional Commits, ≤ 72 characters, imperative. End each commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git add <paths>`, never `-A`.
- Reviewers must not run vitest (concurrent runs collide on the shared local DB). Before running vitest yourself,
  check `pgrep -fl vitest` shows none from other sessions.
- Browser tests have no app CSS: pin structure, attributes and text there; verify layout live (Task 8).
- The visx overlay (`[data-hover-overlay]`) is painted over the plot, so tests drive the visx chart by dispatching on
  it (`chartDom.ts`'s `moveAt`, `tapOn`), never through hit-testing (5a's CI lesson).
- d3-time intervals and `Intl.DateTimeFormat` both use the browser's local time zone, as the current formatter does.
  Node tests must not assume a time zone: assert on `getHours()` / `getDate()` of the ticks, not on UTC strings.

### Accepted differences (owner-approved 2026-10-06; state them in the PR)

1. **Round time ticks.** Ticks fall on round local times (24 h: every 3/6/12 h; 1 w: midnights; 1 m: Mondays;
   3 m–6 m: the 1st and 16th or month starts; 1 y and all: month starts every 1–3 (all: up to 12) months), the finest
   that fits. Labels: 24 h `HH:mm`, 1 w the short weekday ("tis"), longer ranges the short date ("1 okt."). recharts
   divided the span into five equal parts at odd times (15:20, 22:16, 05:13 …).
2. **A dot on each card row's reading.** recharts drew its 4 px active dot only on the line that owned the hovered x;
   now each visible device listed in the card gets one, on its own nearest reading, so the dots match the rows.
3. **Every device hidden.** recharts drew no tick labels but four grid lines. Now the time axis keeps its ticks (the
   time domain spans hidden devices by design), and there is no y axis label or grid line (no value range).

## Review focus

1. **Every device hidden** (the toggles allow it): no line, no card on hover, no keyboard step, the legend still lists
   every device, and nothing throws. Pinned in Task 4 and Task 5.
2. **Unaligned readings** (24 h: sensors report on different minutes, ~2 h apart): one hover lists every visible
   device; a device silent longer than a cadence around that time is left out; the dots match the rows. Pinned in
   Task 1 (kept) and Task 4.
3. **A poll under an open card or a keyboard walk** (24 h, 1 w and 1 m poll every 60 s): the card stays on its time
   after a refetch adds a reading, and the next → continues from that time, not from an index that moved. Pinned in
   Task 4 and Task 5.
4. **The data moves away under an open card** (a range switch, or the time drops out of the window): no stale card
   or cursor line is left showing a time the chart no longer has rows for. Pinned in Task 4.
5. **A 320 px phone.** Time labels never overlap or crowd (24 h, 1 w, 1 y), and the y labels (`-10°C`) aren't
   clipped. Pinned in Task 3 (`pickTimeTicks` at narrow widths) and checked live in Task 8.

---

### Task 0: Baseline, roadmap row, plan

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md`
- Create: this plan (already written)

- [ ] **Step 1: Verify `main` still matches the plan's assumptions**

Run: `git log --oneline -1 origin/main && git grep -ln "from 'recharts'\|components/ui/chart'\|evCharging/ChartFrame'" -- src`
Expected: `a8c684e` (or a later commit that doesn't touch the files below), and the importers are exactly
`src/components/evCharging/ChartFrame.tsx`, `src/components/sensor/ClimateChart.tsx` and
`src/components/ui/chart.tsx`. `git grep -ln "ChartFrame" -- src` lists no file other than `ChartFrame.tsx` and a
comment.

- [ ] **Step 2: Measure the baseline**

Run: `bun run bundle:measure 2>&1 | tail -60`
Expected: `/sensors` ~121 KB gz with recharts in its own chunk (5b notes). Write the entry + shell and every page's
total into the "Step 5c notes" section (Step 3). Also run
`grep -c '"recharts\|"redux\|"immer\|"decimal.js-light\|"@reduxjs' bun.lock` and note the count.

- [ ] **Step 3: Update the roadmap**

- Row 5b: status `merged` (PR #115).
- Row 5c: plan link `[plan](../plans/2026-10-06-client-perf-5c-climate-chart.md)`, status `in progress`.
- Add `## Step 5c notes` after "Step 5b notes": the baseline numbers from Step 2 and the three accepted differences
  (copy them from this plan).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/roadmaps/2026-10-05-client-performance.md docs/superpowers/plans/2026-10-06-client-perf-5c-climate-chart.md
git commit -m "docs(perf): plan the Klimat charts on visx"
```

Reviewers: none (docs).

---

### Task 1: Klimat chart tests through `chartDom.ts`

Pure test refactor, green on recharts. Every assertion keeps its meaning; only the way it finds and drives elements
changes. Three characterization tests are added for behaviour the swap must keep (legend with a hidden device, the
cursor line, the colours).

**Files:**
- Modify: `test/browser/chartDom.ts`
- Modify: `src/components/sensor/ClimateChart.browser.test.tsx`
- Modify: `src/routes/_authenticated/-sensorsRoute.browser.test.tsx:199-216`

**Interfaces:**
- Produces (used by Tasks 4–6): `readingDots`, `activeDots`, `hoverCursor` in `chartDom.ts`;
  `[data-reading-dot]`, `[data-active-dot]` and `[data-hover-cursor]` are the hooks `ClimateChart` must render in
  Task 4. The test file's `renderChart` helper is the one place Task 4 adds the new props.

- [ ] **Step 1: Add the helpers**

In `test/browser/chartDom.ts`, add to `SEL` (after `selectedTint`):

```ts
  // The Klimat chart: an isolated reading's dot, the hovered readings' dots, the hover line.
  readingDot: '.recharts-line-dots .recharts-dot, [data-reading-dot]',
  activeDot: '.recharts-active-dot .recharts-dot, [data-active-dot]',
  hoverCursor: '.recharts-tooltip-cursor, [data-hover-cursor]',
```

and after `lineDots`:

```ts
/** The dots for isolated readings (a reading with no connected neighbour). */
export const readingDots = (root: ParentNode) => all<SVGElement>(root, SEL.readingDot)
/** The dots on the hovered readings. */
export const activeDots = (root: ParentNode) => all<SVGElement>(root, SEL.activeDot)
/** The vertical hover line (null: none). */
export const hoverCursor = (root: ParentNode) => root.querySelector<SVGElement>(SEL.hoverCursor)
```

- [ ] **Step 2: Rewrite `ClimateChart.browser.test.tsx`**

Replace the whole file with:

```tsx
import { beforeEach, expect, test, vi } from 'vitest'
import { type SeriesPoint, toDeviceSeries } from '~/lib/sensor/chartData'
import { CADENCE_SEC, MAX_GAP_BUCKETS } from '~/lib/sensor/range'
import type { SeriesBucket } from '~/lib/services/sensor'
import {
  activeDots,
  centre,
  chartSvg,
  hoverCursor,
  legendLabels,
  lineCurves,
  moveAt,
  parkPointer,
  readingDots,
  tooltipText,
  yTickLabels,
} from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { ClimateChart, type ClimateChartDevice } from './ClimateChart'

// Browser mode shares one real pointer across tests and files: one left over a
// chart shows its card and active dot, which these assertions would count.
beforeEach(parkPointer)

const MIN = 60_000
const HOUR = 3_600_000
const T0 = 1_784_000_000_000

const device = (
  id: string,
  points: SeriesPoint[],
  extra: Partial<ClimateChartDevice> = {},
): ClimateChartDevice => ({ id, displayName: id, color: 'var(--chart-1)', points, ...extra })

// Every test renders through here, so a prop the chart gains changes one place.
async function renderChart(
  devices: ClimateChartDevice[],
  { formatTick = (t: number) => String(t) }: { formatTick?: (t: number) => string } = {},
) {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart devices={devices} unit="°C" formatTick={formatTick} />
    </div>,
  )
  return screen.container
}

/** Hovers the plot's centre (the visx overlay, or the element there on recharts). */
async function hoverPlot(root: HTMLElement) {
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  const svg = chartSvg(root)
  if (!svg) throw new Error('chart not rendered')
  const { x, y } = centre(svg)
  moveAt(root, x, y)
}

const moveTos = (d: string | null | undefined) => (d?.match(/M/gi) ?? []).length

test('draws connected lines for hours-apart readings on a coarse range', async () => {
  // End-to-end guard for the epoch-ms gap-threshold bug: buckets → toDeviceSeries
  // → chart. On the 1m range (3h buckets) readings a few hours apart must render
  // as a continuous line, not a scatter of isolated dots.
  const bucketSec = 3 * 3600
  const buckets: SeriesBucket[] = Array.from({ length: 8 }, (_, i) => ({
    t: T0 + i * 3 * HOUR,
    perDevice: { dev: { tempAvg: 14.4 + (i % 3) * 0.1, humAvg: 80 } },
  }))
  const [series] = toDeviceSeries(buckets, 'temp', {
    bucketSec,
    maxGapBuckets: MAX_GAP_BUCKETS,
    cadenceSec: CADENCE_SEC,
  })
  const root = await renderChart([device('dev', series.points)])

  await vi.waitFor(() => {
    // One continuous curve (a single move-to) with real line segments, and no
    // isolated-reading dots: the points connected rather than broke apart.
    const d = lineCurves(root)[0]?.getAttribute('d')
    expect(moveTos(d)).toBe(1)
    expect(d).toMatch(/[CL]/)
    expect(readingDots(root)).toHaveLength(0)
  })
})

test('renders one line per visible device in its own colour, and a legend entry for every device', async () => {
  const root = await renderChart([
    device(
      'a',
      [
        { t: 1, a: 20 },
        { t: 2, a: 21 },
      ],
      { displayName: 'NW corner', color: 'rgb(1, 2, 3)' },
    ),
    device(
      'b',
      [
        { t: 1, b: 25 },
        { t: 2, b: 26 },
      ],
      { displayName: 'Kitchen', color: 'rgb(4, 5, 6)' },
    ),
    device(
      'c',
      [
        { t: 1, c: 30 },
        { t: 2, c: 31 },
      ],
      { displayName: 'Boiler', color: 'rgb(7, 8, 9)', hidden: true },
    ),
  ])

  // Two visible devices → two curves; the hidden one draws none.
  await vi.waitFor(() => {
    const curves = lineCurves(root)
    expect(curves).toHaveLength(2)
    for (const curve of curves) expect(curve.getAttribute('d') ?? '').toMatch(/[CL]/)
  })
  // Each line resolves to its own device's colour (recharts through its CSS
  // variables, visx directly), so the colours survive the swap.
  expect(lineCurves(root).map((c) => getComputedStyle(c).stroke)).toEqual([
    'rgb(1, 2, 3)',
    'rgb(4, 5, 6)',
  ])
  // The legend lists every device, the hidden one too, sorted by name (recharts' order).
  expect(legendLabels(root)).toEqual(['Boiler', 'Kitchen', 'NW corner'])
})

test('breaks the line at an outage marker while keeping each cluster connected', async () => {
  // A device offline mid-window: a null break marker separates two clusters.
  // The path splits into two move-to sub-paths (a visible gap), and neither
  // cluster endpoint is isolated, so no dots.
  const root = await renderChart([
    device('a', [
      { t: 0, a: 20 },
      { t: 1, a: 21 },
      { t: 5, a: null },
      { t: 9, a: 22 },
      { t: 10, a: 23 },
    ]),
  ])

  await vi.waitFor(() => {
    const d = lineCurves(root)[0]?.getAttribute('d')
    expect(moveTos(d)).toBe(2)
    expect(d).toMatch(/[CL]/)
    expect(readingDots(root)).toHaveLength(0)
  })
})

test('x-axis spans hidden devices so toggling a device does not rescale time', async () => {
  // Device A (hidden) spans 0–1000; device B (visible) only 400–500. If the
  // domain spans A, B's segment sits mid-axis; if it wrongly rescaled to B's
  // own 400–500, B's first point would pin to the left edge.
  const root = await renderChart([
    device(
      'a',
      [
        { t: 0, a: 1 },
        { t: 1000, a: 2 },
      ],
      { hidden: true },
    ),
    device('b', [
      { t: 400, b: 3 },
      { t: 500, b: 4 },
    ]),
  ])

  await vi.waitFor(() => {
    const d = lineCurves(root)[0]?.getAttribute('d') ?? ''
    expect(Number(d.match(/M([\d.]+)/)?.[1])).toBeGreaterThan(100)
  })
})

test('formats y-axis tick labels to one decimal for a narrow value range', async () => {
  // A stable room: recharts' own auto-domain gave arbitrary fractional ticks
  // (24.595, 24.49, …) that overflowed the axis. Every tick must read as at most
  // two decimals plus the unit, distinct, on a nice step (1, 2 or 5 × 10ⁿ).
  const root = await renderChart([
    device('a', [
      { t: 1, a: 24.49 },
      { t: 2, a: 24.55 },
      { t: 3, a: 24.58 },
    ]),
    device('b', [
      { t: 1, b: 24.6 },
      { t: 2, b: 24.55 },
      { t: 3, b: 24.5 },
    ]),
  ])

  await vi.waitFor(() => {
    const yTicks = yTickLabels(root)
    expect(yTicks.length).toBeGreaterThan(1)
    expect(new Set(yTicks).size).toBe(yTicks.length)
    for (const text of yTicks) expect(text).toMatch(/^-?\d+(\.\d{1,2})?°C$/)
    const nums = yTicks.map((t) => Number.parseFloat(t)).sort((a, b) => a - b)
    const step = nums[1] - nums[0]
    for (let i = 1; i < nums.length; i++) expect(nums[i] - nums[i - 1]).toBeCloseTo(step, 6)
    const niceFraction = Math.round(step / 10 ** Math.floor(Math.log10(step)))
    expect([1, 2, 5]).toContain(niceFraction)
  })
})

test('a single hover lists every visible sensor at its nearest reading, with the hover line', async () => {
  // Sensors report on different minutes, so no two share a timestamp. The card
  // snaps each line to its nearest reading within the cadence window, so one
  // hover shows both.
  const root = await renderChart(
    [
      device('a', [
        { t: T0 + 0 * MIN, a: 15.1 },
        { t: T0 + 20 * MIN, a: 15.3 },
        { t: T0 + 40 * MIN, a: 15.5 },
      ], { displayName: 'Fack 1' }),
      device('b', [
        { t: T0 + 7 * MIN, b: 14.2 },
        { t: T0 + 27 * MIN, b: 14.4 },
        { t: T0 + 47 * MIN, b: 14.6 },
      ], { displayName: 'Fack 3' }),
    ],
    { formatTick: (t) => new Date(t).toISOString().slice(11, 16) },
  )
  await hoverPlot(root)

  await vi.waitFor(() => {
    const tip = tooltipText()
    expect(tip).toContain('Fack 1')
    expect(tip).toContain('Fack 3')
    expect((tip.match(/°C/g) ?? []).length).toBe(2)
    expect(hoverCursor(root)).not.toBeNull()
    expect(activeDots(root).length).toBeGreaterThan(0)
  })
})

test('renders a dot for an isolated reading so it is not invisible', async () => {
  const root = await renderChart([
    device('a', [{ t: 5, a: 20, isolated: true }]),
    device('b', [
      { t: 1, b: 30 },
      { t: 2, b: 31 },
    ]),
  ])

  // Only the isolated reading draws a dot; the continuous line draws none.
  await vi.waitFor(() => expect(readingDots(root)).toHaveLength(1))
})

test('with every device hidden there is no line and no card, and the legend keeps every device', async () => {
  const root = await renderChart([
    device(
      'a',
      [
        { t: T0, a: 20 },
        { t: T0 + HOUR, a: 21 },
      ],
      { hidden: true },
    ),
    device(
      'b',
      [
        { t: T0, b: 30 },
        { t: T0 + HOUR, b: 31 },
      ],
      { hidden: true },
    ),
  ])
  await vi.waitFor(() => expect(legendLabels(root)).toEqual(['a', 'b']))
  expect(lineCurves(root)).toHaveLength(0)
  await hoverPlot(root)
  // Give a card the chance to appear before asserting it didn't.
  await new Promise((r) => setTimeout(r, 200))
  expect(tooltipText()).toBe('')
})
```

Notes for the implementer:
- `hoverPlot` replaces `userEvent.hover(surface)`. On recharts `moveAt` falls back to `pointAt`, which dispatches
  `pointermove` and `mousemove` on the element under the plot's centre; recharts listens for `mousemove` on its
  wrapper, so the card opens.
- If `readingDots` finds nothing for the isolated test on recharts, inspect the DOM
  (`root.querySelector('.recharts-line')?.innerHTML`) and fix the selector's recharts half so it matches the
  `<circle class="recharts-dot">` that `IsolatedDot` renders inside the line's dot layer. Never loosen it to plain
  `.recharts-dot`: that also matches the hover's active dot.
- The colour test uses literal colours on purpose: the browser tests have no app CSS, so `var(--chart-1)` resolves
  to nothing on both libraries.

- [ ] **Step 3: The `/sensors` route test**

In `src/routes/_authenticated/-sensorsRoute.browser.test.tsx`, import `xTickLabels` from `~test/browser/chartDom` and
replace the `xTicks` helper in "a range switch keeps the shown range's chart …" with:

```ts
  // The x-axis ticks (the y-axis ones carry the unit and aren't x ticks).
  const xTicks = () => xTickLabels(document)
```

The rest of the test stays. Its `/\d{1,2}[:.]\d{2}/` check holds for both the old and the round 24 h labels.

- [ ] **Step 4: Run them on recharts**

Run: `pgrep -fl vitest; bunx vitest run --project browser src/components/sensor/ClimateChart.browser.test.tsx src/routes/_authenticated/-sensorsRoute.browser.test.tsx`
Expected: all PASS on the unchanged recharts chart.

- [ ] **Step 5: Commit**

```bash
git add test/browser/chartDom.ts src/components/sensor/ClimateChart.browser.test.tsx src/routes/_authenticated/-sensorsRoute.browser.test.tsx
git commit -m "test(sensor): query the Klimat charts through chartDom"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`, told to
check that no assertion was weakened (each old one has a new one with the same meaning) and that the recharts halves
of the new selectors can't match the wrong element.

---

### Task 2: The shared axis look in `chart/axis.ts`

Structural only: BarChart's private axis constants move to a module ClimateChart can import. No render changes.

**Files:**
- Create: `src/components/chart/axis.ts`
- Modify: `src/components/chart/BarChart.tsx:97-110,170-171,206`

**Interfaces:**
- Produces (used by Task 4): `CHART_MARGIN`, `X_AXIS_H`, `TICK_SIZE`, `X_TICK_MARGIN`, `Y_TICK_MARGIN`, `TICK_PX`,
  `AXIS_COLOR`, `measureAt(px): (s: string) => number`, `yAxisWidth(labels, measure): number`.

- [ ] **Step 1: Create `src/components/chart/axis.ts`**

```ts
import { getStringWidth } from '@visx/text'
import { max } from 'd3-array'

// The axis look the visx charts share (BarChart, ClimateChart): recharts 3's
// defaults, so the move to visx kept the axes where they were.

export const CHART_MARGIN = { top: 8, right: 12, bottom: 0, left: 4 } as const
/** The x axis' band under the plot: tick, margin and one 12–13 px label line. */
export const X_AXIS_H = 30
// recharts' tick size: labels keep their distance from the axis even with the
// tick lines hidden (visx places labels at tickLength too).
export const TICK_SIZE = 6
export const X_TICK_MARGIN = 8
export const Y_TICK_MARGIN = 4
export const TICK_PX = 12
/** recharts' default axis colour; our ChartContainer never restyled it. */
export const AXIS_COLOR = '#666'

/** A label's width in px at `px` font size (an estimate where nothing can measure, as in SSR). */
export const measureAt = (px: number) => (s: string) =>
  getStringWidth(s, { fontSize: px }) ?? s.length * px * 0.6

/** The y axis' width for these labels, its tick and margin included (recharts' width="auto"). */
export const yAxisWidth = (labels: readonly string[], measure: (s: string) => number) =>
  (max(labels, measure) ?? 0) + TICK_SIZE + Y_TICK_MARGIN + 2
```

- [ ] **Step 2: Use it in `BarChart.tsx`**

Delete the local `MARGIN`, `X_AXIS_H`, `TICK_SIZE`, `X_TICK_MARGIN`, `Y_TICK_MARGIN`, `TICK_PX`, `AXIS` and
`measureAt` declarations (and their comments), and the now-unused `getStringWidth` and `max` imports. Import from
`./axis`:

```ts
import {
  AXIS_COLOR,
  CHART_MARGIN as MARGIN,
  measureAt,
  TICK_PX,
  TICK_SIZE,
  X_AXIS_H,
  X_TICK_MARGIN,
  Y_TICK_MARGIN,
  yAxisWidth,
} from './axis'
```

Then replace `stroke={AXIS}` (both axes) with `stroke={AXIS_COLOR}`, and the `yAxisW` line with:

```ts
    const yAxisW = hideYAxis ? 0 : yAxisWidth(yLabels, measure)
```

`DOT_R` stays in `BarChart.tsx` (the Spot line's dots).

- [ ] **Step 3: Run the bar chart suites**

Run: `pgrep -fl vitest; bunx vitest run --project browser src/components/chart src/components/evCharging src/components/energy && bunx vitest run --project node src/components/chart && bun run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/chart/axis.ts src/components/chart/BarChart.tsx
git commit -m "refactor(charts): share the visx axis constants"
```

Reviewers: `code-reviewer` + a reviewer loading `vercel-react-best-practices`, told to diff every moved value
against the old one (a changed number is a moved axis).

---

### Task 3: Round time ticks (`makeTimeAxis`, `pickTimeTicks`, reading times)

Pure, node-tested, nothing calls it yet.

**Files:**
- Modify: `src/lib/sensor/tickFormat.ts`
- Modify: `src/lib/sensor/tickFormat.test.ts`
- Create: `src/components/sensor/climateLayout.ts`
- Create: `src/components/sensor/climateLayout.test.ts`

**Interfaces:**
- Consumes: `labelsFit`, `thinTicks` from `~/components/chart/barLayout`; `SeriesPoint` from
  `~/lib/sensor/chartData`.
- Produces (used by Tasks 4–5):
  - `type TimeAxis = { intervals: readonly TimeInterval[]; format: (t: number) => string }` and
    `makeTimeAxis(range: SeriesRange, locale: string): TimeAxis` in `src/lib/sensor/tickFormat.ts`;
  - `TIME_TICK_GAP = 16`,
    `pickTimeTicks(opts: { domain: readonly [number, number]; x: (t: number) => number; axis: TimeAxis; measure: (s: string) => number }): number[]`,
    `readingTimes(devices): number[]`, `nearestTime(times: readonly number[], t: number): number | null` in
    `src/components/sensor/climateLayout.ts`.

- [ ] **Step 1: Write the failing `makeTimeAxis` tests**

Append to `src/lib/sensor/tickFormat.test.ts` (and add `makeTimeAxis` to its import):

```ts
// The axis' round ticks (step 5c). Hours and dates are read in the runner's
// local zone, the zone d3-time and Intl both use, so this holds in any TZ.
const span = (from: string, days: number) => {
  const start = new Date(from)
  return [start, new Date(start.getTime() + days * 86_400_000)] as const
}

test('the 24h axis ticks fall on whole hours, every 3 h at the finest', () => {
  const [a, b] = span('2026-08-02T10:20:00', 1)
  const ticks = makeTimeAxis('24h', 'sv-SE').intervals[0].range(a, b)
  expect(ticks.length).toBe(8)
  for (const t of ticks) {
    expect(t.getMinutes()).toBe(0)
    expect(t.getHours() % 3).toBe(0)
  }
})

test('the 1w axis ticks fall on midnights and label the weekday alone', () => {
  const [a, b] = span('2026-08-02T10:20:00', 7)
  const axis = makeTimeAxis('1w', 'sv-SE')
  const ticks = axis.intervals[0].range(a, b)
  expect(ticks.length).toBe(7)
  for (const t of ticks) expect([t.getHours(), t.getMinutes()]).toEqual([0, 0])
  // Two days apart: different labels; the same weekday a week apart: the same label.
  expect(axis.format(ticks[0].getTime())).not.toBe(axis.format(ticks[1].getTime()))
  const weekLater = new Date(ticks[0].getTime() + 7 * 86_400_000).getTime()
  expect(axis.format(weekLater)).toBe(axis.format(ticks[0].getTime()))
})

test('the 1m axis ticks fall on Mondays', () => {
  const [a, b] = span('2026-08-02T10:20:00', 30)
  for (const t of makeTimeAxis('1m', 'sv-SE').intervals[0].range(a, b)) {
    expect([t.getDay(), t.getHours()]).toEqual([1, 0])
  }
})

test('the longer axes fall on the 1st and 16th or on month starts', () => {
  const [a, b] = span('2026-01-10T10:20:00', 180)
  const half = makeTimeAxis('3m', 'sv-SE').intervals[0].range(a, b)
  expect(half.length).toBeGreaterThan(8)
  for (const t of half) expect([1, 16]).toContain(t.getDate())
  for (const range of ['6m', '1y', 'all'] as const) {
    const intervals = makeTimeAxis(range, 'sv-SE').intervals
    for (const t of intervals[intervals.length - 1].range(a, b)) {
      expect([t.getDate(), t.getHours()]).toEqual([1, 0])
    }
  }
})

test('every range lists its intervals finest first', () => {
  for (const range of SERIES_RANGES) {
    const [a, b] = span('2026-01-10T10:20:00', 400)
    const counts = makeTimeAxis(range, 'sv-SE').intervals.map((i) => i.range(a, b).length)
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThan(counts[i - 1])
  }
})

test('the 24h axis labels by time of day, the longer ones by date', () => {
  const day = makeTimeAxis('24h', 'sv-SE').format
  expect(day(new Date('2026-08-02T15:00:00').getTime())).toMatch(/^15[:.]00$/)
  const month = makeTimeAxis('1y', 'sv-SE').format
  expect(month(new Date('2026-08-01T00:00:00').getTime())).toBe(
    makeTickFormatter('1m', 'sv-SE')(new Date('2026-08-01T12:00:00').getTime()),
  )
})
```

Add `import { SERIES_RANGES } from './range'` to the test file.

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project node src/lib/sensor/tickFormat.test.ts`
Expected: FAIL, `makeTimeAxis` is not exported.

- [ ] **Step 3: Implement `makeTimeAxis`**

Append to `src/lib/sensor/tickFormat.ts` (add the imports at the top):

```ts
import {
  type CountableTimeInterval,
  type TimeInterval,
  timeDay,
  timeHour,
  timeMonday,
  timeMonth,
} from 'd3-time'

/** A time axis: its candidate tick intervals, finest first, and its tick label. */
export type TimeAxis = {
  intervals: readonly TimeInterval[]
  format: (t: number) => string
}

// `every` is null only for a non-positive step.
const every = (interval: CountableTimeInterval, step: number): TimeInterval =>
  interval.every(step) ?? interval
// The 1st and the 16th: twice a month without drifting off the calendar.
const halfMonth = timeDay.filter((d) => d.getDate() === 1 || d.getDate() === 16)

// Round local times per range (owner's choice, step 5c). The chart takes the
// finest interval whose labels fit its width (pickTimeTicks).
const INTERVALS: Record<SeriesRange, readonly TimeInterval[]> = {
  '24h': [every(timeHour, 3), every(timeHour, 6), every(timeHour, 12)],
  '1w': [timeDay, every(timeDay, 2)],
  '1m': [timeMonday, halfMonth],
  '3m': [halfMonth, timeMonth],
  '6m': [halfMonth, timeMonth, every(timeMonth, 2)],
  '1y': [timeMonth, every(timeMonth, 2), every(timeMonth, 3)],
  all: [
    timeMonth,
    every(timeMonth, 2),
    every(timeMonth, 3),
    every(timeMonth, 6),
    every(timeMonth, 12),
  ],
}

// The axis label matches its ticks: the time of day for hours, the weekday for
// midnights, the date beyond a week. (The card's header keeps makeTickFormatter.)
export function makeTimeAxis(range: SeriesRange, locale: string): TimeAxis {
  const options: Intl.DateTimeFormatOptions =
    range === '24h'
      ? { hour: '2-digit', minute: '2-digit' }
      : range === '1w'
        ? { weekday: 'short' }
        : { month: 'short', day: 'numeric' }
  const fmt = new Intl.DateTimeFormat(locale, options)
  return { intervals: INTERVALS[range], format: (t) => fmt.format(new Date(t)) }
}
```

`timeDay.every(2)` counts by day of the month, so a 31st and the next 1st can both tick; that's d3's behaviour and
accepted. If `CountableTimeInterval` isn't exported under that name by the installed `@types/d3-time` 3.0.4, check
the package's `index.d.ts` and use the name it exports for an interval with `every`.

- [ ] **Step 4: Run them to see them pass**

Run: `bunx vitest run --project node src/lib/sensor/tickFormat.test.ts`
Expected: PASS (old and new).

- [ ] **Step 5: Write the failing `climateLayout` tests**

Create `src/components/sensor/climateLayout.test.ts`:

```ts
import { scaleLinear } from 'd3-scale'
import { describe, expect, test } from 'vitest'
import { makeTimeAxis } from '~/lib/sensor/tickFormat'
import { nearestTime, pickTimeTicks, readingTimes, TIME_TICK_GAP } from './climateLayout'

// A fixed-width measure (7 px a character) keeps the fit independent of fonts.
const measure = (s: string) => s.length * 7
const HOUR = 3_600_000
const DAY = 24 * HOUR

const ticksFor = (range: Parameters<typeof makeTimeAxis>[0], days: number, plotW: number) => {
  const start = new Date('2026-08-02T10:20:00').getTime()
  const domain = [start, start + days * DAY] as const
  const x = scaleLinear().domain(domain).range([0, plotW])
  const axis = makeTimeAxis(range, 'sv-SE')
  return { ticks: pickTimeTicks({ domain, x, axis, measure }), x, axis }
}

// No two labels closer than the gap.
const spaced = ({ ticks, x, axis }: ReturnType<typeof ticksFor>) => {
  for (let i = 1; i < ticks.length; i++) {
    const right = x(ticks[i - 1]) + measure(axis.format(ticks[i - 1])) / 2
    const left = x(ticks[i]) - measure(axis.format(ticks[i])) / 2
    expect(left - right).toBeGreaterThanOrEqual(TIME_TICK_GAP)
  }
}

describe('pickTimeTicks', () => {
  test('a wide 24h chart takes every 3 hours', () => {
    const r = ticksFor('24h', 1, 900)
    expect(r.ticks.length).toBe(8)
    for (const t of r.ticks) expect(new Date(t).getHours() % 3).toBe(0)
    spaced(r)
  })

  test('a 320 px phone falls back to coarser hours, never crowded', () => {
    const r = ticksFor('24h', 1, 260)
    expect(r.ticks.length).toBeLessThan(8)
    expect(r.ticks.length).toBeGreaterThan(1)
    for (const t of r.ticks) expect(new Date(t).getHours() % 6).toBe(0)
    spaced(r)
  })

  test('1w keeps a daily tick on a phone (short weekday labels)', () => {
    const r = ticksFor('1w', 7, 300)
    expect(r.ticks.length).toBe(7)
    spaced(r)
  })

  test('1y on a phone thins the month starts until they fit', () => {
    const r = ticksFor('1y', 365, 260)
    expect(r.ticks.length).toBeGreaterThan(1)
    expect(r.ticks.length).toBeLessThan(12)
    for (const t of r.ticks) expect(new Date(t).getDate()).toBe(1)
    spaced(r)
  })

  test('when even the coarsest interval crowds, its labels are thinned', () => {
    const r = ticksFor('24h', 1, 60)
    expect(r.ticks.length).toBeGreaterThanOrEqual(1)
    spaced(r)
  })

  test('a span with no round time in it has no ticks', () => {
    const start = new Date('2026-08-02T10:20:00').getTime()
    const domain = [start, start + 10 * 60_000] as const
    const x = scaleLinear().domain(domain).range([0, 600])
    expect(pickTimeTicks({ domain, x, axis: makeTimeAxis('24h', 'sv-SE'), measure })).toEqual([])
  })

  test('the domain end is included when it falls on a tick', () => {
    const start = new Date('2026-08-02T00:00:00').getTime()
    const domain = [start, start + DAY] as const
    const x = scaleLinear().domain(domain).range([0, 900])
    const ticks = pickTimeTicks({ domain, x, axis: makeTimeAxis('24h', 'sv-SE'), measure })
    expect(ticks[0]).toBe(start)
    expect(ticks[ticks.length - 1]).toBe(start + DAY)
  })
})

describe('readingTimes and nearestTime', () => {
  const devices = [
    { id: 'a', points: [{ t: 10, a: 1 }, { t: 30, a: null }, { t: 50, a: 2 }] },
    { id: 'b', points: [{ t: 10, b: 3 }, { t: 20, b: 4 }] },
    { id: 'c', hidden: true, points: [{ t: 15, c: 5 }] },
  ]

  test('merges the visible devices’ real readings, ascending and distinct', () => {
    // 30 is an outage marker, 15 belongs to a hidden device.
    expect(readingTimes(devices)).toEqual([10, 20, 50])
  })

  test('nothing visible gives no times', () => {
    expect(readingTimes(devices.map((d) => ({ ...d, hidden: true })))).toEqual([])
  })

  test('snaps to the closest time, and to null with none', () => {
    expect(nearestTime([10, 20, 50], 14)).toBe(10)
    expect(nearestTime([10, 20, 50], 36)).toBe(50)
    expect(nearestTime([10, 20, 50], -100)).toBe(10)
    expect(nearestTime([], 5)).toBeNull()
  })
})
```

- [ ] **Step 6: Run them to see them fail**

Run: `bunx vitest run --project node src/components/sensor/climateLayout.test.ts`
Expected: FAIL, `./climateLayout` doesn't exist.

- [ ] **Step 7: Implement `climateLayout.ts`**

```ts
import { bisectCenter } from 'd3-array'
import { labelsFit, thinTicks } from '~/components/chart/barLayout'
import type { SeriesPoint } from '~/lib/sensor/chartData'
import type { TimeAxis } from '~/lib/sensor/tickFormat'

// The Klimat chart's pure geometry (step 5c). The y scale and the card's rows
// stay in ~/lib/sensor/chartData (niceYScale, valueRange, nearestReadings).

/** px kept clear between two time labels. */
export const TIME_TICK_GAP = 16

/**
 * The axis' tick times: the finest of the axis' intervals whose labels all fit
 * `TIME_TICK_GAP` apart; when none does, the coarsest, thinned to fit.
 * The domain's end counts as a tick when it falls on one.
 */
export function pickTimeTicks({
  domain,
  x,
  axis,
  measure,
}: {
  domain: readonly [number, number]
  x: (t: number) => number
  axis: TimeAxis
  measure: (s: string) => number
}): number[] {
  let thinned: number[] = []
  for (const interval of axis.intervals) {
    // range() stops before its end: one ms more keeps a tick on the end itself.
    const ticks = interval.range(new Date(domain[0]), new Date(domain[1] + 1)).map(Number)
    const centres = ticks.map(x)
    const widths = ticks.map((t) => measure(axis.format(t)))
    if (labelsFit(centres, widths, TIME_TICK_GAP)) return ticks
    thinned = thinTicks(centres, widths, TIME_TICK_GAP).map((i) => ticks[i])
  }
  return thinned
}

/** Every real reading time of the visible devices, ascending and distinct: where hover and the keys stop. */
export function readingTimes(
  devices: readonly { id: string; hidden?: boolean; points: readonly SeriesPoint[] }[],
): number[] {
  const times = new Set<number>()
  for (const d of devices) {
    if (d.hidden) continue
    // Outage markers (`<id>: null`) aren't readings.
    for (const p of d.points) if (typeof p[d.id] === 'number') times.add(p.t)
  }
  return [...times].sort((a, b) => a - b)
}

/** The time in `times` (ascending) closest to `t`; null when there is none. */
export function nearestTime(times: readonly number[], t: number): number | null {
  return times.length === 0 ? null : times[bisectCenter(times, t)]
}
```

- [ ] **Step 8: Run them to see them pass**

Run: `bunx vitest run --project node src/components/sensor/climateLayout.test.ts src/lib/sensor && bun run typecheck`
Expected: PASS. If "a wide 24h chart takes every 3 hours" fails on the count, check the fixed `measure`: "15:00" is
5 characters = 35 px, 8 ticks over 900 px are 112 px apart, so they fit; a different count means the interval or
the end handling is off.

- [ ] **Step 9: Commit**

```bash
git add src/lib/sensor/tickFormat.ts src/lib/sensor/tickFormat.test.ts src/components/sensor/climateLayout.ts src/components/sensor/climateLayout.test.ts
git commit -m "feat(sensor): round time ticks for the Klimat axis"
```

(The `feat` type is right here: it adds a capability nothing uses yet; the visible change lands in Task 4.)

Reviewers: `code-reviewer` + `test-completeness`, told to check DST days (a 23 h or 25 h day on the 24h range) and
month ends (`every(timeDay, 2)`, the 31st) against the code, and that no test depends on the runner's time zone.

---

### Task 4: ClimateChart draws with visx (lines, axes, legend, hover, touch)

The swap. The chart's props gain `timeAxis` and `label`; the route passes them. Keyboard comes in Task 5 (the group
is labelled here already, but has no key handler yet).

**Files:**
- Modify: `src/components/sensor/ClimateChart.tsx` (rewritten)
- Modify: `src/routes/_authenticated/sensors.tsx:132-133,235,247`
- Modify: `src/components/sensor/ClimateChart.browser.test.tsx`

**Interfaces:**
- Consumes: Task 2's `axis.ts`; Task 3's `makeTimeAxis`, `TimeAxis`, `pickTimeTicks`, `readingTimes`, `nearestTime`;
  `useChartPopover`, `ChartPopover` (`~/components/evCharging/ChartPopover`); `ChartLegend` (`~/components/chart/ChartParts`);
  `nearestReadings`, `niceYScale`, `timeDomain`, `valueRange` (`~/lib/sensor/chartData`).
- Produces: `ClimateChart` props `{ devices, unit, formatTick, timeAxis: TimeAxis, label: string }`; DOM hooks
  `svg[data-chart-svg]`, `[data-hover-overlay]`, `[data-line-curve]`, `[data-reading-dot]`, `[data-active-dot]`,
  `[data-hover-cursor]`, `[data-axis="x"|"y"]`, `[data-grid]`, `[data-slot="chart-legend"]`,
  `[data-slot="chart-tooltip"]`, `[data-chart-focus]` (Task 5 adds its key handler).

- [ ] **Step 1: Give the tests the new props and the visx-only expectations**

In `ClimateChart.browser.test.tsx`, change `renderChart` to pass the new props:

```tsx
async function renderChart(
  devices: ClimateChartDevice[],
  {
    formatTick = (t: number) => String(t),
    timeAxis = makeTimeAxis('24h', 'sv-SE'),
  }: { formatTick?: (t: number) => string; timeAxis?: TimeAxis } = {},
) {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={devices}
        unit="°C"
        formatTick={formatTick}
        timeAxis={timeAxis}
        label="Temperatur"
      />
    </div>,
  )
  return screen.container
}
```

(import `makeTimeAxis` and `type TimeAxis` from `~/lib/sensor/tickFormat`), add `centre`, `tapOn`, `xTickLabels`
and `activeDots` to the chartDom import if missing, then append:

```tsx
// Two sensors a day long, reporting every 2 h on different minutes (the 24 h shape).
const day = () => {
  const start = new Date('2026-08-02T10:20:00').getTime()
  return [
    device(
      'a',
      Array.from({ length: 12 }, (_, i) => ({ t: start + i * 2 * HOUR, a: 20 + (i % 3) * 0.2 })),
      { displayName: 'Fack 1' },
    ),
    device(
      'b',
      Array.from({ length: 12 }, (_, i) => ({ t: start + i * 2 * HOUR + 41 * MIN, b: 5 - (i % 4) })),
      { displayName: 'Fack 3' },
    ),
  ]
}

test('the 24 h axis labels round hours', async () => {
  const root = await renderChart(day())
  await vi.waitFor(() => expect(xTickLabels(root).length).toBeGreaterThan(2))
  for (const label of xTickLabels(root)) {
    const [h, m] = label.split(/[:.]/).map(Number)
    expect(m).toBe(0)
    expect(h % 3).toBe(0)
  }
})

test('a hover puts one dot on each card row’s reading', async () => {
  const root = await renderChart(day())
  await hoverPlot(root)
  await vi.waitFor(() => {
    expect(tooltipText()).toContain('Fack 1')
    expect(tooltipText()).toContain('Fack 3')
    expect(activeDots(root)).toHaveLength(2)
  })
})

test('a sensor silent around the hovered time is left out of the card and gets no dot', async () => {
  const [a, b] = day()
  // b stops after its first four readings; the plot's centre is hours later.
  const root = await renderChart([a, { ...b, points: b.points.slice(0, 4) }])
  await hoverPlot(root)
  await vi.waitFor(() => {
    expect(tooltipText()).toContain('Fack 1')
    expect(tooltipText()).not.toContain('Fack 3')
    expect(activeDots(root)).toHaveLength(1)
  })
})

test('a tap keeps the card; the mouse leaving the plot closes it', async () => {
  const root = await renderChart(day())
  await vi.waitFor(() => expect(root.querySelector('[data-hover-overlay]')).not.toBeNull())
  const overlay = () => root.querySelector('[data-hover-overlay]') as Element
  tapOn(root, overlay)
  await vi.waitFor(() => expect(tooltipText()).toContain('Fack 1'))
  // A lifted finger keeps it.
  // React's onPointerLeave listens for pointerout (relatedTarget outside), not a dispatched pointerleave.
  const leave = (pointerType: string) =>
    overlay().dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, pointerType, relatedTarget: document.body }),
    )
  leave('touch')
  await new Promise((r) => setTimeout(r, 150))
  expect(tooltipText()).toContain('Fack 1')
  // A mouse leaving closes it, and the hover line goes with it.
  await hoverPlot(root)
  leave('mouse')
  await vi.waitFor(() => {
    expect(tooltipText()).toBe('')
    expect(hoverCursor(root)).toBeNull()
  })
})

test('every device hidden: the time axis keeps its ticks, with no y labels and no grid', async () => {
  const root = await renderChart(day().map((d) => ({ ...d, hidden: true })))
  await vi.waitFor(() => expect(xTickLabels(root).length).toBeGreaterThan(2))
  expect(yTickLabels(root)).toEqual([])
  expect(gridLines(root)).toHaveLength(0)
})
```

(also import `gridLines` from chartDom), and two refetch tests, which need a rerender:

```tsx
test('a refetch that adds a reading keeps the open card on its time', async () => {
  const devices = day()
  const ui = (ds: ClimateChartDevice[]) => (
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={ds}
        unit="°C"
        formatTick={(t) => new Date(t).toISOString()}
        timeAxis={makeTimeAxis('24h', 'sv-SE')}
        label="Temperatur"
      />
    </div>
  )
  const { screen } = await renderWithProviders(ui(devices))
  const root = screen.container
  await hoverPlot(root)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const header = tooltipNodes()[0]?.firstElementChild?.textContent
  const [a, b] = devices
  const later = a.points[a.points.length - 1].t + 2 * HOUR
  await screen.rerender(ui([{ ...a, points: [...a.points, { t: later, a: 21 }] }, b]))
  await new Promise((r) => setTimeout(r, 150))
  expect(tooltipNodes()[0]?.firstElementChild?.textContent).toBe(header)
})

test('when the data moves away from an open card, no card or hover line is left', async () => {
  const devices = day()
  const ui = (ds: ClimateChartDevice[]) => (
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={ds}
        unit="°C"
        formatTick={(t) => String(t)}
        timeAxis={makeTimeAxis('24h', 'sv-SE')}
        label="Temperatur"
      />
    </div>
  )
  const { screen } = await renderWithProviders(ui(devices))
  const root = screen.container
  await hoverPlot(root)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  // A range switch: the same sensors, readings a year earlier.
  const shifted = devices.map((d) => ({
    ...d,
    points: d.points.map((p) => ({ ...p, t: p.t - 365 * 24 * HOUR })),
  }))
  await screen.rerender(ui(shifted))
  await vi.waitFor(() => {
    expect(tooltipText()).toBe('')
    expect(hoverCursor(root)).toBeNull()
    expect(activeDots(root)).toHaveLength(0)
  })
})
```

(import `tooltipNodes` from chartDom; `renderWithProviders`' screen has `rerender`, as `BarChart.browser.test.tsx`
uses; wrap in `QueryClientProvider` the same way if `rerender` drops the provider: follow that file's lines 361–394.)

- [ ] **Step 2: Run them to see the new ones fail**

Run: `bunx vitest run --project browser src/components/sensor/ClimateChart.browser.test.tsx`
Expected: the Task 1 tests PASS (recharts ignores the new props, and TypeScript isn't checked by vitest), the new
ones FAIL (no `[data-active-dot]`, recharts' odd ticks, …).

- [ ] **Step 3: Rewrite `ClimateChart.tsx`**

```tsx
import { AxisBottom, AxisLeft } from '@visx/axis'
import { curveMonotoneX } from '@visx/curve'
import { GridRows } from '@visx/grid'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { LinePath } from '@visx/shape'
import { scaleLinear } from 'd3-scale'
import type * as React from 'react'
import { useMemo, useRef } from 'react'
import {
  AXIS_COLOR,
  CHART_MARGIN,
  measureAt,
  TICK_PX,
  TICK_SIZE,
  X_AXIS_H,
  X_TICK_MARGIN,
  Y_TICK_MARGIN,
  yAxisWidth,
} from '~/components/chart/axis'
import { ChartLegend } from '~/components/chart/ChartParts'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import {
  type ClimateTooltipRow,
  nearestReadings,
  niceYScale,
  type SeriesPoint,
  timeDomain,
  valueRange,
} from '~/lib/sensor/chartData'
import { CADENCE_SEC } from '~/lib/sensor/range'
import type { TimeAxis } from '~/lib/sensor/tickFormat'
import { nearestTime, pickTimeTicks, readingTimes } from './climateLayout'

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
  /** The card's time header (range-aware). */
  formatTick: (t: number) => string
  /** The time axis' round ticks and labels (makeTimeAxis). */
  timeAxis: TimeAxis
  /** The chart's accessible name: its section's title. */
  label: string
}

const HEIGHT = 260
const ISOLATED_DOT_R = 3
const ACTIVE_DOT_R = 4
// A reading counts for a hovered time within one reporting cadence (nearestReadings).
const WINDOW_MS = CADENCE_SEC * 1000

// The card: one row per visible device, each at its reading nearest the
// hovered time. A row shows its own time only when it differs from the header
// (the hovered reading's time), so a sensor's offset stays visible.
function CardContent({
  t,
  rows,
  unit,
  formatTick,
}: {
  t: number
  rows: ClimateTooltipRow[]
  unit: string
  formatTick: (t: number) => string
}) {
  return (
    <>
      <div className="font-medium">{formatTick(t)}</div>
      <div className="grid gap-1.5">
        {rows.map((row) => (
          <div key={row.id} className="flex w-full items-center justify-between gap-6">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="inline-block size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: row.color }}
              />
              {row.displayName}
            </span>
            <span className="flex items-baseline gap-2">
              {row.t !== t ? (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {formatTick(row.t)}
                </span>
              ) : null}
              <span className="font-medium font-mono text-foreground tabular-nums">
                {row.value.toFixed(1)}
                <span className="ml-0.5 font-sans text-muted-foreground">{unit}</span>
              </span>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

// One coloured line per visible device on a shared time axis, drawn with visx
// on d3 scales (the geometry in climateLayout.ts). Each line reads its own
// points, so a null is only an outage break. The time axis spans every device,
// hidden ones too, so a toggle never rescales time; the y axis spans the
// visible ones. Hover snaps to the nearest reading of any visible device and
// shows every device's reading nearest that time. The section's <h2> names the
// chart, so the svg has no <title>.
export function ClimateChart({ devices, unit, formatTick, timeAxis, label }: Props) {
  // No debounce: a resize that wraps the legend re-lays the plot at once.
  const { parentRef, width, height: plotBoxH } = useParentSize({ debounceTime: 0 })
  // followScroll: the card is portalled, so it re-measures while a scroll
  // container moves the chart under it.
  const popover = useChartPopover<number>({ followScroll: true })
  // The reading time the pointer last moved to (Task 5's keys continue from it).
  const cursor = useRef<number | null>(null)
  const times = useMemo(() => readingTimes(devices), [devices])
  const visible = devices.filter((d) => !d.hidden)

  const geometry = useMemo(() => {
    if (width <= 0 || plotBoxH <= 0) return null
    const measure = measureAt(TICK_PX)
    const plotH = Math.max(0, plotBoxH - CHART_MARGIN.top - CHART_MARGIN.bottom - X_AXIS_H)
    const values = valueRange(devices)
    const yNice = values ? niceYScale(values[0], values[1]) : null
    const yFormat = (v: number) => `${v.toFixed(yNice?.decimals ?? 0)}${unit}`
    const yTicks = yNice?.ticks ?? []
    const y = scaleLinear()
      .domain(yNice?.domain ?? [0, 1])
      .range([plotH, 0])
    const left = CHART_MARGIN.left + (yNice ? yAxisWidth(yTicks.map(yFormat), measure) : 0)
    const plotW = Math.max(0, width - left - CHART_MARGIN.right)
    const domain = timeDomain(devices)
    const x = scaleLinear()
      .domain(domain ?? [0, 1])
      .range([0, plotW])
    const xTicks = domain ? pickTimeTicks({ domain, x, axis: timeAxis, measure }) : []
    return { x, y, yTicks, yFormat, left, plotW, plotH, xTicks }
  }, [width, plotBoxH, devices, unit, timeAxis])

  // The open time's rows. Empty when the data moved away from it (a refetch or
  // a range switch): then nothing shows, not a stale card.
  const active = popover.open && popover.data !== undefined ? popover.data : null
  const rows = active === null ? [] : nearestReadings(devices, active, WINDOW_MS)
  const shown = active !== null && rows.length > 0 && geometry !== null ? active : null

  // The card's anchor: the hovered time, above the highest of its dots.
  const anchor = (t: number) => {
    if (!geometry) return { left: 0, top: 0 }
    const dots = nearestReadings(devices, t, WINDOW_MS).map((r) => geometry.y(r.value))
    return {
      left: geometry.left + geometry.x(t),
      top: CHART_MARGIN.top + Math.min(geometry.plotH, ...dots) - ACTIVE_DOT_R,
    }
  }
  const open = (t: number) => {
    cursor.current = t
    const { left, top } = anchor(t)
    popover.show(t, left, top)
  }
  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    if (!geometry) return
    const box = e.currentTarget.getBoundingClientRect()
    if (box.width <= 0) return
    const t = nearestTime(times, geometry.x.invert(((e.clientX - box.left) / box.width) * geometry.plotW))
    // Nothing visible: no reading to show. Same reading: no re-render per pixel.
    if (t === null || (popover.open && popover.data === t)) return
    open(t)
  }

  const svg = geometry ? (
    // biome-ignore lint/a11y/noSvgWithoutTitle: visual; the labelled group is the accessible path
    <svg data-chart-svg width={width} height={plotBoxH} aria-hidden className="block overflow-visible">
      <Group left={geometry.left} top={CHART_MARGIN.top}>
        {geometry.yTicks.length === 0 ? null : (
          <g data-grid>
            <GridRows
              scale={geometry.y}
              tickValues={geometry.yTicks}
              width={geometry.plotW}
              stroke="var(--border)"
              strokeOpacity={0.5}
            />
          </g>
        )}
        {shown === null ? null : (
          <line
            data-hover-cursor
            x1={geometry.x(shown)}
            x2={geometry.x(shown)}
            y1={0}
            y2={geometry.plotH}
            stroke="var(--border)"
            pointerEvents="none"
          />
        )}
        {visible.map((d) => (
          <g key={d.id} data-series={d.id} data-kind="line">
            <LinePath
              data-line-curve
              data={d.points}
              // Outage markers break the line (recharts' connectNulls={false}).
              defined={(p) => typeof p[d.id] === 'number'}
              x={(p) => geometry.x(p.t)}
              y={(p) => geometry.y(p[d.id] as number)}
              curve={curveMonotoneX}
              stroke={d.color}
              strokeWidth={2}
              fill="none"
            />
            {d.points
              .filter((p) => p.isolated && typeof p[d.id] === 'number')
              .map((p) => (
                <circle
                  key={p.t}
                  data-reading-dot
                  cx={geometry.x(p.t)}
                  cy={geometry.y(p[d.id] as number)}
                  r={ISOLATED_DOT_R}
                  fill={d.color}
                  stroke={d.color}
                />
              ))}
          </g>
        ))}
        {shown === null
          ? null
          : rows.map((r) => (
              <circle
                key={r.id}
                data-active-dot
                cx={geometry.x(r.t)}
                cy={geometry.y(r.value)}
                r={ACTIVE_DOT_R}
                fill={r.color}
                pointerEvents="none"
              />
            ))}
        {geometry.yTicks.length === 0 ? null : (
          <g data-axis="y">
            <AxisLeft
              scale={geometry.y}
              tickValues={geometry.yTicks}
              tickFormat={(v) => geometry.yFormat(Number(v))}
              tickLength={TICK_SIZE}
              stroke={AXIS_COLOR}
              tickStroke={AXIS_COLOR}
              tickLabelProps={() => ({
                fill: 'var(--muted-foreground)',
                fontSize: TICK_PX,
                dx: -Y_TICK_MARGIN,
                dy: '0.32em',
                textAnchor: 'end' as const,
              })}
            />
          </g>
        )}
        <g data-axis="x">
          <AxisBottom
            top={geometry.plotH}
            scale={geometry.x}
            tickValues={geometry.xTicks}
            tickFormat={(t) => timeAxis.format(Number(t))}
            tickLength={TICK_SIZE}
            stroke={AXIS_COLOR}
            tickStroke={AXIS_COLOR}
            tickLabelProps={() => ({
              fill: 'var(--muted-foreground)',
              fontSize: TICK_PX,
              dy: X_TICK_MARGIN,
              textAnchor: 'middle' as const,
            })}
          />
        </g>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer surface in the aria-hidden svg; the labelled group is the keyboard path */}
        <rect
          data-hover-overlay
          width={geometry.plotW}
          height={geometry.plotH}
          fill="transparent"
          // A horizontal finger drag scrubs through the readings; a vertical one scrolls.
          style={{ touchAction: 'pan-y' }}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          // Off the plot the card closes; a lifted finger keeps it (ChartPopover's touch rule).
          onPointerLeave={(e) => {
            if (e.pointerType !== 'touch') popover.hide()
          }}
        />
      </Group>
    </svg>
  ) : null

  return (
    <div
      data-chart="line"
      {...popover.containerProps}
      // The box is inline styles, not Tailwind: the plot must measure before
      // CSS loads and in the CSS-less browser tests.
      className="w-full text-xs"
      style={{ height: HEIGHT, display: 'flex', flexDirection: 'column' }}
    >
      <div
        ref={parentRef}
        data-chart-focus
        role="group"
        aria-label={label}
        tabIndex={0}
        className="rounded-sm outline-hidden focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ flex: '1 1 0', minHeight: 0 }}
      >
        {svg}
      </div>
      <ChartLegend
        items={devices.map((d) => ({ key: d.id, label: d.displayName, color: d.color }))}
      />
      <ChartPopover
        // Anchored from the current layout on every render, so a refetch or a
        // resize moves the card with its time.
        state={shown === null ? { ...popover, open: false } : { ...popover, ...anchor(shown) }}
        variant="card"
        dataKey={shown === null ? undefined : String(shown)}
      >
        {shown === null ? null : (
          <CardContent t={shown} rows={rows} unit={unit} formatTick={formatTick} />
        )}
      </ChartPopover>
    </div>
  )
}
```

Notes for the implementer:
- The hint (`aria-describedby`) and the live region come with the keys in Task 5.
- `ChartLegend`'s `pt-3` and `gap-x-4` match recharts' `ChartLegendContent` (`pt-3`, `gap-4`), and its swatch is
  the same `h-2 w-2 rounded-[2px]`.
- Compare `AxisLeft`/`AxisBottom` with BarChart's: the only differences are the tick lines (shown here, as recharts'
  `tickLine` default was) and the label formats.
- Don't memo `rows`/`anchor`: they're cheap (one pass over each visible device's points) and must follow every
  render.

- [ ] **Step 4: Pass the new props from the route**

In `src/routes/_authenticated/sensors.tsx`, import `makeTimeAxis` with `makeTickFormatter`, and after the
`formatTick` memo add:

```ts
  const timeAxis = useMemo(() => makeTimeAxis(shownRange, getIntlLocale()), [shownRange])
```

Then pass `timeAxis={timeAxis}` and `label={m.sensors_temp_chart_title()}` (temperature) /
`label={m.sensors_humidity_chart_title()}` (humidity) to the two `ClimateChart`s.

- [ ] **Step 5: Run the tests**

Run: `pgrep -fl vitest; bunx vitest run --project browser src/components/sensor src/routes/_authenticated/-sensorsRoute.browser.test.tsx && bun run typecheck`
Expected: all PASS. If the Task 1 hover test fails on the visx chart, check that the overlay receives the
`pointermove` (`moveAt` dispatches on `[data-hover-overlay]`) before changing any test.

- [ ] **Step 6: Commit**

```bash
git add src/components/sensor/ClimateChart.tsx src/components/sensor/ClimateChart.browser.test.tsx src/routes/_authenticated/sensors.tsx
git commit -m "refactor(sensor): draw the Klimat charts with visx"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`, told to
compare against `main`'s recharts chart item by item (the "Behaviour to preserve" list) and the three accepted
differences, and to look for re-render storms on pointer moves and for stale state after a refetch.

---

### Task 5: The keyboard

**Files:**
- Modify: `src/components/sensor/ClimateChart.tsx`
- Modify: `src/components/sensor/ClimateChart.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: Task 4's chart; `focusChart`, `pressUntil`, `settle`, `tooltipNodes` from chartDom.
- Produces: `[data-chart-announce]` (the live region), the key handler on `[data-chart-focus]`.

- [ ] **Step 1: Add the string**

`messages/sv.json`: `"sensors_chart_keyboard_hint": "Använd piltangenterna för att stega mellan mätningarna"`
`messages/en.json`: `"sensors_chart_keyboard_hint": "Use the arrow keys to step through the readings"`
(next to `chart_keyboard_hint`), then `bun run i18n:compile`.

- [ ] **Step 2: Write the failing tests**

Append to `ClimateChart.browser.test.tsx` (import `userEvent` from `vitest/browser`, and `focusChart`, `settle`,
`tooltipNodes` from chartDom):

```tsx
const header = () => tooltipNodes()[0]?.firstElementChild?.textContent ?? null
const announced = (root: HTMLElement) =>
  root.querySelector('[data-chart-announce]')?.textContent ?? ''

test('the chart is one named Tab stop whose arrows walk the readings', async () => {
  const devices = day()
  const root = await renderChart(devices, { formatTick: (t) => String(t) })
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  const group = focusChart(root)
  expect(group.getAttribute('role')).toBe('group')
  expect(group.getAttribute('aria-label')).toBe('Temperatur')
  expect(tooltipText()).toBe('')

  const times = [...devices[0].points, ...devices[1].points].map((p) => p.t).sort((a, b) => a - b)
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(times[0]))
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(times[1]))
  await userEvent.keyboard('{ArrowLeft}')
  await settle()
  expect(header()).toBe(String(times[0]))
  // Clamped at the first reading.
  await userEvent.keyboard('{ArrowLeft}')
  await settle()
  expect(header()).toBe(String(times[0]))
  await userEvent.keyboard('{End}')
  await settle()
  expect(header()).toBe(String(times[times.length - 1]))
  await userEvent.keyboard('{Home}')
  await settle()
  expect(header()).toBe(String(times[0]))
  // Each step is announced with its card's content.
  expect(announced(root)).toContain(String(times[0]))
  expect(announced(root)).toContain('Fack 1')
})

test('← from nothing starts at the last reading; Escape and Tab-out close the card', async () => {
  const devices = day()
  const root = await renderChart(devices, { formatTick: (t) => String(t) })
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  await userEvent.keyboard('{ArrowLeft}')
  await settle()
  const last = Math.max(...devices.flatMap((d) => d.points.map((p) => p.t)))
  expect(header()).toBe(String(last))
  await userEvent.keyboard('{Escape}')
  await settle()
  expect(tooltipText()).toBe('')
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(tooltipText()).not.toBe('')
  ;(document.activeElement as HTMLElement).blur()
  await settle()
  expect(tooltipText()).toBe('')
  expect(announced(root)).toBe('')
})

test('after a refetch adds a reading, → continues from the shown time', async () => {
  const devices = day()
  const ui = (ds: ClimateChartDevice[]) => (
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={ds}
        unit="°C"
        formatTick={(t) => String(t)}
        timeAxis={makeTimeAxis('24h', 'sv-SE')}
        label="Temperatur"
      />
    </div>
  )
  const { screen } = await renderWithProviders(ui(devices))
  const root = screen.container
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  const times = [...devices[0].points, ...devices[1].points].map((p) => p.t).sort((a, b) => a - b)
  for (let i = 0; i < 3; i++) {
    await userEvent.keyboard('{ArrowRight}')
    await settle()
  }
  expect(header()).toBe(String(times[2]))
  // A new reading before the shown one shifts every index by one.
  const [a, b] = devices
  const earlier = times[0] - HOUR
  await screen.rerender(ui([{ ...a, points: [{ t: earlier, a: 19 }, ...a.points] }, b]))
  await settle()
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(times[3]))
})

test('with every device hidden the keys do nothing', async () => {
  const root = await renderChart(day().map((d) => ({ ...d, hidden: true })))
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  await userEvent.keyboard('{ArrowRight}{End}')
  await settle()
  expect(tooltipText()).toBe('')
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/sensor/ClimateChart.browser.test.tsx`
Expected: the four new tests FAIL (no key handling, no live region).

- [ ] **Step 4: Implement the keyboard**

In `ClimateChart.tsx`:
- import `bisectCenter` from `d3-array`, `useId` and `useState` from `react`, `m` from `~/paraglide/messages`;
- add `const hintId = useId()` and `const [announced, setAnnounced] = useState<number | null>(null)` next to
  `cursor`;
- in `onPointer`, call `setAnnounced(null)` before `open(t)` (a mouse move ends the keyboard's announcement);
- add, after `onPointer`:

```tsx
  const close = () => {
    cursor.current = null
    popover.hide()
    setAnnounced(null)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Browser shortcuts (Alt+← back, Cmd+Home …) pass through.
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Escape') return close()
    if (times.length === 0) return
    const last = times.length - 1
    // Found again by time: a refetch may have shifted every index since.
    const current = cursor.current === null ? null : bisectCenter(times, cursor.current)
    const next =
      e.key === 'ArrowRight'
        ? current === null
          ? 0
          : Math.min(current + 1, last)
        : e.key === 'ArrowLeft'
          ? current === null
            ? last
            : Math.max(current - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (next === null) return
    e.preventDefault()
    open(times[next])
    setAnnounced(times[next])
  }
```

- on the focus `div`, add `aria-describedby={hintId}`, `onKeyDown={onKeyDown}` and
  `onBlur={close}` (leaving by keyboard closes the card, as in BarChart: a card left behind would cover whatever
  takes focus next);
- after `<ChartLegend …/>`, add:

```tsx
      <p id={hintId} className="sr-only">
        {m.sensors_chart_keyboard_hint()}
      </p>
      {/* Read whole (atomic): only the changed text would otherwise be read. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-chart-announce>
        {announced === null ? null : (
          <span key={announced}>
            <CardContent
              t={announced}
              rows={nearestReadings(devices, announced, WINDOW_MS)}
              unit={unit}
              formatTick={formatTick}
            />
          </span>
        )}
      </div>
```

- [ ] **Step 5: Run the tests**

Run: `pgrep -fl vitest; bunx vitest run --project browser src/components/sensor && bun run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/sensor/ClimateChart.tsx src/components/sensor/ClimateChart.browser.test.tsx messages/sv.json messages/en.json
git commit -m "refactor(sensor): walk the Klimat readings from the keyboard"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`, told to
check the group against 5a's keyboard notes (roadmap "Step 5a notes"), the live region's content, and that a mouse
and the keys can't leave the card and the announcement out of step.

---

### Task 6: Delete recharts

**Files:**
- Delete: `src/components/ui/chart.tsx`, `src/components/evCharging/ChartFrame.tsx`
- Modify: `package.json`, `bun.lock` (via `bun remove recharts`)
- Modify: `test/browser/chartDom.ts`
- Modify: comments that point at the deleted files: `src/components/chart/ChartParts.tsx:4-5` and any other hit of
  the grep in Step 1

**Interfaces:**
- Produces: `chartDom.ts` with only the visx selectors; every exported helper keeps its name and signature.

- [ ] **Step 1: Confirm nothing imports them**

Run: `git grep -n "recharts\|ui/chart'\|ChartFrame\|ChartContainer\|ChartConfig" -- src test scripts`
Expected: imports only in the two files being deleted; the other hits are comments (BarChart and barLayout describe
recharts parity; leave those, they explain where the numbers come from) and `chartDom.ts`.

- [ ] **Step 2: Delete**

```bash
git rm src/components/ui/chart.tsx src/components/evCharging/ChartFrame.tsx
bun remove recharts
```

Then fix `ChartParts.tsx`'s header comment ("so the visx charts can use them without pulling recharts into their
page's bundle") to say what it is now: `// The chart parts every chart shares: the height, the empty state, tooltip rows and the legend.`

- [ ] **Step 3: Drop the recharts halves of `chartDom.ts`**

- `SEL`: keep only each value's visx half, e.g. `bar: '[data-bar]'`, `legend: '[data-slot="chart-legend"]'`,
  `xTick: '[data-axis="x"] .visx-axis-tick'`, `readingDot: '[data-reading-dot]'`. Drop `svg`'s and `focus`'s
  `svg.recharts-surface` parts, and the Energi recharts hooks (`[data-slot="hover-month"]`,
  `[data-slot="selected-month"]`).
- The file's header comment: say the selectors are the visx charts' `data-*` hooks.
- `legendLabels`: only the `[data-legend-item]` path.
- `tooltipText` / `tooltipNodes`: drop the `visibility: hidden` filter (ChartPopover unmounts a closed card).
- `barHeight`: keep (it still guards that `[data-bar]` is the shape itself).
- `moveAt`, `hoverBar`, `hoverBetween`, `clickOn`, `tapOn`: drop the recharts fallbacks; with no
  `[data-hover-overlay]` they throw `new Error('no chart hover overlay')` instead of hit-testing. `moveOverPlot`
  folds into `moveAt` if nothing else calls it (`git grep -n moveOverPlot`). `pointAt` goes if `git grep -n
  "pointAt(" -- src test | grep -v SessionPriceChart` finds no caller (SessionPriceChart's test has its own).
- `MonthlyChart.browser.test.tsx:572`'s comment ("recharts shows January on focus; …"): keep it only if it still
  explains the test; otherwise say what the test checks.

- [ ] **Step 4: Check the build and the lockfile**

Run: `bun run build 2>&1 | tail -5 && grep -c '"recharts\|"redux\|"immer\|"decimal.js-light\|"@reduxjs\|"victory-vendor\|"react-redux' bun.lock`
Expected: the build passes; the count is 0. If a package remains, `bun pm why <name>` says what still pulls it; a
dependency other than recharts keeping it is fine, but write it down for the roadmap notes (checkpoint 5 lists
"recharts, redux, immer and decimal.js-light gone from the build").

- [ ] **Step 5: Run every chart suite**

Run: `pgrep -fl vitest; bunx vitest run --project browser src/components test/browser src/routes && bunx vitest run --project node src/components src/lib/sensor`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -u src test package.json bun.lock
git commit -m "refactor(charts): delete recharts and its chart frame"
```

Reviewers: `code-reviewer` + a reviewer loading `vercel-react-best-practices`, told to check that no chart test lost
an assertion when its helper's fallback went, and that nothing in `src/` still reaches a deleted file.

---

### Task 7: Bones without `.sr-only`, recaptured

5a and 5b left the recapture here. A capture today turns a chart's sr-only nodes (the hint, the live region) into
dot bones; excluding `.sr-only` stops that. `boneyard.config.json` can't carry it (the CLI reads only `breakpoints`,
`out`, `wait` and `auth` from it); the exclusion is a `snapshotConfig` the `<Skeleton>` gets, so it goes in
`SectionSkeleton`.

**Files:**
- Modify: `src/components/layout/SectionSkeleton.tsx:44-46,71`
- Modify: `src/components/layout/SectionSkeleton.browser.test.tsx`
- Modify: `src/bones/*.bones.json` (generated)

- [ ] **Step 1: Write the failing test**

The CLI's snapshot can't run in a test (it needs the boneyard build flag and a headless capture), so the
exclusion goes through a small exported helper, `skeletonSnapshotConfig(excludeSelectors?: string[])`, that the
`<Skeleton>` gets. Add to `SectionSkeleton.browser.test.tsx`:

```ts
import { skeletonSnapshotConfig } from './SectionSkeleton'

test('a capture always leaves screen-reader-only text out of the bones', () => {
  expect(skeletonSnapshotConfig()).toEqual({ excludeSelectors: ['.sr-only'] })
  expect(skeletonSnapshotConfig(['[data-no-skeleton]'])).toEqual({
    excludeSelectors: ['.sr-only', '[data-no-skeleton]'],
  })
})
```

- [ ] **Step 2: Implement**

In `SectionSkeleton.tsx`:

```ts
/** What a capture leaves out: screen-reader-only text (a chart's hint, its live region) and the caller's selectors. */
export function skeletonSnapshotConfig(excludeSelectors?: string[]) {
  return { excludeSelectors: ['.sr-only', ...(excludeSelectors ?? [])] }
}
```

and `snapshotConfig={skeletonSnapshotConfig(excludeSelectors)}` on the `<Skeleton>`. Update the
`excludeSelectors` prop's doc comment: "Elements the capture leaves out of the bones besides `.sr-only` (e.g.
admin-only controls)."

- [ ] **Step 3: Run the test**

Run: `bunx vitest run --project browser src/components/layout/SectionSkeleton.browser.test.tsx test/sectionSkeletonBones.test.ts`
Expected: PASS.

- [ ] **Step 4: Recapture every page**

With the worktree's dev server on :14610 (`BETTER_AUTH_URL=http://localhost:14610 bunx vite dev --port 14610 --strictPort`, run in the background) and realistic local data (sensor readings over the last year; the local DB was
seeded with ~8 400 synthetic readings on 2026-10-06), run:

```bash
bun run bones:capture --force
```

Expected: every default page captured (~1–2 min each). Then `git diff --stat src/bones` and open two of the changed
files: the chart sections must have no tiny dot bones where the sr-only hint and live region sit (a bone of a few px
at the bottom of a chart section). Data-only drift elsewhere (the patterns timeline, the economy rows) is expected,
as noted in 5a.

- [ ] **Step 5: Commit (two hats, two commits)**

```bash
git add src/components/layout/SectionSkeleton.tsx src/components/layout/SectionSkeleton.browser.test.tsx
git commit -m "fix(layout): leave sr-only text out of captured bones"
git add src/bones
git commit -m "chore(bones): recapture the section skeletons"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines`, told to check a few captures against the
live pages at 375 and 1280 px (the skeleton's chart block the same height as the chart), and that the exclusion
can't hide visible content.

---

### Task 8: Verify, measure, record

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md`

- [ ] **Step 1: Measure the bundle**

Run: `bun run bundle:measure 2>&1 | tail -60`
Expected: no page's `packages:` line lists recharts, redux, immer or decimal.js-light; `/sensors` drops by roughly
the recharts code it carried (~80 KB gz from 121); the other pages and the shell move by at most 1–2 KB.

- [ ] **Step 2: The pre-PR gate**

Run the gate from `docs/feature-workflow.md` (`bun run check`, `check:ci`, `build`, `db:up && db:migrate`, `test`,
the sv/en key check). Expected: all green; paste the output in the PR.

- [ ] **Step 3: Live check at three widths, side by side with `main`**

Follow the `live-ui-check-playwright` memory (worktree Playwright + Mailpit magic link on :14610; wait for load + 4 s,
never `networkidle`). Run `main`'s dev server the same way on another port for the side-by-side screenshots. On
`/sensors` with the seeded local data, at 1280, 768 and 375 px, for 24 h, 1 w, 1 m, 1 y and all:
- lines, colours, the legend, the grid, the axis lines and tick marks, the y labels match `main`;
- the time ticks are round and never crowd (difference 1), also at 320 px for 24 h, 1 w and 1 y;
- hover: the line, one dot per card row (difference 2), the card above the dots with the same rows as `main`'s;
- touch emulation at 375 px: a drag scrubs, a lifted finger keeps the card, a tap elsewhere closes it;
- Tab reaches each chart (focus ring), ←/→/Home/End walk the readings, Escape closes;
- hide both sensors: no lines, no card, the time axis keeps its ticks (difference 3);
- a range switch with a card open leaves no stale card.
Save screenshots under the scratchpad; attach the key ones to the PR.

- [ ] **Step 4: Record in the roadmap**

Row 5c: PR link, status `PR open`. In "Step 5c notes": the before/after bundle table (Task 0 and Step 1), the
lockfile check (Task 6 Step 4), the accepted differences (already there), and any follow-ups the reviews found.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/roadmaps/2026-10-05-client-performance.md
git commit -m "docs(perf): record the Klimat charts' bundle and review notes"
```

Then the branch review (`code-reviewer` + a general correctness pass told to look for moved behaviour), fix findings
in this PR, and open the PR titled `refactor(sensor): draw the Klimat charts with visx`. After the merge, checkpoint 5
runs (roadmap "Checkpoints" 5): the owner reviews every converted chart live on prod.

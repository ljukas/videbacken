# Client performance step 5a: the bar charts on visx (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
> House rule: after each task's commit, two adversarial reviewers (paired per task) start from the assumption that
> the task is wrong and changed behaviour. Fix or rule on every finding before the next task.

**Goal:** The four simple bar charts (HourOfDay, Monthly, Economy, Spot comparison) draw with visx on one shared,
deep bar-chart module, with behaviour preserved. `/charging`, `/charging/economy` and `/charging/patterns` stop
loading recharts (an 84 KB gz chunk on `main`).

**Architecture:**
- Safety net first. One test-helper module (`test/browser/chartDom.ts`) gives the chart tests library-neutral
  queries: bars, series, legend, tooltip, ticks, hover, focus. While the migration runs it matches both recharts'
  classes and the new module's `data-*` hooks. The existing tests move onto it, and characterization tests pin the
  untested behaviours, all on recharts and all green, before any chart changes.
- `src/components/chart/barLayout.ts` is pure geometry: band slots, stacking (d3-shape), the 4 px floor, the y
  scale and its ticks, x-tick thinning. `src/components/chart/BarChart.tsx` is the one React module. Callers pass
  rows, a series list (stack, legend and tooltip order in one place), a value accessor and a tooltip render.
- The tooltip keeps today's card look and content, placed with `ChartPopover`'s mechanics: portal, above the hovered
  month, kept in the window, closed by a tap outside or Escape (`variant="card"`).
- Keyboard: a chart with a `label` is one Tab stop, a labelled `role="group"`. ←/→/Home/End walk the months and
  show each month's tooltip, Escape closes it, and each step is announced in a polite live region (the
  SessionPriceChart idiom). A chart without a `label` is `aria-hidden` behind its own sr-only table (HourOfDay).

**Tech stack:** React 19, visx 4.0.0 (`@visx/axis`, `@visx/shape`, `@visx/group`, `@visx/responsive`,
`@visx/tooltip`; new: `@visx/grid`, `@visx/text`), d3-scale 4, d3-array 3, new `d3-shape` 3, Vitest (node + browser
projects), bun.

**Design:** the architecture review and grilling in chat on 2026-10-06 (candidates 3 → 1 → 2; 4 folded into 1).
The owner chose (a) keep the keyboard path in the house idiom: `role="group"` with a name, not recharts'
`role="application"`; (b) the card tooltip placed above the month with ChartPopover's mechanics, not following the
cursor. There is no separate spec.
**Roadmap:** `docs/superpowers/roadmaps/2026-10-05-client-performance.md`, step 5a. Step 5 is split into 5a (this),
5b (the Energi chart on this module) and 5c (ClimateChart on visx lines; recharts and `ui/chart.tsx` deleted).

## Re-measured baseline (`main` at `5edaa9f`, prod build, `bun run bundle:measure`)

Entry + shell 257 KB gz. KB gz each page adds:

| Page | Adds | recharts `chart` chunk |
|---|---:|---|
| `/charging` | 160 | 84 |
| `/charging/economy` | 158 | 84 |
| `/charging/patterns` | 170 | 84 (patterns also has visx `Axis` 11) |
| `/energy` | 148 | 84 (stays until 5b) |
| `/sensors` | 123 | 84 (stays until 5c) |

## Global constraints

- Work in the worktree `.claude/worktrees/perf-visx` on branch `refactor/recharts-to-visx`. Never `cd` to the main
  checkout.
- **Refactor: one hat per commit.** No commit changes what a viewer sees or can do, except the two owner-approved
  gaps above (keyboard role/name, tooltip placement) and the pixel-level drift listed under "Parity". Any other
  difference found on the way is a bug in the swap, not a feature.
- Behaviour to preserve per chart: the same bars (count, DOM order: series by series, month by month), the same
  stacking and grouping, the 4 px floor rules (`minBarFor` semantics, incl. `zeroIsData`), the same legend entries
  in the same order (rendered series only), the same tooltip text and row order, the band-wide hover (a month with
  no rect still opens its tooltip), and the same empty states.
- New dependencies, exact versions like the rest of `package.json`: `d3-shape@3.2.0`, `@types/d3-shape@3.1.7`
  (dev), `@visx/grid@4.0.0`, `@visx/text@4.0.0`. `recharts` stays (Energi, sensors) until 5c.
- Logging via `~/lib/logger`, never `console.*`.
- One new user-facing string, `chart_keyboard_hint` (sv source of truth + en), added in Task 5.
- File naming: React component files are PascalCase (`BarChart.tsx`, `ChartParts.tsx`), everything else camelCase.
- `src/bones/*.bones.json` is generated (`bun run bones:capture`); never hand-edit it.
- Client code may only `import type` from services.
- Conventional Commits, ≤ 72 characters, imperative. End each commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git add <paths>`, never `-A`.
- Reviewers must not run vitest (concurrent runs collide on the shared local DB). Before running vitest yourself,
  check `pgrep -fl vitest` shows none from other sessions.
- Browser tests have no app CSS: pin structure, attributes and text there, and verify layout live.

### Parity (recharts defaults to reproduce)

Read from `node_modules/recharts/es6` 3.8.0, so the visx charts keep the same look:
- margins `{ left: 4, right: 12, top: 8, bottom: 0 }`, x axis 30 px tall, tick labels 12 px (the frame's
  `text-xs`), `fill: var(--muted-foreground)`, no tick lines, x `tickMargin` 8, y `tickMargin` 4;
- axis lines `stroke="#666"` (recharts' `CartesianAxis` default; ChartContainer doesn't restyle them). Economy and
  Spot hide the y axis line (`axisLine={false}`);
- horizontal grid lines at the y ticks, `stroke: var(--border)` at 50 % (ChartContainer's `stroke-border/50`);
- `barCategoryGap` 10 % of the band on each side and `barGap` 4 px (Economy: 2 px);
- the y domain is `[min(0, data), max(0, data)]` made nice, about 5 ticks; `allowDecimals={false}` means
  integer ticks with a step of at least 1. `width="auto"`: the y axis is as wide as its widest label;
- a line's dots: `r` 3, `fill="#fff"` (recharts' `Line` default), stroke as the line, solid;
- legend below the plot, inside the chart's height: `flex flex-wrap items-center justify-center gap-x-4 gap-y-1
  pt-3`, an 8 px swatch (`rounded-[2px]`) per entry;
- the tooltip card: `grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5
  py-1.5 text-xs shadow-xl`, a `font-medium` month label on top (HourOfDay has none).

Accepted drift, stated in the PR and reviewed live by the owner (checkpoint 5): tick values may differ by one step
(d3's nice ticks vs recharts'), the x-tick thinning may keep a different subset, and the tooltip sits above the
month instead of beside the cursor.

## Review focus

1. **A month whose only value is 0 or null still answers a hover** (Monthly's own-solar June draws no rect; an
   Economy month without comparable sessions has no bars and shows no tooltip). Pinned in Task 2 (existing June test
   via the helper) and Task 5 (`tooltip` returning null opens nothing).
2. **Negative values** (a negative spot price makes the stacked spot segment go below 0 in Monthly's kr view). The
   axis must include 0 and the negative segment must draw below the baseline with its floor growing downward.
   Pinned in Task 4.
3. **A chart narrower than its labels** (a 320 px phone): the y axis must not clip a long label like `−1 200 kr`,
   and the x labels must not overlap. Pinned in Task 4 (thinning) and Task 3 (Monthly at 280 px, HourOfDay at
   320 px); the y label width is measured with `getStringWidth` and checked live in Task 11 with a negative month.
4. **Keyboard focus while the pointer also hovers**: a pointer move must not leave a stale announcement, and Escape
   must close the tooltip. Pinned in Task 5.
5. **A tooltip near the window edge** (the first and last month on a phone): the card stays inside the window.
   Pinned in Task 5 (the edge test).

---

### Task 1: Roadmap split and baseline

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md`
- Create: this plan (already written)

- [ ] **Step 1: Verify `main` still matches the plan's assumptions**

Run: `git log --oneline -1 origin/main && git grep -ln "from 'recharts'" -- src`
Expected: `5edaa9f` (or a later commit that doesn't touch the files below), and exactly these importers:
`src/components/ui/chart.tsx`, `src/components/energy/EnergyMonthlyChart.tsx`,
`src/components/evCharging/{EconomyMonthlyChart,HourOfDayChart,MonthlyChart,SpotComparisonChart}.tsx`,
`src/components/sensor/ClimateChart.tsx`. If `main` moved, re-run `bun run bundle:measure` and update the baseline
table above.

- [ ] **Step 2: Split row 5 in the roadmap**

Replace row 5 of the status table with:

```markdown
| 5a | Bar charts on visx (refactor-workflow): a shared visx bar-chart module, tests moved off recharts' classes, HourOfDay, Monthly, Economy and Spot converted. `/charging`, economy and patterns drop recharts | [plan](../plans/2026-10-06-client-perf-5a-visx-bar-charts.md) | — | in progress | — |
| 5b | The Energi month chart on the bar module (selection, keyboard, export below the axis, hover outline) | — | — | not started | — |
| 5c | ClimateChart on visx lines; recharts, `ui/chart.tsx` and the old `ChartFrame` deleted; checkpoint 5 | — | — | not started | — |
```

In "Checkpoints", replace item 5's heading line with: `5. **After step 5c (prod).**` and add one sentence after
it: `Steps 5a and 5b have no checkpoint of their own; each PR is reviewed live at three widths before merge.`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/roadmaps/2026-10-05-client-performance.md docs/superpowers/plans/2026-10-06-client-perf-5a-visx-bar-charts.md
git commit -m "docs(perf): split step 5 and plan the visx bar charts"
```

Reviewers: none (docs). Self-check the table renders.

---

### Task 2: Chart tests through one library-neutral helper module

Pure test refactor. Every assertion keeps its meaning; only the way it finds elements changes. Green on recharts.

**Files:**
- Create: `test/browser/chartDom.ts`
- Modify: `src/components/evCharging/HourOfDayChart.browser.test.tsx`,
  `src/components/evCharging/MonthlyChart.browser.test.tsx`,
  `src/components/evCharging/EconomyMonthlyChart.browser.test.tsx`,
  `src/components/evCharging/SpotComparisonChart.browser.test.tsx`

**Interfaces:**
- Produces (used by Tasks 3–10): the exports of `chartDom.ts` below. The `data-*` selectors are the contract
  `BarChart` (Task 5) must render.

- [ ] **Step 1: Write the helper module**

```ts
// test/browser/chartDom.ts
import { expect, vi } from 'vitest'

// Library-neutral queries for the chart tests. Each selector matches recharts'
// DOM and the visx bar module's own data-* hooks, so a test keeps its
// assertions while a chart moves from one to the other (client-perf step 5).
// Once no chart in a test file renders recharts, its recharts half is dead
// weight; step 5c deletes those halves with recharts itself.
const SEL = {
  bar: '.recharts-bar-rectangle, [data-bar]',
  barSeries: '.recharts-bar, [data-kind="bar"]',
  lineSeries: '.recharts-line, [data-kind="line"]',
  lineCurve: '.recharts-line-curve, [data-line-curve]',
  lineDot: '.recharts-line-dot, [data-line-dot]',
  legend: '.recharts-legend-wrapper, [data-slot="chart-legend"]',
  tooltip: '.recharts-tooltip-wrapper, [data-slot="chart-tooltip"]',
  xTick: '.recharts-xAxis .recharts-cartesian-axis-tick, [data-axis="x"] .visx-axis-tick',
  yTick: '.recharts-yAxis .recharts-cartesian-axis-tick, [data-axis="y"] .visx-axis-tick',
  gridLine: '.recharts-cartesian-grid-horizontal line, [data-grid] line',
  svg: 'svg.recharts-surface, svg[data-chart-svg]',
  focus: 'svg.recharts-surface[tabindex], [data-chart-focus]',
} as const

const all = <E extends Element = Element>(root: ParentNode, sel: string) =>
  [...root.querySelectorAll<E>(sel)]

/** Every bar rectangle, in DOM order: series by series, then month by month. */
export const bars = (root: ParentNode) => all<SVGElement>(root, SEL.bar)
/** The bar series groups, in series order. */
export const barSeries = (root: ParentNode) => all(root, SEL.barSeries)
/** The bars of the `i`th bar series. */
export const seriesBars = (root: ParentNode, i: number) =>
  all<SVGElement>(barSeries(root)[i] ?? document.createDocumentFragment(), SEL.bar)
/** A bar's drawn height in px (recharts wraps the shape; the visx bar is the shape). */
export const barHeight = (bar: Element) =>
  (bar.matches('path, rect') ? bar : (bar.querySelector('path, rect') ?? bar)).getBoundingClientRect()
    .height
export const lineSeries = (root: ParentNode) => all(root, SEL.lineSeries)
export const lineCurve = (root: ParentNode) => root.querySelector<SVGPathElement>(SEL.lineCurve)
export const lineDots = (root: ParentNode) => all<SVGElement>(root, SEL.lineDot)
export const gridLines = (root: ParentNode) => all(root, SEL.gridLine)
export const chartSvg = (root: ParentNode) => root.querySelector<SVGSVGElement>(SEL.svg)
/** The chart's keyboard stop (recharts' focusable svg, or the visx module's group). */
export const focusTarget = (root: ParentNode) => root.querySelector<HTMLElement>(SEL.focus)

export const legend = (root: ParentNode) => root.querySelector<HTMLElement>(SEL.legend)
export const legendText = (root: ParentNode) => legend(root)?.textContent ?? ''
/** Legend entries' labels in order. */
export const legendLabels = (root: ParentNode) => {
  const box = legend(root)
  if (!box) return []
  const items = all(box, '[data-legend-item]')
  // recharts: wrapper > ChartLegendContent's div > one div per entry.
  const entries = items.length > 0 ? items : [...(box.firstElementChild?.children ?? [])]
  return entries.map((e) => e.textContent ?? '')
}

/** The open tooltip's text ('' when none). Tooltips may be portalled, so this searches the document. */
export const tooltipText = () =>
  all(document, SEL.tooltip)
    .map((t) => t.textContent ?? '')
    .join('')

export const xTickLabels = (root: ParentNode) => all(root, SEL.xTick).map((t) => t.textContent ?? '')
export const yTickLabels = (root: ParentNode) => all(root, SEL.yTick).map((t) => t.textContent ?? '')

/** Moves the pointer to (x, y): both recharts (mousemove) and the visx module (pointermove) listen. */
export function pointAt(x: number, y: number) {
  const target = document.elementFromPoint(x, y) ?? document.body
  const init = { bubbles: true, clientX: x, clientY: y }
  target.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerType: 'mouse' }))
  target.dispatchEvent(new MouseEvent('mousemove', init))
}

const centre = (el: Element) => {
  const b = el.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Hovers the centre of the `index`th bar (DOM order, see `bars`). */
export async function hoverBar(root: ParentNode, index: number) {
  await vi.waitFor(() => expect(bars(root).length).toBeGreaterThan(index))
  const { x, y } = centre(bars(root)[index])
  pointAt(x, y)
}

/** Hovers halfway between two bars' centres (a month that draws no rect of its own). */
export async function hoverBetween(root: ParentNode, a: number, b: number) {
  await vi.waitFor(() => expect(bars(root).length).toBeGreaterThan(Math.max(a, b)))
  const p = centre(bars(root)[a])
  const q = centre(bars(root)[b])
  pointAt((p.x + q.x) / 2, p.y)
}
```

- [ ] **Step 2: Move the four test files onto it**

Mechanical, per file; keep every test name, fixture and expected value. The mapping:

| Old | New |
|---|---|
| `querySelectorAll('.recharts-bar-rectangle')` | `bars(screen.container)` |
| `querySelectorAll('.recharts-bar')` | `barSeries(screen.container)` |
| `querySelectorAll('.recharts-line')` | `lineSeries(screen.container)` |
| `.recharts-line-curve` / `.recharts-line-dot` | `lineCurve(...)` / `lineDots(...)` |
| `querySelector('.recharts-legend-wrapper')?.textContent` | `legendText(screen.container)` |
| `document.querySelector('.recharts-tooltip-wrapper')?.textContent` | `tooltipText()` |
| local `hoverBar`/`hover` (mousemove at a rect's centre) | `hoverBar(screen.container, i)` |
| the June "halfway between May and July" mousemove | `hoverBetween(screen.container, 4, 5)` |
| local `barHeights(container, bar)` | `seriesBars(screen.container, bar).map(barHeight)` |
| `.recharts-bar-rectangle path` height | `barHeight(bars(screen.container)[0])` |
| `svg.recharts-surface` | `chartSvg(screen.container)` |
| `.recharts-cartesian-grid-horizontal line` | `gridLines(screen.container)` |
| `.recharts-xAxis .recharts-cartesian-axis-tick` | `xTickLabels(screen.container)` (count via `.length`) |
| `svg tspan` month-label lookup | `xTickLabels(screen.container)` |
| `.recharts-surface` rect in Economy's sliver test | `chartSvg(screen.container)` |

Two tests need an exact rewrite, because they reach past what a helper can express:
- HourOfDay "hides the chart from assistive tech": assert
  `focusTarget(screen.container)` is `null`, `chartSvg(screen.container)?.getAttribute('role')` is not
  `'application'`, and `chartSvg(screen.container)?.closest('[aria-hidden="true"]')` is not null (recharts:
  ChartContainer's `[data-chart]` div carries it). The sr-only caption assertion stays.
- Spot "dots are solid": `lineCurve(...)?.getAttribute('stroke-dasharray')` is `'5 4'`; every `lineDots(...)` has
  `stroke-dasharray` absent, `none` or `0`.

Drop the comments that explain recharts internals in moved code ("Recharts omits a zero-height rectangle") only
where the helper now carries the meaning; keep the ones that explain the fixture.

- [ ] **Step 3: Run the four files**

Run: `bunx vitest run --project browser src/components/evCharging/{HourOfDay,Monthly,EconomyMonthly,SpotComparison}Chart.browser.test.tsx`
Expected: PASS, with the same number of tests as before: for each file, `grep -c "^test(" <file>` equals
`git show HEAD:<file> | grep -c "^test("`.

- [ ] **Step 4: Commit**

```bash
git add test/browser/chartDom.ts src/components/evCharging/HourOfDayChart.browser.test.tsx src/components/evCharging/MonthlyChart.browser.test.tsx src/components/evCharging/EconomyMonthlyChart.browser.test.tsx src/components/evCharging/SpotComparisonChart.browser.test.tsx
git commit -m "test(charts): query the bar charts through one neutral helper"
```

Reviewers: `code-reviewer` + a general reviewer told "assume an assertion was weakened or now matches the wrong
element; diff each test against `HEAD~1` and prove it pins the same thing".

---

### Task 3: Characterization tests for what nothing pins yet

On recharts, through the helpers. They capture today's behaviour; if one fails on recharts, the test is wrong, not
the chart: fix the test to what recharts does and say so in the commit body.

**Files:**
- Modify: the four `*.browser.test.tsx` files from Task 2.

**Interfaces:** Consumes `chartDom.ts`.

- [ ] **Step 1: Add the tests**

`MonthlyChart.browser.test.tsx` (reuse its `months`, `costMonths` fixtures; add imports `userEvent` from
`vitest/browser`, and `formatOneDecimal` from `./format`):

```tsx
test('the kWh tooltip names the month and its energy', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} />
    </div>,
  )
  await hoverBar(screen.container, 2) // March: 20 kWh
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(monthLabel(3))
    expect(tooltipText()).toContain(`${formatOneDecimal(20)} kWh`)
  })
})

test('the kr legend and tooltip list the series in stack order', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() =>
    expect(legendLabels(screen.container)).toEqual([
      m.charging_chart_series_spot(),
      m.charging_chart_series_fees(),
    ]),
  )
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.charging_chart_total()))
  const text = tooltipText()
  expect(text.indexOf(m.charging_chart_series_spot())).toBeLessThan(
    text.indexOf(m.charging_chart_series_fees()),
  )
  expect(text.indexOf(m.charging_chart_series_fees())).toBeLessThan(
    text.indexOf(m.charging_chart_total()),
  )
})

test('the stub comes last in the kr legend', async () => {
  const unpriced = costMonths.map((c) =>
    c.month === 1
      ? { ...c, fullKwh: 0, noPriceKwh: c.kwh, spotSek: 0, feesSek: 0, totalSek: 0, avgOre: null, complete: false }
      : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: unpriced }} metric="sek" />
    </div>,
  )
  await vi.waitFor(() =>
    expect(legendLabels(screen.container)).toEqual([
      m.charging_chart_series_spot(),
      m.charging_chart_series_fees(),
      m.charging_chart_no_price(),
    ]),
  )
})

test('the count axis labels whole, formatted numbers', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months.map((mo) => ({ ...mo, kwh: mo.kwh * 100 }))} />
    </div>,
  )
  await vi.waitFor(() => expect(yTickLabels(screen.container).length).toBeGreaterThan(1))
  for (const label of yTickLabels(screen.container)) {
    // sv-SE groups thousands with a no-break space; never a decimal comma.
    expect(label).toMatch(/^−?\d{1,3}( \d{3})*$/)
  }
})

test('a narrow chart thins the month labels but keeps the first and the last', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 280, height: 300 }}>
      <MonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => expect(xTickLabels(screen.container).length).toBeGreaterThan(1))
  const labels = xTickLabels(screen.container)
  expect(labels.length).toBeLessThan(12)
  expect(labels[0]).toBe(monthLabel(1))
  expect(labels.at(-1)).toBe(monthLabel(12))
})

test('the keyboard reaches the chart and the arrows walk its tooltip a month at a time', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <button type="button">before</button>
      <MonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => expect(focusTarget(screen.container)).not.toBeNull())
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  expect(document.activeElement).toBe(focusTarget(screen.container))
  // recharts shows January on focus; the visx group shows it on the first →.
  // Either way, two → in a row move exactly one month.
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const shown = () => [...Array(12).keys()].map((i) => monthLabel(i + 1)).findIndex((l) => tooltipText().startsWith(l))
  const before = shown()
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(shown()).toBe(before + 1))
  await userEvent.keyboard('{ArrowLeft}')
  await vi.waitFor(() => expect(shown()).toBe(before))
})
```

`EconomyMonthlyChart.browser.test.tsx` (its `months` fixture; add `userEvent`, `formatSek` from `./format`,
`monthLabel` from `./format`):

```tsx
test('the legend lists immediate, actual, optimal, then the stub', async () => {
  const withStub = months.map((mo) =>
    mo.month === 3 ? month(3, { sessions: 1, excluded: { noHourly: 1, noPrice: 0 } }) : mo,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={withStub} />
    </div>,
  )
  await vi.waitFor(() =>
    expect(legendLabels(screen.container)).toEqual([
      m.charging_economy_series_immediate(),
      m.charging_economy_series_actual(),
      m.charging_economy_series_optimal(),
      m.charging_economy_series_not_comparable(),
    ]),
  )
})

test('a month tooltip lists its three kronor rows in series order', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <EconomyMonthlyChart months={months} />
    </div>,
  )
  await hoverBar(screen.container, 1) // September's "actual" bar
  await vi.waitFor(() => expect(tooltipText()).toContain(formatSek(70)))
  const text = tooltipText()
  expect(text).toContain(monthLabel(9))
  const at = (label: string, sek: number) => text.indexOf(`${label}${formatSek(sek)}`)
  expect(at(m.charging_economy_series_immediate(), 120)).toBeGreaterThanOrEqual(0)
  expect(at(m.charging_economy_series_immediate(), 120)).toBeLessThan(
    at(m.charging_economy_series_actual(), 90),
  )
  expect(at(m.charging_economy_series_actual(), 90)).toBeLessThan(
    at(m.charging_economy_series_optimal(), 70),
  )
})

test('the keyboard reaches the chart and the arrows walk its tooltip', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <button type="button">before</button>
      <EconomyMonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => expect(focusTarget(screen.container)).not.toBeNull())
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  expect(document.activeElement).toBe(focusTarget(screen.container))
  // Walk right across the eight months without comparable sessions (they show
  // no kronor rows) until September's rows appear. The walk must not restart
  // at January on an empty month.
  await vi.waitFor(
    async () => {
      if (!tooltipText().includes(formatSek(120))) await userEvent.keyboard('{ArrowRight}')
      expect(tooltipText()).toContain(formatSek(120))
    },
    { timeout: 5000, interval: 100 },
  )
  expect(tooltipText()).toContain(monthLabel(9))
})
```

Only → is used: recharts has no Home/End, and it shows January on focus where the visx group waits for the first
→. Both reach September within twelve presses.

`SpotComparisonChart.browser.test.tsx` (its `month`/`months` fixtures; add `formatOrePrecise`, `monthLabel` from
`./format`):

```tsx
test('the legend lists the paid price, then the month average', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart months={months} />
    </div>,
  )
  await vi.waitFor(() =>
    expect(legendLabels(screen.container)).toEqual([
      m.charging_economy_series_paid(),
      m.charging_economy_series_avg(),
    ]),
  )
})

test('a month tooltip shows what we paid, then the average, in öre', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart months={months} />
    </div>,
  )
  await hoverBar(screen.container, 0) // September: paid 80, average 95
  await vi.waitFor(() => expect(tooltipText()).toContain(monthLabel(9)))
  const text = tooltipText()
  const paid = text.indexOf(m.charging_economy_ore({ value: formatOrePrecise(80) }))
  const avg = text.indexOf(m.charging_economy_ore({ value: formatOrePrecise(95) }))
  expect(paid).toBeGreaterThanOrEqual(0)
  expect(paid).toBeLessThan(avg)
})

test('the average line breaks across a month without a paid price', async () => {
  const priced = (mo: number) =>
    month(mo, { sessions: 1, included: 1, paidSpotOre: 50, avgSpotOre: 90 })
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <SpotComparisonChart
        months={Array.from({ length: 12 }, (_, i) =>
          i === 7 ? priced(8) : i === 9 ? priced(10) : month(i + 1, { avgSpotOre: 90 }),
        )}
      />
    </div>,
  )
  await vi.waitFor(() => expect(lineDots(screen.container)).toHaveLength(2))
  // Two separate one-point segments: no line drawn through September.
  const d = lineCurve(screen.container)?.getAttribute('d') ?? ''
  expect(d.match(/M/g)?.length ?? 0).not.toBe(1)
  expect(d).not.toMatch(/L/)
})
```

`HourOfDayChart.browser.test.tsx` (add `hoverBar`, `tooltipText`, `xTickLabels`; `hourRangeLabel` from
`./format`, `valueLabel` from `./patternChart`):

```tsx
test('a wide chart labels every third hour', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 220 }}>
      <HourOfDayChart hours={hours} metric="kwh" />
    </div>,
  )
  await vi.waitFor(() =>
    expect(xTickLabels(screen.container)).toEqual(['00', '03', '06', '09', '12', '15', '18', '21']),
  )
})

test('hovering an hour shows its range and value', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 220 }}>
      <HourOfDayChart hours={hours} metric="kwh" />
    </div>,
  )
  await hoverBar(screen.container, 4) // hour 5 (hour 0 draws no bar): 10 kWh
  await vi.waitFor(() =>
    expect(tooltipText()).toContain(`${hourRangeLabel(5)} · ${valueLabel(10, 'kwh')}`),
  )
})
```

The line-break test checks what recharts draws for two isolated points with `connectNulls={false}`: no `L`
segment at all. If recharts draws its single points differently (an `M` per point, or nothing for a lone point),
pin what it does and keep the "no line through September" meaning.

- [ ] **Step 2: Run them on recharts**

Run: `bunx vitest run --project browser src/components/evCharging/{HourOfDay,Monthly,EconomyMonthly,SpotComparison}Chart.browser.test.tsx`
Expected: PASS. Any failure means the test misdescribes recharts: fix the test (not the chart), and note it in the
commit body.

- [ ] **Step 3: Commit**

```bash
git add src/components/evCharging/HourOfDayChart.browser.test.tsx src/components/evCharging/MonthlyChart.browser.test.tsx src/components/evCharging/EconomyMonthlyChart.browser.test.tsx src/components/evCharging/SpotComparisonChart.browser.test.tsx
git commit -m "test(charts): pin legend order, tooltips, ticks and keys"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines`, told "assume these tests would still pass
if the visx swap broke the behaviour they claim to pin; find the weakest one".

---

### Task 4: Pure bar geometry (`barLayout.ts`)

**Files:**
- Modify: `package.json`, `bun.lock` (`bun add d3-shape@3.2.0 @visx/grid@4.0.0 @visx/text@4.0.0` and
  `bun add -d @types/d3-shape@3.1.7`)
- Create: `src/components/chart/barLayout.ts`, `src/components/chart/barLayout.test.ts`

**Interfaces:**
- Produces:

```ts
export const MIN_BAR_PX = 4
export type BarSeries = {
  key: string
  label: string
  color: string
  stack?: string
  radius?: number
  roundEndOnly?: boolean
  zeroIsData?: boolean
  stroke?: string
  strokeWidth?: number
}
export type BarRect = { key: string; index: number; x: number; y: number; width: number; height: number; value: number }
export function slotsOf(series: readonly BarSeries[]): string[][]
export function layoutBars(args: {
  count: number
  series: readonly BarSeries[]
  value: (index: number, key: string) => number | null
  x: ScaleBand<number>
  y: ScaleLinear<number, number>
  barGap: number
}): BarRect[]
export function yScaleFor(args: {
  extent: readonly [number, number]
  height: number
  integers?: boolean
  domain?: readonly [number, number]
}): { scale: ScaleLinear<number, number>; ticks: number[] }
export function stackExtent(args: {
  count: number
  series: readonly BarSeries[]
  value: (index: number, key: string) => number | null
}): [number, number]
export function thinTicks(centres: readonly number[], widths: readonly number[], gap?: number): number[]
```

- [ ] **Step 1: Add the dependencies**

Run: `bun add d3-shape@3.2.0 @visx/grid@4.0.0 @visx/text@4.0.0 && bun add -d @types/d3-shape@3.1.7`
Expected: `package.json` gains them with exact versions. If bun writes a caret, edit it to the exact version.

- [ ] **Step 2: Write the failing tests**

```ts
// src/components/chart/barLayout.test.ts
import { range } from 'd3-array'
import { scaleBand } from 'd3-scale'
import { describe, expect, test } from 'vitest'
import { type BarSeries, layoutBars, MIN_BAR_PX, slotsOf, stackExtent, thinTicks, yScaleFor } from './barLayout'

const s = (key: string, over: Partial<BarSeries> = {}): BarSeries => ({ key, label: key, color: 'red', ...over })
const band = (n: number, width: number) => scaleBand<number>().domain(range(n)).range([0, width])

describe('slotsOf', () => {
  test('series side by side unless they share a stack, in first-seen order', () => {
    // Economy: immediate | actual + stub | optimal.
    const series = [s('immediate'), s('actual', { stack: 'mid' }), s('optimal'), s('stub', { stack: 'mid' })]
    expect(slotsOf(series)).toEqual([['immediate'], ['actual', 'stub'], ['optimal']])
  })
})

describe('layoutBars', () => {
  const y = yScaleFor({ extent: [0, 100], height: 100 }).scale

  test('one bar per non-null value, series by series, month by month', () => {
    const rects = layoutBars({
      count: 3,
      series: [s('a'), s('b')],
      value: (i, k) => (k === 'a' ? [10, null, 30][i] : [5, 5, 5][i]),
      x: band(3, 300),
      y,
      barGap: 4,
    })
    expect(rects.map((r) => `${r.key}${r.index}`)).toEqual(['a0', 'a2', 'b0', 'b1', 'b2'])
  })

  test('a band keeps 10 % each side, slots split the rest with the bar gap', () => {
    const [a, b] = layoutBars({
      count: 1,
      series: [s('a'), s('b')],
      value: () => 50,
      x: band(1, 100),
      y,
      barGap: 4,
    })
    expect(a.x).toBeCloseTo(10)
    expect(a.width).toBeCloseTo(38) // (100 − 2·10 − 4) / 2
    expect(b.x).toBeCloseTo(52)
  })

  test('stacked series sit on each other in series order', () => {
    const [spot, fees] = layoutBars({
      count: 1,
      series: [s('spot', { stack: 'sek' }), s('fees', { stack: 'sek' })],
      value: (_, k) => (k === 'spot' ? 20 : 30),
      x: band(1, 100),
      y,
      barGap: 4,
    })
    expect(spot.y + spot.height).toBeCloseTo(y(0))
    expect(spot.y).toBeCloseTo(y(20))
    expect(fees.y + fees.height).toBeCloseTo(y(20))
    expect(fees.y).toBeCloseTo(y(50))
    expect(spot.width).toBeCloseTo(fees.width)
  })

  test('a tiny real value gets the floor; a genuine 0 draws nothing unless it is data', () => {
    const rects = layoutBars({
      count: 3,
      series: [s('a'), s('z', { zeroIsData: true })],
      value: (i, k) => (k === 'a' ? [0.01, 0, null][i] : [0, 0, null][i]),
      x: band(3, 300),
      y,
      barGap: 4,
    })
    expect(rects.map((r) => `${r.key}${r.index}`)).toEqual(['a0', 'z0', 'z1'])
    for (const r of rects) {
      expect(r.height).toBe(MIN_BAR_PX)
      expect(r.y + r.height).toBeCloseTo(y(0)) // grows up from the baseline
    }
  })

  test('a negative value draws below the baseline and its floor grows downward', () => {
    const yn = yScaleFor({ extent: [-10, 100], height: 110 }).scale
    const [neg, tiny] = layoutBars({
      count: 2,
      series: [s('a')],
      value: (i) => [-10, -0.001][i],
      x: band(2, 200),
      y: yn,
      barGap: 4,
    })
    expect(neg.y).toBeCloseTo(yn(0))
    expect(neg.y + neg.height).toBeCloseTo(yn(-10))
    expect(tiny.y).toBeCloseTo(yn(0))
    expect(tiny.height).toBe(MIN_BAR_PX)
  })
})

describe('stackExtent', () => {
  test('covers 0 and every stack top, positive and negative', () => {
    expect(
      stackExtent({
        count: 2,
        series: [s('spot', { stack: 'sek' }), s('fees', { stack: 'sek' }), s('other')],
        value: (i, k) => ({ spot: [-5, 10], fees: [3, 20], other: [1, 2] })[k]?.[i] ?? null,
      }),
    ).toEqual([-5, 30])
  })
})

describe('yScaleFor', () => {
  test('includes 0 and makes the domain nice', () => {
    const { scale, ticks } = yScaleFor({ extent: [3, 87], height: 200 })
    expect(scale.domain()).toEqual([0, 100])
    expect(ticks[0]).toBe(0)
    expect(ticks.at(-1)).toBe(100)
  })

  test('integer axes step by at least 1', () => {
    const { ticks } = yScaleFor({ extent: [0, 0.01], height: 200, integers: true })
    expect(ticks.every(Number.isInteger)).toBe(true)
    expect(ticks.length).toBeGreaterThan(1)
  })

  test('a pinned domain wins', () => {
    expect(yScaleFor({ extent: [0, 1], height: 100, domain: [0, 33] }).scale.domain()).toEqual([0, 33])
  })

  test('y runs top-down: the top of the domain is 0 px', () => {
    const { scale } = yScaleFor({ extent: [0, 100], height: 200 })
    expect(scale(100)).toBe(0)
    expect(scale(0)).toBe(200)
  })
})

describe('thinTicks', () => {
  test('keeps every label that fits', () => {
    expect(thinTicks([10, 30, 50], [10, 10, 10])).toEqual([0, 1, 2])
  })

  test('drops colliding labels but keeps the first and the last', () => {
    const centres = range(12).map((i) => 12 + i * 24)
    const kept = thinTicks(centres, centres.map(() => 26))
    expect(kept[0]).toBe(0)
    expect(kept.at(-1)).toBe(11)
    expect(kept.length).toBeLessThan(12)
    for (let k = 1; k < kept.length; k++) {
      const a = kept[k - 1]
      const b = kept[k]
      expect(centres[b] - 13 - (centres[a] + 13)).toBeGreaterThanOrEqual(5)
    }
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bunx vitest run --project node src/components/chart/barLayout.test.ts`
Expected: FAIL, "Failed to load url ./barLayout".

- [ ] **Step 4: Implement**

```ts
// src/components/chart/barLayout.ts
import { range, tickStep } from 'd3-array'
import { type ScaleBand, type ScaleLinear, scaleLinear } from 'd3-scale'
import { stack, stackOffsetNone } from 'd3-shape'

// Pure geometry for the bar-chart module (BarChart.tsx). It reproduces what
// recharts 3 did for our charts, so the move to visx keeps the bars where
// they were: 10 % of each band either side, slots split by the bar gap,
// stacked series on top of each other in series order, and a 4 px floor.

/** A real but tiny value still draws this tall, so it doesn't read as "nothing". */
export const MIN_BAR_PX = 4
/** recharts' barCategoryGap: 10 % of a band on each side. */
const CATEGORY_GAP = 0.1

export type BarSeries = {
  key: string
  label: string
  color: string
  /** Series with the same stack id draw as one bar, stacked in series order; others sit side by side. */
  stack?: string
  radius?: number
  /** Round only the end away from the axis (a stack's top). Default: every corner. */
  roundEndOnly?: boolean
  /** A real 0 is data and gets the floor (a 0 kr counterfactual). Default: 0 draws nothing. */
  zeroIsData?: boolean
  /** A hairline round each bar, e.g. the seam between stacked segments. */
  stroke?: string
  strokeWidth?: number
}

export type BarRect = {
  key: string
  index: number
  x: number
  y: number
  width: number
  height: number
  value: number
}

type Value = (index: number, key: string) => number | null

/** The band's slots: one per stack id or unstacked series, in first-seen order. */
export function slotsOf(series: readonly BarSeries[]): string[][] {
  const slots = new Map<string, string[]>()
  for (const s of series) {
    const id = s.stack === undefined ? `series:${s.key}` : `stack:${s.stack}`
    slots.set(id, [...(slots.get(id) ?? []), s.key])
  }
  return [...slots.values()]
}

// [y0, y1] per series key and index; a null value stacks as 0 (it draws nothing).
function stacked(count: number, keys: string[], value: Value) {
  const layers = stack<number, string>()
    .keys(keys)
    .value((i, key) => value(i, key) ?? 0)
    .offset(stackOffsetNone)(range(count))
  return new Map(layers.map((layer) => [layer.key, layer.map(([y0, y1]) => [y0, y1] as const)]))
}

export function layoutBars({
  count,
  series,
  value,
  x,
  y,
  barGap,
}: {
  count: number
  series: readonly BarSeries[]
  value: Value
  x: ScaleBand<number>
  y: ScaleLinear<number, number>
  barGap: number
}): BarRect[] {
  const slots = slotsOf(series)
  const band = x.bandwidth()
  const offset = band * CATEGORY_GAP
  const width = Math.max(0, (band - 2 * offset - (slots.length - 1) * barGap) / slots.length)
  const segments = new Map<string, { slot: number; ys: (readonly [number, number])[] }>()
  slots.forEach((keys, slot) => {
    const ys = stacked(count, keys, value)
    for (const key of keys) segments.set(key, { slot, ys: ys.get(key) ?? [] })
  })
  const rects: BarRect[] = []
  for (const s of series) {
    const seg = segments.get(s.key)
    if (!seg) continue
    for (let i = 0; i < count; i++) {
      const v = value(i, s.key)
      if (v === null || (v === 0 && !s.zeroIsData)) continue
      const [y0, y1] = seg.ys[i]
      const base = y(y0)
      const end = y(y1)
      const height = Math.max(Math.abs(base - end), MIN_BAR_PX)
      // A positive (or zero) value grows up from its base; a negative one down.
      const top = v >= 0 ? base - height : base
      rects.push({
        key: s.key,
        index: i,
        x: (x(i) ?? 0) + offset + seg.slot * (width + barGap),
        y: top,
        width,
        height,
        value: v,
      })
    }
  }
  return rects
}

/** The value range the bars cover: every stack's lowest and highest point, and 0. */
export function stackExtent({
  count,
  series,
  value,
}: {
  count: number
  series: readonly BarSeries[]
  value: Value
}): [number, number] {
  let lo = 0
  let hi = 0
  for (const keys of slotsOf(series)) {
    for (const ys of stacked(count, keys, value).values()) {
      for (const [y0, y1] of ys) {
        lo = Math.min(lo, y0, y1)
        hi = Math.max(hi, y0, y1)
      }
    }
  }
  return [lo, hi]
}

const TICK_COUNT = 5

/** A top-down linear y scale over `extent` (0 included), made nice, and its ticks. */
export function yScaleFor({
  extent,
  height,
  integers = false,
  domain,
}: {
  extent: readonly [number, number]
  height: number
  integers?: boolean
  domain?: readonly [number, number]
}): { scale: ScaleLinear<number, number>; ticks: number[] } {
  const lo = Math.min(0, extent[0])
  const hi = Math.max(0, extent[1])
  if (domain) {
    const scale = scaleLinear().domain([domain[0], domain[1]]).range([height, 0])
    return { scale, ticks: scale.ticks(TICK_COUNT) }
  }
  if (integers) {
    // recharts' allowDecimals={false}: whole steps, at least 1.
    const step = Math.max(1, tickStep(lo, hi === lo ? lo + 1 : hi, TICK_COUNT - 1))
    const d0 = Math.floor(lo / step) * step
    const d1 = Math.max(Math.ceil(hi / step) * step, d0 + step)
    const scale = scaleLinear().domain([d0, d1]).range([height, 0])
    return { scale, ticks: range(d0, d1 + step / 2, step) }
  }
  const scale = scaleLinear()
    .domain([lo, hi === lo ? lo + 1 : hi])
    .range([height, 0])
    .nice(TICK_COUNT)
  return { scale, ticks: scale.ticks(TICK_COUNT) }
}

/**
 * The tick indexes to label so no two labels come closer than `gap` px
 * (recharts' interval="preserveStartEnd"): the first and the last always,
 * the ones between greedily from the start.
 */
export function thinTicks(centres: readonly number[], widths: readonly number[], gap = 5): number[] {
  const n = centres.length
  if (n <= 2) return range(n)
  const left = (i: number) => centres[i] - widths[i] / 2
  const right = (i: number) => centres[i] + widths[i] / 2
  const kept = [0]
  for (let i = 1; i < n - 1; i++) {
    if (left(i) >= right(kept[kept.length - 1]) + gap && right(i) + gap <= left(n - 1)) kept.push(i)
  }
  kept.push(n - 1)
  return kept
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run --project node src/components/chart/barLayout.test.ts`
Expected: PASS. If a hand-computed expectation is off by recharts-vs-plan rounding, re-derive it from the code's
formula above and fix the expectation, not the formula.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/components/chart/barLayout.ts src/components/chart/barLayout.test.ts
git commit -m "refactor(charts): add pure bar geometry for the visx charts"
```

Reviewers: `code-reviewer` + `test-completeness`-style reviewer (general agent) told "assume the geometry differs
from recharts 3.8.0 for some input our four charts produce; read `node_modules/recharts/es6/util/ChartUtils.js`
(`getBarSizeList`, `getBarPosition`) and the `minPointSize` handling in `cartesian/Bar.js`, and find it".

---

### Task 5: The card tooltip and the `BarChart` module

**Files:**
- Modify: `src/components/evCharging/ChartPopover.tsx` (add `variant`)
- Create: `src/components/chart/ChartParts.tsx` (moved `CHART_HEIGHT`, `NoData`, `TooltipRow` from
  `ChartFrame.tsx`, plus the new `ChartLegend`)
- Modify: `src/components/evCharging/ChartFrame.tsx` (re-export the moved parts so recharts callers keep compiling)
- Create: `src/components/chart/BarChart.tsx`, `src/components/chart/BarChart.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json` (add `chart_keyboard_hint`)

**Interfaces:**
- Consumes: `barLayout.ts` (Task 4); `useChartPopover`, `ChartPopover` (existing).
- Produces:

```ts
// ChartParts.tsx (no recharts import, ever)
export const CHART_HEIGHT = 260
export function NoData(): JSX.Element
export function TooltipRow(props: { label: string; color?: string; strong?: boolean; share?: string; children?: React.ReactNode }): JSX.Element
export function ChartLegend(props: { items: readonly { key: string; label: string; color: string }[] }): JSX.Element

// BarChart.tsx
export type { BarSeries } from './barLayout'
export type LineSeries = { key: string; label: string; color: string; dash?: string }
export type BarChartProps<Row> = {
  rows: readonly Row[]
  category: (row: Row) => string
  series: readonly BarSeries[]
  value: (row: Row, key: string) => number | null
  line?: LineSeries
  yTickFormat: (v: number) => string
  yIntegers?: boolean
  yDomain?: readonly [number, number]
  hideYAxis?: boolean
  yAxisLine?: boolean
  xTickEvery?: number
  barGap?: number
  height?: number
  legend?: boolean
  tooltip: (row: Row, index: number) => React.ReactNode
  tooltipTitle?: boolean
  label?: string
}
export function BarChart<Row>(props: BarChartProps<Row>): JSX.Element

// ChartPopover.tsx
export function ChartPopover(props: { state: …; dataKey?: string; variant?: 'pill' | 'card'; children: React.ReactNode }): JSX.Element | null
```

- [ ] **Step 1: Move the recharts-free parts out of `ChartFrame.tsx`**

Create `src/components/chart/ChartParts.tsx` with `CHART_HEIGHT`, `NoData` and `TooltipRow` moved verbatim from
`src/components/evCharging/ChartFrame.tsx` (with their comments), plus:

```tsx
/** The series key under the plot, inside the chart's height (touch can't hover). */
export function ChartLegend({ items }: { items: readonly { key: string; label: string; color: string }[] }) {
  return (
    <div
      data-slot="chart-legend"
      className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3"
    >
      {items.map((item) => (
        <div key={item.key} data-legend-item={item.key} className="flex items-center gap-1.5">
          <div className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
          {item.label}
        </div>
      ))}
    </div>
  )
}
```

In `ChartFrame.tsx`, delete the moved code and add
`export { CHART_HEIGHT, NoData, TooltipRow } from '~/components/chart/ChartParts'` plus
`import { CHART_HEIGHT } from '~/components/chart/ChartParts'` for `ChartFrame`'s own height, so EnergyMonthlyChart
(still recharts until 5b) compiles unchanged. Run `bun run typecheck`; expected: no errors.

- [ ] **Step 2: Write the failing tests**

```tsx
// src/components/chart/BarChart.browser.test.tsx
import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { m } from '~/paraglide/messages'
import {
  bars,
  focusTarget,
  hoverBar,
  hoverBetween,
  legendLabels,
  pointAt,
  seriesBars,
  tooltipText,
  xTickLabels,
} from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { BarChart, type BarChartProps } from './BarChart'

type Row = { label: string; a: number | null; b: number | null }
const rows: Row[] = [
  { label: 'jan', a: 10, b: 5 },
  { label: 'feb', a: null, b: null },
  { label: 'mar', a: 0, b: 0 },
  { label: 'apr', a: 30, b: 10 },
]
const base: BarChartProps<Row> = {
  rows,
  category: (r) => r.label,
  series: [
    { key: 'a', label: 'Serie A', color: 'red' },
    { key: 'b', label: 'Serie B', color: 'blue' },
  ],
  value: (r, k) => r[k as 'a' | 'b'],
  yTickFormat: String,
  tooltip: (r) =>
    r.a === null ? null : (
      <span>
        A {r.a} B {r.b}
      </span>
    ),
  legend: true,
  label: 'Testdiagram',
}
const render = (over: Partial<BarChartProps<Row>> = {}, width = 480) =>
  renderWithProviders(
    <div style={{ width }}>
      <button type="button">before</button>
      <BarChart {...base} {...over} />
    </div>,
  )

test('draws one bar per drawn value, series by series, with data hooks', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(4)) // jan, apr × 2; feb null, mar 0
  expect(seriesBars(screen.container, 0).map((b) => b.getAttribute('data-index'))).toEqual(['0', '3'])
  expect(screen.container.querySelector('[data-series="a"][data-kind="bar"]')).not.toBeNull()
})

test('the legend lists the series in order', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(legendLabels(screen.container)).toEqual(['Serie A', 'Serie B']))
})

test('hovering anywhere in a month opens its card with the month label on top', async () => {
  const { screen } = await render()
  await hoverBar(screen.container, 1) // apr's a
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  const card = document.querySelector('[data-slot="chart-tooltip"]')
  expect(card?.className).toContain('bg-background')
})

// The centre of the `i`th of the 4 bands, in client coordinates.
const bandCentre = (container: Element, i: number) => {
  const o = (container.querySelector('[data-hover-overlay]') as SVGRectElement).getBoundingClientRect()
  return { x: o.x + (o.width * (i + 0.5)) / 4, y: o.y + o.height / 2 }
}

test('a month whose bars draw nothing still answers a hover; a null tooltip opens nothing', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  const mar = bandCentre(screen.container, 2) // 0 and 0: no rect, but a tooltip
  pointAt(mar.x, mar.y)
  await vi.waitFor(() => expect(tooltipText()).toBe('marA 0 B 0'))
  const feb = bandCentre(screen.container, 1) // its tooltip render is null: no card at all
  pointAt(feb.x, feb.y)
  await vi.waitFor(() => expect(document.querySelector('[data-slot="chart-tooltip"]')).toBeNull())
})

test('the band halfway between two bars answers too (hoverBetween)', async () => {
  const { screen } = await render({ rows: [rows[0], rows[2], rows[3]] }) // jan, mar, apr
  await hoverBetween(screen.container, 0, 1) // jan's a and apr's a: mar's band
  await vi.waitFor(() => expect(tooltipText()).toBe('marA 0 B 0'))
})

test('leaving the chart with a mouse closes the card', async () => {
  const { screen } = await render()
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  // React's onPointerLeave listens to pointerout with a relatedTarget outside.
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  overlay.dispatchEvent(
    new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }),
  )
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

test('a labelled chart is one named Tab stop; arrows, Home and End walk the months', async () => {
  const { screen } = await render()
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  const group = screen.getByRole('group', { name: 'Testdiagram' })
  await expect.element(group).toHaveFocus()
  expect(group.element().getAttribute('aria-describedby')).toBeTruthy()
  await expect.element(screen.getByText(m.chart_keyboard_hint())).toBeInTheDocument()
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(tooltipText()).toBe('janA 10 B 5'))
  await userEvent.keyboard('{End}')
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  // A keyboard step is announced once, politely, with its month.
  const live = screen.container.querySelector('[data-chart-announce]')
  expect(live?.getAttribute('aria-live')).toBe('polite')
  expect(live?.textContent).toBe('aprA 30 B 10')
  await userEvent.keyboard('{Home}')
  await vi.waitFor(() => expect(tooltipText()).toBe('janA 10 B 5'))
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
  expect(live?.textContent).toBe('')
})

test('the keyboard walk steps over a month without a tooltip instead of restarting', async () => {
  const { screen } = await render()
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}') // jan
  await vi.waitFor(() => expect(tooltipText()).toBe('janA 10 B 5'))
  await userEvent.keyboard('{ArrowRight}') // feb: null tooltip, nothing shown
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
  await userEvent.keyboard('{ArrowRight}') // mar, not jan again
  await vi.waitFor(() => expect(tooltipText()).toBe('marA 0 B 0'))
})

test('a pointer move after a keyboard step clears the announcement', async () => {
  const { screen } = await render()
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}')
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  await hoverBar(screen.container, 1)
  await vi.waitFor(() => expect(tooltipText()).toBe('aprA 30 B 10'))
  expect(screen.container.querySelector('[data-chart-announce]')?.textContent).toBe('')
})

test('an unlabelled chart is hidden from assistive tech and not a Tab stop', async () => {
  const { screen } = await render({ label: undefined })
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  expect(focusTarget(screen.container)).toBeNull()
  expect(screen.container.querySelector('[data-chart="bar"]')?.getAttribute('aria-hidden')).toBe('true')
})

test('xTickEvery labels every nth category', async () => {
  const { screen } = await render({ xTickEvery: 2 })
  await vi.waitFor(() => expect(xTickLabels(screen.container)).toEqual(['jan', 'mar']))
})

test('a line series draws a dashed path through its non-null points, with solid dots', async () => {
  const { screen } = await render({
    series: [{ key: 'a', label: 'Serie A', color: 'red' }],
    line: { key: 'b', label: 'Serie B', color: 'blue', dash: '5 4' },
  })
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('[data-line-dot]')).toHaveLength(3), // jan, mar, apr
  )
  const curve = screen.container.querySelector('[data-line-curve]')
  expect(curve?.getAttribute('stroke-dasharray')).toBe('5 4')
  expect(curve?.getAttribute('d')?.match(/M/g)).toHaveLength(2) // broken at feb (null)
  for (const dot of screen.container.querySelectorAll('[data-line-dot]')) {
    expect(dot.getAttribute('stroke-dasharray')).toBeNull()
    expect(dot.getAttribute('fill')).toBe('#fff')
  }
  expect(legendLabels(screen.container)).toEqual(['Serie A', 'Serie B'])
})

test('hideYAxis drops the y axis and the grid', async () => {
  const { screen } = await render({ hideYAxis: true })
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  expect(screen.container.querySelector('[data-axis="y"]')).toBeNull()
  expect(screen.container.querySelector('[data-grid]')).toBeNull()
})

test('the card stays inside the window at the edges', async () => {
  const { screen } = await render({}, 320)
  await hoverBar(screen.container, 0) // the first month, at the left edge
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const card = document.querySelector('[data-slot="chart-tooltip"]') as HTMLElement
  await vi.waitFor(() => {
    const r = card.getBoundingClientRect()
    expect(r.left).toBeGreaterThanOrEqual(8)
    expect(r.right).toBeLessThanOrEqual(window.innerWidth - 8)
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bunx vitest run --project browser src/components/chart/BarChart.browser.test.tsx`
Expected: FAIL, "Failed to load url ./BarChart".

- [ ] **Step 4: Add the card variant to `ChartPopover`**

In `src/components/evCharging/ChartPopover.tsx`:

```tsx
// Gap between the card and the point it describes.
const CARD_GAP = 8

// A card is centred over its point, its bottom CARD_GAP above it; with no room
// above, it drops below the point. Then it's nudged inside the window.
function placeCard(el: HTMLDivElement | null) {
  if (!el) return
  el.style.transform = ''
  const r = el.getBoundingClientRect() // top-left corner on the point
  let dx = -r.width / 2
  let dy = -r.height - CARD_GAP
  if (r.top + dy < EDGE) dy = CARD_GAP
  dx += Math.max(EDGE - (r.left + dx), 0) + Math.min(window.innerWidth - EDGE - (r.right + dx), 0)
  dy += Math.max(EDGE - (r.top + dy), 0) + Math.min(window.innerHeight - EDGE - (r.bottom + dy), 0)
  el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`
}
```

Add `variant = 'pill'` to `ChartPopover`'s props (`variant?: 'pill' | 'card'`). With `'card'`: the clamp ref calls
`placeCard`, `offsetLeft` and `offsetTop` are 0, and the `Tooltip` gets
`data-slot="chart-tooltip"` and
`className="pointer-events-none z-50 grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-foreground text-xs shadow-xl"`.
`'pill'` keeps today's code path byte for byte (heatmap, calendar, session chart). Add `variant` to the
`useCallback` dependency list.

- [ ] **Step 5: Add the message**

`messages/sv.json`: `"chart_keyboard_hint": "Använd piltangenterna för att stega mellan staplarna"`;
`messages/en.json`: `"chart_keyboard_hint": "Use the arrow keys to step through the bars"`. Run
`bun run i18n:compile`.

- [ ] **Step 6: Implement `BarChart`**

```tsx
// src/components/chart/BarChart.tsx
import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { Bar, BarRounded, LinePath } from '@visx/shape'
import { getStringWidth } from '@visx/text'
import { max, range } from 'd3-array'
import { scaleBand } from 'd3-scale'
import type * as React from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { type BarSeries, layoutBars, stackExtent, thinTicks, yScaleFor } from './barLayout'
import { CHART_HEIGHT, ChartLegend } from './ChartParts'

export type { BarSeries } from './barLayout'
export type LineSeries = { key: string; label: string; color: string; dash?: string }

export type BarChartProps<Row> = {
  rows: readonly Row[]
  /** The category's x label (also the tooltip's title). */
  category: (row: Row) => string
  /** Bars in stack, legend and tooltip order (bottom to top within a stack). */
  series: readonly BarSeries[]
  /** A series' value for a row; null draws nothing. */
  value: (row: Row, key: string) => number | null
  /** One line over the bars (Spot's month average), through its non-null points. */
  line?: LineSeries
  yTickFormat: (v: number) => string
  /** Whole-number ticks (recharts' allowDecimals={false}). */
  yIntegers?: boolean
  yDomain?: readonly [number, number]
  /** No y axis and no grid (a year with no kronor to scale against). */
  hideYAxis?: boolean
  /** Draw the y axis line (default true; Economy and Spot hide it). */
  yAxisLine?: boolean
  /** Label every nth category; default: as many as fit, the first and last always. */
  xTickEvery?: number
  barGap?: number
  height?: number
  legend?: boolean
  /** A row's tooltip content; null shows no tooltip for that row. */
  tooltip: (row: Row, index: number) => React.ReactNode
  /** The category label on top of the card (default true). */
  tooltipTitle?: boolean
  /** Accessible name. With it the chart is a keyboard stop; without, it is aria-hidden (bring an sr-only table). */
  label?: string
}

const MARGIN = { top: 8, right: 12, bottom: 0, left: 4 }
const X_AXIS_H = 30
const X_TICK_MARGIN = 8
const Y_TICK_MARGIN = 4
const TICK_PX = 12
// recharts' default axis colour; our ChartContainer never restyled it.
const AXIS = '#666'
const TICK_LABEL = { fill: 'var(--muted-foreground)', fontSize: TICK_PX }
const measure = (s: string) => getStringWidth(s, { fontSize: TICK_PX }) ?? s.length * 7

// One bar chart for the category charts (months, hours): visx shapes on d3
// scales, the geometry in barLayout.ts. The SVG is visual; a labelled chart is
// one Tab stop whose arrows walk the categories, showing each tooltip and
// announcing it once (the SessionPriceChart idiom). The tooltip is a card in a
// portal above the hovered category (ChartPopover), so no ancestor clips it.
export function BarChart<Row>({
  rows,
  category,
  series,
  value,
  line,
  yTickFormat,
  yIntegers = false,
  yDomain,
  hideYAxis = false,
  yAxisLine = true,
  xTickEvery,
  barGap = 4,
  height = CHART_HEIGHT,
  legend = false,
  tooltip,
  tooltipTitle = true,
  label,
}: BarChartProps<Row>) {
  const { parentRef, width, height: plotBoxH } = useParentSize({ debounceTime: 100 })
  const popover = useChartPopover<number>()
  const hintId = useId()
  const [announced, setAnnounced] = useState<number | null>(null)
  // The category the pointer or the keys last moved to (null: none). Kept apart
  // from the popover, which stays closed on a category without a tooltip: the
  // keyboard walk must step over it, not restart at the first category.
  const cursor = useRef<number | null>(null)
  const at = (i: number, key: string) => value(rows[i], key)
  const count = rows.length

  const geometry = useMemo(() => {
    if (width <= 0 || plotBoxH <= 0) return null
    const keys = line ? [...series, { key: line.key, label: '', color: '' }] : series
    const extent = stackExtent({ count, series: keys, value: at })
    const plotH = Math.max(0, plotBoxH - MARGIN.top - MARGIN.bottom - X_AXIS_H)
    const y = yScaleFor({ extent, height: plotH, integers: yIntegers, domain: yDomain })
    const yLabels = y.ticks.map(yTickFormat)
    const yAxisW = hideYAxis ? 0 : (max(yLabels, measure) ?? 0) + Y_TICK_MARGIN + 2
    const left = MARGIN.left + yAxisW
    const plotW = Math.max(0, width - left - MARGIN.right)
    const x = scaleBand<number>().domain(range(count)).range([0, plotW])
    const centres = range(count).map((i) => (x(i) ?? 0) + x.bandwidth() / 2)
    const xTicks =
      xTickEvery === undefined
        ? thinTicks(centres, rows.map((r) => measure(category(r))))
        : range(0, count, xTickEvery)
    const rects = layoutBars({ count, series, value: at, x, y: y.scale, barGap })
    return { x, y, left, plotW, plotH, xTicks, rects, centres }
    // biome-ignore lint/correctness/useExhaustiveDependencies: `at` reads rows + value
  }, [width, plotBoxH, rows, series, line, value, yTickFormat, yIntegers, yDomain, hideYAxis, xTickEvery, barGap, category, count])

  // The card's anchor: the category's centre, at the top of its tallest bar.
  const anchor = (i: number) => {
    if (!geometry) return { left: 0, top: 0 }
    const tops = geometry.rects.filter((r) => r.index === i).map((r) => r.y)
    return {
      left: geometry.left + geometry.centres[i],
      top: MARGIN.top + Math.min(geometry.plotH, ...tops),
    }
  }
  const open = (i: number) => {
    cursor.current = i
    if (tooltip(rows[i], i) === null) return popover.hide()
    const { left, top } = anchor(i)
    popover.show(i, left, top)
  }
  const indexAt = (e: React.PointerEvent<SVGRectElement>) => {
    if (!geometry || count === 0) return null
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.floor(((e.clientX - box.left) / box.width) * count)
    return Math.min(Math.max(i, 0), count - 1)
  }
  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    const i = indexAt(e)
    if (i === null) return
    setAnnounced(null)
    open(i)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      cursor.current = null
      popover.hide()
      setAnnounced(null)
      return
    }
    if (count === 0) return
    const last = count - 1
    const current = cursor.current ?? -1
    const next =
      e.key === 'ArrowRight'
        ? current < 0 ? 0 : Math.min(current + 1, last)
        : e.key === 'ArrowLeft'
          ? current < 0 ? last : Math.max(current - 1, 0)
          : e.key === 'Home' ? 0 : e.key === 'End' ? last : null
    if (next === null) return
    e.preventDefault()
    open(next)
    setAnnounced(tooltip(rows[next], next) === null ? null : next)
  }

  const legendItems = [
    ...series.map(({ key, label: l, color }) => ({ key, label: l, color })),
    ...(line ? [{ key: line.key, label: line.label, color: line.color }] : []),
  ]
  const active = popover.open && popover.data !== undefined ? popover.data : null
  const card = (i: number) => (
    <>
      {tooltipTitle ? <div className="font-medium">{category(rows[i])}</div> : null}
      <div className="grid gap-1.5">{tooltip(rows[i], i)}</div>
    </>
  )

  const svg = geometry ? (
    // biome-ignore lint/a11y/noSvgWithoutTitle: visual; the group (or the caller's sr-only table) is the accessible path
    <svg data-chart-svg width={width} height={plotBoxH} aria-hidden className="block overflow-visible">
      <Group left={geometry.left} top={MARGIN.top}>
        {hideYAxis ? null : (
          <g data-grid>
            <GridRows scale={geometry.y.scale} tickValues={geometry.y.ticks} width={geometry.plotW} stroke="var(--border)" strokeOpacity={0.5} />
          </g>
        )}
        {series.map((s) => (
          <g key={s.key} data-series={s.key} data-kind="bar">
            {geometry.rects
              .filter((r) => r.key === s.key)
              .map((r) => {
                const common = {
                  'data-bar': true,
                  'data-index': r.index,
                  x: r.x,
                  y: r.y,
                  width: r.width,
                  height: r.height,
                  fill: s.color,
                  stroke: s.stroke,
                  strokeWidth: s.strokeWidth,
                }
                if (!s.radius) return <Bar key={r.index} {...common} />
                const end = r.value >= 0 ? { top: true } : { bottom: true }
                return (
                  <BarRounded key={r.index} {...common} radius={s.radius} {...(s.roundEndOnly ? end : { all: true })} />
                )
              })}
          </g>
        ))}
        {line ? (
          <g data-series={line.key} data-kind="line">
            <LinePath
              data-line-curve
              data={range(count)}
              defined={(i) => at(i, line.key) !== null}
              x={(i) => geometry.centres[i]}
              y={(i) => geometry.y.scale(at(i, line.key) ?? 0)}
              stroke={line.color}
              strokeWidth={2}
              strokeDasharray={line.dash}
              fill="none"
            />
            {range(count)
              .filter((i) => at(i, line.key) !== null)
              .map((i) => (
                <circle
                  key={i}
                  data-line-dot
                  cx={geometry.centres[i]}
                  cy={geometry.y.scale(at(i, line.key) ?? 0)}
                  r={3}
                  fill="#fff"
                  stroke={line.color}
                  strokeWidth={2}
                />
              ))}
          </g>
        ) : null}
        {hideYAxis ? null : (
          <g data-axis="y">
            <AxisLeft
              scale={geometry.y.scale}
              tickValues={geometry.y.ticks}
              tickFormat={(v) => yTickFormat(Number(v))}
              hideTicks
              hideAxisLine={!yAxisLine}
              stroke={AXIS}
              tickLabelProps={() => ({ ...TICK_LABEL, dx: -Y_TICK_MARGIN, dy: '0.32em', textAnchor: 'end' as const })}
            />
          </g>
        )}
        <g data-axis="x">
          <AxisBottom
            top={geometry.plotH}
            scale={geometry.x}
            tickValues={geometry.xTicks}
            tickFormat={(i) => category(rows[Number(i)])}
            hideTicks
            stroke={AXIS}
            tickLabelProps={() => ({ ...TICK_LABEL, dy: X_TICK_MARGIN, textAnchor: 'middle' as const })}
          />
        </g>
        <rect
          data-hover-overlay
          width={geometry.plotW}
          height={geometry.plotH}
          fill="transparent"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
        />
      </Group>
    </svg>
  ) : null

  const keyboard = label !== undefined
  return (
    <div
      data-chart="bar"
      {...popover.containerProps}
      aria-hidden={keyboard ? undefined : true}
      className="flex w-full flex-col text-xs"
      style={{ height }}
    >
      <div
        ref={parentRef}
        data-chart-focus={keyboard ? true : undefined}
        role={keyboard ? 'group' : undefined}
        aria-label={label}
        aria-describedby={keyboard ? hintId : undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the keyboard path to the chart's tooltip (onKeyDown)
        tabIndex={keyboard ? 0 : undefined}
        onKeyDown={keyboard ? onKeyDown : undefined}
        className={cn('min-h-0 flex-1 rounded-sm', keyboard && 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50')}
      >
        {svg}
      </div>
      {legend ? <ChartLegend items={legendItems} /> : null}
      {keyboard ? (
        <>
          <p id={hintId} className="sr-only">{m.chart_keyboard_hint()}</p>
          <div className="sr-only" aria-live="polite" data-chart-announce>
            {announced === null ? null : card(announced)}
          </div>
        </>
      ) : null}
      <ChartPopover state={popover} variant="card" dataKey={active === null ? undefined : String(active)}>
        {active === null ? null : card(active)}
      </ChartPopover>
    </div>
  )
}
```

Implementation notes (keep them as code comments where they explain a choice):
- `popover.containerProps` carries the ref the popover measures and the mouse `pointerleave` close; spread it on
  the root, as the heatmap does. Its close doesn't reset `cursor`: a pointer that leaves and a key that follows
  continue from the last category, as recharts' keyboard layer did.
- The hover overlay covers the plot only (recharts' tooltip also answered inside the plot area only).
- `@visx/axis` renders labels with `@visx/text` (`<text><tspan>`), and each tick group has class
  `visx-axis-tick`; that is what `xTickLabels`/`yTickLabels` read.
- If `getStringWidth` returns null (no DOM), the `s.length * 7` estimate stands in.
- `useParentSize` measures the flex child, so the legend's height comes out of the plot, as recharts' legend did.

- [ ] **Step 7: Run the tests**

Run: `bunx vitest run --project browser src/components/chart/BarChart.browser.test.tsx && bun run typecheck`
Expected: PASS, no type errors. Then run the heatmap/calendar/session suites to prove `pill` is untouched:
`bunx vitest run --project browser src/components/evCharging/{WeekdayHourHeatmap,ChargingCalendar,SessionPriceChart}.browser.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/chart/ src/components/evCharging/ChartPopover.tsx src/components/evCharging/ChartFrame.tsx messages/sv.json messages/en.json
git commit -m "refactor(charts): add a visx bar-chart module with a card tooltip"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`, told
"assume the keyboard path, the live region or the portal breaks for a real user (touch, screen reader, StrictMode
remount, a scrolled page); prove it doesn't".

---

### Task 6: HourOfDayChart on the module

**Files:**
- Modify: `src/components/evCharging/HourOfDayChart.tsx`

**Interfaces:** Consumes `BarChart` (Task 5). Its own props are unchanged:
`HourOfDayChart({ hours, metric }: { hours: Slot[]; metric: PatternMetric })`.

- [ ] **Step 1: Replace the recharts body**

```tsx
import { useParentSize } from '@visx/responsive'
import { range } from 'd3-array'
import { useMemo } from 'react'
import { BarChart } from '~/components/chart/BarChart'
import type { Slot } from '~/lib/evCharging/patterns'
import { m } from '~/paraglide/messages'
import { formatCount, hourRangeLabel } from './format'
import { type PatternMetric, slotValue, valueLabel } from './patternChart'

const NARROW_PX = 480
type Row = { hour: number; label: string; value: number }
const series = [{ key: 'value', label: '', color: 'var(--brand)', radius: 4 }]

// Charging per hour of day — always 24 bars. A tick every 3 h on desktop and
// every 6 h on a phone (24 two-digit labels don't fit 320 px). The tooltip
// (hover/tap) names the hour; the SVG is visual, so the same numbers are also
// in an sr-only table, like the heatmap, and the chart takes no keyboard stop.
export function HourOfDayChart({ hours, metric }: { hours: Slot[]; metric: PatternMetric }) {
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  // Unmeasured (0) counts as narrow so a phone never flashes the wide ticks.
  const narrow = width < NARROW_PX
  const data = useMemo(
    () =>
      hours.map((slot, hour): Row => ({
        hour,
        label: String(hour).padStart(2, '0'),
        value: slotValue(slot, metric),
      })),
    [hours, metric],
  )
  const table = useMemo(
    () => (
      <table className="sr-only">
        <caption>{m.charging_patterns_hour_caption()}</caption>
        <tbody>
          {range(24).map((h) => (
            <tr key={h}>
              <th scope="row">{hourRangeLabel(h)}</th>
              <td>{valueLabel(data[h]?.value ?? 0, metric)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [data, metric],
  )

  return (
    <div ref={parentRef} className="w-full">
      <BarChart
        rows={data}
        category={(r) => r.label}
        series={series}
        value={(r) => r.value}
        yTickFormat={formatCount}
        yIntegers
        xTickEvery={narrow ? 6 : 3}
        height={220}
        tooltipTitle={false}
        tooltip={(r) => (
          <span className="font-medium font-mono text-foreground tabular-nums">
            {hourRangeLabel(r.hour)} · {valueLabel(r.value, metric)}
          </span>
        )}
      />
      {table}
    </div>
  )
}
```

`series` uses `label: ''` because the chart has no legend. `minBarFor`'s rule (a 0 draws nothing, a tiny real
value gets the floor) is now `zeroIsData` left false.

- [ ] **Step 2: Run its tests**

Run: `bunx vitest run --project browser src/components/evCharging/HourOfDayChart.browser.test.tsx src/routes/_authenticated/charging/`
Expected: PASS, every test from Tasks 2–3 unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/components/evCharging/HourOfDayChart.tsx
git commit -m "refactor(charts): draw the hour-of-day chart with visx"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`, told
"assume the visx chart differs from the recharts one for a viewer; compare `git show HEAD~1:<file>` prop by prop".

---

### Task 7: MonthlyChart on the module

**Files:**
- Modify: `src/components/evCharging/MonthlyChart.tsx`

**Interfaces:** Consumes `BarChart`, `TooltipRow` from `~/components/chart/ChartParts`. Exports unchanged
(`MonthlyChart`, `chartMetricOptions`, `ChartMetric`). Add a `label` per view (the section headings' text).

- [ ] **Step 1: Replace `EnergyChart`, `CostChart` and `CountAxis`**

Keep `chartMetricOptions`, `MonthlyChart`, `SolarTooltipRows` and every comment that explains a product rule.
Replace the two charts:

```tsx
const kwhSeries = [{ key: 'kwh', label: 'kWh', color: 'var(--chart-1)', radius: 4 }]

function EnergyChart({ months }: { months: Month[] }) {
  const data = months.map((mo) => ({ label: monthLabel(mo.month), kwh: mo.kwh }))
  return (
    <BarChart
      rows={data}
      category={(r) => r.label}
      series={kwhSeries}
      value={(r) => r.kwh}
      yTickFormat={formatCount}
      yIntegers
      label={m.charging_chart_title()}
      tooltip={(r) => (
        <span className="font-medium font-mono text-foreground tabular-nums">
          {formatOneDecimal(r.kwh)} kWh
        </span>
      )}
    />
  )
}
```

`CostChart`: keep the empty-year check, `unpriced`, `stub`, the `data` rows (`label`, `spot`, `fees`, `unpriced`,
`totalSek`, `missingShare`, `solar`) and `hasUnpriced` exactly as they are. Then:

```tsx
  // Segments are separated by a hairline in the page colour, so the split
  // doesn't rely on the two hues alone.
  const seam = { stroke: 'var(--background)', strokeWidth: 1 }
  // Stack order bottom → top, which is also the legend's and the tooltip's.
  // The legend lists the rendered series, so "Pris saknas" appears only with a stub.
  const series = [
    { key: 'spot', label: config.spot.label, color: config.spot.color, stack: 'sek', ...seam },
    { key: 'fees', label: config.fees.label, color: config.fees.color, stack: 'sek', radius: 4, roundEndOnly: true, ...seam },
    ...(hasUnpriced
      ? [{ key: 'unpriced', label: config.unpriced.label, color: config.unpriced.color, stack: 'sek', radius: 4, roundEndOnly: true }]
      : []),
  ]
  return (
    <BarChart
      rows={data}
      category={(r) => r.label}
      series={series}
      value={(r, key) => r[key as 'spot' | 'fees' | 'unpriced']}
      yTickFormat={formatCount}
      yIntegers
      legend
      label={m.charging_chart_title_cost()}
      tooltip={(r) => {
        if (r.unpriced !== null) {
          return (
            <div className="flex w-full flex-col gap-0.5">
              <TooltipRow label={config.unpriced.label} color={config.unpriced.color} />
              <SolarTooltipRows view={r.solar} />
            </div>
          )
        }
        if (r.spot === null || r.fees === null) return null
        const total = formatSek(r.totalSek)
        return (
          <>
            <TooltipRow label={config.spot.label} color={config.spot.color}>
              {formatSek(r.spot)}
            </TooltipRow>
            <div className="flex w-full flex-col gap-0.5">
              <TooltipRow label={config.fees.label} color={config.fees.color}>
                {formatSek(r.fees)}
              </TooltipRow>
              <TooltipRow label={m.charging_chart_total()} strong>
                {r.missingShare === null ? total : m.charging_cost_min({ total })}
              </TooltipRow>
              {r.missingShare === null ? null : (
                <span className="text-muted-foreground text-xs">
                  {m.charging_cost_partial_hint({ share: formatShare(r.missingShare) })}
                </span>
              )}
              <SolarTooltipRows view={r.solar} />
            </div>
          </>
        )
      }}
    />
  )
```

`config` becomes a plain object (drop `satisfies ChartConfig`). Remove the imports of `recharts`,
`~/components/ui/chart`, `./ChartFrame` and `./minBar`; import `TooltipRow` from `~/components/chart/ChartParts`
and `BarChart` from `~/components/chart/BarChart`. Recharts' `minPointSize` floors (`minBarFor` per series) are the
module's default rule now: a non-null, non-zero value gets 4 px; the stub's value is never 0.

Keep the empty-year `div` with `h-[260px]` as it is (it doesn't go through the frame).

- [ ] **Step 2: Run its tests and the page's**

Run: `bunx vitest run --project browser src/components/evCharging/MonthlyChart.browser.test.tsx src/routes/_authenticated/charging/`
Expected: PASS. The keyboard characterization test now walks the visx group.

- [ ] **Step 3: Commit**

```bash
git add src/components/evCharging/MonthlyChart.tsx
git commit -m "refactor(charts): draw the monthly charging chart with visx"
```

Reviewers: as Task 6.

---

### Task 8: EconomyMonthlyChart on the module

**Files:**
- Modify: `src/components/evCharging/EconomyMonthlyChart.tsx`

**Interfaces:** Consumes `BarChart`, `NoData`, `TooltipRow` from `~/components/chart/ChartParts`. Export unchanged.

- [ ] **Step 1: Replace the recharts body**

Keep the colour/contrast comment, `allExcluded`, `stubReason`, `config` (plain object), the no-sessions `NoData`,
`hasStub`, `top`, `flat`, `stub` and `data` exactly as they are. Replace `floorFor` and the JSX with:

```tsx
  // Side by side: immediate | actual (its stub stacked in the same slot) | optimal.
  // A real 0 or near-0 kr counterfactual in an included month is data and gets
  // a visible bar; null (excluded month) stays empty.
  const series = [
    { key: 'immediate', ...config.immediate, radius: 3, zeroIsData: true },
    { key: 'actual', ...config.actual, stack: 'mid', radius: 3, zeroIsData: true },
    { key: 'optimal', ...config.optimal, radius: 3, zeroIsData: true },
    // Lists the rendered series, so the stub's legend entry appears only with one.
    ...(hasStub ? [{ key: 'stub', ...config.stub, stack: 'mid', radius: 3, zeroIsData: true }] : []),
  ]
  return (
    <BarChart
      rows={data}
      category={(r) => r.label}
      series={series}
      value={(r, key) => r[key as 'immediate' | 'actual' | 'optimal' | 'stub']}
      yTickFormat={(v) => formatSek(v)}
      yAxisLine={false}
      hideYAxis={flat}
      yDomain={flat ? [0, stub / 0.03] : undefined}
      barGap={2}
      legend
      label={m.charging_economy_chart_sek_title()}
      tooltip={(r) => {
        // The stub has a label but no kronor value — nothing was compared.
        if (r.stub !== null) {
          return <TooltipRow label={r.reason ?? config.stub.label} color={config.stub.color} />
        }
        if (r.immediate === null || r.actual === null || r.optimal === null) return null
        return (
          <>
            <TooltipRow label={config.immediate.label} color={config.immediate.color}>
              {formatSek(r.immediate)}
            </TooltipRow>
            <TooltipRow label={config.actual.label} color={config.actual.color}>
              {formatSek(r.actual)}
            </TooltipRow>
            <div className="flex w-full flex-col gap-0.5">
              <TooltipRow label={config.optimal.label} color={config.optimal.color}>
                {formatSek(r.optimal)}
              </TooltipRow>
              {r.included < r.sessions ? (
                <span className="text-muted-foreground text-xs">
                  {m.charging_economy_tooltip_compared({ included: r.included, sessions: r.sessions })}
                </span>
              ) : null}
            </div>
          </>
        )
      }}
    />
  )
```

`config`'s entries carry `label` and `color`, so `{ key, ...config.x }` makes a `BarSeries`. Remove the recharts,
`ui/chart`, `./ChartFrame` and `./minBar` imports.

- [ ] **Step 2: Run its tests and the page's**

Run: `bunx vitest run --project browser src/components/evCharging/EconomyMonthlyChart.browser.test.tsx src/routes/_authenticated/charging/`
Expected: PASS, including "no horizontal grid lines" in the flat year (`hideYAxis` drops the grid).

- [ ] **Step 3: Commit**

```bash
git add src/components/evCharging/EconomyMonthlyChart.tsx
git commit -m "refactor(charts): draw the monthly economy chart with visx"
```

Reviewers: as Task 6.

---

### Task 9: SpotComparisonChart on the module

**Files:**
- Modify: `src/components/evCharging/SpotComparisonChart.tsx`

**Interfaces:** Consumes `BarChart` (with `line`), `NoData`, `TooltipRow`. Export unchanged.

- [ ] **Step 1: Replace the recharts body**

Keep the colour comment, the chart comment, `config` (plain object), the `NoData` early return and `data`. Then:

```tsx
  return (
    <BarChart
      rows={data}
      category={(r) => r.label}
      // A real near-zero price (even 0) must not vanish; null draws no bar.
      series={[{ key: 'paid', ...config.paid, radius: 3, zeroIsData: true }]}
      // Dashed, so it reads as a reference line rather than a second bar
      // series; its dots stay solid.
      line={{ key: 'avg', ...config.avg, dash: '5 4' }}
      value={(r, key) => r[key as 'paid' | 'avg']}
      yTickFormat={(v) => formatOre(v)}
      yAxisLine={false}
      legend
      label={m.charging_economy_chart_spot_title()}
      tooltip={(r) =>
        r.paid === null ? null : (
          <>
            <TooltipRow label={config.paid.label} color={config.paid.color}>
              {m.charging_economy_ore({ value: formatOrePrecise(r.paid) })}
            </TooltipRow>
            {r.avg === null ? null : (
              <TooltipRow label={config.avg.label} color={config.avg.color}>
                {m.charging_economy_ore({ value: formatOrePrecise(r.avg) })}
              </TooltipRow>
            )}
          </>
        )
      }
    />
  )
```

Remove `SERIES_ORDER`/`seriesOrder` (the series list is the order now), the recharts, `ui/chart`, `./ChartFrame`
and `./minBar` imports.

- [ ] **Step 2: Run its tests and the page's**

Run: `bunx vitest run --project browser src/components/evCharging/SpotComparisonChart.browser.test.tsx src/routes/_authenticated/charging/`
Expected: PASS, including the line-break characterization from Task 3.

- [ ] **Step 3: Commit**

```bash
git add src/components/evCharging/SpotComparisonChart.tsx
git commit -m "refactor(charts): draw the spot comparison chart with visx"
```

Reviewers: as Task 6.

---

### Task 10: Clean up, measure, recapture, record

**Files:**
- Delete: `src/components/evCharging/minBar.ts` (no importer left; `git grep minBar` to confirm)
- Modify: `src/bones/charging-chart.bones.json`, `charging-economy.bones.json`, `charging-patterns.bones.json`
  (regenerated only)
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md`

- [ ] **Step 1: Delete `minBar.ts`**

Run: `git grep -n "minBar" -- src` → only `minBar.ts` itself and comments. Delete the file; update any comment that
still names `minBarFor` to point at `barLayout.ts`'s floor. `bun run typecheck` → clean.

- [ ] **Step 2: Measure**

Run: `bun run bundle:measure`
Expected: `/charging`, `/charging/economy` and `/charging/patterns` list no `chart` chunk of 84 KB and no recharts
in their closures. `/energy` and `/sensors` still do. Record each page's total. Check also with
`git grep -n "from 'recharts'" -- src` → only `ui/chart.tsx`, `EnergyMonthlyChart.tsx`, `ClimateChart.tsx`.

- [ ] **Step 3: Recapture the charging bones**

The chart frames' inner layout moved (the legend is now a flex row under the svg). With the dev stack up
(`bun run dev:up`, `bun run dev`, Mailpit for the sign-in), run
`BETTER_AUTH_URL=http://localhost:14610 bunx vite dev --port 14610 --strictPort` in one terminal, then
`bun run bones:capture --force /charging /charging/economy /charging/patterns` (usage in
`scripts/captureBones.ts`). Expected: only `charging-chart`, `charging-economy`, `charging-patterns` (and possibly
`charging-totals`/`charging-sessions`/`charging-timeline`, recaptured unchanged) differ; revert any bones file whose
only change is `_hash`. Never hand-edit them.

- [ ] **Step 4: Update the roadmap row**

Row 5a: PR link, status `PR open`, and add a "Step 5a notes" section with the before/after page totals table
(baseline above vs Step 2) and the accepted drift list from "Parity".

- [ ] **Step 5: Commit**

```bash
git add -u src/components/evCharging/minBar.ts src/bones/ docs/superpowers/roadmaps/2026-10-05-client-performance.md
git commit -m "chore(charts): drop minBar, recapture charging bones, record 5a"
```

Reviewers: `code-reviewer` + a general reviewer told "assume something still imports recharts on a charging page,
or a bone no longer matches its section".

---

### Task 11: Verify and ship (refactor-workflow Phases 6–7)

- [ ] Run the [pre-PR gate](../../feature-workflow.md#pre-pr-gate) in full and paste its output into the PR.
- [ ] Live, in a real browser at desktop (1280), tablet (768) and phone (375) widths, signed in as an admin with
  data: `/charging` (kWh and kr views), `/charging/economy` (both charts, incl. a stub month if one exists),
  `/charging/patterns` (hour chart). Compare each with prod (recharts) side by side: bars, axes, legend, tooltip
  text, hover across an empty month, Tab + arrows, a touch tap (device emulation), dark mode. Note every visible
  difference; anything beyond the accepted drift is fixed before the PR.
- [ ] Whole-branch review: `code-reviewer` (ADR adherence) + a general correctness pass told "assume behaviour
  moved somewhere in this branch".
- [ ] PR: title `refactor(charts): draw the charging bar charts with visx`, template body with the before/after
  bundle table, the two owner-approved gaps, the accepted drift, and the live-check notes. Squash-merge after
  review; then set row 5a to `merged`.

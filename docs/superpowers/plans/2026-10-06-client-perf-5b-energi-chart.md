# Client performance step 5b: the Energi month chart on visx (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
> House rule: after each task's commit, two adversarial reviewers (paired per task) start from the assumption that
> the task is wrong and changed behaviour. Fix or rule on every finding before the next task.

**Goal:** The Energi month chart (`EnergyMonthlyChart`) draws with the shared visx `BarChart` from step 5a, with its
selection, keyboard, export-below-the-axis and hover outline preserved, so `/energy` stops loading recharts.

**Architecture:**
- Safety net first. The Energi chart tests move onto `test/browser/chartDom.ts` (a few new helpers) and stay green on
  recharts before any chart code changes.
- `barLayout.ts` (pure) learns a diverging stack (recharts' `stackOffset="sign"`: positives up from 0, negatives
  down from 0), an optional bar floor, and `labelsFit`.
- `BarChart.tsx` learns **selection as a first-class feature** (owner's choice A, 2026-10-06): a `selection` prop
  `{ selected, onSelect, canSelect }`. With it the chart selects on a click or tap on a category or its label, and on
  Enter / Space for the keyboard's category; tints the selected category and bolds its label; outlines the hovered or
  keyboard category round its column, label included (dashed for one that can't be selected, keyboard only; none on
  touch); opens no card on touch; shows a pointer cursor over a selectable category. Plus small options:
  `stackOffset`, `zeroLine`, `shortCategory`, `tickPx`, `minBarPx`, `tooltipClassName`, `legendClassName`,
  `keyboardHint`.
- `EnergyMonthlyChart.tsx` becomes config (series, colours, seams, rounded ends) plus its tooltip content, the
  empty-year state and the visible hint line.

**Tech stack:** React 19, visx 4.0.0 (`@visx/axis`, `@visx/grid`, `@visx/group`, `@visx/responsive`, `@visx/shape`,
`@visx/text`, `@visx/tooltip`), d3-scale 4, d3-array 3, d3-shape 3.2.0, Vitest 5 (node + browser projects), bun.
No new dependencies.

**Design:** agreed in chat on 2026-10-06 (no separate spec, as in 5a). The owner chose option A (selection inside
`BarChart`) over render slots (B) or a separate Energi chart on `barLayout` (C), and approved the four differences
listed under "Accepted drift".
**Roadmap:** `docs/superpowers/roadmaps/2026-10-05-client-performance.md`, step 5b. 5a (#111) is merged; 5c
(ClimateChart, recharts deleted, checkpoint 5) follows in its own session.

## Global constraints

- Work in the worktree `.claude/worktrees/perf-energi-chart` on branch `refactor/energi-chart-visx`. Never `cd` to
  the main checkout.
- **Refactor: one hat per commit.** No commit changes what a viewer sees or can do, except the 5a decisions (the
  keyboard is a named `role="group"` whose first → lands on the first month; the card sits above the month) and
  the four accepted differences below. Any other difference found on the way is a bug in the swap.
- Behaviour to preserve: the same bars (count and DOM order: series by series, month by month), the stacking with
  Nät's export below the axis and a zero line, no bar for a month without data (null, never 0), the legend entries
  in stack order, the tooltip's rows and their order (parts, total, Nät's export, the gap), "(hittills)" on the
  current month, selection by click on a column or its label and by Enter / Space, no selection of a month without
  readings, the selected tint and bold label, the outline (solid on hover, dashed from the keyboard on a month
  without readings, none on touch, painted over the bars, covering the label), a touch tap selecting without a card
  or outline, initials on a narrow chart, 13 px ticks, a `text-sm` legend and card, the empty-year state with its
  reserved hint line, and the visible hint line.
- `recharts` stays in `package.json` (ClimateChart) until 5c. `/energy` must stop importing anything that reaches
  it: `~/components/ui/chart` and `~/components/evCharging/ChartFrame` both do.
- One new user-facing string, `energy_chart_keyboard_hint` (sv source of truth + en), added in Task 5.
- Logging via `~/lib/logger`, never `console.*`. Biome must pass (`bun run check:ci`).
- File naming: React component files PascalCase, everything else camelCase.
- `src/bones/*.bones.json` is generated; don't touch it in this step (the recapture is in 5c, as in 5a).
- Conventional Commits, ≤ 72 characters, imperative. End each commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git add <paths>`, never `-A`.
- Reviewers must not run vitest (concurrent runs collide on the shared local DB). Before running vitest yourself,
  check `pgrep -fl vitest` shows none from other sessions.
- Browser tests have no app CSS: pin structure, attributes and text there; verify layout live (Task 6).
- The visx overlay (`[data-hover-overlay]`) is painted over the bars and the labels, so a Playwright
  `userEvent.click(bar)` is intercepted by it. Tests click and hover the visx chart by dispatching on the overlay
  (`chartDom.ts`'s helpers), never through hit-testing (5a's CI lesson).

### Accepted drift (owner-approved 2026-10-06; state it in the PR)

1. Hovering a month's label now outlines the month and opens its card (the label was clickable but showed nothing).
2. The switch to initials is measured (`labelsFit`) instead of a fixed 36 px column, so full labels stay down to
   about a 27–30 px column.
3. A mouse click focuses the chart group (the ring shows for keyboard focus only, `focus-visible`). The old
   `onMouseDown preventDefault` only kept recharts' keyboard mode off January.
4. The screen-reader announcement starts with the short label ("apr.") before the card's "April …".

## Review focus

1. **Nät with export larger than the purchase, or export with no purchase.** The axis must reach below 0 by the
   export, the export bar hangs from the zero line (never from the top of the import stack), and the zero line sits
   at 0. Pinned in Task 2 (`barLayout` diverging tests) and Task 3 (zero line + negative bar in the DOM).
2. **The selection changes while the pointer or keyboard is on another month** (the page sets it after a click, or a
   period picker changes it). The tint and bold label move; the outline stays on the cursor's month; a selected index
   outside the rows draws nothing. Pinned in Task 4.
3. **A hybrid device: a tap, then a mouse.** After a touch tap selects (no card), a mouse move over the same month
   must show the card and outline again. Pinned in Task 1 (Energi test, kept through Task 5) and Task 4.
4. **The metric switches while a card is open.** The card must show the new metric's rows, not the old ones. Pinned
   in Task 5.
5. **A 320 px phone.** Initials, the outline inside the chart's box at the first and last month, and the y labels not
   clipped. Pinned in Task 5 (test at 320 px) and checked live in Task 6.

---

### Task 0: Baseline, roadmap row, plan

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md`
- Create: this plan (already written)

- [ ] **Step 1: Verify `main` still matches the plan's assumptions**

Run: `git log --oneline -1 origin/main && git grep -ln "from 'recharts'\|components/ui/chart'\|evCharging/ChartFrame'" -- src`
Expected: `3862039` (or a later commit that doesn't touch the files below), and the importers are
`src/components/energy/EnergyMonthlyChart.tsx`, `src/components/evCharging/ChartFrame.tsx`,
`src/components/sensor/ClimateChart.tsx`, `src/components/ui/chart.tsx` (plus files importing those; check no other
`/energy` component does).

- [ ] **Step 2: Measure the baseline**

Run: `bun run bundle:measure 2>&1 | tail -60`
Expected: `/energy` ~148 KB gz with a recharts `chart` chunk (~81–84). Write the `/energy`, `/sensors` and entry +
shell numbers into the "Step 5b notes" section (Step 3).

- [ ] **Step 3: Update the roadmap**

- Row 5a: PR column stays #111, status `merged`.
- Row 5b: plan link `[plan](../plans/2026-10-06-client-perf-5b-energi-chart.md)`, status `in progress`.
- Add a `## Step 5b notes` section after "Step 5a notes" holding the baseline numbers from Step 2 and the four
  accepted differences (copy them from this plan).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/roadmaps/2026-10-05-client-performance.md docs/superpowers/plans/2026-10-06-client-perf-5b-energi-chart.md
git commit -m "docs(perf): plan the Energi chart on the visx bar module"
```

Reviewers: none (docs).

---

### Task 1: Energi chart tests through `chartDom.ts`

Pure test refactor, green on recharts. Every assertion keeps its meaning; only the way it finds and drives elements
changes.

**Files:**
- Modify: `test/browser/chartDom.ts`
- Modify: `src/components/energy/EnergyMonthlyChart.browser.test.tsx`

**Interfaces:**
- Produces (used by Tasks 3–5): the new `chartDom.ts` exports below. `[data-slot="category-outline"]` and
  `[data-slot="category-selected"]` are the hooks `BarChart` must render in Task 4.

- [ ] **Step 1: Add the helpers**

In `test/browser/chartDom.ts`, add to `SEL`:

```ts
  // The Energi chart's recharts hooks, and the bar module's selection hooks.
  outline: '[data-slot="hover-month"], [data-slot="category-outline"]',
  selectedTint: '[data-slot="selected-month"], [data-slot="category-selected"]',
```

and these exports (after `yTickLabels`):

```ts
/** The outline round the hovered or keyboard category (null: none). */
export const outline = (root: ParentNode) => root.querySelector<SVGGraphicsElement>(SEL.outline)
/** The selected category's tint (null: none). */
export const selectedTint = (root: ParentNode) =>
  root.querySelector<SVGGraphicsElement>(SEL.selectedTint)
/** The x tick label `<text>` elements (recharts' are the nodes; visx wraps each in a tick group). */
export const xTickTexts = (root: ParentNode) =>
  xTickNodes(root)
    .map((n) => (n.matches('text') ? n : n.querySelector('text')))
    .filter((t): t is SVGTextElement => t !== null)
/** The x tick node showing `label` (throws when none does). */
export const xTick = (root: ParentNode, label: string) => {
  const tick = xTickNodes(root).find((t) => t.textContent === label)
  if (!tick) throw new Error(`no x tick "${label}" (have ${xTickLabels(root).join(', ')})`)
  return tick
}
/** The labels drawn bold (the selected category's). */
export const boldTickLabels = (root: ParentNode) =>
  xTickTexts(root)
    .filter((t) => t.getAttribute('font-weight') === '600')
    .map((t) => t.textContent ?? '')
/** The open tooltips' elements (portalled, so searched in the document; recharts' hidden ones skipped). */
export const tooltipNodes = () =>
  all<HTMLElement>(document, SEL.tooltip).filter((t) => t.style.visibility !== 'hidden')

/** A mouse move at (x, y): on the visx overlay when there is one, else on the element there (recharts). */
export function moveAt(root: ParentNode, x: number, y: number) {
  if (!moveOverPlot(root, x, y)) pointAt(x, y)
}

/**
 * A mouse click at the centre of `el` (a bar or a tick label). The visx
 * overlay covers both, so the click is dispatched on it at that point;
 * recharts gets a real click on the element.
 */
export async function clickOn(root: ParentNode, el: Element) {
  const overlay = root.querySelector('[data-hover-overlay]')
  const { x, y } = centre(el)
  if (!overlay) return userEvent.click(el)
  const init = { bubbles: true, clientX: x, clientY: y }
  overlay.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }))
  overlay.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse' }))
  overlay.dispatchEvent(new MouseEvent('click', init))
}

/**
 * A finger tap at the centre of `el`: the pointer events say "touch", then
 * the browser emulates the mouse (move, down, up, click). Dispatched on the
 * visx overlay when there is one, else on `el` (recharts).
 */
export function tapOn(root: ParentNode, el: Element) {
  const target = root.querySelector('[data-hover-overlay]') ?? el
  const { x, y } = centre(el)
  const at = { bubbles: true, clientX: x, clientY: y }
  target.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'touch' }))
  target.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'touch' }))
  target.dispatchEvent(new MouseEvent('mousemove', at))
  target.dispatchEvent(new MouseEvent('mousedown', at))
  target.dispatchEvent(new MouseEvent('mouseup', at))
  target.dispatchEvent(new MouseEvent('click', at))
}
```

(`centre` already exists in the file; move it above the first use if needed. Export `centre` too, as
`export const centre`, for the tests below.)

- [ ] **Step 2: Move the Energi tests onto the helpers**

In `src/components/energy/EnergyMonthlyChart.browser.test.tsx`:
- Add `beforeEach(parkPointer)` (import `beforeEach` from vitest).
- Delete the local `barRects`, `legendText`, `tickText`, `tooltipText`; import from `~test/browser/chartDom`:
  `bars, boldTickLabels, centre, clickOn, focusTarget, legend, legendText, moveAt, outline, parkPointer,
  selectedTint, tapOn, tooltipNodes, tooltipText, xTick, xTickLabels, hoverBar`.
- Replace each use, keeping every assertion:

| Before | After |
|---|---|
| `barRects(screen.container)` / `querySelectorAll('.recharts-bar-rectangle')` | `bars(screen.container)` |
| `legendText(screen.container)` (local) | `legendText(screen.container)` (chartDom) |
| `screen.container.querySelector('.recharts-legend-wrapper')` | `legend(screen.container)` |
| the Nät test's manual `mousemove` on `rects()[0]` + `document.body.textContent` | `await hoverBar(screen.container, 0)`, then read `tooltipText()` (wait for it to contain `m.energy_chart_so_far()`) |
| `userEvent.click(barRects(...)[n])` | `await clickOn(screen.container, bars(screen.container)[n])` |
| `userEvent.click(tickText(container, n))` | `await clickOn(screen.container, xTick(screen.container, monthLabel(n)))` |
| `querySelector('[data-slot="selected-month"]')` | `selectedTint(screen.container)` |
| bold ticks via `.recharts-xAxis-tick-labels text[font-weight="600"]` | `boldTickLabels(screen.container)` (`toEqual([monthLabel(2)])`, or `toEqual([])`) |
| the tint-vs-band check via the ticks' `x` attributes | `centre(xTick(c, monthLabel(3))).x - centre(xTick(c, monthLabel(2))).x`, compared with `(selectedTint(c) as SVGGraphicsElement).getBoundingClientRect().width` (`toBeCloseTo(band, 0)`) |
| `userEvent.hover(barRects(...)[0])` | `await hoverBar(screen.container, 0)` |
| `.recharts-tooltip-wrapper span` | `tooltipNodes().flatMap((t) => [...t.querySelectorAll('span')])` |
| `querySelector('[data-slot="hover-month"]')` | `outline(screen.container)` |
| the touch test's manual event sequence | `tapOn(screen.container, bars(screen.container)[3])`; the "same spot under a mouse" step becomes `const c = centre(bars(screen.container)[3]); moveAt(screen.container, c.x + 1, c.y)` |
| `screen.container.querySelector('.recharts-surface') as HTMLElement` then `.focus()` | `focusTarget(screen.container)?.focus()` |
| `.recharts-xAxis-tick-labels text` (narrow / wide tests) | `xTickLabels(screen.container)` |

- Keep the test "after a click, moving the pointer off…" as it is, including its
  `document.activeElement?.classList.contains('recharts-surface')` line; Task 5 replaces that line (accepted drift 3).
- Keep the keyboard tests' key sequences as they are (recharts lands on January when focused). Task 5 adjusts them.

- [ ] **Step 3: Run the Energi tests on recharts**

Run: `pgrep -fl vitest; bunx vitest run --project browser src/components/energy/EnergyMonthlyChart.browser.test.tsx`
Expected: all 21 tests PASS, the same count as before the change.

- [ ] **Step 4: Run every chart test (the helper change touches them all)**

Run: `bunx vitest run --project browser src/components/chart src/components/evCharging src/components/energy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/browser/chartDom.ts src/components/energy/EnergyMonthlyChart.browser.test.tsx
git commit -m "test(energy): read the month chart through the chart DOM helpers"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`, both told
the task is a pure test refactor and to look for any assertion that lost its meaning or became vacuous.

---

### Task 2: Diverging stacks, an optional floor and `labelsFit` in `barLayout.ts`

**Files:**
- Modify: `src/components/chart/barLayout.ts`
- Test: `src/components/chart/barLayout.test.ts`

**Interfaces:**
- Produces (Task 3):
  - `export type StackOffset = 'none' | 'diverging'`
  - `layoutBars({ count, series, value, x, y, barGap, offset?: StackOffset, minPx?: number }): BarRect[]`
    (`offset` default `'none'`, `minPx` default `MIN_BAR_PX`)
  - `stackExtent({ count, series, value, offset?: StackOffset }): [number, number]`
  - `labelsFit(centres: readonly number[], widths: readonly number[], gap?: number): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `src/components/chart/barLayout.test.ts` (reuse the file's existing imports; add `labelsFit` and
`type BarSeries` to the import from `./barLayout`, and `scaleBand, scaleLinear` from `d3-scale` if not imported):

```ts
describe('diverging stacks (recharts stackOffset="sign")', () => {
  const series: BarSeries[] = [
    { key: 'a', label: 'A', color: 'red', stack: 's' },
    { key: 'b', label: 'B', color: 'blue', stack: 's' },
    { key: 'c', label: 'C', color: 'green', stack: 's' },
  ]
  const values: Record<string, number> = { a: 10, b: 5, c: -4 }
  const value = (_: number, key: string) => values[key]
  const x = scaleBand<number>().domain([0]).range([0, 100])
  // 10 px per unit; 0 is at 200 px.
  const y = scaleLinear().domain([-10, 20]).range([300, 0])

  test('positives stack up from 0, a negative hangs from 0, whatever its place in the stack', () => {
    const rects = layoutBars({ count: 1, series, value, x, y, barGap: 4, offset: 'diverging' })
    const at = (key: string) => rects.find((r) => r.key === key)
    expect(at('a')).toMatchObject({ y: 100, height: 100 })
    expect(at('b')).toMatchObject({ y: 50, height: 50 })
    expect(at('c')).toMatchObject({ y: 200, height: 40 })
  })

  test('the default keeps stacking a negative on the running sum (recharts "none")', () => {
    const rects = layoutBars({ count: 1, series, value, x, y, barGap: 4 })
    expect(rects.find((r) => r.key === 'c')).toMatchObject({ y: 50, height: 40 })
  })

  test('stackExtent: diverging spans the negatives below 0 and the positives above', () => {
    expect(stackExtent({ count: 1, series, value, offset: 'diverging' })).toEqual([-4, 15])
    expect(stackExtent({ count: 1, series, value })).toEqual([0, 15])
  })

  test('export larger than the purchase, and export with no purchase', () => {
    const v: Record<string, number | null>[] = [
      { a: 2, b: null, c: -30 },
      { a: null, b: null, c: -12 },
    ]
    const val = (i: number, key: string) => v[i][key]
    expect(stackExtent({ count: 2, series, value: val, offset: 'diverging' })).toEqual([-30, 2])
    const xs = scaleBand<number>().domain([0, 1]).range([0, 200])
    const ys = scaleLinear().domain([-30, 10]).range([400, 0]) // 0 at 100 px
    const rects = layoutBars({ count: 2, series, value: val, x: xs, y: ys, barGap: 4, offset: 'diverging' })
    for (const r of rects.filter((r) => r.key === 'c')) expect(r.y).toBe(100)
  })
})

describe('the bar floor', () => {
  const series: BarSeries[] = [{ key: 'a', label: 'A', color: 'red' }]
  const x = scaleBand<number>().domain([0]).range([0, 100])
  const y = scaleLinear().domain([0, 100]).range([100, 0])
  const value = () => 0.2

  test('minPx 0 draws a tiny value at its true height', () => {
    const [r] = layoutBars({ count: 1, series, value, x, y, barGap: 4, minPx: 0 })
    expect(r.height).toBeCloseTo(0.2)
  })

  test('the default floor is MIN_BAR_PX', () => {
    const [r] = layoutBars({ count: 1, series, value, x, y, barGap: 4 })
    expect(r.height).toBe(MIN_BAR_PX)
  })
})

describe('labelsFit', () => {
  test('true when every label keeps the gap to its neighbours', () => {
    expect(labelsFit([10, 40, 70], [20, 20, 20])).toBe(true)
  })
  test('false when any two would come closer than the gap', () => {
    expect(labelsFit([10, 40, 70], [28, 28, 28])).toBe(false)
  })
  test('none or one label always fits', () => {
    expect(labelsFit([], [])).toBe(true)
    expect(labelsFit([5], [500])).toBe(true)
  })
})
```

(If `MIN_BAR_PX` isn't imported in the test file yet, add it.)

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project node src/components/chart/barLayout.test.ts`
Expected: FAIL (`labelsFit` is not exported; `offset` and `minPx` are ignored, so the diverging and floor tests fail).

- [ ] **Step 3: Implement**

In `src/components/chart/barLayout.ts`:

```ts
import { stack, stackOffsetDiverging, stackOffsetNone } from 'd3-shape'

/** 'none' stacks each series on the running sum; 'diverging' stacks positives up from 0 and negatives down from 0 (recharts' "sign"). */
export type StackOffset = 'none' | 'diverging'

// [y0, y1] per series key and index; a null value stacks as 0 (it draws nothing).
function stacked(count: number, keys: string[], value: Value, offset: StackOffset = 'none') {
  const layers = stack<number, string>()
    .keys(keys)
    .value((i, key) => value(i, key) ?? 0)
    .offset(offset === 'diverging' ? stackOffsetDiverging : stackOffsetNone)(range(count))
  return new Map(layers.map((layer) => [layer.key, layer.map(([y0, y1]) => [y0, y1] as const)]))
}
```

`layoutBars` takes `offset = 'none'` and `minPx = MIN_BAR_PX` (add both to its parameter type with a one-line doc
each), passes `offset` to `stacked(count, keys, value, offset)`, and uses
`const height = Math.max(Math.abs(base - end), minPx)`. `stackExtent` takes `offset = 'none'` and passes it to
`stacked`. Add after `thinTicks`:

```ts
/** Whether every label fits without thinning (no two closer than `gap` px). */
export function labelsFit(
  centres: readonly number[],
  widths: readonly number[],
  gap = 5,
): boolean {
  return thinTicks(centres, widths, gap).length === centres.length
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `bunx vitest run --project node src/components/chart/barLayout.test.ts`
Expected: PASS, the existing tests included.

- [ ] **Step 5: Commit**

```bash
git add src/components/chart/barLayout.ts src/components/chart/barLayout.test.ts
git commit -m "refactor(charts): diverging stacks and an optional floor in the bar layout"
```

Reviewers: `code-reviewer` + a reviewer who checks the geometry against recharts 3.8.0's `stackOffset="sign"`
(`node_modules/recharts/es6/util/ChartUtils.js`, `offsetSign`) and d3-shape's `stackOffsetDiverging`, assuming they
differ somewhere (a 0 value, a null, a NaN).

---

### Task 3: `BarChart`'s small options

Additive: the 5a charts pass none of them and must render exactly as before.

**Files:**
- Modify: `src/components/chart/BarChart.tsx`, `src/components/chart/ChartParts.tsx`,
  `src/components/evCharging/ChartPopover.tsx`
- Test: `src/components/chart/BarChart.browser.test.tsx`

**Interfaces:**
- Consumes: Task 2's `StackOffset`, `layoutBars({ offset, minPx })`, `stackExtent({ offset })`, `labelsFit`.
- Produces (Tasks 4–5), new `BarChartProps<Row>` fields:
  - `stackOffset?: StackOffset` (default `'none'`)
  - `zeroLine?: boolean` (default false): a `var(--border)` line at 0 across the plot, `data-zero-line`
  - `shortCategory?: (row: Row) => string`: with it every category is labelled; full labels when `labelsFit`,
    otherwise every label short
  - `tickPx?: number` (default 12): the axis labels' font size (also used to measure them)
  - `minBarPx?: number` (default `MIN_BAR_PX`)
  - `tooltipClassName?: string`: merged (`cn`) into the card's classes
  - `legendClassName?: string`: merged into the legend's classes
  - `keyboardHint?: string`: the sr-only hint (default `m.chart_keyboard_hint()`)
  - `ChartPopover` gains `className?: string` (card variant only), `ChartLegend` gains `className?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/chart/BarChart.browser.test.tsx` (it already has `base`, `render`, `rows`):

```ts
test('stackOffset="diverging" hangs a negative series from the zero line', async () => {
  const signed = [
    { label: 'jan', a: 10, b: -6 },
    { label: 'feb', a: 4, b: -12 },
  ]
  const { screen } = await render({
    rows: signed,
    series: [
      { key: 'a', label: 'A', color: 'red', stack: 's' },
      { key: 'b', label: 'B', color: 'blue', stack: 's' },
    ],
    stackOffset: 'diverging',
    zeroLine: true,
  })
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(4))
  const zero = screen.container.querySelector('[data-zero-line]') as SVGLineElement
  expect(zero).not.toBeNull()
  const zeroY = zero.getBoundingClientRect().y
  for (const bar of seriesBars(screen.container, 1)) {
    expect(bar.getBoundingClientRect().top).toBeCloseTo(zeroY, 0)
  }
  for (const bar of seriesBars(screen.container, 0)) {
    expect(bar.getBoundingClientRect().bottom).toBeCloseTo(zeroY, 0)
  }
})

test('no zero line unless asked for', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  expect(screen.container.querySelector('[data-zero-line]')).toBeNull()
})

const twelve = Array.from({ length: 12 }, (_, i) => ({ label: `Långmånad${i}`, a: 5, b: 1 }))

test('shortCategory: every label, full when they fit, all short when they do not', async () => {
  const props = { rows: twelve, shortCategory: (r: Row) => r.label.slice(-1) }
  const narrow = await render(props, 240)
  await vi.waitFor(() =>
    expect(xTickLabels(narrow.screen.container)).toEqual(twelve.map((r) => r.label.slice(-1))),
  )
  narrow.screen.unmount()
  const wide = await render(props, 1400)
  await vi.waitFor(() => expect(xTickLabels(wide.screen.container)).toEqual(twelve.map((r) => r.label)))
})

test('tickPx sets the axis label size', async () => {
  const { screen } = await render({ tickPx: 13 })
  await vi.waitFor(() => expect(xTickTexts(screen.container).length).toBeGreaterThan(0))
  for (const t of xTickTexts(screen.container)) expect(t.getAttribute('font-size')).toBe('13')
})

test('minBarPx 0 draws a tiny value at its true height', async () => {
  const tiny = [
    { label: 'jan', a: 0.1, b: null },
    { label: 'feb', a: 100, b: null },
  ]
  const floored = await render({ rows: tiny })
  await vi.waitFor(() => expect(bars(floored.screen.container)).toHaveLength(2))
  expect(barHeight(bars(floored.screen.container)[0])).toBeCloseTo(4, 0)
  floored.screen.unmount()
  const flat = await render({ rows: tiny, minBarPx: 0 })
  await vi.waitFor(() => expect(bars(flat.screen.container)).toHaveLength(2))
  expect(barHeight(bars(flat.screen.container)[0])).toBeLessThan(1)
})

test('tooltipClassName and legendClassName merge over the defaults', async () => {
  const { screen } = await render({
    tooltipClassName: 'min-w-56 text-sm',
    legendClassName: 'text-sm',
  })
  expect(legend(screen.container)?.className).toContain('text-sm')
  await hoverBar(screen.container, 0)
  const card = await vi.waitFor(() => {
    const el = document.querySelector('[data-slot="chart-tooltip"]')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  expect(card.className).toContain('text-sm')
  expect(card.className).not.toContain('text-xs')
  expect(card.className).toContain('min-w-56')
  expect(card.className).not.toContain('min-w-32')
})

test('keyboardHint replaces the default hint', async () => {
  const { screen } = await render({ keyboardHint: 'Pila och välj' })
  await expect.element(screen.getByText('Pila och välj')).toBeInTheDocument()
  expect(screen.container.textContent).not.toContain(m.chart_keyboard_hint())
})
```

Add `barHeight`, `legend`, `xTickTexts` to the `~test/browser/chartDom` import.

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/chart/BarChart.browser.test.tsx`
Expected: the seven new tests FAIL (unknown props are ignored); the old ones PASS.

- [ ] **Step 3: Implement**

`src/components/evCharging/ChartPopover.tsx`: add `className?: string` to `ChartPopover`'s props (doc: "card
variant: classes merged over the card's"), import `cn` from `~/lib/utils`, and in the card branch use
`className={cn('pointer-events-none z-50 grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-foreground text-xs shadow-xl', className)}`.

`src/components/chart/ChartParts.tsx`: `ChartLegend` takes `className?: string` and uses
`className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3', className)}` (import `cn`).

`src/components/chart/BarChart.tsx`:
- Import `labelsFit, MIN_BAR_PX, type StackOffset` from `./barLayout`.
- Add the props listed under **Interfaces** to `BarChartProps` with one-line docs, and destructure them with
  defaults `stackOffset = 'none'`, `zeroLine = false`, `tickPx = TICK_PX`, `minBarPx = MIN_BAR_PX`.
- Replace the module-level `measure` and `TICK_LABEL` with a per-size measure:

```ts
const measureAt = (px: number) => (s: string) =>
  getStringWidth(s, { fontSize: px }) ?? s.length * px * 0.6
```

  and inside the component `const tickLabel = { fill: 'var(--muted-foreground)', fontSize: tickPx }`.
- In the geometry memo:

```ts
    const measure = measureAt(tickPx)
    const extent = stackExtent({ count, series: keys, value: at, offset: stackOffset })
    // … plotH, y, yLabels, yAxisW (with this `measure`), left, plotW, x, centres as before …
    const fullWidths = rows.map((r) => measure(category(r)))
    // With short labels every category is labelled: full when they all fit, else all short.
    const short = shortCategory !== undefined && !labelsFit(centres, fullWidths)
    const xTicks =
      shortCategory !== undefined
        ? range(count)
        : xTickEvery === undefined
          ? thinTicks(centres, fullWidths)
          : range(0, count, xTickEvery)
    const rects = layoutBars({
      count,
      series,
      value: at,
      x,
      y: y.scale,
      barGap,
      offset: stackOffset,
      minPx: minBarPx,
    })
    return { x, y, left, plotW, plotH, xTicks, rects, centres, short }
```

  and add `stackOffset, shortCategory, tickPx, minBarPx` to the memo's dependency list.
- Tick labels: `const tickText = (i: number) => geometry.short && shortCategory ? shortCategory(rows[i]) : category(rows[i])`
  inside the `svg` branch; `AxisBottom` gets `tickFormat={(i) => tickText(Number(i))}`. Both axes'
  `tickLabelProps` spread `tickLabel` instead of `TICK_LABEL`.
- After the bar series groups (and the line), before the axes:

```tsx
        {zeroLine ? (
          <line
            data-zero-line
            x1={0}
            x2={geometry.plotW}
            y1={geometry.y.scale(0)}
            y2={geometry.y.scale(0)}
            stroke="var(--border)"
          />
        ) : null}
```

- `<ChartLegend items={legendItems} className={legendClassName} />`, the hint
  `{keyboardHint ?? m.chart_keyboard_hint()}`, and `<ChartPopover … className={tooltipClassName}>`.

- [ ] **Step 4: Run the chart tests**

Run: `bunx vitest run --project browser src/components/chart src/components/evCharging`
Expected: PASS (the 5a charts unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/components/chart/BarChart.tsx src/components/chart/ChartParts.tsx src/components/evCharging/ChartPopover.tsx src/components/chart/BarChart.browser.test.tsx
git commit -m "refactor(charts): stack offset, zero line and label options on BarChart"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`, told to
assume a 5a chart changed (memo deps, tick sizes, the legend or card classes).

---

### Task 4: Selection in `BarChart`

**Files:**
- Modify: `src/components/chart/BarChart.tsx`
- Test: `src/components/chart/BarChart.browser.test.tsx`

**Interfaces:**
- Consumes: Task 1's `chartDom` helpers, Task 3's options.
- Produces (Task 5):

```ts
export type BarSelection<Row> = {
  /** The selected category's index, or null. An index outside the rows draws nothing. */
  selected: number | null
  onSelect: (index: number) => void
  /** Whether a category can be selected (the Energi chart: it has readings). */
  canSelect: (row: Row) => boolean
}
```

  and `selection?: BarSelection<Row>` on `BarChartProps`. Hooks: `[data-slot="category-selected"]` (the tint),
  `[data-slot="category-outline"]` (the outline, `stroke-dasharray` set only when dashed).

- [ ] **Step 1: Write the failing tests**

Append to `src/components/chart/BarChart.browser.test.tsx`:

```ts
// jan, mar and apr can be selected; feb (null) can't.
const selectable = (r: Row) => r.a !== null
const withSelection = (selected: number | null, onSelect = vi.fn()) => ({
  selection: { selected, onSelect, canSelect: selectable },
})
const overlayBox = (c: Element) =>
  (c.querySelector('[data-hover-overlay]') as SVGRectElement).getBoundingClientRect()
const clickBand = (c: Element, i: number, y?: number) => {
  const o = overlayBox(c)
  const at = { bubbles: true, clientX: o.x + (o.width * (i + 0.5)) / 4, clientY: y ?? o.y + 10 }
  const overlay = c.querySelector('[data-hover-overlay]') as SVGRectElement
  overlay.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse' }))
  overlay.dispatchEvent(new MouseEvent('click', at))
}

test('a click selects the category under it; one that cannot be selected does nothing', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  clickBand(screen.container, 1) // feb
  clickBand(screen.container, 3) // apr
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(3))
  expect(onSelect).toHaveBeenCalledTimes(1)
})

test('the label band under the plot is clickable too', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  const tick = xTick(screen.container, 'jan').getBoundingClientRect()
  expect(overlayBox(screen.container).bottom).toBeGreaterThanOrEqual(tick.bottom)
  clickBand(screen.container, 0, tick.y + tick.height / 2)
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(0))
})

test('without selection the overlay stops at the plot and draws no outline', async () => {
  const { screen } = await render()
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const tick = xTick(screen.container, 'jan').getBoundingClientRect()
  expect(overlayBox(screen.container).bottom).toBeLessThanOrEqual(tick.top)
  expect(outline(screen.container)).toBeNull()
})

test('Enter and Space select the keyboard category; not one that cannot be selected', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{Enter}') // feb: nothing
  await userEvent.keyboard('{ArrowRight}{ArrowRight} ') // apr
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(3))
  expect(onSelect).toHaveBeenCalledTimes(1)
  await userEvent.keyboard('{Home}{Enter}')
  await vi.waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(0))
})

test('the selected category is tinted over its band and its label is bold', async () => {
  const { screen } = await render(withSelection(2))
  const tint = await vi.waitFor(() => {
    const el = selectedTint(screen.container)
    expect(el).not.toBeNull()
    return el as SVGGraphicsElement
  })
  const band = centre(xTick(screen.container, 'apr')).x - centre(xTick(screen.container, 'mar')).x
  expect(tint.getBoundingClientRect().width).toBeCloseTo(band, 0)
  expect(centre(tint).x).toBeCloseTo(centre(xTick(screen.container, 'mar')).x, 0)
  expect(boldTickLabels(screen.container)).toEqual(['mar'])
  // Painted under the bars.
  for (const bar of bars(screen.container))
    expect(tint.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('no selection, or one outside the rows, draws no tint and no bold label', async () => {
  for (const selected of [null, 4, -1]) {
    const { screen } = await render(withSelection(selected))
    await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
    expect(selectedTint(screen.container)).toBeNull()
    expect(boldTickLabels(screen.container)).toEqual([])
    screen.unmount()
  }
})

test('a new selection moves the tint; the hover outline stays on the pointer', async () => {
  const { screen } = await render(withSelection(0))
  await hoverBar(screen.container, 1) // apr's a
  await vi.waitFor(() => expect(outline(screen.container)).not.toBeNull())
  const outlineX = centre(outline(screen.container) as Element).x
  screen.rerender(
    <div style={{ width: 480 }}>
      <button type="button">before</button>
      <BarChart {...base} {...withSelection(2)} />
    </div>,
  )
  await vi.waitFor(() => expect(boldTickLabels(screen.container)).toEqual(['mar']))
  expect(centre(outline(screen.container) as Element).x).toBeCloseTo(outlineX, 0)
})

test('hovering a selectable category outlines its column, label included, over the bars', async () => {
  const { screen } = await render(withSelection(null))
  await hoverBar(screen.container, 1) // apr's a
  const o = await vi.waitFor(() => {
    const el = outline(screen.container)
    expect(el).not.toBeNull()
    return el as SVGGraphicsElement
  })
  const box = o.getBoundingClientRect()
  const tick = xTick(screen.container, 'apr').getBoundingClientRect()
  expect(box.left).toBeLessThanOrEqual(tick.left)
  expect(box.right).toBeGreaterThanOrEqual(tick.right)
  expect(box.bottom).toBeGreaterThanOrEqual(tick.bottom)
  expect(o.getAttribute('stroke-dasharray')).toBeNull()
  for (const bar of bars(screen.container))
    expect(bar.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  expect(overlay.style.cursor).toBe('pointer')
})

test('hovering a category that cannot be selected draws no outline and no pointer cursor', async () => {
  const { screen } = await render(withSelection(null))
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  const o = overlayBox(screen.container)
  moveOverPlot(screen.container, o.x + (o.width * 1.5) / 4, o.y + 10) // feb
  await settle()
  expect(outline(screen.container)).toBeNull()
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  expect(overlay.style.cursor).toBe('')
})

test('from the keyboard a category that cannot be selected gets a dashed outline', async () => {
  const { screen } = await render(withSelection(null))
  await screen.getByRole('button', { name: 'before' }).click()
  await userEvent.tab()
  await userEvent.keyboard('{ArrowRight}{ArrowRight}') // feb
  await vi.waitFor(() =>
    expect(outline(screen.container)?.getAttribute('stroke-dasharray')).not.toBeNull(),
  )
  await userEvent.keyboard('{ArrowRight}') // mar
  await vi.waitFor(() =>
    expect(outline(screen.container)?.getAttribute('stroke-dasharray')).toBeNull(),
  )
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(outline(screen.container)).toBeNull())
})

test('a tap selects without a card or an outline; a mouse afterwards shows both', async () => {
  const onSelect = vi.fn()
  const { screen } = await render(withSelection(null, onSelect))
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  tapOn(screen.container, bars(screen.container)[1]) // apr
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(3))
  await settle()
  expect(tooltipText()).toBe('')
  expect(outline(screen.container)).toBeNull()
  const c = centre(bars(screen.container)[1])
  moveAt(screen.container, c.x + 1, c.y)
  await vi.waitFor(() => {
    expect(tooltipText()).toBe('aprA 30 B 10')
    expect(outline(screen.container)).not.toBeNull()
  })
})

test('leaving the chart with a mouse clears the outline', async () => {
  const { screen } = await render(withSelection(null))
  await hoverBar(screen.container, 1)
  await vi.waitFor(() => expect(outline(screen.container)).not.toBeNull())
  const overlay = screen.container.querySelector('[data-hover-overlay]') as SVGRectElement
  overlay.dispatchEvent(
    new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }),
  )
  await vi.waitFor(() => expect(outline(screen.container)).toBeNull())
})
```

Add `boldTickLabels, centre, moveAt, outline, selectedTint, tapOn, xTick` to the `~test/browser/chartDom` import.

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/chart/BarChart.browser.test.tsx`
Expected: the new selection tests FAIL; "without selection the overlay stops at the plot…" already PASSES (it pins
today's behaviour).

- [ ] **Step 3: Implement**

In `src/components/chart/BarChart.tsx`:

1. Export `BarSelection<Row>` (Interfaces above) and add `selection?: BarSelection<Row>` to `BarChartProps` with the
   doc "Click / tap / Enter selects a category; adds the selected tint, the outline and the pointer cursor."
2. State, next to `cursor`:

```ts
  // The outlined category (selection only): where the pointer or the keys
  // are. From the keyboard one that can't be selected is outlined dashed, so
  // focus stays visible; the pointer outlines only selectable ones; never touch.
  const [outline, setOutline] = useState<{ index: number; keyboard: boolean } | null>(null)
```

3. `indexAt` takes `e: React.MouseEvent<SVGRectElement>` (a pointer event is one).
4. `onPointer`:

```ts
  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    const i = indexAt(e)
    if (i === null) return
    if (selection && e.pointerType === 'touch') {
      // A tap selects (onClick) and shows nothing: the page shows the selection.
      cursor.current = i
      if (popover.open) popover.hide()
      if (outline !== null) setOutline(null)
      return
    }
    const next = selection?.canSelect(rows[i]) ? { index: i, keyboard: false } : null
    const sameOutline = next?.index === outline?.index && next?.keyboard === outline?.keyboard
    // Moving within the same category (open, or one without a tooltip) changes
    // nothing: no re-render per pixel.
    if (
      i === cursor.current &&
      sameOutline &&
      (popover.open || tooltip(rows[i], i) === null)
    )
      return
    setAnnounced(null)
    if (selection && !sameOutline) setOutline(next)
    open(i)
  }
```

5. Click:

```ts
  const onClick = (e: React.MouseEvent<SVGRectElement>) => {
    if (!selection) return
    const i = indexAt(e)
    if (i !== null && selection.canSelect(rows[i])) selection.onSelect(i)
  }
```

6. `close()` also calls `setOutline(null)`.
7. `onKeyDown`, right after the Escape line:

```ts
    if (selection && (e.key === 'Enter' || e.key === ' ')) {
      // Space would scroll the page; Enter has nothing else to do here.
      e.preventDefault()
      const i = cursor.current
      if (i !== null && i < count && selection.canSelect(rows[i])) selection.onSelect(i)
      return
    }
```

   and after `open(next)`: `if (selection) setOutline({ index: next, keyboard: true })`.
8. Derived values before `const svg = …`:

```ts
  const selected =
    selection?.selected != null && selection.selected >= 0 && selection.selected < count
      ? selection.selected
      : null
  const outlined = selection && outline !== null && outline.index < count ? outline.index : null
  const dashed = outlined !== null && !selection?.canSelect(rows[outlined])
```

9. In the SVG `Group`: after the grid, before the series groups:

```tsx
        {selected === null ? null : (
          <rect
            data-slot="category-selected"
            x={geometry.x(selected) ?? 0}
            y={0}
            width={geometry.x.bandwidth()}
            height={geometry.plotH}
            fill="var(--brand)"
            fillOpacity={0.12}
            pointerEvents="none"
          />
        )}
```

   The x axis' `tickLabelProps={(v) => ({ ...tickLabel, dy: X_TICK_MARGIN, textAnchor: 'middle' as const,
   ...(Number(v) === selected ? { fontWeight: 600, fill: 'var(--foreground)' } : {}) })}`.
   After the axes, before the overlay (painted over the bars and the labels):

```tsx
        {outlined === null ? null : (
          // The whole column, its label included, inset so it never clips at the chart's edges.
          <rect
            data-slot="category-outline"
            x={(geometry.x(outlined) ?? 0) + 2}
            y={-4}
            width={Math.max(0, geometry.x.bandwidth() - 4)}
            height={geometry.plotH + 4 + X_AXIS_H}
            rx={6}
            fill="none"
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            strokeDasharray={dashed ? '4 3' : undefined}
            strokeOpacity={dashed ? 0.6 : 1}
            pointerEvents="none"
          />
        )}
```

10. The overlay: `height={geometry.plotH + (selection ? X_AXIS_H : 0)}` (with a comment: "with selection the labels
    are clickable too"), `style={{ touchAction: 'pan-y', cursor: outlined !== null && !outline?.keyboard ? 'pointer' : undefined }}`,
    `onClick={onClick}`, and its `onPointerLeave` also calls `setOutline(null)` for a non-touch pointer. If Biome
    flags the click handler (`useKeyWithClickEvents`), add
    `// biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the group's onKeyDown (Enter / Space)`.

- [ ] **Step 4: Run the chart tests**

Run: `bunx vitest run --project browser src/components/chart src/components/evCharging && bun run check:ci`
Expected: PASS, and Biome clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/chart/BarChart.tsx src/components/chart/BarChart.browser.test.tsx
git commit -m "refactor(charts): category selection in the visx BarChart"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`, told to
assume the selection breaks a 5a chart (a re-render per pointer pixel, a click doing something without
`selection`), the touch rule, or the keyboard (Space scrolling, Enter on a stale cursor after a refetch).

---

### Task 5: The Energi chart on `BarChart`

**Files:**
- Modify: `src/components/energy/EnergyMonthlyChart.tsx`
- Modify: `src/components/energy/EnergyMonthlyChart.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `BarChart`, `BarSeries`, `BarSelection` (Tasks 3–4); `CHART_HEIGHT`, `TooltipRow` from
  `~/components/chart/ChartParts`.
- `EnergyMonthlyChart`'s props and `energyMetricOptions` are unchanged (the route doesn't change).

- [ ] **Step 1: Add the keyboard hint**

`messages/sv.json`, after `energy_chart_select_hint`:
`"energy_chart_keyboard_hint": "Använd piltangenterna för att stega mellan månaderna och Enter för att välja en."`
`messages/en.json`, same place:
`"energy_chart_keyboard_hint": "Use the arrow keys to step through the months and Enter to select one."`
Run: `bun run i18n:compile`

- [ ] **Step 2: Update the tests for the approved keyboard and focus changes, and add the new ones**

In `EnergyMonthlyChart.browser.test.tsx`:
- "after a click, moving the pointer off…": delete the `document.activeElement?.classList.contains('recharts-surface')`
  line (accepted drift 3).
- The keyboard tests: focusing no longer shows January; the first → does (5a's decision). So:
  - "keyboard focus on a month without readings…": after `focusTarget(...)?.focus()`, press `{ArrowRight}` before
    waiting for the dashed outline; then `{ArrowRight}{ArrowRight}{ArrowRight}` reaches April (solid). Rename it
    "the keyboard on a month without readings shows a dashed outline, no tooltip".
  - "Space on the keyboard-focused month…" and "Enter on the keyboard-focused month…": four `{ArrowRight}` before
    the key, not three.
  - "a month without readings is not selectable": `{ArrowRight}{Enter}` instead of `{Enter}`.
- Add:

```ts
test('the chart is one Tab stop named by its title, with the month hint', async () => {
  const { screen } = await renderChart()
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  const group = screen.getByRole('group', { name: m.energy_chart_title({ year: '2026' }) })
  await expect.element(group).toBeInTheDocument()
  await expect.element(screen.getByText(m.energy_chart_keyboard_hint())).toBeInTheDocument()
})

test('Nät: export hangs below the zero line, the purchase stands on it', async () => {
  const { screen } = await render('grid')
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(27))
  const zero = (screen.container.querySelector('[data-zero-line]') as SVGLineElement).getBoundingClientRect().y
  // Series order: import direct, import battery, export.
  for (const bar of seriesBars(screen.container, 2))
    expect(bar.getBoundingClientRect().top).toBeCloseTo(zero, 0)
  for (const bar of seriesBars(screen.container, 0))
    expect(bar.getBoundingClientRect().bottom).toBeCloseTo(zero, 0)
})

test('switching the metric with a card open shows the new metric', async () => {
  const { screen } = await renderChart({ metric: 'solar' })
  await hoverBar(screen.container, 0) // April
  await vi.waitFor(() => expect(tooltipText()).toContain(m.energy_chart_total_solar()))
  screen.rerender(
    <div style={{ width: 720, height: 340 }}>
      <EnergyMonthlyChart
        year={2026}
        months={months}
        metric="grid"
        currentMonth={null}
        selectedMonth={null}
        onSelectMonth={vi.fn()}
      />
    </div>,
  )
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(m.energy_chart_total_grid())
    expect(tooltipText()).not.toContain(m.energy_chart_total_solar())
  })
})

test('a 320 px phone: initials, and the outline stays inside the chart at both ends', async () => {
  const { screen } = await renderChart({ data: allMonths, width: 320 })
  await vi.waitFor(() => expect(bars(screen.container).length).toBe(36))
  expect(xTickLabels(screen.container).every((l) => l.length === 1)).toBe(true)
  const svg = (screen.container.querySelector('svg[data-chart-svg]') as SVGSVGElement).getBoundingClientRect()
  for (const i of [0, 11]) {
    // Series 0's bars, month by month: [0] January, [11] December.
    await hoverBar(screen.container, i)
    const o = await vi.waitFor(() => {
      const el = outline(screen.container)
      expect(el).not.toBeNull()
      return (el as SVGGraphicsElement).getBoundingClientRect()
    })
    expect(o.left).toBeGreaterThanOrEqual(svg.left)
    expect(o.right).toBeLessThanOrEqual(svg.right)
  }
  // The widest y label is inside the chart.
  const yLabels = [...screen.container.querySelectorAll('[data-axis="y"] text')]
  for (const t of yLabels) expect(t.getBoundingClientRect().left).toBeGreaterThanOrEqual(svg.left)
})
```

Add `seriesBars` to the chartDom import. Move the `allMonths` constant above its first use if needed.

- [ ] **Step 3: Run them on recharts to see the new and changed ones fail**

Run: `bunx vitest run --project browser src/components/energy/EnergyMonthlyChart.browser.test.tsx`
Expected: the changed keyboard tests, the Tab-stop test, the Nät zero-line test and the 320 px test FAIL on
recharts; the rest PASS.

- [ ] **Step 4: Rewrite `EnergyMonthlyChart.tsx` on `BarChart`**

Keep `energyMetricOptions`, `seriesConfig`, `TOTAL_LABEL` and the `EnergyMetric` re-export. Delete `seriesOrder`,
`TICK_BAND`, `NARROW_COLUMN`, `Modality`, `MonthOutline`, `ChartProbe`, `MonthTick` and every recharts, `ui/chart`
and `evCharging/ChartFrame` import. Imports become:

```ts
import { BarChart, type BarSeries } from '~/components/chart/BarChart'
import { CHART_HEIGHT, TooltipRow } from '~/components/chart/ChartParts'
import {
  formatCount,
  formatOneDecimal,
  formatShare,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
import type { MetricOption } from '~/components/evCharging/MetricToggle'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import {
  type ChartRow,
  chartRows,
  type EnergyMetric,
  energyTooltipRows,
  isBelowAxis,
  METRIC_SERIES,
  type SeriesKey,
} from './energyTooltip'
```

The component (keep the existing header comment, updated: "visx `BarChart`; the chart owns hover, keyboard and
selection"):

```tsx
export function EnergyMonthlyChart({
  year,
  months,
  metric,
  currentMonth,
  selectedMonth,
  onSelectMonth,
}: {
  // … the same prop types and docs as today …
}) {
  if (months.every((p) => p === null)) {
    // … the empty-year state exactly as today (CHART_HEIGHT from ChartParts) …
  }
  const keys = METRIC_SERIES[metric]
  const config = seriesConfig()
  // The stack's top is rounded; on Nät that's the purchase's top (export hangs below).
  const top = keys[keys.length - (metric === 'grid' ? 2 : 1)]
  const series: BarSeries[] = keys.map((key) => ({
    key,
    label: config[key].label,
    color: config[key].color,
    stack: 'kwh',
    ...(key === top || isBelowAxis(metric, key) ? { radius: 2, roundEndOnly: true } : {}),
    // A 2 px surface gap between stacked segments.
    stroke: 'var(--card)',
    strokeWidth: 2,
  }))
  const rows = chartRows(metric, months)
  return (
    <div>
      <BarChart
        rows={rows}
        category={(r) => monthLabel(r.month)}
        shortCategory={(r) => monthLabel(r.month).charAt(0).toUpperCase()}
        series={series}
        value={(r, key) => r[key as SeriesKey] ?? null}
        stackOffset={metric === 'grid' ? 'diverging' : 'none'}
        zeroLine={metric === 'grid'}
        yTickFormat={formatCount}
        yIntegers
        tickPx={13}
        minBarPx={0}
        legend
        legendClassName="text-sm"
        tooltipTitle={false}
        tooltipClassName="min-w-56 gap-1 px-3 py-2 text-sm [&>div]:gap-1"
        tooltip={(r) =>
          r.sums ? (
            <EnergyTooltip row={r} sums={r.sums} metric={metric} currentMonth={currentMonth} />
          ) : null
        }
        label={m.energy_chart_title({ year: String(year) })}
        keyboardHint={m.energy_chart_keyboard_hint()}
        selection={{
          selected: selectedMonth === null ? null : selectedMonth - 1,
          onSelect: (i) => onSelectMonth(rows[i].month),
          canSelect: (r) => r.sums !== null,
        }}
      />
      <p className="mt-2 text-muted-foreground text-sm">{m.energy_chart_select_hint()}</p>
    </div>
  )
}
```

`EnergyTooltip` keeps its rows and order but drops its own card (the `BarChart` card is the card now):

```tsx
function EnergyTooltip({
  row,
  sums,
  metric,
  currentMonth,
}: {
  row: ChartRow
  sums: PeriodSums
  metric: EnergyMetric
  currentMonth: number | null
}) {
  const { parts, totalKwh } = energyTooltipRows(metric, sums)
  const gap = gapHours(energyFigures(sums))
  const config = seriesConfig()
  // … `stacked`, `after`, `rowFor` exactly as today …
  return (
    <>
      <div className="font-semibold text-sm">
        {monthName(row.month)}
        {row.month === currentMonth ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      {stacked.map(rowFor)}
      <TooltipRow label={TOTAL_LABEL[metric]()} strong share="">
        {formatOneDecimal(totalKwh)} kWh
      </TooltipRow>
      {after.map(rowFor)}
      {gap === null ? null : (
        <span className="text-muted-foreground">
          {m.energy_missing_hours({ hours: String(gap) })}
        </span>
      )}
    </>
  )
}
```

`BarChart` wraps the tooltip content in `<div className="grid gap-1.5">` inside the card. Today's Energi card spaces
its rows by `gap-1`, so `tooltipClassName` also carries `[&>div]:gap-1` (a child selector, more specific than the
inner div's `gap-1.5`): `tooltipClassName="min-w-56 gap-1 px-3 py-2 text-sm [&>div]:gap-1"`.

- [ ] **Step 5: Run the Energi tests and the whole browser project**

Run: `bunx vitest run --project browser src/components/energy src/components/chart src/components/evCharging`
Expected: PASS, including every test from Task 1 unchanged apart from Step 2's edits.

- [ ] **Step 6: Confirm `/energy` no longer reaches recharts**

Run: `git grep -n "recharts\|ui/chart'\|ChartFrame'" -- src/components/energy src/routes/_authenticated/energy`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/components/energy/EnergyMonthlyChart.tsx src/components/energy/EnergyMonthlyChart.browser.test.tsx messages/sv.json messages/en.json
git commit -m "refactor(energy): draw the month chart with the visx bar chart"
```

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`, told to
assume a preserved behaviour (Global constraints' list) or the tooltip content changed.

---

### Task 6: Verify, measure, record

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md`

- [ ] **Step 1: Measure the bundle**

Run: `bun run bundle:measure 2>&1 | tail -60`
Expected: `/energy`'s `packages:` line has no `recharts`; its total drops by roughly the recharts chunk (~80 KB gz).
The 5a pages and the shell move by at most 1–2 KB. `/sensors` keeps recharts (5c).

- [ ] **Step 2: The pre-PR gate**

Run the gate from `docs/feature-workflow.md` (`bun run check`, `check:ci`, `build`, `db:up && db:migrate`, `test`,
the sv/en key check). Expected: all green; paste the output in the PR.

- [ ] **Step 3: Live check at three widths**

Follow the `live-ui-check-playwright` memory (worktree Playwright + Mailpit magic link on :14610; wait for load + 4 s,
never `networkidle`). On `/energy` with local data, at 1280, 768 and 375 px, for Solel, Nät and Förbrukning:
- the bars, the legend and the colours match `main` side by side (open `main`'s dev server the same way for
  screenshots);
- hover shows the outline and the card above the month; hovering a label does the same (drift 1);
- a click selects (tint, bold label, the summary above updates); a month without readings can't be selected;
- Tab reaches the chart, → walks the months with the dashed outline on empty ones, Enter selects;
- at 375 px the labels are initials, the first and last months' outlines and cards stay inside the window, and the
  y labels aren't clipped;
- Nät: export below the zero line.
Save screenshots under the scratchpad; attach the key ones to the PR.

- [ ] **Step 4: Record in the roadmap**

Row 5b: PR link, status `PR open`. In "Step 5b notes": the before/after bundle table (from Task 0 and Step 1), the
accepted drift (already there), and any follow-ups the reviews found.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/roadmaps/2026-10-05-client-performance.md
git commit -m "docs(perf): record the Energi chart's bundle and review notes"
```

Then the branch review (`code-reviewer` + a general correctness pass told to look for moved behaviour), fix
findings in this PR, and open the PR titled `refactor(energy): draw the month chart with visx`.

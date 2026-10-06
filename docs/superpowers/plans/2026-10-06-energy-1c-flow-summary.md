# House energy, step 1c: the Summering card as a flow diagram — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/energy`, the Summering card shows the chosen period as a flow diagram: Solel and Köpt el in, the
battery (with its loss) in the middle, Förbrukning and Såld el out, arrows as wide as their kWh and coloured by
where the energy came from, big icon tiles, values on the arrows behind a "Visa värden" switch, and Självförsörjning
as the card's first line. Nothing shifts when the period changes.

**Architecture:** `figures.ts` gains the two battery-outflow values. A new pure, client-safe `flowLayout.ts` owns the
geometry (nodes, arrows, curves, widths, the loss stub, the text positions inside a node) for a given width, so all
of it is unit-tested in node. `EnergyFlowDiagram` draws that geometry in SVG with visx (`@visx/group`, the visx-based
`ChartPopover`); `EnergyFlow` is the card body (Självförsörjning line, the reserved diagram box measured with
`@visx/responsive`, the switch, the gap note, the table). The page swaps `EnergyReadouts` for `EnergyFlow`.

**Tech Stack:** React 19, visx 4.0.0 (`@visx/group`, `@visx/responsive`, `@visx/tooltip` through `ChartPopover`),
lucide-react ^1.23 icons, shadcn `Switch` (Radix, added in Task 4), Tailwind v4 container queries, Paraglide,
Vitest (node + browser), Playwright for the live check.

**Spec:** [`docs/superpowers/specs/2026-10-06-energy-flow-summary-design.md`](../specs/2026-10-06-energy-flow-summary-design.md)
(amends [`2026-10-05-energy-period-control-design.md`](../specs/2026-10-05-energy-period-control-design.md) and
[`2026-10-05-house-energy-pages-design.md`](../specs/2026-10-05-house-energy-pages-design.md))
· ADR: [`0024`](../../adr/0024-house-energy-pages.md) decision 4 (amended)
· Roadmap: [`2026-10-05-house-energy-pages.md`](../roadmaps/2026-10-05-house-energy-pages.md) (step 1c)
· Mockup the owner approved: <https://claude.ai/artifact/EuLriFUiKZcpxnaYhXDDHB> (version 4). Its geometry is the
reference; read it (`Artifact` tool, `action: "read"`) when a number here is unclear.

## Global Constraints

- Read-only, no schema change, no new request: everything comes from the period's `PeriodSums` via `energyFigures`.
- Client code only `import type` from services; `figures.ts` and `flowLayout.ts` are client-safe (in the guard).
- **No layout shift**: changing the period moves no element. The diagram box has a fixed height per layout (360 px
  from a card width of 860 px, else 490 px), reserved by a container query before it is measured; nodes never move.
- **Colours in the diagram: only the three source colours** — arrows from Solel `var(--energy-solar)`, from Köpt el
  `var(--energy-grid)`, from the battery `var(--energy-battery)`; source icon tiles tinted
  `color-mix(in oklab, <colour> 24%, <node surface>)`; out-node tiles neutral. No `--energy-house`, `--energy-car`,
  `--energy-export` in the diagram (validator fails).
- **Sizes**: node label 14 px medium; node figure 28 px (24 px narrow) semibold, unit 14 px muted; battery loss
  figure 20 px (18 px narrow); charge level 13 px muted; arrow values 14 px semibold in a pill; Självförsörjning
  figure 28 px (24 px narrow); hint, switch label, gap note 14 px; icon tiles 48 px / 28 px icon (wide), 34 px /
  20 px icon (narrow). No `text-xs` on the card.
- **Text block centred on its icon tile** (label cap top to figure baseline, cap height ≈ 0.7 em), within 2 px.
- **Loss**: |loss| < 0.5 kWh or negative → "≈ 0 kWh", no stub; the table and tooltip show the real value.
- An arrow below 0.05 kWh isn't drawn. Arrow width = max(2, 20 × kWh ÷ the period's largest arrow) (16 narrow);
  the loss stub uses the same scale with a 4 px minimum.
- "Visa värden": on by default, `localStorage` key `videbacken-energy-flow-values`, server snapshot "on".
- User-facing text via Paraglide (sv source, en key-complete). Synthetic data only in tests.
- Conventional Commits, one hat per commit. PR title: `feat(energy): show the summary as an energy flow diagram`.

## Review Focus

1. **Storage blocked** (private window, blocked site data): `localStorage` throws. The switch must still hide and
   show the values for the session, and the page must not crash. Pinned in Task 4 (`useLocalStorageFlag` with a
   throwing storage).
2. **A flow that is zero or tiny** (January: 4,4 kWh sold; a month without charging; a sunless December): that
   arrow is dropped (no "0,0" pill, no 2 px sliver for 0,01 kWh), the car lines are blank but keep their space.
   Pinned in Task 2 (`drawnFlows`) and Task 5 (no car).
3. **A small or negative battery loss** (October's partial month: 0,66 kWh; a period where the SoC rose more than
   the meters show: −1,2 kWh): "≈ 0 kWh", no stub, the table shows the real value. Pinned in Task 2
   (`lossStub`, `lossLabel`) and Task 5.
4. **Batteri → Såld el present** (export above the solar surplus; zero in every 2026 month so far): the arrow is
   drawn, is the only one allowed to cross another (Solel → Förbrukning), and its tooltip names it. Pinned in Task 2
   (the crossing test's single allowed pair) and Task 5.
5. **The widest figures on the narrowest card** (Totalt at 390 px: "9 366,6 kWh" in a 150 px node; February's
   1 631,7 kWh arrow next to a 17,9 kWh one): text stays inside its node; thin arrows keep 2 px. Pinned in Task 2
   (width scale) and measured live in Task 7.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/houseEnergy/figures.ts` (+ test) (modify) | `batteryToGrid`, `batteryToHouse` |
| `src/lib/houseEnergy/flowLayout.ts` (create) | Pure geometry: `flowLayout`, `flowCurve`, `arrowHead`, `flowWidth`, `edgeKwh`, `drawnFlows`, `lossStub`, `lossLabel`, `nodeText` |
| `src/lib/houseEnergy/flowLayout.test.ts` (create) | Node tests: bounds, overlap, ports, crossings, widths, loss, text centring |
| `src/lib/houseEnergy/clientSafe.browser.test.tsx` (modify) | Add `flowLayout.ts` to the guard |
| `src/hooks/useLocalStorageFlag.ts` (+ `.browser.test.tsx`) (create) | A boolean remembered in `localStorage`, memory fallback, SSR snapshot |
| `src/components/ui/switch.tsx` (create via shadcn CLI) | Radix switch |
| `src/components/evCharging/ChartPopover.tsx` (modify) | Optional `className` (the energy tooltip is a 14 px card, not the 12 px pill) |
| `src/components/energy/EnergyFlowDiagram.tsx` (+ `.browser.test.tsx`) (create) | The SVG: nodes, icon tiles, arrows, pills, loss stub, tooltip |
| `src/components/energy/EnergyFlow.tsx` (+ `.browser.test.tsx`) (create) | The card body: Självförsörjning line, reserved box, switch, gap note, table, empty states |
| `src/components/energy/EnergyTiles.tsx` (+ test) (delete) | Replaced by `EnergyFlow` |
| `src/routes/_authenticated/energy/index.tsx` (+ `-energyPage.browser.test.tsx`) (modify) | Use `EnergyFlow` |
| `src/bones/energy-tiles.bones.json` (regenerate) | `bun run bones:capture /energy --force` |
| `messages/sv.json`, `messages/en.json` (modify) | `energy_flow_*`; remove the old tile-only keys |
| `docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md` (modify) | Row 1c → `PR open`, log line |

---

### Task 0: Verify `main` still matches this plan

**Files:** none (read-only), then the worktree.

- [ ] **Step 1: Check the seams this plan names**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "export function energyFigures\|importDirect\|batteryOut\|deltaStored\|efficiency" src/lib/houseEnergy/figures.ts
grep -n "export function EnergyReadouts" src/components/energy/EnergyTiles.tsx
grep -n "EnergyReadouts\|energyTilesBones" src/routes/_authenticated/energy/index.tsx
grep -n "export function useChartPopover\|export function ChartPopover\|className=" src/components/evCharging/ChartPopover.tsx
grep -n "useParentSize" src/components/evCharging/WeekdayHourHeatmap.tsx
grep -n '"@visx/group"\|"@visx/responsive"\|"@visx/tooltip"\|"lucide-react"' package.json
ls node_modules/lucide-react/dist/esm/icons/{solar-panel,utility-pole,battery-medium,house,coins}.mjs
ls src/components/ui/switch.tsx 2>/dev/null || echo "switch not installed (expected)"
grep -n "export function formatOneDecimal\|export function formatShare" src/components/evCharging/format.ts
```

Expected: every grep prints a line, the five icon files exist, `switch.tsx` is absent. If step 2 (Batteri) merged
first, it may reuse `EnergyReadouts`/`Readout`: keep `Readout` (in `TotalsTiles.tsx`) untouched and only delete
`EnergyTiles.tsx` if nothing else imports it.

- [ ] **Step 2: Create the worktree** (no `+` in the path; it hangs Vitest browser mode)

```bash
git worktree add .claude/worktrees/energy-flow-summary -b feat/energy-flow-summary origin/main
cd .claude/worktrees/energy-flow-summary && cp ../../../.env .env 2>/dev/null; bun install && bun run db:up && bun run db:migrate
```

---

### Task 1: The battery's outflows in `figures.ts`

**Reviewers:** `code-reviewer` · `test-completeness`

**Files:**
- Modify: `src/lib/houseEnergy/figures.ts`
- Test: `src/lib/houseEnergy/figures.test.ts`

**Interfaces:**
- Produces: `EnergyFigures.batteryToGrid: number`, `EnergyFigures.batteryToHouse: number` (kWh, ≥ 0).

- [ ] **Step 1: Write the failing tests** (append to `figures.test.ts`; `sums()` is the file's existing helper)

```ts
test('battery to grid is the export the solar surplus cannot explain', () => {
  // 10 kWh solar, 8 into the battery: 2 kWh of solar could be sold; the other 3 kWh came from the battery.
  const f = energyFigures(sums({ solarKwh: 10, batteryChargeSolarKwh: 8, gridExportKwh: 5, batteryDischargeKwh: 20 }))
  expect(f.batteryToGrid).toBe(3)
  expect(f.batteryToHouse).toBe(17)
})

test('export within the solar surplus leaves nothing from the battery to the grid', () => {
  const f = energyFigures(sums({ solarKwh: 500, batteryChargeSolarKwh: 170, gridExportKwh: 110, batteryDischargeKwh: 90 }))
  expect(f.batteryToGrid).toBe(0)
  expect(f.batteryToHouse).toBe(90)
})

test('battery to house is never negative', () => {
  // More export beyond the surplus than the battery discharged (meter noise): the house gets 0, not −2.
  const f = energyFigures(sums({ gridExportKwh: 5, batteryDischargeKwh: 3 }))
  expect(f.batteryToGrid).toBe(5)
  expect(f.batteryToHouse).toBe(0)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run src/lib/houseEnergy/figures.test.ts`
Expected: FAIL (`batteryToGrid` is `undefined`).

- [ ] **Step 3: Implement**

In `EnergyFigures` (after `importDirect`):

```ts
  /** Export the solar surplus can't explain: it came out of the battery. */
  batteryToGrid: number
  /** What the battery delivered to the house: its discharge minus `batteryToGrid`. */
  batteryToHouse: number
```

In `energyFigures`, after `importToBattery`:

```ts
  const batteryToGrid = Math.max(0, p.gridExportKwh - solarExported)
```

and in the returned object, after `importDirect`:

```ts
    batteryToGrid,
    batteryToHouse: Math.max(0, p.batteryDischargeKwh - batteryToGrid),
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/lib/houseEnergy/figures.test.ts`
Expected: PASS (all, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/houseEnergy/figures.ts src/lib/houseEnergy/figures.test.ts
git commit -m "feat(energy): split the battery's discharge into house and grid"
```

---

### Task 2: The diagram's geometry (`flowLayout.ts`)

**Reviewers:** `code-reviewer` · `test-completeness`

**Files:**
- Create: `src/lib/houseEnergy/flowLayout.ts`
- Test: `src/lib/houseEnergy/flowLayout.test.ts`
- Modify: `src/lib/houseEnergy/clientSafe.browser.test.tsx`

**Interfaces:**
- Consumes: `EnergyFigures` (Task 1).
- Produces (all exported from `~/lib/houseEnergy/flowLayout`):
  - `type FlowNodeKey = 'sol' | 'imp' | 'bat' | 'exp' | 'load'`; `type Side = 'l' | 'r' | 't' | 'b'`
  - `type FlowNode = { x: number; y: number; w: number; h: number }` (centre, size)
  - `type FlowEdgeSpec = { from: FlowNodeKey; to: FlowNodeKey; fromSide: Side; fromOffset: number; toSide: Side; toOffset: number; k1: number; k2: number; labelT: number }`
  - `type FlowLayout = { narrow: boolean; height: number; nodes: Record<FlowNodeKey, FlowNode>; edges: FlowEdgeSpec[]; loss: { side: 'b' | 'r'; offset: number; length: number } }`
  - `WIDE_MIN_WIDTH = 860`, `WIDE_HEIGHT = 360`, `NARROW_HEIGHT = 490`, `MIN_FLOW_KWH = 0.05`, `MIN_LOSS_KWH = 0.5`
  - `flowLayout(width: number): FlowLayout`
  - `flowCurve(layout: FlowLayout, e: FlowEdgeSpec): { d: string; at: (t: number) => { x: number; y: number }; tip: { x: number; y: number; dx: number; dy: number } }`
  - `arrowHead(tip, width: number): string` (polygon `points`)
  - `flowWidth(kwh: number, max: number, narrow: boolean): number`
  - `edgeKwh(f: EnergyFigures, from: FlowNodeKey, to: FlowNodeKey): number`
  - `drawnFlows(layout: FlowLayout, f: EnergyFigures): { spec: FlowEdgeSpec; kwh: number }[]` (≥ `MIN_FLOW_KWH`)
  - `lossStub(layout: FlowLayout, lossKwh: number, max: number): { x: number; y: number; width: number; height: number; side: 'b' | 'r' } | null`
  - `lossLabel(lossKwh: number): 'about-zero' | 'value'`
  - `nodeText(node: FlowNode, key: FlowNodeKey, narrow: boolean): NodeText` with
    `type NodeText = { tile: { x: number; y: number; size: number; icon: number }; label: { x: number; y: number }; value: { x: number; y: number; size: number }; second: { x: number; y: number } | null; third: { x: number; y: number } | null }`
    (`second`/`third`: the battery's loss and charge-level lines, or Förbrukning's two car lines; `null` elsewhere).

- [ ] **Step 1: Write the failing tests** (`src/lib/houseEnergy/flowLayout.test.ts`)

```ts
import { describe, expect, test } from 'vitest'
import { energyFigures, type PeriodSums } from './figures'
import {
  arrowHead,
  drawnFlows,
  edgeKwh,
  type FlowLayout,
  type FlowNodeKey,
  flowCurve,
  flowLayout,
  flowWidth,
  lossLabel,
  lossStub,
  MIN_FLOW_KWH,
  NARROW_HEIGHT,
  nodeText,
  WIDE_HEIGHT,
} from './flowLayout'

// Card content widths: phone (390 px viewport), tablet (820), desktop (1440, the page's max width).
const WIDTHS = [324, 754, 1006]

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 145.8, gridExportKwh: 15.5, solarKwh: 76.9, loadKwh: 200.6, batteryDischargeKwh: 49,
  batteryChargeSolarKwh: 21.8, batteryChargeGridKwh: 34, carKwh: 28.4, firstSocPct: 19, lastSocPct: 100,
  buckets: 1568, expectedBuckets: 1568, ...over,
})

const rects = (l: FlowLayout) =>
  Object.entries(l.nodes).map(([key, n]) => ({ key, x0: n.x - n.w / 2, x1: n.x + n.w / 2, y0: n.y - n.h / 2, y1: n.y + n.h / 2 }))

describe.each(WIDTHS)('at %i px', (width) => {
  const layout = flowLayout(width)

  test('the layout and height follow the width', () => {
    expect(layout.narrow).toBe(width < 860)
    expect(layout.height).toBe(width < 860 ? NARROW_HEIGHT : WIDE_HEIGHT)
  })

  test('every node lies inside the box and no two nodes overlap', () => {
    const r = rects(layout)
    for (const a of r) {
      expect(a.x0).toBeGreaterThanOrEqual(0)
      expect(a.x1).toBeLessThanOrEqual(width)
      expect(a.y0).toBeGreaterThanOrEqual(0)
      expect(a.y1).toBeLessThanOrEqual(layout.height)
      for (const b of r) {
        if (a === b) continue
        const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0
        expect(apart, `${a.key} overlaps ${b.key}`).toBe(true)
      }
    }
  })

  test('each arrow ends on its target node edge, pointing in', () => {
    for (const e of layout.edges) {
      const { tip } = flowCurve(layout, e)
      const n = layout.nodes[e.to]
      const onEdge =
        (Math.abs(tip.x - (n.x - n.w / 2)) < 0.01 || Math.abs(tip.x - (n.x + n.w / 2)) < 0.01) ||
        (Math.abs(tip.y - (n.y - n.h / 2)) < 0.01 || Math.abs(tip.y - (n.y + n.h / 2)) < 0.01)
      expect(onEdge, `${e.from}>${e.to}`).toBe(true)
      expect(tip.x).toBeGreaterThanOrEqual(n.x - n.w / 2 - 0.01)
      expect(tip.x).toBeLessThanOrEqual(n.x + n.w / 2 + 0.01)
    }
  })

  test('no arrow passes through a node', () => {
    for (const e of layout.edges) {
      const c = flowCurve(layout, e)
      for (let t = 0.06; t <= 0.94; t += 0.02) {
        const p = c.at(t)
        for (const r of rects(layout)) {
          const inside = p.x > r.x0 + 1 && p.x < r.x1 - 1 && p.y > r.y0 + 1 && p.y < r.y1 - 1
          expect(inside, `${e.from}>${e.to} at t=${t.toFixed(2)} inside ${r.key}`).toBe(false)
        }
      }
    }
  })

  test('no two arrows cross, except battery → sold with solar → consumption', () => {
    // Battery → sold can't avoid solar → consumption: that arrow separates the battery from Såld el
    // (spec "Geometry"). It is drawn only when export exceeds the solar surplus (zero in every 2026 month).
    const allowed = new Set(['bat>exp|sol>load', 'sol>load|bat>exp'])
    const polyline = (e: (typeof layout.edges)[number]) => {
      const c = flowCurve(layout, e)
      return Array.from({ length: 41 }, (_, i) => c.at(0.08 + (0.84 * i) / 40))
    }
    const cross = (p: { x: number; y: number }[], q: { x: number; y: number }[]) => {
      const side = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
        Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
      for (let i = 1; i < p.length; i++)
        for (let j = 1; j < q.length; j++)
          if (side(p[i - 1], p[i], q[j - 1]) * side(p[i - 1], p[i], q[j]) < 0 &&
              side(q[j - 1], q[j], p[i - 1]) * side(q[j - 1], q[j], p[i]) < 0) return true
      return false
    }
    for (const a of layout.edges)
      for (const b of layout.edges) {
        if (a === b) continue
        const pair = `${a.from}>${a.to}|${b.from}>${b.to}`
        if (allowed.has(pair)) continue
        expect(cross(polyline(a), polyline(b)), pair).toBe(false)
      }
  })

  test('each node text block is centred on its icon tile (cap height 0.7 em)', () => {
    for (const [key, node] of Object.entries(layout.nodes) as [FlowNodeKey, (typeof layout.nodes)['sol']][]) {
      const t = nodeText(node, key, layout.narrow)
      const tileCentre = t.tile.y + t.tile.size / 2
      // Wide: label cap top to the last line's baseline. Narrow: the label alone shares the tile's row.
      const capTop = t.label.y - 14 * 0.7
      const bottom = layout.narrow ? t.label.y : key === 'bat' ? (t.third?.y ?? t.value.y) : t.value.y
      expect(Math.abs((capTop + bottom) / 2 - tileCentre), key).toBeLessThanOrEqual(2)
      expect(t.tile.y).toBeGreaterThanOrEqual(node.y - node.h / 2)
    }
  })
})

test('widths are linear in kWh with a 2 px floor', () => {
  expect(flowWidth(1631.7, 1631.7, false)).toBe(20)
  expect(flowWidth(815.85, 1631.7, false)).toBeCloseTo(10)
  expect(flowWidth(17.9, 1631.7, false)).toBe(2)
  expect(flowWidth(1631.7, 1631.7, true)).toBe(16)
})

test('every arrow carries the figure the spec names', () => {
  const f = energyFigures(sums())
  const pairs: [FlowNodeKey, FlowNodeKey, number][] = [
    ['sol', 'load', f.solarDirect], ['sol', 'bat', f.solarToBattery], ['sol', 'exp', f.solarExported],
    ['imp', 'load', f.importDirect], ['imp', 'bat', f.importToBattery],
    ['bat', 'load', f.batteryToHouse], ['bat', 'exp', f.batteryToGrid],
  ]
  for (const [from, to, kwh] of pairs) expect(edgeKwh(f, from, to), `${from}>${to}`).toBe(kwh)
})

test('arrows below 0.05 kWh are not drawn', () => {
  // October 2026: export within the solar surplus, so battery → sold is 0.
  const flows = drawnFlows(flowLayout(1006), energyFigures(sums()))
  expect(flows.map((x) => `${x.spec.from}>${x.spec.to}`)).not.toContain('bat>exp')
  expect(flows.every((x) => x.kwh >= MIN_FLOW_KWH)).toBe(true)
  const tiny = drawnFlows(flowLayout(1006), energyFigures(sums({ gridExportKwh: 0.04, solarKwh: 21.84 })))
  expect(tiny.map((x) => `${x.spec.from}>${x.spec.to}`)).not.toContain('sol>exp')
})

test('the loss stub appears from 0.5 kWh, at least 4 px wide', () => {
  const wide = flowLayout(1006)
  expect(lossStub(wide, 0.49, 100)).toBeNull()
  expect(lossStub(wide, -1.2, 100)).toBeNull()
  const s = lossStub(wide, 0.66, 111.8)
  expect(s?.side).toBe('b')
  expect(s?.width).toBe(4)
  expect(lossStub(flowLayout(324), 118.3, 1631.7)?.side).toBe('r')
})

test('a loss below 0.5 kWh or negative reads "about zero"', () => {
  expect(lossLabel(0.66)).toBe('value')
  expect(lossLabel(0.49)).toBe('about-zero')
  expect(lossLabel(-0.2)).toBe('about-zero')
  expect(lossLabel(-1.2)).toBe('about-zero')
})

test('the arrowhead is a triangle whose tip sits on the node edge', () => {
  const pts = arrowHead({ x: 100, y: 50, dx: -1, dy: 0 }, 10).split(' ')
  expect(pts).toHaveLength(3)
  expect(pts[0]).toBe('100,50')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run src/lib/houseEnergy/flowLayout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/houseEnergy/flowLayout.ts`**

```ts
// Client-safe, pure (step 1c, ADR-0024). The Summering flow diagram's geometry for a given width: where the five
// nodes sit, which arrows join them, the cubic each arrow draws, arrow widths, the battery's loss stub and where a
// node's text goes. Numbers from the approved mockup (spec "Geometry"); the component only draws them.
import type { EnergyFigures } from './figures'

export type FlowNodeKey = 'sol' | 'imp' | 'bat' | 'exp' | 'load'
export type Side = 'l' | 'r' | 't' | 'b'
/** Centre and size. */
export type FlowNode = { x: number; y: number; w: number; h: number }
export type FlowEdgeSpec = {
  from: FlowNodeKey
  to: FlowNodeKey
  fromSide: Side
  fromOffset: number
  toSide: Side
  toOffset: number
  /** How far each end keeps its side's direction, as a share of the distance along that axis. */
  k1: number
  k2: number
  /** Where on the curve the value pill sits. */
  labelT: number
}
export type FlowLayout = {
  narrow: boolean
  height: number
  nodes: Record<FlowNodeKey, FlowNode>
  edges: FlowEdgeSpec[]
  loss: { side: 'b' | 'r'; offset: number; length: number }
}
type Point = { x: number; y: number }
type Port = Point & { dx: number; dy: number }

/** From this card width the in → out layout runs left to right; below it, top to bottom. */
export const WIDE_MIN_WIDTH = 860
export const WIDE_HEIGHT = 360
export const NARROW_HEIGHT = 490
/** Below this an arrow would read "0,0": not drawn. */
export const MIN_FLOW_KWH = 0.05
/** Below this (or negative) the loss reads "≈ 0" and has no stub (house energy design, display rules). */
export const MIN_LOSS_KWH = 0.5
const ARROW_LENGTH = 9

const edge = (
  from: FlowNodeKey,
  to: FlowNodeKey,
  fromSide: Side,
  fromOffset: number,
  toSide: Side,
  toOffset: number,
  k1 = 0.5,
  k2 = 0.5,
  labelT = 0.5,
): FlowEdgeSpec => ({ from, to, fromSide, fromOffset, toSide, toOffset, k1, k2, labelT })

export function flowLayout(width: number): FlowLayout {
  if (width >= WIDE_MIN_WIDTH) {
    const nw = 236
    const h = 80
    const hLoad = 124
    const H = WIDE_HEIGHT
    const L = nw / 2 + 1
    const R = width - nw / 2 - 1
    return {
      narrow: false,
      height: H,
      nodes: {
        sol: { x: L, y: 46, w: nw, h },
        imp: { x: L, y: H - 46, w: nw, h },
        bat: { x: width / 2, y: H / 2 - 10, w: nw, h: 84 },
        exp: { x: R, y: 46, w: nw, h },
        load: { x: R, y: H - hLoad / 2 - 2, w: nw, h: hLoad },
      },
      edges: [
        edge('sol', 'exp', 'r', -22, 'l', 0),
        edge('sol', 'load', 'r', -2, 't', -20),
        edge('sol', 'bat', 'r', 20, 't', -26),
        edge('imp', 'bat', 'r', -20, 'b', -26),
        edge('imp', 'load', 'r', 14, 'l', 30),
        edge('bat', 'load', 'r', 0, 'l', -14),
        edge('bat', 'exp', 't', 26, 'b', -30),
      ],
      loss: { side: 'b', offset: 40, length: 44 },
    }
  }
  const nw = Math.min(220, Math.floor((width - 24) / 2))
  const h = 82
  const hLoad = 134
  const H = NARROW_HEIGHT
  // Offsets were tuned at a 146 px node; they scale with it so a tablet-wide card keeps the arrows apart.
  const k = nw / 146
  const L = nw / 2 + 1
  const R = width - nw / 2 - 1
  return {
    narrow: true,
    height: H,
    nodes: {
      sol: { x: L, y: 43, w: nw, h },
      imp: { x: R, y: 43, w: nw, h },
      bat: { x: width / 2 + 14 * k, y: 226, w: Math.min(190, nw + 4), h: 82 },
      exp: { x: L, y: H - 43, w: nw, h },
      load: { x: R, y: H - hLoad / 2 - 2, w: nw, h: hLoad },
    },
    edges: [
      edge('sol', 'exp', 'b', -50 * k, 't', -50 * k),
      // Keeps its downward start long so it passes under the battery.
      edge('sol', 'load', 'b', -22 * k, 't', -52 * k, 0.9, 0.25),
      edge('sol', 'bat', 'b', 30 * k, 't', -24 * k),
      edge('imp', 'bat', 'b', -34 * k, 't', 24 * k),
      // Its value sits high, clear of the loss stub.
      edge('imp', 'load', 'b', 46 * k, 't', 48 * k, 0.5, 0.5, 0.22),
      edge('bat', 'load', 'b', 30 * k, 't', 0),
      edge('bat', 'exp', 'b', -20 * k, 't', 20 * k),
    ],
    loss: { side: 'r', offset: 4, length: Math.min(30, 18 * k) },
  }
}

const NORMAL: Record<Side, [number, number]> = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] }

function port(n: FlowNode, side: Side, offset: number): Port {
  const [dx, dy] = NORMAL[side]
  return {
    x: n.x + (dx * n.w) / 2 + (dy !== 0 ? offset : 0),
    y: n.y + (dy * n.h) / 2 + (dx !== 0 ? offset : 0),
    dx,
    dy,
  }
}

/** A cubic from the source port to just outside the target port; the arrowhead fills the last 9 px. */
export function flowCurve(layout: FlowLayout, e: FlowEdgeSpec) {
  const a = port(layout.nodes[e.from], e.fromSide, e.fromOffset)
  const tip = port(layout.nodes[e.to], e.toSide, e.toOffset)
  const end = { x: tip.x + tip.dx * ARROW_LENGTH, y: tip.y + tip.dy * ARROW_LENGTH }
  const k1 = Math.max(16, e.k1 * Math.abs(a.dx ? end.x - a.x : end.y - a.y))
  const k2 = Math.max(16, e.k2 * Math.abs(tip.dx ? end.x - a.x : end.y - a.y))
  const c1 = { x: a.x + a.dx * k1, y: a.y + a.dy * k1 }
  const c2 = { x: end.x + tip.dx * k2, y: end.y + tip.dy * k2 }
  const at = (t: number): Point => {
    const m = 1 - t
    return {
      x: m ** 3 * a.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t ** 3 * end.x,
      y: m ** 3 * a.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t ** 3 * end.y,
    }
  }
  return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`, at, tip }
}

/** A triangle from the tip (on the node edge) back along the side's normal. */
export function arrowHead(tip: Port, width: number): string {
  const half = Math.max(5, width / 2 + 4)
  const bx = tip.x + tip.dx * ARROW_LENGTH
  const by = tip.y + tip.dy * ARROW_LENGTH
  const px = -tip.dy
  const py = tip.dx
  return `${tip.x},${tip.y} ${bx + px * half},${by + py * half} ${bx - px * half},${by - py * half}`
}

/** Linear in kWh (the widths are the data), with a floor so a small flow stays visible. */
export function flowWidth(kwh: number, max: number, narrow: boolean): number {
  return Math.max(2, ((narrow ? 16 : 20) * kwh) / max)
}

export function edgeKwh(f: EnergyFigures, from: FlowNodeKey, to: FlowNodeKey): number {
  switch (`${from}>${to}`) {
    case 'sol>load': return f.solarDirect
    case 'sol>bat': return f.solarToBattery
    case 'sol>exp': return f.solarExported
    case 'imp>load': return f.importDirect
    case 'imp>bat': return f.importToBattery
    case 'bat>load': return f.batteryToHouse
    case 'bat>exp': return f.batteryToGrid
    default: return 0
  }
}

export function drawnFlows(layout: FlowLayout, f: EnergyFigures) {
  return layout.edges
    .map((spec) => ({ spec, kwh: edgeKwh(f, spec.from, spec.to) }))
    .filter((x) => x.kwh >= MIN_FLOW_KWH)
}

export function lossLabel(lossKwh: number): 'about-zero' | 'value' {
  return lossKwh < MIN_LOSS_KWH ? 'about-zero' : 'value'
}

/** The stub that leaves the battery, on the arrows' width scale (4 px floor), or null when the loss reads ≈ 0. */
export function lossStub(layout: FlowLayout, lossKwh: number, max: number) {
  if (lossLabel(lossKwh) === 'about-zero') return null
  const b = layout.nodes.bat
  const w = Math.max(4, flowWidth(lossKwh, max, layout.narrow))
  const { side, offset, length } = layout.loss
  return side === 'b'
    ? { side, x: b.x + offset - w / 2, y: b.y + b.h / 2, width: w, height: length }
    : { side, x: b.x + b.w / 2, y: b.y + offset - w / 2, width: length, height: w }
}

export type NodeText = {
  tile: { x: number; y: number; size: number; icon: number }
  label: Point
  value: Point & { size: number }
  second: Point | null
  third: Point | null
}

/**
 * Where a node's tile and text go. Wide: the tile left of the text, the text block (label cap top to the last
 * baseline, cap height ≈ 0.7 em) centred on the tile. Narrow: the tile and the label share the first row, the
 * figure runs the node's width below. `second`/`third`: the battery's loss and charge-level lines, or
 * Förbrukning's two car lines.
 */
export function nodeText(node: FlowNode, key: FlowNodeKey, narrow: boolean): NodeText {
  const x0 = node.x - node.w / 2
  const y0 = node.y - node.h / 2
  if (narrow) {
    const tile = { x: x0 + 12, y: y0 + 10, size: 34, icon: 20 }
    const label = { x: tile.x + 34 + 10, y: tile.y + 22 }
    if (key === 'bat') return { tile, label, value: { x: x0 + 12, y: y0 + 70, size: 18 }, second: null, third: null }
    const car = key === 'load'
    return {
      tile,
      label,
      value: { x: x0 + 12, y: y0 + 72, size: 24 },
      second: car ? { x: x0 + 12, y: y0 + node.h - 32 } : null,
      third: car ? { x: x0 + 12, y: y0 + node.h - 13 } : null,
    }
  }
  if (key === 'bat') {
    const tile = { x: x0 + 12, y: y0 + (node.h - 48) / 2, size: 48, icon: 28 }
    const tx = tile.x + 48 + 12
    return {
      tile,
      label: { x: tx, y: y0 + 25 },
      value: { x: tx, y: y0 + 50, size: 20 },
      second: null,
      third: { x: tx, y: y0 + 69 },
    }
  }
  const tile = { x: x0 + 12, y: y0 + 16, size: 48, icon: 28 }
  const tx = tile.x + 48 + 12
  const car = key === 'load'
  return {
    tile,
    label: { x: tx, y: tile.y + 14 },
    value: { x: tx, y: tile.y + 44, size: 28 },
    second: car ? { x: tx, y: y0 + node.h - 32 } : null,
    third: car ? { x: tx, y: y0 + node.h - 13 } : null,
  }
}
```

- [ ] **Step 4: Add the client-safe guard** (append to `src/lib/houseEnergy/clientSafe.browser.test.tsx`)

```ts
test('the flow diagram geometry is importable client-side', async () => {
  const mod = await import('~/lib/houseEnergy/flowLayout')
  expect(typeof mod.flowLayout).toBe('function')
})
```

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run src/lib/houseEnergy/flowLayout.test.ts`
Expected: PASS. If a geometry test fails (a crossing, an arrow through a node, a centring miss), **change the
offsets or curve factors, never the test**, then look at it (Task 5's story or the mockup) before committing. The
mockup's numbers passed a visual check at 324 / 754 / 1006 px but were never asserted.

Run: `bunx vitest run --project browser src/lib/houseEnergy/clientSafe.browser.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/houseEnergy/flowLayout.ts src/lib/houseEnergy/flowLayout.test.ts src/lib/houseEnergy/clientSafe.browser.test.tsx
git commit -m "feat(energy): lay out the summary flow diagram"
```

---

### Task 3: A remembered boolean (`useLocalStorageFlag`)

**Reviewers:** `code-reviewer` · reviewer loading `vercel-react-best-practices`

**Files:**
- Create: `src/hooks/useLocalStorageFlag.ts`
- Test: `src/hooks/useLocalStorageFlag.browser.test.tsx`

**Interfaces:**
- Produces: `useLocalStorageFlag(key: string, fallback: boolean): readonly [boolean, (next: boolean) => void]`.
  Server snapshot = `fallback`; same-tab and cross-tab updates re-render; works without storage (memory).

- [ ] **Step 1: Write the failing tests**

```tsx
import { afterEach, expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { useLocalStorageFlag } from './useLocalStorageFlag'

const KEY = 'videbacken-test-flag'

function Probe() {
  const [on, set] = useLocalStorageFlag(KEY, true)
  return (
    <button type="button" onClick={() => set(!on)}>
      {on ? 'on' : 'off'}
    </button>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  try { localStorage.removeItem(KEY) } catch {}
})

test('starts at the fallback and remembers a change', async () => {
  const { screen } = await renderWithProviders(<Probe />)
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
  await screen.getByRole('button').click()
  await expect.element(screen.getByRole('button', { name: 'off' })).toBeVisible()
  expect(localStorage.getItem(KEY)).toBe('0')
})

test('reads a stored value', async () => {
  localStorage.setItem(KEY, '0')
  const { screen } = await renderWithProviders(<Probe />)
  await expect.element(screen.getByRole('button', { name: 'off' })).toBeVisible()
})

test('still toggles for the session when storage throws', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  const { screen } = await renderWithProviders(<Probe />)
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
  await screen.getByRole('button').click()
  await expect.element(screen.getByRole('button', { name: 'off' })).toBeVisible()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project browser src/hooks/useLocalStorageFlag.browser.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { useCallback, useSyncExternalStore } from 'react'

// A per-browser boolean preference (a viewer convenience, never shared state). The server and the first client
// render use `fallback`, so hydration agrees; a stored value applies right after. Without storage (a private
// window, blocked site data) the value lives in memory for the session.
const memory = new Map<string, boolean>()
const CHANGE = 'videbacken:local-flag'

function read(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key)
    if (v !== null) return v === '1'
  } catch {}
  return memory.get(key) ?? fallback
}

export function useLocalStorageFlag(key: string, fallback: boolean) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) onChange()
      }
      window.addEventListener('storage', onStorage)
      window.addEventListener(CHANGE, onChange)
      return () => {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener(CHANGE, onChange)
      }
    },
    [key],
  )
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback,
  )
  const set = useCallback(
    (next: boolean) => {
      memory.set(key, next)
      try {
        window.localStorage.setItem(key, next ? '1' : '0')
      } catch {}
      window.dispatchEvent(new Event(CHANGE))
    },
    [key],
  )
  return [value, set] as const
}
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run --project browser src/hooks/useLocalStorageFlag.browser.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLocalStorageFlag.ts src/hooks/useLocalStorageFlag.browser.test.tsx
git commit -m "feat(ui): remember a boolean preference per browser"
```

---

### Task 4: The diagram (`EnergyFlowDiagram`)

**Reviewers:** `code-reviewer` · reviewer loading `web-design-guidelines` + `vercel-react-best-practices`

**Files:**
- Create: `src/components/energy/EnergyFlowDiagram.tsx`
- Test: `src/components/energy/EnergyFlowDiagram.browser.test.tsx`
- Modify: `src/components/evCharging/ChartPopover.tsx` (optional `className`)
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `flowLayout`, `flowCurve`, `arrowHead`, `flowWidth`, `drawnFlows`, `lossStub`, `lossLabel`, `nodeText`
  (Task 2); `EnergyFigures` (Task 1); `useChartPopover`, `ChartPopover`.
- Produces: `EnergyFlowDiagram({ sums, figures, width, showValues }: { sums: PeriodSums; figures: EnergyFigures; width: number; showValues: boolean })`
  — an `<svg role="img">` of `flowLayout(width).height`; `data-flow-node="<key>"` on each node group,
  `data-flow-edge="<from>>"<to>"` on each arrow group, `data-slot="flow-value"` on each value pill,
  `data-slot="flow-loss"` on the loss stub.

- [ ] **Step 1: Messages** (add to `messages/sv.json`, then the same keys to `messages/en.json`; keep the files'
  key order style)

| Key | sv | en |
|---|---|---|
| `energy_flow_battery` | Batteri | Battery |
| `energy_flow_loss` | Förlust | Loss |
| `energy_flow_about_zero` | ≈ 0 | ≈ 0 |
| `energy_flow_charge_level` | laddnivå {from} → {to} % | charge {from} → {to} % |
| `energy_flow_car` | varav laddning | of which charging |
| `energy_flow_arrow` | {from} → {to} | {from} → {to} |
| `energy_flow_share_solar` | {share} av solelen | {share} of the solar |
| `energy_flow_share_import` | {share} av köpt el | {share} of the bought |
| `energy_flow_share_load` | {share} av förbrukningen | {share} of the consumption |
| `energy_flow_loss_title` | Förlust i batteriet | Battery loss |
| `energy_flow_loss_share` | {share} av det som laddades in | {share} of what was charged |
| `energy_flow_winter_hint` | Det mesta är batteriets egen uppvärmning och standby när det är kallt. | Mostly the battery heating itself and standing by in the cold. |
| `energy_flow_description` | Energiflöden för perioden. Värdena finns också i tabellen under diagrammet. | Energy flows for the period. The values are also in the table below the diagram. |

Run: `bun run i18n:compile`

- [ ] **Step 2: `ChartPopover` takes a `className`** (in `src/components/evCharging/ChartPopover.tsx`: add
  `className?: string` to the props and merge it last: `className={cn('pointer-events-none z-10 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-background text-xs shadow-md', className)}`,
  importing `cn` from `~/lib/utils`). Existing callers are unchanged.

- [ ] **Step 3: Write the failing tests** (`src/components/energy/EnergyFlowDiagram.browser.test.tsx`)

```tsx
import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyFlowDiagram } from './EnergyFlowDiagram'

// October 2026 on prod, rounded (synthetic copy).
const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 145.8, gridExportKwh: 15.5, solarKwh: 76.9, loadKwh: 200.6, batteryDischargeKwh: 49,
  batteryChargeSolarKwh: 21.8, batteryChargeGridKwh: 34, carKwh: 28.4, firstSocPct: 19, lastSocPct: 100,
  buckets: 1568, expectedBuckets: 1568, ...over,
})
const draw = (s: PeriodSums, width = 1006, showValues = true) =>
  renderWithProviders(<EnergyFlowDiagram sums={s} figures={energyFigures(s)} width={width} showValues={showValues} />)

test('every node shows its figure', async () => {
  const { screen } = await draw(sums())
  for (const text of ['76,9 kWh', '145,8 kWh', '15,5 kWh', '200,6 kWh']) {
    await expect.element(screen.getByText(text)).toBeInTheDocument()
  }
  await expect.element(screen.getByText(m.energy_flow_car())).toBeInTheDocument()
  await expect.element(screen.getByText('28,4 kWh')).toBeInTheDocument()
})

test('arrows carry their values; the switch off removes only the pills', async () => {
  const { screen } = await draw(sums())
  const pills = screen.container.querySelectorAll('[data-slot="flow-value"]')
  // sol>exp, sol>load, sol>bat, imp>bat, imp>load, bat>load (bat>exp is 0 in October).
  expect(pills).toHaveLength(6)
  expect([...pills].map((p) => p.textContent)).toContain('111,8')
  const off = await draw(sums(), 1006, false)
  expect(off.screen.container.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(0)
  // The arrows stay (one hit area each).
  expect(off.screen.container.querySelectorAll('[data-slot="flow-hit"]')).toHaveLength(6)
})

test('the loss: a value and a stub from 0.5 kWh, "≈ 0" and no stub below or negative', async () => {
  // February: in 274,45, out 156,97, Δstored −0,83 → loss ≈ 118,3.
  const feb = await draw(sums({ batteryChargeSolarKwh: 25.57, batteryChargeGridKwh: 248.88, batteryDischargeKwh: 156.97, firstSocPct: 34, lastSocPct: 23 }))
  await expect.element(feb.screen.getByText('118,3')).toBeInTheDocument()
  expect(feb.screen.container.querySelector('[data-slot="flow-loss"]')).not.toBeNull()
  // Charging 10 kWh, discharging 9, SoC up by 20 % (1,5 kWh): loss −0,5 → "≈ 0".
  const neg = await draw(sums({ batteryChargeSolarKwh: 10, batteryChargeGridKwh: 0, batteryDischargeKwh: 9, firstSocPct: 50, lastSocPct: 70 }))
  await expect.element(neg.screen.getByText(m.energy_flow_about_zero())).toBeInTheDocument()
  expect(neg.screen.container.querySelector('[data-slot="flow-loss"]')).toBeNull()
})

test('battery to sold is drawn when export exceeds the solar surplus', async () => {
  const { screen } = await draw(sums({ gridExportKwh: 30 }))
  expect(screen.container.querySelector('[data-flow-edge="bat>exp"]')).not.toBeNull()
})

test('hovering an arrow names it with its share', async () => {
  const { screen } = await draw(sums())
  // Köpt el → Förbrukning is a point-symmetric cubic: its box centre (where hover points) lies on the stroke.
  const hit = screen.container.querySelector('[data-flow-edge="imp>load"] [data-slot="flow-hit"]') as Element
  await userEvent.hover(hit)
  await expect
    .element(screen.getByText(m.energy_flow_arrow({ from: m.energy_tile_import(), to: m.energy_tile_load() })))
    .toBeVisible()
  // importDirect 111,8 of 145,8 → 77 %
  await expect.element(screen.getByText(m.energy_flow_share_import({ share: '77 %' }))).toBeVisible()
  await userEvent.hover(document.body)
})

test('the narrow layout drops the charge level from the battery node', async () => {
  const { screen } = await draw(sums(), 324)
  expect(screen.container.querySelector('svg')?.getAttribute('height')).toBe('490')
  expect(screen.getByText(m.energy_flow_charge_level({ from: '19', to: '100' })).elements()).toHaveLength(0)
})
```

- [ ] **Step 4: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/energy/EnergyFlowDiagram.browser.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `src/components/energy/EnergyFlowDiagram.tsx`**

```tsx
import { Group } from '@visx/group'
import {
  BatteryMediumIcon,
  CoinsIcon,
  HouseIcon,
  type LucideIcon,
  SolarPanelIcon,
  UtilityPoleIcon,
} from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import type { EnergyFigures, PeriodSums } from '~/lib/houseEnergy/figures'
import {
  arrowHead,
  drawnFlows,
  type FlowNodeKey,
  flowCurve,
  flowLayout,
  flowWidth,
  lossLabel,
  lossStub,
  nodeText,
} from '~/lib/houseEnergy/flowLayout'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// The Summering card's flow diagram (step 1c): where the period's energy came from and went. Geometry lives in
// flowLayout.ts; this draws it. Colour = where the energy came from (three validated source colours only).
const SOURCE_COLOR: Partial<Record<FlowNodeKey, string>> = {
  sol: 'var(--energy-solar)',
  imp: 'var(--energy-grid)',
  bat: 'var(--energy-battery)',
}
const ICON: Record<FlowNodeKey, LucideIcon> = {
  sol: SolarPanelIcon,
  imp: UtilityPoleIcon,
  bat: BatteryMediumIcon,
  load: HouseIcon,
  exp: CoinsIcon,
}
const NODE_SURFACE = 'color-mix(in oklab, var(--foreground) 3%, var(--card))'
const label = (key: FlowNodeKey) =>
  ({
    sol: m.energy_tile_solar(),
    imp: m.energy_tile_import(),
    bat: m.energy_flow_battery(),
    load: m.energy_tile_load(),
    exp: m.energy_tile_export(),
  })[key]
const kwh = (v: number) => formatOneDecimal(v)

type Tip =
  | { kind: 'flow'; id: string; from: FlowNodeKey; to: FlowNodeKey; kwh: number; share: string | null }
  | { kind: 'loss'; id: 'loss'; kwh: number; share: string | null; charge: string | null; winter: boolean }

function flowShare(f: EnergyFigures, sums: PeriodSums, from: FlowNodeKey, value: number): string | null {
  if (from === 'sol') {
    // As the old tiles: normalised so an overshoot never reads above 100 %.
    const total = Math.max(sums.solarKwh, f.solarDirect + f.solarToBattery + f.solarExported)
    return total > 0 ? m.energy_flow_share_solar({ share: formatShare(value / total) }) : null
  }
  if (from === 'imp') return sums.gridImportKwh > 0 ? m.energy_flow_share_import({ share: formatShare(value / sums.gridImportKwh) }) : null
  return sums.loadKwh > 0 ? m.energy_flow_share_load({ share: formatShare(value / sums.loadKwh) }) : null
}

export function EnergyFlowDiagram({
  sums,
  figures: f,
  width,
  showValues,
}: {
  sums: PeriodSums
  figures: EnergyFigures
  width: number
  showValues: boolean
}) {
  const layout = flowLayout(width)
  const popover = useChartPopover<Tip>()
  const { markProps, containerProps } = popover
  const descId = useId()
  const fadeId = `loss-fade-${useId().replace(/:/g, '')}`
  const flows = drawnFlows(layout, f)
  const max = Math.max(1, ...flows.map((x) => x.kwh))
  const stub = lossStub(layout, f.loss, max)
  const charge =
    sums.firstSocPct !== null && sums.lastSocPct !== null
      ? m.energy_flow_charge_level({ from: String(sums.firstSocPct), to: String(sums.lastSocPct) })
      : null
  const active = popover.open ? popover.data?.id : undefined
  const dim = (id: string) => (active !== undefined && active !== id ? 'opacity-25' : undefined)

  return (
    <div {...containerProps} className="relative">
      <svg width={width} height={layout.height} role="img" aria-describedby={descId} className="block overflow-visible">
        <desc id={descId}>{m.energy_flow_description()}</desc>
        <defs>
          <linearGradient id={fadeId} x1={0} y1={0} x2={layout.loss.side === 'r' ? 1 : 0} y2={layout.loss.side === 'b' ? 1 : 0}>
            <stop offset={0} stopColor="var(--energy-battery)" stopOpacity={0.9} />
            <stop offset={1} stopColor="var(--energy-battery)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* Arrows under the nodes; pills and hit areas over them. */}
        <Group>
          {flows.map(({ spec, kwh: v }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const w = flowWidth(v, max, layout.narrow)
            const color = SOURCE_COLOR[spec.from]
            return (
              <g key={id} data-flow-edge={id} className={cn('transition-opacity motion-reduce:transition-none', dim(id))}>
                <path d={c.d} fill="none" stroke={color} strokeWidth={w} />
                <polygon points={arrowHead(c.tip, w)} fill={color} />
              </g>
            )
          })}
          {stub ? (
            <rect data-slot="flow-loss" x={stub.x} y={stub.y} width={stub.width} height={stub.height} fill={`url(#${fadeId})`} className={dim('loss')} />
          ) : null}
        </Group>
        <Group>
          {(Object.keys(layout.nodes) as FlowNodeKey[]).map((key) => (
            <FlowNodeBox key={key} nodeKey={key} layout={layout} f={f} sums={sums} charge={charge} />
          ))}
        </Group>
        <Group>
          {showValues
            ? flows.map(({ spec, kwh: v }) => {
                const p = flowCurve(layout, spec).at(spec.labelT)
                return <ValuePill key={`${spec.from}>${spec.to}`} x={p.x} y={p.y} text={kwh(v)} />
              })
            : null}
          {flows.map(({ spec, kwh: v }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const mid = c.at(spec.labelT)
            const tip: Tip = { kind: 'flow', id, from: spec.from, to: spec.to, kwh: v, share: flowShare(f, sums, spec.from, v) }
            return (
              <g key={id} data-flow-edge={id}>
                <path
                  data-slot="flow-hit"
                  d={c.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(22, flowWidth(v, max, layout.narrow))}
                  pointerEvents="stroke"
                  className="cursor-pointer"
                  {...markProps(tip, mid.x, mid.y)}
                />
              </g>
            )
          })}
          {stub ? (
            <rect
              x={stub.x - 8}
              y={stub.y - 8}
              width={stub.width + 16}
              height={stub.height + 16}
              fill="transparent"
              className="cursor-pointer"
              {...markProps(
                {
                  kind: 'loss',
                  id: 'loss',
                  kwh: f.loss,
                  share: f.efficiency !== null ? m.energy_flow_loss_share({ share: formatShare(f.loss / (f.batteryIn - f.deltaStored)) }) : null,
                  charge,
                  winter: f.efficiency !== null && f.loss / (f.batteryIn - f.deltaStored) > 0.25,
                },
                stub.x + stub.width / 2,
                stub.y + stub.height / 2,
              )}
            />
          ) : null}
        </Group>
      </svg>
      <ChartPopover
        state={popover}
        dataKey={popover.data?.id}
        className="flex min-w-48 flex-col gap-0.5 whitespace-normal rounded-lg border bg-card px-3 py-2 text-card-foreground text-sm shadow-lg"
      >
        {popover.data ? <TipBody tip={popover.data} /> : null}
      </ChartPopover>
    </div>
  )
}

function TipBody({ tip }: { tip: Tip }) {
  if (tip.kind === 'loss') {
    return (
      <>
        <span className="flex items-center gap-2 font-semibold">
          <span aria-hidden className="size-2.5 rounded-xs bg-energy-battery" />
          {m.energy_flow_loss_title()}
        </span>
        <span className="font-semibold text-base tabular-nums">{kwh(tip.kwh)} kWh</span>
        {tip.share ? <span className="text-muted-foreground">{tip.share}</span> : null}
        {tip.charge ? <span className="text-muted-foreground">{tip.charge}</span> : null}
        {tip.winter ? <span className="max-w-64 text-muted-foreground">{m.energy_flow_winter_hint()}</span> : null}
      </>
    )
  }
  const color = SOURCE_COLOR[tip.from]
  return (
    <>
      <span className="flex items-center gap-2 font-semibold">
        <span aria-hidden className="size-2.5 rounded-xs" style={{ background: color }} />
        {m.energy_flow_arrow({ from: label(tip.from), to: label(tip.to) })}
      </span>
      <span className="font-semibold text-base tabular-nums">{kwh(tip.kwh)} kWh</span>
      {tip.share ? <span className="text-muted-foreground">{tip.share}</span> : null}
    </>
  )
}

// A value on an arrow: the pill is measured from the text, before paint.
function ValuePill({ x, y, text }: { x: number; y: number; text: string }) {
  const ref = useRef<SVGTextElement>(null)
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const b = ref.current?.getBBox()
    if (b) setBox({ x: b.x, y: b.y, width: b.width, height: b.height })
  }, [text, x, y])
  return (
    <g data-slot="flow-value" pointerEvents="none">
      {box ? (
        <rect x={box.x - 7} y={box.y - 3} width={box.width + 14} height={box.height + 6} rx={6} className="fill-card stroke-border" />
      ) : null}
      <text ref={ref} x={x} y={y + 5} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-foreground tabular-nums">
        {text}
      </text>
    </g>
  )
}

function FlowNodeBox({
  nodeKey: key,
  layout,
  f,
  sums,
  charge,
}: {
  nodeKey: FlowNodeKey
  layout: ReturnType<typeof flowLayout>
  f: EnergyFigures
  sums: PeriodSums
  charge: string | null
}) {
  const n = layout.nodes[key]
  const t = nodeText(n, key, layout.narrow)
  const Icon = ICON[key]
  const tint = SOURCE_COLOR[key]
  const figure = { sol: sums.solarKwh, imp: sums.gridImportKwh, exp: sums.gridExportKwh, load: sums.loadKwh, bat: 0 }[key]
  return (
    <g data-flow-node={key}>
      <rect x={n.x - n.w / 2} y={n.y - n.h / 2} width={n.w} height={n.h} rx={12} className="stroke-border" style={{ fill: NODE_SURFACE }} />
      <rect
        x={t.tile.x}
        y={t.tile.y}
        width={t.tile.size}
        height={t.tile.size}
        rx={t.tile.size * 0.24}
        style={{
          fill: tint
            ? `color-mix(in oklab, ${tint} 24%, var(--card))`
            : 'color-mix(in oklab, var(--foreground) 7%, var(--card))',
        }}
      />
      <Icon
        aria-hidden
        x={t.tile.x + (t.tile.size - t.tile.icon) / 2}
        y={t.tile.y + (t.tile.size - t.tile.icon) / 2}
        width={t.tile.icon}
        height={t.tile.icon}
        className="text-foreground"
      />
      <text x={t.label.x} y={t.label.y} fontSize={14} fontWeight={500} className="fill-foreground">
        {label(key)}
      </text>
      {key === 'bat' ? (
        <>
          <text x={t.value.x} y={t.value.y} fontSize={14} className="fill-muted-foreground">
            {m.energy_flow_loss()}{' '}
            <tspan fontSize={t.value.size} fontWeight={600} className="fill-foreground tabular-nums">
              {lossLabel(f.loss) === 'about-zero' ? m.energy_flow_about_zero() : kwh(f.loss)}
            </tspan>{' '}
            kWh
          </text>
          {t.third && charge ? (
            <text x={t.third.x} y={t.third.y} fontSize={13} className="fill-muted-foreground">
              {charge}
            </text>
          ) : null}
        </>
      ) : (
        <text x={t.value.x} y={t.value.y} fontSize={t.value.size} fontWeight={600} className="fill-foreground tabular-nums">
          {kwh(figure)}{' '}
          <tspan fontSize={14} fontWeight={400} className="fill-muted-foreground">
            kWh
          </tspan>
        </text>
      )}
      {key === 'load' && f.car > 0 && t.second && t.third ? (
        <>
          <text x={t.second.x} y={t.second.y} fontSize={14} className="fill-muted-foreground">
            {m.energy_flow_car()}
          </text>
          <text x={t.third.x} y={t.third.y} fontSize={14} className="fill-muted-foreground tabular-nums">
            {kwh(f.car)} kWh
          </text>
        </>
      ) : null}
    </g>
  )
}
```

Notes for the implementer:
- `getByText('76,9 kWh')` matches the `<text>` whose content is "76,9 kWh" (value, a literal space, the unit
  `tspan`). Keep the `{' '}`: the page tests look figures up that way.
- The hit-area paths sit in a top group so the nodes never swallow the pointer; `markProps` covers touch
  (`pointerdown`), as in the heatmaps.
- If `ChartPopover`'s `whitespace-nowrap` fights `whitespace-normal`, `cn` (tailwind-merge) keeps the later class.

- [ ] **Step 6: Run the tests**

Run: `bunx vitest run --project browser src/components/energy/EnergyFlowDiagram.browser.test.tsx src/components/evCharging`
Expected: PASS (the charging charts' popover tests too).

- [ ] **Step 7: Commit**

```bash
git add src/components/energy/EnergyFlowDiagram.tsx src/components/energy/EnergyFlowDiagram.browser.test.tsx src/components/evCharging/ChartPopover.tsx messages/sv.json messages/en.json
git commit -m "feat(energy): draw the energy flow diagram"
```

---

### Task 5: The card body (`EnergyFlow`) and the switch

**Reviewers:** `code-reviewer` · reviewer loading `web-design-guidelines` + `vercel-react-best-practices`

**Files:**
- Create: `src/components/energy/EnergyFlow.tsx`
- Test: `src/components/energy/EnergyFlow.browser.test.tsx`
- Create (CLI): `src/components/ui/switch.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `EnergyFlowDiagram` (Task 4), `useLocalStorageFlag` (Task 3), `energyFigures`, `gapHours`.
- Produces: `EnergyFlow({ sums }: { sums: PeriodSums | null | 'unavailable' })` and
  `SHOW_FLOW_VALUES_KEY = 'videbacken-energy-flow-values'`; `data-slot="energy-flow-box"` on the reserved box,
  `data-slot="energy-gap"` on the gap line (as before).

- [ ] **Step 1: Add the switch**

```bash
bunx shadcn@latest add switch
```

Check `src/components/ui/switch.tsx`: the CLI may import `cn` from the npm package `cn` — change it to
`import { cn } from '~/lib/utils'` and revert any `cn` dependency it added to `package.json` (memory: shadcn add
gotchas). Leave its `data-*` variant classes alone.

- [ ] **Step 2: Messages** (sv / en)

| Key | sv | en |
|---|---|---|
| `energy_flow_hint` | Pilens bredd visar mängden energi. Färgen visar var den kom ifrån. | An arrow's width shows the amount of energy. Its colour shows where it came from. |
| `energy_flow_show_values` | Visa värden | Show values |
| `energy_flow_table_toggle` | Visa som tabell | Show as a table |
| `energy_flow_table_flow` | Flöde | Flow |
| `energy_flow_row_battery_in` | Batteri in | Battery in |
| `energy_flow_row_battery_out` | Batteri ut | Battery out |
| `energy_flow_row_stored` | Förändrad laddning | Change in stored energy |

Run: `bun run i18n:compile`

- [ ] **Step 3: Write the failing tests** (`src/components/energy/EnergyFlow.browser.test.tsx`)

```tsx
import { afterEach, expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyFlow, SHOW_FLOW_VALUES_KEY } from './EnergyFlow'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 145.8, gridExportKwh: 15.5, solarKwh: 76.9, loadKwh: 200.6, batteryDischargeKwh: 49,
  batteryChargeSolarKwh: 21.8, batteryChargeGridKwh: 34, carKwh: 28.4, firstSocPct: 19, lastSocPct: 100,
  buckets: 1568, expectedBuckets: 1568, ...over,
})

afterEach(() => localStorage.removeItem(SHOW_FLOW_VALUES_KEY))

test('opens with Självförsörjning, then the diagram', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums()} />)
  // .first(): the (closed) table repeats both.
  await expect.element(screen.getByText(m.energy_tile_self_sufficiency()).first()).toBeVisible()
  // 1 − 145,8 / 200,6 ≈ 27 %
  await expect.element(screen.getByText(/^27\s%$/).first()).toBeVisible()
  await expect.element(screen.getByRole('img')).toBeVisible()
})

test('the switch hides the values and is remembered', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums()} />)
  await expect.poll(() => screen.container.querySelectorAll('[data-slot="flow-value"]').length).toBe(6)
  await screen.getByRole('switch', { name: m.energy_flow_show_values() }).click()
  await expect.poll(() => screen.container.querySelectorAll('[data-slot="flow-value"]').length).toBe(0)
  expect(localStorage.getItem(SHOW_FLOW_VALUES_KEY)).toBe('0')
})

test('the table lists every value, the battery included', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums()} />)
  await screen.getByText(m.energy_flow_table_toggle()).click()
  const table = screen.getByRole('table')
  await expect.element(table.getByRole('rowheader', { name: m.energy_flow_row_battery_in() })).toBeVisible()
  await expect.element(table.getByRole('rowheader', { name: m.energy_flow_loss_title() })).toBeVisible()
  // The loss row keeps the real value: 55,8 − 49 − 6,14 ≈ 0,7.
  await expect.element(table.getByRole('cell', { name: '0,7' })).toBeVisible()
})

test('no car: the car lines are blank, the box keeps its height', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums({ carKwh: 0 })} />)
  // The table keeps its "varav laddning" row (0,0); the diagram has no car lines.
  await expect.poll(() => screen.container.querySelector('svg[role="img"]')).not.toBeNull()
  expect(screen.container.querySelector('svg[role="img"]')?.textContent).not.toContain(m.energy_flow_car())
  const box = screen.container.querySelector('[data-slot="energy-flow-box"]') as HTMLElement
  const withCar = await renderWithProviders(<EnergyFlow sums={sums()} />)
  const box2 = withCar.screen.container.querySelector('[data-slot="energy-flow-box"]') as HTMLElement
  expect(box.getBoundingClientRect().height).toBe(box2.getBoundingClientRect().height)
})

test('a period without data says so in a box of the same height; unavailable stays blank', async () => {
  const empty = await renderWithProviders(<EnergyFlow sums={null} />)
  await expect.element(empty.screen.getByText(m.energy_period_no_data())).toBeVisible()
  const full = await renderWithProviders(<EnergyFlow sums={sums()} />)
  const h = (c: HTMLElement) => (c.querySelector('[data-slot="energy-flow-box"]') as HTMLElement).getBoundingClientRect().height
  expect(h(empty.screen.container)).toBe(h(full.screen.container))
  const blank = await renderWithProviders(<EnergyFlow sums="unavailable" />)
  expect(blank.screen.getByText(m.energy_period_no_data()).elements()).toHaveLength(0)
  expect(blank.screen.container.querySelector('svg[role="img"]')).toBeNull()
})

test('a gap in the readings is named under the diagram', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums({ buckets: 8760, expectedBuckets: 8928 })} />)
  await expect.element(screen.getByText(m.energy_missing_hours({ hours: '14' }))).toBeVisible()
})
```

- [ ] **Step 4: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/energy/EnergyFlow.browser.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `src/components/energy/EnergyFlow.tsx`**

```tsx
import { useParentSize } from '@visx/responsive'
import { useId } from 'react'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { Switch } from '~/components/ui/switch'
import { useLocalStorageFlag } from '~/hooks/useLocalStorageFlag'
import { type EnergyFigures, energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { EnergyFlowDiagram } from './EnergyFlowDiagram'

export const SHOW_FLOW_VALUES_KEY = 'videbacken-energy-flow-values'

// The Summering card's body (step 1c, spec "The card"): Självförsörjning, the flow diagram in a box whose height
// is reserved per layout by a container query (860 px = 53.75rem → 360 px, else 490 px) so nothing shifts before
// it is measured or when the period changes, the values switch, the gap note and the table.
export function EnergyFlow({ sums }: { sums: PeriodSums | null | 'unavailable' }) {
  const [showValues, setShowValues] = useLocalStorageFlag(SHOW_FLOW_VALUES_KEY, true)
  const { parentRef, width } = useParentSize({ debounceTime: 50 })
  const switchId = useId()
  const s = sums && sums !== 'unavailable' ? sums : null
  const f = s ? energyFigures(s) : null
  const gap = f ? gapHours(f) : null
  return (
    <div className="@container flex flex-col gap-3">
      <SelfSufficiency value={f?.selfSufficiency ?? null} hidden={!f} />
      <div ref={parentRef} data-slot="energy-flow-box" className="relative h-[490px] w-full @[53.75rem]:h-[360px]">
        {s && f && width > 0 ? <EnergyFlowDiagram sums={s} figures={f} width={width} showValues={showValues} /> : null}
        {sums === null ? (
          <p className="absolute top-0 left-0 text-muted-foreground text-sm">{m.energy_period_no_data()}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-muted-foreground text-sm">{m.energy_flow_hint()}</p>
        <label htmlFor={switchId} className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm">
          <Switch id={switchId} checked={showValues} onCheckedChange={setShowValues} />
          {m.energy_flow_show_values()}
        </label>
      </div>
      <p data-slot="energy-gap" className="min-h-[1.5em] text-muted-foreground text-sm leading-normal">
        {gap === null ? null : m.energy_missing_hours({ hours: String(gap) })}
      </p>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground">{m.energy_flow_table_toggle()}</summary>
        {s && f ? <FlowTable sums={s} f={f} /> : null}
      </details>
    </div>
  )
}

function SelfSufficiency({ value, hidden }: { value: number | null; hidden: boolean }) {
  const r = 18
  const circ = 2 * Math.PI * r
  return (
    // Invisible (not absent) without figures, so the card is as tall for every period.
    <div className={hidden ? 'invisible flex items-center gap-3' : 'flex items-center gap-3'} aria-hidden={hidden || undefined}>
      <svg viewBox="0 0 44 44" className="size-11 shrink-0" aria-hidden>
        <circle cx={22} cy={22} r={r} fill="none" strokeWidth={6} className="stroke-muted" />
        {value !== null ? (
          <circle cx={22} cy={22} r={r} fill="none" strokeWidth={6} className="stroke-foreground" strokeDasharray={`${circ * value} ${circ}`} transform="rotate(-90 22 22)" />
        ) : null}
      </svg>
      <div className="flex flex-col">
        <span className="font-medium text-sm">{m.energy_tile_self_sufficiency()}</span>
        <span className="font-semibold text-[length:24px] tabular-nums leading-tight @[53.75rem]:text-[length:28px]">
          {value === null ? '—' : formatShare(value)}
        </span>
        <span className="text-muted-foreground text-sm">{m.energy_tile_self_sufficiency_detail()}</span>
      </div>
    </div>
  )
}

function FlowTable({ sums: s, f }: { sums: PeriodSums; f: EnergyFigures }) {
  const solar = m.energy_tile_solar()
  const imp = m.energy_tile_import()
  const bat = m.energy_flow_battery()
  const load = m.energy_tile_load()
  const exp = m.energy_tile_export()
  const arrow = (from: string, to: string) => m.energy_flow_arrow({ from, to })
  const rows: [string, string][] = [
    [solar, formatOneDecimal(s.solarKwh)],
    [imp, formatOneDecimal(s.gridImportKwh)],
    [exp, formatOneDecimal(s.gridExportKwh)],
    [load, formatOneDecimal(s.loadKwh)],
    [m.energy_flow_car(), formatOneDecimal(f.car)],
    [arrow(solar, load), formatOneDecimal(f.solarDirect)],
    [arrow(solar, bat), formatOneDecimal(f.solarToBattery)],
    [arrow(solar, exp), formatOneDecimal(f.solarExported)],
    [arrow(imp, load), formatOneDecimal(f.importDirect)],
    [arrow(imp, bat), formatOneDecimal(f.importToBattery)],
    [arrow(bat, load), formatOneDecimal(f.batteryToHouse)],
    [arrow(bat, exp), formatOneDecimal(f.batteryToGrid)],
    [m.energy_flow_row_battery_in(), formatOneDecimal(f.batteryIn)],
    [m.energy_flow_row_battery_out(), formatOneDecimal(f.batteryOut)],
    [m.energy_flow_row_stored(), formatOneDecimal(f.deltaStored)],
    // The real value, also when the diagram says "≈ 0".
    [m.energy_flow_loss_title(), formatOneDecimal(f.loss)],
  ]
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="min-w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1.5 pr-4 font-medium">{m.energy_flow_table_flow()}</th>
            <th scope="col" className="py-1.5 text-right font-medium">kWh</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name} className="border-b">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">{name}</th>
              <td className="py-1.5 text-right tabular-nums">{value}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-1.5 pr-4 text-left font-normal">{m.energy_tile_self_sufficiency()}</th>
            <td className="py-1.5 text-right tabular-nums">{f.selfSufficiency === null ? '—' : formatShare(f.selfSufficiency)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 6: Run the tests**

Run: `bunx vitest run --project browser src/components/energy/EnergyFlow.browser.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/energy/EnergyFlow.tsx src/components/energy/EnergyFlow.browser.test.tsx src/components/ui/switch.tsx messages/sv.json messages/en.json package.json bun.lock
git commit -m "feat(energy): add the summary card body with a values switch"
```

---

### Task 6: The page uses the flow card

**Reviewers:** `code-reviewer` · reviewer loading `web-design-guidelines` + `vercel-react-best-practices`

**Files:**
- Modify: `src/routes/_authenticated/energy/index.tsx`
- Modify: `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`
- Delete: `src/components/energy/EnergyTiles.tsx`, `src/components/energy/EnergyTiles.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json` (remove unused keys)
- Regenerate: `src/bones/energy-tiles.bones.json`

**Interfaces:**
- Consumes: `EnergyFlow` (Task 5).

- [ ] **Step 1: Swap the component** in `src/routes/_authenticated/energy/index.tsx`: replace
  `import { EnergyReadouts } from '~/components/energy/EnergyTiles'` with
  `import { EnergyFlow } from '~/components/energy/EnergyFlow'`, and `<EnergyReadouts sums={tileSums} />` with
  `<EnergyFlow sums={tileSums} />`. The card, header, period control, announcement and stale dimming stay.

- [ ] **Step 2: Delete the old tiles**

```bash
git rm src/components/energy/EnergyTiles.tsx src/components/energy/EnergyTiles.browser.test.tsx
grep -rn "energy_tile_solar_split\|energy_tile_import_to_battery\|energy_tile_load_car" src
```

Remove from both message files each key the grep no longer finds in `src` (expected: all three), then
`bun run i18n:compile`.

- [ ] **Step 3: Run the page tests**

Run: `bunx vitest run --project browser src/routes/_authenticated/energy`
Expected: PASS. The figures are looked up as "108,0 kWh"; the node `<text>` reads the same. If a test relied on the
readout grid (`.grid`, `readout-detail`), assert the same intent on `data-slot="energy-flow-box"` instead (its
height is the no-shift guarantee now) — don't delete the intent.

- [ ] **Step 4: Add a page test for the reserved height** (append to `-energyPage.browser.test.tsx`; `renderPage`,
  `Overview`, `seedOverview` and `withData` are the file's own helpers, as in its stepping test)

```tsx
test('the flow box keeps its height across periods', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await expect.element(screen.getByText('108,0 kWh')).toBeVisible()
  const box = () => (screen.container.querySelector('[data-slot="energy-flow-box"]') as HTMLElement).getBoundingClientRect()
  const before = box()
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  await expect.element(screen.getByText('107,0 kWh')).toBeVisible()
  expect(box().height).toBe(before.height)
  expect(box().top).toBe(before.top)
})
```

- [ ] **Step 5: Re-capture the skeleton** (needs the dev server and a signed-in session, as in step 1b)

```bash
bun run bones:capture /energy --force
git diff --stat src/bones/
```

Expected: `energy-tiles.bones.json` changes (the new card's shape); `energy-chart.bones.json` may not.

- [ ] **Step 6: The full suites**

Run: `bun run test`
Expected: PASS (node + browser).

- [ ] **Step 7: Commit**

```bash
git add -A src/routes/_authenticated/energy src/components/energy src/bones messages
git commit -m "feat(energy): show the summary as an energy flow diagram"
```

---

### Task 7: Verify live, record the step

**Reviewers:** none (evidence task); the branch review (feature-workflow Phase 5) follows.

- [ ] **Step 1: No-shift and fit** (Playwright on the local dev server, full local history, signed in through the
  Mailpit magic link as in the bones capture; memory "Live UI check via Playwright"). For 1440, 820 and 390 px,
  light and dark: visit `/energy?period=2026-10`, then step to `2026-08` (gap note), `2026-02` (big loss, thin
  battery arrows), Hela 2026 and Totalt. After each, record `getBoundingClientRect()` of the period label button,
  the Summering card and `[data-slot="energy-flow-box"]`, and check:
  - the rects are identical across periods per viewport/theme;
  - every `[data-flow-node] text` lies inside its node rect (Totalt at 390 px: "9 366,6 kWh");
  - no `[data-slot="flow-value"]` rect intersects a `[data-flow-node] > rect:first-child`;
  - `document.documentElement.scrollWidth === innerWidth`; console clean.
  Save the script in the scratchpad, not the repo; paste the table in the PR.

- [ ] **Step 2: Look at it**: screenshots of the card at the three widths, light and dark, with an arrow hovered
  and the loss stub hovered (February). Compare with the mockup (version 4). Check the icons read at a glance, the
  text sits centred on the tiles, the tinted tiles match their arrows.

- [ ] **Step 3: Figures**: on `/energy?period=2026-08` locally, the table's rows equal a plain SQL sum for August
  (step 1's checkpoint query plus `battery_discharge_kwh`, `battery_charge_*`), and the loss equals
  in − out − (last SoC − first SoC) ÷ 100 × 7,58.

- [ ] **Step 4: Pre-PR gate** ([feature-workflow](../../feature-workflow.md#pre-pr-gate)): `bun run check`,
  `check:ci`, `build`, `test`, the sv/en key check.

- [ ] **Step 5: Roadmap**: row 1c → PR link, `PR open`; a log line with the measurements.

```bash
git add docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md
git commit -m "docs(energy): record step 1c"
```

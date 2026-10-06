import { describe, expect, test } from 'vitest'
import { energyFigures, type PeriodSums } from './figures'
import {
  arrowHead,
  drawnFlows,
  edgeKwh,
  type FlowEdgeSpec,
  type FlowLayout,
  type FlowNodeKey,
  flowCurve,
  flowLayout,
  flowWidth,
  lossLabel,
  lossStub,
  MIN_FLOW_KWH,
  NARROW_HEIGHT,
  type NodeText,
  nodeText,
  WIDE_HEIGHT,
} from './flowLayout'

// Card content widths: phone (390 px viewport), tablet (820), desktop (1440, the page's max width), and either
// side of the switch to the wide layout (WIDE_MIN_WIDTH).
const WIDTHS = [324, 754, 859, 860, 1006]

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 145.8,
  gridExportKwh: 15.5,
  solarKwh: 76.9,
  loadKwh: 200.6,
  batteryDischargeKwh: 49,
  batteryChargeSolarKwh: 21.8,
  batteryChargeGridKwh: 34,
  carKwh: 28.4,
  firstSocPct: 19,
  lastSocPct: 100,
  buckets: 1568,
  expectedBuckets: 1568,
  ...over,
})

const rects = (l: FlowLayout) =>
  Object.entries(l.nodes).map(([key, n]) => ({
    key,
    x0: n.x - n.w / 2,
    x1: n.x + n.w / 2,
    y0: n.y - n.h / 2,
    y1: n.y + n.h / 2,
  }))

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
        Math.abs(tip.x - (n.x - n.w / 2)) < 0.01 ||
        Math.abs(tip.x - (n.x + n.w / 2)) < 0.01 ||
        Math.abs(tip.y - (n.y - n.h / 2)) < 0.01 ||
        Math.abs(tip.y - (n.y + n.h / 2)) < 0.01
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
      const side = (
        a: { x: number; y: number },
        b: { x: number; y: number },
        c: { x: number; y: number },
      ) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
      for (let i = 1; i < p.length; i++)
        for (let j = 1; j < q.length; j++)
          if (
            side(p[i - 1], p[i], q[j - 1]) * side(p[i - 1], p[i], q[j]) < 0 &&
            side(q[j - 1], q[j], p[i - 1]) * side(q[j - 1], q[j], p[i]) < 0
          )
            return true
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
    for (const [key, node] of Object.entries(layout.nodes) as [
      FlowNodeKey,
      (typeof layout.nodes)['sol'],
    ][]) {
      const t = nodeText(node, key, layout.narrow)
      const tileCentre = t.tile.y + t.tile.size / 2
      // Wide: label cap top to the last line's baseline. Narrow: the label alone shares the tile's row.
      const capTop = t.label.y - 14 * 0.7
      const bottom = layout.narrow
        ? t.label.y
        : key === 'bat'
          ? (t.third?.y ?? t.value.y)
          : t.value.y
      expect(Math.abs((capTop + bottom) / 2 - tileCentre), key).toBeLessThanOrEqual(2)
      expect(t.tile.y).toBeGreaterThanOrEqual(node.y - node.h / 2)
    }
  })
})

test.each([
  280, 296, 311, 320, 340,
])('at %i px a 16 px Solel → Förbrukning stroke clears the battery by 2 px', (width) => {
  // Narrow phones: the arrow runs down the battery's left side and under it. Its widest stroke (16 px, when it
  // is the period's largest arrow) must not touch the battery's corner.
  const layout = flowLayout(width)
  const e = layout.edges.find((x) => x.from === 'sol' && x.to === 'load') as FlowEdgeSpec
  const b = layout.nodes.bat
  const c = flowCurve(layout, e)
  let nearest = Number.POSITIVE_INFINITY
  for (let i = 0; i <= 2000; i++) {
    const p = c.at(i / 2000)
    const dx = Math.max(b.x - b.w / 2 - p.x, 0, p.x - (b.x + b.w / 2))
    const dy = Math.max(b.y - b.h / 2 - p.y, 0, p.y - (b.y + b.h / 2))
    nearest = Math.min(nearest, Math.hypot(dx, dy))
  }
  expect(nearest - 16 / 2).toBeGreaterThanOrEqual(2)
})

test('without a charge level the wide battery text block is still centred on its tile', () => {
  const layout = flowLayout(1006)
  const t = nodeText(layout.nodes.bat, 'bat', false, { chargeLine: false })
  expect(t.third).toBeNull()
  const capTop = t.label.y - 14 * 0.7
  expect(Math.abs((capTop + t.value.y) / 2 - (t.tile.y + t.tile.size / 2))).toBeLessThanOrEqual(2)
})

test.each([
  296, 1006,
])('at %i px each figure may run to 12 px inside its node, and shrinks to 18 px (loss 16)', (width) => {
  const layout = flowLayout(width)
  for (const [key, node] of Object.entries(layout.nodes) as [
    FlowNodeKey,
    FlowLayout['nodes']['sol'],
  ][]) {
    const { value } = nodeText(node, key, layout.narrow)
    expect(value.x + value.room, key).toBe(node.x + node.w / 2 - 12)
    expect(value.minSize, key).toBe(key === 'bat' ? 16 : 18)
    expect(value.size, key).toBeGreaterThan(value.minSize)
  }
})

test('widths are linear in kWh with a 2 px floor', () => {
  expect(flowWidth(1631.7, 1631.7, false)).toBe(20)
  expect(flowWidth(815.85, 1631.7, false)).toBeCloseTo(10)
  expect(flowWidth(17.9, 1631.7, false)).toBe(2)
  expect(flowWidth(1631.7, 1631.7, true)).toBe(16)
})

test('without a positive largest arrow the width is the floor, never NaN or Infinity', () => {
  expect(flowWidth(0, 0, false)).toBe(2)
  expect(flowWidth(5, 0, false)).toBe(2)
  expect(flowWidth(5, 0, true)).toBe(2)
  expect(flowWidth(5, -1, false)).toBe(2)
})

test('every arrow carries the figure the spec names', () => {
  const f = energyFigures(sums())
  const pairs: [FlowNodeKey, FlowNodeKey, number][] = [
    ['sol', 'load', f.solarDirect],
    ['sol', 'bat', f.solarToBattery],
    ['sol', 'exp', f.solarExported],
    ['imp', 'load', f.importDirect],
    ['imp', 'bat', f.importToBattery],
    ['bat', 'load', f.batteryToHouse],
    ['bat', 'exp', f.batteryToGrid],
  ]
  for (const [from, to, kwh] of pairs) expect(edgeKwh(f, from, to), `${from}>${to}`).toBe(kwh)
})

test('export above the solar surplus splits the discharge between sold and the house', () => {
  // Solar 76.9 − 21.8 into the battery leaves a 55.1 surplus; 60 sold puts 4.9 of the battery's 49 on the grid.
  const f = energyFigures(sums({ gridExportKwh: 60 }))
  expect(f.solarDirect).toBe(0)
  expect(edgeKwh(f, 'bat', 'exp')).toBeCloseTo(4.9)
  expect(edgeKwh(f, 'bat', 'load')).toBeCloseTo(44.1)
  expect(edgeKwh(f, 'sol', 'exp')).toBeCloseTo(55.1)
  expect(edgeKwh(f, 'sol', 'load')).toBe(0)
  const drawn = drawnFlows(flowLayout(1006), f).map((x) => `${x.spec.from}>${x.spec.to}`)
  expect(drawn).toContain('bat>exp')
  expect(drawn).not.toContain('sol>load')
})

test('a pair with no arrow carries nothing', () => {
  const f = energyFigures(sums())
  expect(edgeKwh(f, 'load', 'sol')).toBe(0)
  expect(edgeKwh(f, 'exp', 'bat')).toBe(0)
})

test('arrows below 0.05 kWh are not drawn', () => {
  // October 2026: export within the solar surplus, so battery → sold is 0.
  const flows = drawnFlows(flowLayout(1006), energyFigures(sums()))
  expect(flows.map((x) => `${x.spec.from}>${x.spec.to}`)).not.toContain('bat>exp')
  expect(flows.every((x) => x.kwh >= MIN_FLOW_KWH)).toBe(true)
  const tiny = drawnFlows(
    flowLayout(1006),
    energyFigures(sums({ gridExportKwh: 0.04, solarKwh: 21.84 })),
  )
  expect(tiny.map((x) => `${x.spec.from}>${x.spec.to}`)).not.toContain('sol>exp')
})

test('an arrow of exactly 0.05 kWh is drawn', () => {
  const f = energyFigures(sums())
  const keys = (solarExported: number) =>
    drawnFlows(flowLayout(1006), { ...f, solarExported }).map((x) => `${x.spec.from}>${x.spec.to}`)
  expect(keys(MIN_FLOW_KWH)).toContain('sol>exp')
  expect(keys(0.0499)).not.toContain('sol>exp')
})

test('the wide layout starts at 860 px', () => {
  expect(flowLayout(859)).toMatchObject({ narrow: true, height: NARROW_HEIGHT })
  expect(flowLayout(860)).toMatchObject({ narrow: false, height: WIDE_HEIGHT })
})

test('the loss stub appears from 0.5 kWh, at least 4 px wide', () => {
  const wide = flowLayout(1006)
  expect(lossStub(wide, 0.49, 100)).toBeNull()
  expect(lossStub(wide, -1.2, 100)).toBeNull()
  const s = lossStub(wide, 0.66, 111.8)
  expect(s?.side).toBe('b')
  expect(s?.width).toBe(4)
  expect(lossStub(flowLayout(324), 118.3, 1631.7)?.side).toBe('r')
  expect(lossStub(wide, 0.5, 100)).not.toBeNull()
  expect(lossStub(wide, Number.NaN, 100)).toBeNull()
})

test('a loss stub with no arrows drawn (largest arrow 0) is 4 px, not Infinity', () => {
  const s = lossStub(flowLayout(1006), 3, 0)
  expect(s?.width).toBe(4)
  expect(
    Object.values(s ?? {})
      .filter((v) => typeof v === 'number')
      .every(Number.isFinite),
  ).toBe(true)
  expect(lossStub(flowLayout(324), 3, 0)?.height).toBe(4)
})

test('a loss below 0.5 kWh or negative reads "about zero"', () => {
  expect(lossLabel(0.66)).toBe('value')
  expect(lossLabel(0.49)).toBe('about-zero')
  expect(lossLabel(-0.2)).toBe('about-zero')
  expect(lossLabel(-1.2)).toBe('about-zero')
  expect(lossLabel(0)).toBe('about-zero')
  expect(lossLabel(0.5)).toBe('value')
  expect(lossLabel(Number.NaN)).toBe('about-zero')
  expect(lossLabel(Number.POSITIVE_INFINITY)).toBe('about-zero')
})

test('the arrowhead is a triangle whose tip sits on the node edge', () => {
  const pts = arrowHead({ x: 100, y: 50, dx: -1, dy: 0 }, 10).split(' ')
  expect(pts).toHaveLength(3)
  expect(pts[0]).toBe('100,50')
})

test('the arrowhead runs 9 px back along the normal, max(5, width / 2 + 4) to either side', () => {
  // Into a left side (normal −x): thin arrows get the 5 px minimum, thick ones width / 2 + 4.
  expect(arrowHead({ x: 100, y: 50, dx: -1, dy: 0 }, 2)).toBe('100,50 91,45 91,55')
  expect(arrowHead({ x: 100, y: 50, dx: -1, dy: 0 }, 20)).toBe('100,50 91,36 91,64')
  // Into a top side (normal −y).
  expect(arrowHead({ x: 10, y: 20, dx: 0, dy: -1 }, 10)).toBe('10,20 19,11 1,11')
})

test.each(WIDTHS)('at %i px each arrowhead base meets its curve end', (width) => {
  const layout = flowLayout(width)
  for (const e of layout.edges) {
    const c = flowCurve(layout, e)
    const [, b1, b2] = arrowHead(c.tip, 10)
      .split(' ')
      .map((p) => p.split(',').map(Number))
    const end = c.at(1)
    expect((b1[0] + b2[0]) / 2, `${e.from}>${e.to}`).toBeCloseTo(end.x)
    expect((b1[1] + b2[1]) / 2, `${e.from}>${e.to}`).toBeCloseTo(end.y)
  }
})

test.each([false, true])('which text lines a node has (narrow: %s)', (narrow) => {
  const layout = flowLayout(narrow ? 324 : 1006)
  const lines = (key: FlowNodeKey) => {
    const t: NodeText = nodeText(layout.nodes[key], key, narrow)
    return { second: t.second !== null, third: t.third !== null }
  }
  // The battery's loss is its value; its charge level is the third line, wide only. Förbrukning has two car lines.
  expect(lines('bat')).toEqual({ second: false, third: !narrow })
  expect(lines('load')).toEqual({ second: true, third: true })
  for (const key of ['sol', 'imp', 'exp'] as const)
    expect(lines(key), key).toEqual({ second: false, third: false })
})

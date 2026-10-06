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

test('widths are linear in kWh with a 2 px floor', () => {
  expect(flowWidth(1631.7, 1631.7, false)).toBe(20)
  expect(flowWidth(815.85, 1631.7, false)).toBeCloseTo(10)
  expect(flowWidth(17.9, 1631.7, false)).toBe(2)
  expect(flowWidth(1631.7, 1631.7, true)).toBe(16)
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

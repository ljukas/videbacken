import { describe, expect, test } from 'vitest'
import {
  BATTERY_NARROW_HEIGHT,
  BATTERY_WIDE_HEIGHT,
  type BatteryNodeKey,
  batteryDrawnFlows,
  batteryEdgeKwh,
  batteryFlowLayout,
  batteryNodeText,
} from './batteryFlowLayout'
import { energyFigures, type PeriodSums } from './figures'
import { flowCurve, NODE_PADDING } from './flowLayout'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561,
  gridExportKwh: 114,
  solarKwh: 509,
  loadKwh: 947,
  batteryDischargeKwh: 225.4,
  batteryChargeSolarKwh: 172.9,
  batteryChargeGridKwh: 67.9,
  carKwh: 211,
  firstSocPct: 15,
  lastSocPct: 20,
  buckets: 8603,
  expectedBuckets: 8640,
  ...over,
})
const KEYS: BatteryNodeKey[] = ['sol', 'imp', 'bat', 'out', 'loss']
const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h

type P = { x: number; y: number }
const rect = (n: { x: number; y: number; w: number; h: number }) => ({
  x0: n.x - n.w / 2,
  x1: n.x + n.w / 2,
  y0: n.y - n.h / 2,
  y1: n.y + n.h / 2,
})
const side = (a: P, b: P, c: P) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
const cross = (p: P[], q: P[]) => {
  for (let i = 1; i < p.length; i++)
    for (let j = 1; j < q.length; j++)
      if (
        side(p[i - 1], p[i], q[j - 1]) * side(p[i - 1], p[i], q[j]) < 0 &&
        side(q[j - 1], q[j], p[i - 1]) * side(q[j - 1], q[j], p[i]) < 0
      )
        return true
  return false
}

test('the 860 px rule: 859 is narrow, 860 is wide', () => {
  expect(batteryFlowLayout(859).narrow).toBe(true)
  expect(batteryFlowLayout(860).narrow).toBe(false)
})

describe.each([256, 296, 311, 324, 380, 754, 859, 860, 1006])('at %i px', (width) => {
  const layout = batteryFlowLayout(width)
  test('the layout kind and height follow the 860 px rule', () => {
    expect(layout.narrow).toBe(width < 860)
    expect(layout.height).toBe(width < 860 ? BATTERY_NARROW_HEIGHT : BATTERY_WIDE_HEIGHT)
  })
  test('every node lies inside the box and no two overlap', () => {
    for (const k of KEYS) {
      const n = layout.nodes[k]
      expect(n.x - n.w / 2, k).toBeGreaterThanOrEqual(0)
      expect(n.x + n.w / 2, k).toBeLessThanOrEqual(width)
      expect(n.y - n.h / 2, k).toBeGreaterThanOrEqual(0)
      expect(n.y + n.h / 2, k).toBeLessThanOrEqual(layout.height)
    }
    for (const a of KEYS)
      for (const b of KEYS)
        if (a < b) expect(overlap(layout.nodes[a], layout.nodes[b]), `${a}/${b}`).toBe(false)
  })
  test('the layout is symmetric', () => {
    const n = layout.nodes
    expect(n.bat.x).toBe(width / 2)
    if (layout.narrow) {
      expect(n.sol.x + n.imp.x).toBe(width)
      expect(n.out.x + n.loss.x).toBe(width)
    } else {
      expect(n.sol.x + n.out.x).toBe(width)
      expect(n.imp.x + n.loss.x).toBe(width)
    }
  })
  test('every arrow joins the battery, starts on its source edge and ends on its target edge', () => {
    expect(layout.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
      'bat>loss',
      'bat>out',
      'imp>bat',
      'sol>bat',
    ])
    const onSide = (n: ReturnType<typeof rect>, s: string, p: P) => {
      const eps = 0.01
      const along = (lo: number, hi: number, v: number) => v >= lo - eps && v <= hi + eps
      if (s === 'l') return Math.abs(p.x - n.x0) < eps && along(n.y0, n.y1, p.y)
      if (s === 'r') return Math.abs(p.x - n.x1) < eps && along(n.y0, n.y1, p.y)
      if (s === 't') return Math.abs(p.y - n.y0) < eps && along(n.x0, n.x1, p.x)
      return Math.abs(p.y - n.y1) < eps && along(n.x0, n.x1, p.x)
    }
    for (const e of layout.edges) {
      expect(e.fromSide, `${e.from}>${e.to} from`).toBe(layout.narrow ? 'b' : 'r')
      expect(e.toSide, `${e.from}>${e.to} to`).toBe(layout.narrow ? 't' : 'l')
      const c = flowCurve(layout, e)
      expect(
        onSide(rect(layout.nodes[e.from]), e.fromSide, c.at(0)),
        `${e.from}>${e.to} start`,
      ).toBe(true)
      expect(onSide(rect(layout.nodes[e.to]), e.toSide, c.tip), `${e.from}>${e.to} tip`).toBe(true)
    }
  })
  test('no arrow passes through a node', () => {
    for (const e of layout.edges) {
      const c = flowCurve(layout, e)
      for (let t = 0.06; t <= 0.94; t += 0.02) {
        const p = c.at(t)
        for (const k of KEYS) {
          const r = rect(layout.nodes[k])
          const inside = p.x > r.x0 + 1 && p.x < r.x1 - 1 && p.y > r.y0 + 1 && p.y < r.y1 - 1
          expect(inside, `${e.from}>${e.to} at t=${t.toFixed(2)} inside ${k}`).toBe(false)
        }
      }
    }
  })
  test('no two arrows cross', () => {
    const polyline = (e: (typeof layout.edges)[number]) => {
      const c = flowCurve(layout, e)
      return Array.from({ length: 41 }, (_, i) => c.at(0.06 + (0.88 * i) / 40))
    }
    for (const a of layout.edges)
      for (const b of layout.edges) {
        if (a === b) continue
        expect(cross(polyline(a), polyline(b)), `${a.from}>${a.to} x ${b.from}>${b.to}`).toBe(false)
      }
  })
  test('node text stays inside its node', () => {
    for (const k of KEYS) {
      const n = layout.nodes[k]
      const r = rect(n)
      const t = batteryNodeText(n, k, layout.narrow)
      expect(t.tile.x, `${k} tile`).toBeGreaterThanOrEqual(r.x0)
      expect(t.tile.x + t.tile.size, `${k} tile`).toBeLessThanOrEqual(r.x1)
      expect(t.tile.y, `${k} tile`).toBeGreaterThanOrEqual(r.y0)
      expect(t.tile.y + t.tile.size, `${k} tile`).toBeLessThanOrEqual(r.y1)
      expect(t.label.x, k).toBeGreaterThan(t.tile.x)
      expect(t.label.y, k).toBeGreaterThan(r.y0)
      expect(t.label.y, k).toBeLessThan(r.y1)
      expect(t.value.x, k).toBeGreaterThanOrEqual(r.x0 + NODE_PADDING)
      expect(t.value.room, k).toBeGreaterThanOrEqual(100)
      expect(t.value.size, k).toBeGreaterThanOrEqual(t.value.minSize)
      expect(t.value.y, k).toBeLessThan(r.y1)
      if (t.second) {
        expect(t.second.x, k).toBeGreaterThanOrEqual(r.x0)
        expect(t.second.y, k).toBeLessThan(r.y1)
        expect(t.second.y, k).toBeGreaterThan(r.y0)
        expect(t.second.y, k).toBeGreaterThan(t.value.y)
      }
    }
  })
  test('node text blocks follow the key and layout', () => {
    for (const k of KEYS) {
      const n = layout.nodes[k]
      const t = batteryNodeText(n, k, layout.narrow)
      if (k === 'sol' || k === 'imp' || k === 'bat') expect(t.second, k).toBeNull()
      expect(t.third, k).toBeNull()
      if (k === 'out') expect(t.second, k).not.toBeNull()
      if (layout.narrow) {
        expect(t.tile.size, k).toBe(34)
        expect(t.value.size, k).toBe(k === 'bat' ? 18 : 24)
      } else {
        expect(t.tile.size, k).toBe(48)
        expect(t.value.size, k).toBe(k === 'bat' ? 20 : 28)
        if (k === 'bat') {
          expect(t.label.y).toBeLessThan(t.value.y)
          expect(t.tile.y + t.tile.size / 2).toBeCloseTo(n.y, 9)
        }
        if (k === 'out' || k === 'loss') expect(t.second?.x, k).toBe(n.x - n.w / 2 + NODE_PADDING)
      }
    }
  })
  test('the wide second line leaves room for the share text', () => {
    if (layout.narrow) return
    const n = layout.nodes.loss
    const t = batteryNodeText(n, 'loss', false)
    expect(n.x + n.w / 2 - NODE_PADDING - (t.second?.x ?? 0)).toBeGreaterThanOrEqual(200)
  })
})

test('edge values: into the battery by origin, out, and the loss only when it reads as a value', () => {
  const f = energyFigures(sums())
  expect(batteryEdgeKwh(f, 'sol', 'bat')).toBeCloseTo(172.9, 9)
  expect(batteryEdgeKwh(f, 'imp', 'bat')).toBeCloseTo(67.9, 9)
  expect(batteryEdgeKwh(f, 'bat', 'out')).toBeCloseTo(225.4, 9)
  expect(batteryEdgeKwh(f, 'bat', 'loss')).toBeCloseTo(f.loss, 9)
  const noisy = energyFigures(
    sums({
      batteryChargeSolarKwh: 10,
      batteryChargeGridKwh: 0,
      batteryDischargeKwh: 10.2,
      firstSocPct: 50,
      lastSocPct: 50,
    }),
  )
  expect(batteryEdgeKwh(noisy, 'bat', 'loss')).toBe(0)
})

test('the loss arrow threshold is 0,5 kWh, and other pairs carry nothing', () => {
  const f = energyFigures(sums())
  expect(batteryEdgeKwh({ ...f, loss: 0.499 }, 'bat', 'loss')).toBe(0)
  expect(batteryEdgeKwh({ ...f, loss: 0.5 }, 'bat', 'loss')).toBe(0.5)
  expect(batteryEdgeKwh(f, 'out', 'bat')).toBe(0)
  expect(batteryEdgeKwh(f, 'sol', 'imp')).toBe(0)
})

test('arrows under 0,05 kWh are not drawn', () => {
  const f = energyFigures(sums({ batteryChargeGridKwh: 0.04 }))
  const drawn = batteryDrawnFlows(batteryFlowLayout(1006), f).map(
    (x) => `${x.spec.from}>${x.spec.to}`,
  )
  expect(drawn).not.toContain('imp>bat')
  expect(drawn).toContain('sol>bat')
})

describe('batteryDrawnFlows', () => {
  const layout = batteryFlowLayout(1006)
  const key = (x: { spec: { from: string; to: string } }) => `${x.spec.from}>${x.spec.to}`
  test("carries each flow's kWh", () => {
    const f = energyFigures(sums())
    const drawn = batteryDrawnFlows(layout, f)
    expect(drawn.map(key).sort()).toEqual(['bat>loss', 'bat>out', 'imp>bat', 'sol>bat'])
    const kwh = (k: string) => drawn.find((x) => key(x) === k)?.kwh
    expect(kwh('sol>bat')).toBeCloseTo(172.9, 9)
    expect(kwh('imp>bat')).toBeCloseTo(67.9, 9)
    expect(kwh('bat>out')).toBeCloseTo(225.4, 9)
    expect(kwh('bat>loss')).toBeCloseTo(f.loss, 9)
  })
  test('exactly 0,05 kWh is kept', () => {
    const f = energyFigures(
      sums({ solarKwh: 0, batteryChargeSolarKwh: 0, batteryChargeGridKwh: 0.05 }),
    )
    expect(batteryDrawnFlows(layout, f).map(key)).toContain('imp>bat')
  })
  test('a loss of 0,4 kWh gives no loss arrow', () => {
    const f = energyFigures(sums())
    expect(batteryDrawnFlows(layout, { ...f, loss: 0.4 }).map(key)).not.toContain('bat>loss')
  })
  test('all-zero sums draw nothing', () => {
    const z = energyFigures(
      sums({
        gridImportKwh: 0,
        gridExportKwh: 0,
        solarKwh: 0,
        loadKwh: 0,
        batteryDischargeKwh: 0,
        batteryChargeSolarKwh: 0,
        batteryChargeGridKwh: 0,
        carKwh: 0,
        firstSocPct: 0,
        lastSocPct: 0,
      }),
    )
    expect(batteryDrawnFlows(layout, z)).toEqual([])
  })
})

test('the Förlust share line is wide only; Ut keeps its line on both', () => {
  const wide = batteryFlowLayout(1006)
  const narrow = batteryFlowLayout(324)
  expect(batteryNodeText(wide.nodes.loss, 'loss', false).second).not.toBeNull()
  expect(batteryNodeText(narrow.nodes.loss, 'loss', true).second).toBeNull()
  expect(batteryNodeText(narrow.nodes.out, 'out', true).second).not.toBeNull()
})

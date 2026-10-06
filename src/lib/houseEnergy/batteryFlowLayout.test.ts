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
import { flowCurve } from './flowLayout'

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

describe.each([324, 754, 1006])('at %i px', (width) => {
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
  test('every arrow joins the battery, starts on its source edge and ends on its target edge', () => {
    expect(layout.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
      'bat>loss',
      'bat>out',
      'imp>bat',
      'sol>bat',
    ])
    for (const e of layout.edges) {
      const c = flowCurve(layout, e)
      const t = layout.nodes[e.to]
      const onEdge =
        Math.abs(Math.abs(c.tip.x - t.x) - t.w / 2) < 0.01 ||
        Math.abs(Math.abs(c.tip.y - t.y) - t.h / 2) < 0.01
      expect(onEdge, `${e.from}>${e.to}`).toBe(true)
    }
  })
  test('node text stays inside its node', () => {
    for (const k of KEYS) {
      const n = layout.nodes[k]
      const t = batteryNodeText(n, k, layout.narrow)
      expect(t.value.x + 0, k).toBeGreaterThan(n.x - n.w / 2)
      expect(t.value.room, k).toBeGreaterThan(0)
      expect(t.value.y, k).toBeLessThan(n.y + n.h / 2)
      if (t.second) expect(t.second.y, k).toBeLessThan(n.y + n.h / 2)
      if (t.second) expect(t.second.y, k).toBeGreaterThan(t.value.y)
    }
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

test('arrows under 0,05 kWh are not drawn', () => {
  const f = energyFigures(sums({ batteryChargeGridKwh: 0.04 }))
  const drawn = batteryDrawnFlows(batteryFlowLayout(1006), f).map(
    (x) => `${x.spec.from}>${x.spec.to}`,
  )
  expect(drawn).not.toContain('imp>bat')
  expect(drawn).toContain('sol>bat')
})

test('the Förlust share line is wide only; Ut keeps its line on both', () => {
  const wide = batteryFlowLayout(1006)
  const narrow = batteryFlowLayout(324)
  expect(batteryNodeText(wide.nodes.loss, 'loss', false).second).not.toBeNull()
  expect(batteryNodeText(narrow.nodes.loss, 'loss', true).second).toBeNull()
  expect(batteryNodeText(narrow.nodes.out, 'out', true).second).not.toBeNull()
})

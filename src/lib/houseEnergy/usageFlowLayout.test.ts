import { describe, expect, test } from 'vitest'
import { energyFigures, type PeriodSums } from './figures'
import { ARROW_LENGTH, flowCurve, NODE_PADDING } from './flowLayout'
import {
  fitPortWidths,
  stackPorts,
  USE_LANE,
  USE_NARROW_HEIGHT,
  USE_WIDE_HEIGHT,
  type UseConsumer,
  usageConsumers,
  usageFlowLayout,
  usageNodeText,
} from './usageFlowLayout'

type Box = { x: number; y: number; w: number; h: number }
const overlap = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h
type P = { x: number; y: number }
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

// September-like shares: house the largest, the car next, two units smaller.
const two: UseConsumer[] = [
  { key: 'car', kwh: 300 },
  { key: 'house', kwh: 390 },
]
const four: UseConsumer[] = [
  { key: 'car', kwh: 300 },
  { key: 'hp:hp-a', kwh: 150 },
  { key: 'hp:hp-b', kwh: 60 },
  { key: 'house', kwh: 390 },
]
const five: UseConsumer[] = [...four.slice(0, 3), { key: 'hp:hp-c', kwh: 40 }, four[3]]

test('usageConsumers: laddning, the units in figure order, övrigt hus', () => {
  const s: PeriodSums = {
    gridImportKwh: 0,
    gridExportKwh: 0,
    solarKwh: 0,
    loadKwh: 900,
    batteryDischargeKwh: 0,
    batteryChargeSolarKwh: 0,
    batteryChargeGridKwh: 0,
    carKwh: 300,
    firstSocPct: null,
    lastSocPct: null,
    buckets: 1,
    expectedBuckets: 1,
    heatPumps: [
      { id: 'hp-a', name: 'Matsal', kwh: 150, hours: 1, expectedHours: 1 },
      { id: 'hp-b', name: 'Övervåning', kwh: 60, hours: 1, expectedHours: 1 },
    ],
  }
  expect(usageConsumers(energyFigures(s))).toEqual(four)
})

test('stackPorts lays widths side by side, 2 px apart, centred; spreads evenly what cannot fit', () => {
  expect(stackPorts([10, 4], 30)).toEqual([12, 21]) // 16 wide in 30: starts at 7 → centres 7 + 5 and 19 + 2
  expect(stackPorts([], 30)).toEqual([])
  expect(stackPorts(fitPortWidths([20, 20, 20], 40), 40)).toEqual([6, 20, 34])
  const unfitted = stackPorts([20, 20, 20], 40)
  expect(unfitted[0]).toBe(10)
  expect(unfitted[2]).toBe(30)
})

test('fitPortWidths keeps widths that fit and scales them all by one factor when they do not', () => {
  expect(fitPortWidths([10, 4], 30)).toEqual([10, 4])
  expect(fitPortWidths([], 30)).toEqual([])
  // 60 + 2 × 2 gaps in 40: the 36 px left are shared in proportion.
  expect(fitPortWidths([20, 20, 20], 40)).toEqual([12, 12, 12])
  const scaled = fitPortWidths([16, 8, 4], 20)
  expect(scaled[0] / scaled[1]).toBeCloseTo(2, 9)
  expect(scaled.reduce((a, b) => a + b, 0) + 4).toBeCloseTo(20, 9)
  // A width one factor would take below 1 px keeps 1 px; the others share the rest.
  const floored = fitPortWidths([30, 30, 0.5], 24)
  expect(floored[2]).toBe(1)
  expect(floored[0] + floored[1] + 1 + 4).toBeCloseTo(24, 9)
})

test('the 860 px rule: 859 is narrow, 860 is wide', () => {
  expect(usageFlowLayout(859, four).narrow).toBe(true)
  expect(usageFlowLayout(860, four).narrow).toBe(false)
})

describe.each([256, 296, 311, 324, 380, 754, 859, 860, 1006])('at %i px', (width) => {
  test.each([
    ['two', two],
    ['four', four],
    ['five', five],
  ] as const)('%s consumers: a fixed height, every node inside, none overlapping', (_n, consumers) => {
    const layout = usageFlowLayout(width, consumers)
    expect(layout.height).toBe(width < 860 ? USE_NARROW_HEIGHT : USE_WIDE_HEIGHT)
    const keys = Object.keys(layout.nodes) as (keyof typeof layout.nodes)[]
    expect(keys).toEqual(['load', ...consumers.map((c) => c.key)])
    for (const k of keys) {
      const n = layout.nodes[k]
      expect(n.x - n.w / 2, k).toBeGreaterThanOrEqual(0)
      expect(n.x + n.w / 2, k).toBeLessThanOrEqual(width)
      expect(n.y - n.h / 2, k).toBeGreaterThanOrEqual(0)
      expect(n.y + n.h / 2, k).toBeLessThanOrEqual(layout.height)
    }
    for (const a of keys)
      for (const b of keys)
        if (a < b) expect(overlap(layout.nodes[a], layout.nodes[b]), `${a}/${b}`).toBe(false)
    // Consumers top to bottom in the given order.
    const ys = consumers.map((c) => layout.nodes[c.key].y)
    expect(ys).toEqual([...ys].sort((p, q) => p - q))
  })

  test('the arrows leave the load side by side and never cross', () => {
    const layout = usageFlowLayout(width, four)
    const load = layout.nodes.load
    for (let i = 1; i < layout.flows.length; i++) {
      const a = layout.flows[i - 1]
      const b = layout.flows[i]
      const gap = layout.narrow
        ? a.spec.fromOffset - b.spec.fromOffset // narrow: the lower consumer's arrow sits further left
        : b.spec.fromOffset - a.spec.fromOffset // wide: in order from the top
      expect(gap).toBeGreaterThanOrEqual((a.width + b.width) / 2 + 2 - 1e-9)
    }
    for (const f of layout.flows) {
      if (layout.narrow) {
        const x = load.x + f.spec.fromOffset
        expect(x - f.width / 2).toBeGreaterThanOrEqual(1)
        // The ports' strip ends where an arrow still has 24 px to turn and its arrowhead before the column.
        expect(x + f.width / 2).toBeLessThanOrEqual(USE_LANE - ARROW_LENGTH - 24 + 1e-9)
      } else {
        expect(Math.abs(f.spec.fromOffset) + f.width / 2).toBeLessThanOrEqual(load.h / 2)
      }
    }
    const curves = layout.flows.map((f) => {
      const c = flowCurve(layout, f.spec)
      return Array.from({ length: 41 }, (_, i) => c.at(i / 40))
    })
    for (let i = 0; i < curves.length; i++)
      for (let j = i + 1; j < curves.length; j++)
        expect(cross(curves[i], curves[j]), `${i}/${j}`).toBe(false)
  })
})

test('wide: the value pills sit at least 30 px apart', () => {
  const layout = usageFlowLayout(1006, five)
  const ys = layout.flows.map((f) => flowCurve(layout, f.spec).at(f.spec.labelT).y)
  for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(30)
})

test('narrow: each arrow runs down the lane, left of the consumer column', () => {
  const layout = usageFlowLayout(311, four)
  for (const f of layout.flows) {
    const pts = Array.from({ length: 41 }, (_, i) => flowCurve(layout, f.spec).at(i / 40))
    const target = layout.nodes[f.spec.to]
    // Until it reaches its node's row, the arrow stays inside the lane.
    for (const p of pts)
      if (p.y < target.y - target.h / 2) expect(p.x).toBeLessThanOrEqual(USE_LANE)
  }
})

test('a consumer under 0,05 kWh has a node but no arrow; nothing drawn leaves the nodes placed', () => {
  const layout = usageFlowLayout(1006, [
    { key: 'car', kwh: 0.01 },
    { key: 'house', kwh: 390 },
  ])
  expect(layout.nodes.car).toBeDefined()
  expect(layout.flows.map((f) => f.spec.to)).toEqual(['house'])
  const none = usageFlowLayout(1006, [
    { key: 'car', kwh: 0 },
    { key: 'house', kwh: 0 },
  ])
  expect(none.flows).toEqual([])
  expect(Object.keys(none.nodes)).toEqual(['load', 'car', 'house'])
})

test('arrow widths are the data: linear in kWh, the largest 20 px wide / 16 px narrow', () => {
  const wide = usageFlowLayout(1006, four)
  expect(wide.flows.find((f) => f.spec.to === 'house')?.width).toBe(20)
  expect(wide.flows.find((f) => f.spec.to === 'car')?.width).toBeCloseTo((20 * 300) / 390, 9)
  expect(usageFlowLayout(311, four).flows.find((f) => f.spec.to === 'house')?.width).toBe(16)
})

describe.each([256, 311, 1006])('node text at %i px', (width) => {
  test('every node’s text starts inside it and leaves the figure room', () => {
    const layout = usageFlowLayout(width, five)
    for (const key of Object.keys(layout.nodes) as (keyof typeof layout.nodes)[]) {
      const n = layout.nodes[key]
      const t = usageNodeText(n, key, layout.narrow)
      expect(t.tile.x).toBeGreaterThanOrEqual(n.x - n.w / 2)
      expect(t.tile.y + t.tile.size).toBeLessThanOrEqual(n.y + n.h / 2)
      expect(t.label.x).toBeLessThan(n.x + n.w / 2 - NODE_PADDING)
      expect(t.value.y).toBeLessThanOrEqual(n.y + n.h / 2)
      expect(t.value.room).toBeGreaterThanOrEqual(90)
    }
  })
})

/** The least distance between two arrows' strokes over the samples kept by `keep` (centre lines less half widths). */
const strokeGap = (
  layout: ReturnType<typeof usageFlowLayout>,
  a: (typeof layout.flows)[number],
  b: (typeof layout.flows)[number],
  keep: (p: P) => boolean,
) => {
  const pts = (f: typeof a) => {
    const c = flowCurve(layout, f.spec)
    return Array.from({ length: 401 }, (_, i) => c.at(i / 400)).filter(keep)
  }
  const pa = pts(a)
  const pb = pts(b)
  let least = Number.POSITIVE_INFINITY
  for (const p of pa) for (const q of pb) least = Math.min(least, Math.hypot(p.x - q.x, p.y - q.y))
  return least - (a.width + b.width) / 2
}

describe.each([
  // January-like: two large units next to the car and the house.
  [
    'January-like',
    [
      { key: 'car', kwh: 400 },
      { key: 'hp:hp-a', kwh: 386 },
      { key: 'hp:hp-b', kwh: 165 },
      { key: 'house', kwh: 600 },
    ],
  ],
  [
    'near-equal',
    [
      { key: 'car', kwh: 300 },
      { key: 'hp:hp-a', kwh: 300 },
      { key: 'hp:hp-b', kwh: 200 },
      { key: 'house', kwh: 300 },
    ],
  ],
] as [string, UseConsumer[]][])('narrow, a full lane (%s)', (_name, consumers) => {
  test.each([
    256, 311, 859,
  ])('at %i px the arrows keep 2 px apart at the load and down the lane', (width) => {
    const layout = usageFlowLayout(width, consumers)
    expect(layout.flows).toHaveLength(4)
    for (let i = 1; i < layout.flows.length; i++) {
      const upper = layout.flows[i - 1]
      const lower = layout.flows[i]
      // At the load: the lower consumer's arrow sits further left.
      expect(upper.spec.fromOffset - lower.spec.fromOffset).toBeGreaterThanOrEqual(
        (upper.width + lower.width) / 2 + 2 - 1e-9,
      )
      // Down the lane, until the upper arrow reaches its node's row.
      const row = layout.nodes[upper.spec.to]
      expect(
        strokeGap(layout, upper, lower, (p) => p.y <= row.y - row.h / 2),
        `${upper.spec.to}/${lower.spec.to}`,
      ).toBeGreaterThanOrEqual(2 - 0.05)
    }
    // Proportions kept: the widths are still the data, one scale for all.
    const k = layout.flows[0].width / consumers[0].kwh
    for (const [i, f] of layout.flows.entries())
      expect(f.width).toBeCloseTo(k * consumers[i].kwh, 9)
  })
})

test('wide, five near-equal consumers: the arrows keep 2 px apart at the load and all the way', () => {
  const consumers: UseConsumer[] = [
    { key: 'car', kwh: 300 },
    { key: 'hp:hp-a', kwh: 290 },
    { key: 'hp:hp-b', kwh: 280 },
    { key: 'hp:hp-c', kwh: 270 },
    { key: 'house', kwh: 300 },
  ]
  for (const width of [860, 1006]) {
    const layout = usageFlowLayout(width, consumers)
    const load = layout.nodes.load
    for (let i = 1; i < layout.flows.length; i++) {
      const a = layout.flows[i - 1]
      const b = layout.flows[i]
      expect(b.spec.fromOffset - a.spec.fromOffset).toBeGreaterThanOrEqual(
        (a.width + b.width) / 2 + 2 - 1e-9,
      )
      expect(strokeGap(layout, a, b, () => true)).toBeGreaterThanOrEqual(2 - 0.05)
    }
    for (const f of layout.flows)
      expect(Math.abs(f.spec.fromOffset) + f.width / 2).toBeLessThanOrEqual(load.h / 2)
  }
})

import { range } from 'd3-array'
import { scaleBand } from 'd3-scale'
import { describe, expect, test } from 'vitest'
import {
  type BarSeries,
  layoutBars,
  MIN_BAR_PX,
  slotsOf,
  stackExtent,
  thinTicks,
  yScaleFor,
} from './barLayout'

const s = (key: string, over: Partial<BarSeries> = {}): BarSeries => ({
  key,
  label: key,
  color: 'red',
  ...over,
})
const band = (n: number, width: number) => scaleBand<number>().domain(range(n)).range([0, width])

describe('slotsOf', () => {
  test('series side by side unless they share a stack, in first-seen order', () => {
    // Economy: immediate | actual + stub | optimal.
    const series = [
      s('immediate'),
      s('actual', { stack: 'mid' }),
      s('optimal'),
      s('stub', { stack: 'mid' }),
    ]
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
    expect(yScaleFor({ extent: [0, 1], height: 100, domain: [0, 33] }).scale.domain()).toEqual([
      0, 33,
    ])
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
    const kept = thinTicks(
      centres,
      centres.map(() => 26),
    )
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

describe('review: recharts parity on small data and stacks', () => {
  test('an integer axis always shows five ticks, growing up from small data', () => {
    expect(yScaleFor({ extent: [0, 1], height: 100, integers: true }).ticks).toEqual([
      0, 1, 2, 3, 4,
    ])
    expect(yScaleFor({ extent: [0, 3], height: 100, integers: true }).ticks).toEqual([
      0, 1, 2, 3, 4,
    ])
    expect(yScaleFor({ extent: [0, 0], height: 100, integers: true }).ticks).toEqual([
      0, 1, 2, 3, 4,
    ])
    expect(yScaleFor({ extent: [-3, 0], height: 100, integers: true }).ticks).toEqual([
      -4, -3, -2, -1, 0,
    ])
  })

  test('a pinned domain keeps its own ticks', () => {
    const { scale, ticks } = yScaleFor({ extent: [0, 1], height: 100, domain: [0, 33] })
    expect(scale.domain()).toEqual([0, 33])
    expect(ticks).toEqual(scale.ticks(5))
  })

  test('a segment stacked on a negative one starts from the running sum', () => {
    const y = yScaleFor({ extent: [-5, 3], height: 100 }).scale
    const [spot, fees] = layoutBars({
      count: 1,
      series: [s('spot', { stack: 'sek' }), s('fees', { stack: 'sek' })],
      value: (_, k) => (k === 'spot' ? -5 : 3),
      x: band(1, 100),
      y,
      barGap: 4,
    })
    expect(spot.y).toBeCloseTo(y(0))
    expect(spot.y + spot.height).toBeCloseTo(y(-5))
    // fees spans −5 → −2: drawn from y(−2) down to y(−5).
    expect(fees.y).toBeCloseTo(y(-2))
    expect(fees.y + fees.height).toBeCloseTo(y(-5))
  })

  test('a segment over a null one starts at 0', () => {
    const y = yScaleFor({ extent: [0, 10], height: 100 }).scale
    const [stub] = layoutBars({
      count: 1,
      series: [s('actual', { stack: 'mid' }), s('stub', { stack: 'mid' })],
      value: (_, k) => (k === 'actual' ? null : 3),
      x: band(1, 100),
      y,
      barGap: 2,
    })
    expect(stub.key).toBe('stub')
    expect(stub.y + stub.height).toBeCloseTo(y(0))
  })

  test('three slots split the band with the gap; bar widths are whole pixels', () => {
    const y = yScaleFor({ extent: [0, 10], height: 100 }).scale
    const rects = layoutBars({
      count: 1,
      series: [
        s('immediate'),
        s('actual', { stack: 'mid' }),
        s('optimal'),
        s('stub', { stack: 'mid' }),
      ],
      value: (_, k) => (k === 'stub' ? null : 5),
      x: band(1, 101),
      y,
      barGap: 2,
    })
    const [imm, act, opt] = rects
    // (101 − 2·10.1 − 2·2) / 3 = 25.6 → 25
    expect(imm.width).toBe(25)
    expect(act.x - imm.x).toBeCloseTo(27)
    expect(opt.x - act.x).toBeCloseTo(27)
  })

  test('a band too narrow for the gaps drops them', () => {
    const y = yScaleFor({ extent: [0, 10], height: 100 }).scale
    const rects = layoutBars({
      count: 1,
      series: [s('a'), s('b'), s('c')],
      value: () => 5,
      x: band(1, 5),
      y,
      barGap: 2,
    })
    // 5 − 2·0.5 − 2·2 = 0: no room for gaps, so the three bars share 4 px.
    expect(rects[1].x - rects[0].x).toBeCloseTo(rects[0].width)
  })

  test('thinTicks handles no ticks, one, and a last label that collides with the first', () => {
    expect(thinTicks([], [])).toEqual([])
    expect(thinTicks([10], [30])).toEqual([0])
    // Two labels wider than their spacing: keep the last only.
    expect(thinTicks([10, 20], [30, 30])).toEqual([1])
  })
})

describe('review: edges a subtly wrong layout would get wrong', () => {
  const y = yScaleFor({ extent: [0, 100], height: 100 }).scale

  test('slots: different stack ids differ; a stack id equal to a series key is still its own slot', () => {
    expect(
      slotsOf([s('a', { stack: 'x' }), s('b', { stack: 'y' }), s('c', { stack: 'x' })]),
    ).toEqual([['a', 'c'], ['b']])
    expect(slotsOf([s('x'), s('y', { stack: 'x' })])).toEqual([['x'], ['y']])
    expect(slotsOf([])).toEqual([])
  })

  test('three slots: positions step by the whole-pixel width plus the gap', () => {
    const rects = layoutBars({
      count: 1,
      series: [s('a'), s('b'), s('c')],
      value: () => 50,
      x: band(1, 100),
      y,
      barGap: 2,
    })
    const w = Math.trunc((100 - 20 - 4) / 3)
    expect(rects.map((r) => r.width)).toEqual([w, w, w])
    expect(rects.map((r) => r.x)).toEqual(
      [10, 10 + w + 2, 10 + 2 * (w + 2)].map((v) => expect.closeTo(v)),
    )
  })

  test('a lone stack fills the band less the category gap, both segments at one x', () => {
    const [spot, fees] = layoutBars({
      count: 1,
      series: [s('spot', { stack: 'sek' }), s('fees', { stack: 'sek' })],
      value: () => 10,
      x: band(1, 100),
      y,
      barGap: 4,
    })
    expect(spot.width).toBe(80)
    expect(spot.x).toBeCloseTo(10)
    expect(fees.x).toBeCloseTo(10)
  })

  test('bars sit in their own band, wherever the band scale starts', () => {
    const x = scaleBand<number>().domain(range(3)).range([40, 340]).paddingInner(0.2)
    const rects = layoutBars({ count: 3, series: [s('a')], value: () => 10, x, y, barGap: 4 })
    for (const r of rects) {
      expect(r.x).toBeCloseTo((x(r.index) ?? Number.NaN) + x.bandwidth() * 0.1)
      expect(r.width).toBe(Math.trunc(x.bandwidth() * 0.8))
    }
  })

  test('a band far too narrow never draws a negative width', () => {
    const rects = layoutBars({
      count: 1,
      series: [s('a'), s('b'), s('c')],
      value: () => 10,
      x: band(1, 10),
      y,
      barGap: 10,
    })
    for (const r of rects) expect(r.width).toBeGreaterThanOrEqual(0)
  })

  test('a segment over an uncounted 0 sits on the baseline', () => {
    const [fees] = layoutBars({
      count: 1,
      series: [s('spot', { stack: 'sek' }), s('fees', { stack: 'sek' })],
      value: (_, k) => (k === 'spot' ? 0 : 30),
      x: band(1, 100),
      y,
      barGap: 4,
    })
    expect(fees.key).toBe('fees')
    expect(fees.y + fees.height).toBeCloseTo(y(0))
    expect(fees.y).toBeCloseTo(y(30))
  })

  test('a floored lower segment does not lift the one above it (as recharts)', () => {
    const [low, high] = layoutBars({
      count: 1,
      series: [s('low', { stack: 'k' }), s('high', { stack: 'k' })],
      value: (_, k) => (k === 'low' ? 0.01 : 30),
      x: band(1, 100),
      y,
      barGap: 4,
    })
    expect(low.height).toBe(MIN_BAR_PX)
    expect(high.y + high.height).toBeCloseTo(y(0.01))
    expect(high.y).toBeCloseTo(y(30.01))
  })

  test('a zero-is-data segment floors on top of the stack below it', () => {
    const [, stub] = layoutBars({
      count: 1,
      series: [s('actual', { stack: 'mid' }), s('stub', { stack: 'mid', zeroIsData: true })],
      value: (_, k) => (k === 'actual' ? 40 : 0),
      x: band(1, 100),
      y,
      barGap: 4,
    })
    expect(stub.height).toBe(MIN_BAR_PX)
    expect(stub.y + stub.height).toBeCloseTo(y(40))
  })

  test('negatives in a stack accumulate downward, and a rect carries its own value', () => {
    const yn = yScaleFor({ extent: [-100, 100], height: 200 }).scale
    const [a, b] = layoutBars({
      count: 1,
      series: [s('a', { stack: 'k' }), s('b', { stack: 'k' })],
      value: (_, k) => (k === 'a' ? -20 : -30),
      x: band(1, 100),
      y: yn,
      barGap: 4,
    })
    expect(a.y).toBeCloseTo(yn(0))
    expect(a.y + a.height).toBeCloseTo(yn(-20))
    expect(b.y).toBeCloseTo(yn(-20))
    expect(b.y + b.height).toBeCloseTo(yn(-50))
    expect(b.value).toBe(-30)
  })

  test('stackExtent: negative segments add up; an unstacked line counts on its own; empty is 0', () => {
    expect(
      stackExtent({
        count: 1,
        series: [s('a', { stack: 'k' }), s('b', { stack: 'k' })],
        value: (_, k) => (k === 'a' ? -5 : -3),
      }),
    ).toEqual([-8, 0])
    expect(
      stackExtent({
        count: 2,
        series: [s('spot', { stack: 'sek' }), s('fees', { stack: 'sek' }), s('avg')],
        value: (i, k) => ({ spot: [1, 2], fees: [3, 4], avg: [50, -7] })[k]?.[i] ?? null,
      }),
    ).toEqual([-7, 50])
    expect(stackExtent({ count: 3, series: [s('avg')], value: (i) => [null, 12, 8][i] })).toEqual([
      0, 12,
    ])
    expect(stackExtent({ count: 0, series: [s('a')], value: () => 1 })).toEqual([0, 0])
    expect(stackExtent({ count: 3, series: [], value: () => 1 })).toEqual([0, 0])
    expect(stackExtent({ count: 3, series: [s('a')], value: () => null })).toEqual([0, 0])
  })

  test('yScaleFor: the tick set, an all-negative extent, a flat extent', () => {
    expect(yScaleFor({ extent: [3, 87], height: 200 }).ticks).toEqual([0, 20, 40, 60, 80, 100])
    const neg = yScaleFor({ extent: [-87, -3], height: 200 }).scale
    expect(neg.domain()).toEqual([-100, 0])
    expect(neg(0)).toBe(0)
    expect(yScaleFor({ extent: [0, 0], height: 100 }).scale.domain()).toEqual([0, 1])
  })

  test('integer axes cover the extent in whole steps, at least five ticks', () => {
    const across = yScaleFor({ extent: [-3, 7], height: 100, integers: true })
    expect(across.scale.domain()).toEqual([-4, 8])
    expect(across.ticks).toEqual([-4, -2, 0, 2, 4, 6, 8])
    expect(yScaleFor({ extent: [0, 13], height: 100, integers: true }).ticks).toEqual([
      0, 5, 10, 15, 20,
    ])
  })

  test('a pinned domain ignores an extent beyond it, is not made nice, and wins over integers', () => {
    const { scale, ticks } = yScaleFor({ extent: [-5, 50], height: 100, domain: [0, 33] })
    expect(scale.domain()).toEqual([0, 33])
    expect(scale(33)).toBe(0)
    expect(scale(0)).toBe(100)
    expect(ticks).toEqual([0, 5, 10, 15, 20, 25, 30])
    expect(
      yScaleFor({ extent: [0, 1], height: 100, domain: [0, 0.5], integers: true }).scale.domain(),
    ).toEqual([0, 0.5])
  })

  test('thinTicks: exact greedy output, the gap boundary, per-label widths, all too wide', () => {
    const centres = range(12).map((i) => 12 + i * 24)
    // 10 would fit after 8 but crowd 11, so it goes.
    expect(
      thinTicks(
        centres,
        centres.map(() => 26),
      ),
    ).toEqual([0, 2, 4, 6, 8, 11])
    // right(0) = 5, left(1) = 10: exactly the 5 px gap, so both stay.
    expect(thinTicks([0, 15, 30], [10, 10, 10])).toEqual([0, 1, 2])
    expect(thinTicks([0, 15, 30], [10, 10, 10], 6)).toEqual([0, 2])
    expect(thinTicks([0, 20, 40, 60], [10, 30, 10, 10])).toEqual([0, 2, 3])
    // Every label wider than the whole axis: only the last shows.
    expect(thinTicks([0, 10, 20, 30], [100, 100, 100, 100])).toEqual([3])
  })
})

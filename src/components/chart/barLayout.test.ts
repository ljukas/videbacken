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

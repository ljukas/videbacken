import { scaleLinear } from 'd3-scale'
import { timeHour } from 'd3-time'
import { describe, expect, test } from 'vitest'
import { makeTimeAxis, type TimeAxis } from '~/lib/sensor/tickFormat'
import {
  nearestTime,
  pickTimeTicks,
  readingTimes,
  TIME_TICK_GAP,
  type TimeTick,
} from './climateLayout'

// A fixed-width measure (7 px a character) keeps the fit independent of fonts.
const measure = (s: string) => s.length * 7
const HOUR = 3_600_000
const DAY = 24 * HOUR
// The every-device-hidden chart's label bounds: no y axis, so only the 4 px
// left margin, and the 12 px right margin past the plot.
const boundsFor = (plotW: number) => [-4, plotW + 12] as const

const ticksFor = (range: Parameters<typeof makeTimeAxis>[0], days: number, plotW: number) => {
  const start = new Date('2026-08-02T10:20:00').getTime()
  const domain = [start, start + days * DAY] as const
  const x = scaleLinear().domain(domain).range([0, plotW])
  const axis = makeTimeAxis(range, 'sv-SE')
  const bounds = boundsFor(plotW)
  return { ticks: pickTimeTicks({ domain, x, axis, measure, bounds }), x, axis, bounds }
}

const timesOf = (ticks: readonly TimeTick[]) => ticks.map((k) => k.t)

// A label's drawn edges: centred on its tick, shifted by its dx.
const edges = ({ t, dx }: TimeTick, x: (t: number) => number, axis: Pick<TimeAxis, 'format'>) => {
  const w = measure(axis.format(t))
  return { left: x(t) + dx - w / 2, right: x(t) + dx + w / 2 }
}

// No two labels closer than the gap, and every label inside the bounds.
const spaced = ({
  ticks,
  x,
  axis,
  bounds,
}: {
  ticks: readonly TimeTick[]
  x: (t: number) => number
  axis: Pick<TimeAxis, 'format'>
  bounds: readonly [number, number]
}) => {
  for (let i = 1; i < ticks.length; i++) {
    expect(
      edges(ticks[i], x, axis).left - edges(ticks[i - 1], x, axis).right,
    ).toBeGreaterThanOrEqual(TIME_TICK_GAP)
  }
  for (const k of ticks) {
    expect(edges(k, x, axis).left).toBeGreaterThanOrEqual(bounds[0])
    expect(edges(k, x, axis).right).toBeLessThanOrEqual(bounds[1])
  }
}

describe('pickTimeTicks', () => {
  test('a wide 24h chart takes every 3 hours', () => {
    const r = ticksFor('24h', 1, 900)
    expect(r.ticks.length).toBe(8)
    for (const t of timesOf(r.ticks)) expect(new Date(t).getHours() % 3).toBe(0)
    spaced(r)
  })

  test('a 320 px phone falls back to every 6 hours, never crowded', () => {
    // 4 ticks 65 px apart fit 35 px labels plus the gap; 8 ticks 32 px apart don't.
    const r = ticksFor('24h', 1, 260)
    expect(timesOf(r.ticks).map((t) => new Date(t).getHours())).toEqual([12, 18, 0, 6])
    spaced(r)
  })

  test('1w keeps a daily tick on a phone (short weekday labels)', () => {
    // A fixed label, so the fit doesn't depend on ICU's weekday length.
    const base = ticksFor('1w', 7, 300)
    const axis = { ...base.axis, format: () => 'mån' }
    const ticks = pickTimeTicks({
      domain: [base.x.domain()[0], base.x.domain()[1]],
      x: base.x,
      axis,
      measure,
      bounds: base.bounds,
    })
    expect(ticks.length).toBe(7)
    spaced({ ticks, x: base.x, axis, bounds: base.bounds })
  })

  test('1y on a phone falls back to every 3 months', () => {
    const r = ticksFor('1y', 365, 260)
    expect(r.ticks.length).toBe(4)
    for (const t of timesOf(r.ticks)) {
      expect([new Date(t).getDate(), new Date(t).getMonth() % 3]).toEqual([1, 0])
    }
    spaced(r)
  })

  test('when even the coarsest interval crowds, its labels are thinned', () => {
    const r = ticksFor('24h', 1, 60)
    const coarsest = r.axis.intervals[r.axis.intervals.length - 1]
    const start = r.x.domain()[0]
    expect(coarsest.range(new Date(start), new Date(start + DAY + 1)).length).toBeGreaterThan(1)
    expect(r.ticks.length).toBe(1)
    spaced(r)
  })

  test('a span with no round time in it has no ticks', () => {
    const start = new Date('2026-08-02T10:20:00').getTime()
    const domain = [start, start + 10 * 60_000] as const
    const x = scaleLinear().domain(domain).range([0, 600])
    expect(
      pickTimeTicks({
        domain,
        x,
        axis: makeTimeAxis('24h', 'sv-SE'),
        measure,
        bounds: boundsFor(600),
      }),
    ).toEqual([])
  })

  test('a month end keeps its labels spaced at a narrow width', () => {
    const start = new Date('2026-07-30T10:20:00').getTime()
    const domain = [start, start + 4 * DAY] as const
    const x = scaleLinear().domain(domain).range([0, 200])
    const axis = makeTimeAxis('1w', 'sv-SE')
    const bounds = boundsFor(200)
    spaced({ ticks: pickTimeTicks({ domain, x, axis, measure, bounds }), x, axis, bounds })
  })

  test('a 1y chart over 3 weeks of data falls back to round days, not a blank axis', () => {
    const r = ticksFor('1y', 21, 900)
    expect(r.ticks.length).toBeGreaterThanOrEqual(2)
    for (const t of timesOf(r.ticks)) {
      expect([new Date(t).getHours(), new Date(t).getMinutes()]).toEqual([0, 0])
    }
    spaced(r)
  })

  test('a 1y chart over a single day keeps the original result, without throwing', () => {
    const r = ticksFor('1y', 1, 900)
    expect(r.ticks.length).toBeLessThan(2)
  })

  test('a span with month starts keeps month ticks, the fallbacks unused', () => {
    const r = ticksFor('1y', 365, 900)
    expect(r.ticks.length).toBe(12)
    for (const t of timesOf(r.ticks)) expect(new Date(t).getDate()).toBe(1)
  })

  test('the domain end is included when it falls on a tick', () => {
    const start = new Date('2026-08-02T00:00:00').getTime()
    const end = new Date('2026-08-03T00:00:00').getTime()
    const domain = [start, end] as const
    const x = scaleLinear().domain(domain).range([0, 900])
    const ticks = timesOf(
      pickTimeTicks({
        domain,
        x,
        axis: makeTimeAxis('24h', 'sv-SE'),
        measure,
        bounds: boundsFor(900),
      }),
    )
    expect(ticks[0]).toBe(start)
    expect(ticks[ticks.length - 1]).toBe(end)
  })
})

describe('pickTimeTicks keeps the labels inside the chart', () => {
  test('a tick 1 px before the domain end keeps its mark; its label shifts left to fit', () => {
    // 24 h over 900 px: 96 s a pixel, so 21:00 sits at x = 899.
    const end = new Date('2026-08-03T21:00:00').getTime() + 96_000
    const domain = [end - DAY, end] as const
    const x = scaleLinear().domain(domain).range([0, 900])
    const axis = makeTimeAxis('24h', 'sv-SE')
    const bounds = boundsFor(900)
    const ticks = pickTimeTicks({ domain, x, axis, measure, bounds })
    const last = ticks[ticks.length - 1]
    expect(last.t).toBe(new Date('2026-08-03T21:00:00').getTime())
    expect(x(last.t)).toBeCloseTo(899)
    // Centred, "21:00" (35 px) would end at 916.5, past the 912 px bound.
    expect(edges(last, x, axis).right).toBeLessThanOrEqual(bounds[1])
    expect(last.dx).toBeLessThan(0)
    spaced({ ticks, x, axis, bounds })
  })

  test('a tick at the domain start, with no y axis (left = 4), keeps its label right of the bound', () => {
    const start = new Date('2026-08-02T00:00:00').getTime()
    const domain = [start, start + DAY - 60_000] as const
    const x = scaleLinear().domain(domain).range([0, 900])
    const axis = makeTimeAxis('24h', 'sv-SE')
    const bounds = boundsFor(900)
    const ticks = pickTimeTicks({ domain, x, axis, measure, bounds })
    expect(ticks[0].t).toBe(start)
    expect(edges(ticks[0], x, axis).left).toBeGreaterThanOrEqual(bounds[0])
    expect(ticks[0].dx).toBeGreaterThan(0)
    spaced({ ticks, x, axis, bounds })
  })

  test('labels that need no shift keep dx 0', () => {
    const r = ticksFor('24h', 1, 900)
    for (const k of r.ticks) expect(k.dx).toBe(0)
  })

  test('an end label shifted into its neighbour thins the ticks instead of colliding', () => {
    // Hourly ticks 55 px apart: centred, 35 px labels clear the 16 px gap
    // (20 px). The domain starts half an hour before the first, so that label
    // needs no shift, and ends 1 min after the last, whose label shifts 4.6 px
    // left and comes within 15.4 px of the one before: that one goes.
    const h0 = new Date('2026-08-02T00:00:00').getTime()
    const domain = [h0 - HOUR / 2, h0 + 3 * HOUR + 60_000] as const
    const plotW = 55 * (3.5 + 1 / 60)
    const x = scaleLinear().domain(domain).range([0, plotW])
    const axis: TimeAxis = { intervals: [timeHour], fallbacks: [], format: () => 'hh:mm' }
    const bounds = boundsFor(plotW)
    const ticks = pickTimeTicks({ domain, x, axis, measure, bounds })
    expect(timesOf(ticks)).toEqual([h0, h0 + HOUR, h0 + 3 * HOUR])
    expect(ticks[0].dx).toBe(0)
    expect(ticks[ticks.length - 1].dx).toBeLessThan(0)
    spaced({ ticks, x, axis, bounds })
  })
})

describe('readingTimes and nearestTime', () => {
  const devices = [
    {
      id: 'a',
      points: [
        { t: 10, a: 1 },
        { t: 30, a: null },
        { t: 50, a: 2 },
      ],
    },
    {
      id: 'b',
      points: [
        { t: 10, b: 3 },
        { t: 20, b: 4 },
      ],
    },
    { id: 'c', hidden: true, points: [{ t: 15, c: 5 }] },
  ]

  test('merges the visible devices’ real readings, ascending and distinct', () => {
    // 30 is an outage marker, 15 belongs to a hidden device.
    expect(readingTimes(devices)).toEqual([10, 20, 50])
  })

  test('nothing visible gives no times', () => {
    expect(readingTimes(devices.map((d) => ({ ...d, hidden: true })))).toEqual([])
  })

  test('snaps to the closest time, and to null with none', () => {
    expect(nearestTime([10, 20, 50], 14)).toBe(10)
    expect(nearestTime([10, 20, 50], 36)).toBe(50)
    expect(nearestTime([10, 20, 50], -100)).toBe(10)
    expect(nearestTime([], 5)).toBeNull()
  })

  test('an exact match, past the last time, and a single time', () => {
    expect(nearestTime([10, 20, 50], 20)).toBe(20)
    expect(nearestTime([10, 20, 50], 999)).toBe(50)
    expect(nearestTime([42], 7)).toBe(42)
  })

  test('a tie goes to the later time', () => {
    expect(nearestTime([10, 20], 15)).toBe(20)
  })
})

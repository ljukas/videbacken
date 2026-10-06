import { scaleLinear } from 'd3-scale'
import { describe, expect, test } from 'vitest'
import { makeTimeAxis } from '~/lib/sensor/tickFormat'
import { nearestTime, pickTimeTicks, readingTimes, TIME_TICK_GAP } from './climateLayout'

// A fixed-width measure (7 px a character) keeps the fit independent of fonts.
const measure = (s: string) => s.length * 7
const HOUR = 3_600_000
const DAY = 24 * HOUR

const ticksFor = (range: Parameters<typeof makeTimeAxis>[0], days: number, plotW: number) => {
  const start = new Date('2026-08-02T10:20:00').getTime()
  const domain = [start, start + days * DAY] as const
  const x = scaleLinear().domain(domain).range([0, plotW])
  const axis = makeTimeAxis(range, 'sv-SE')
  return { ticks: pickTimeTicks({ domain, x, axis, measure }), x, axis }
}

// No two labels closer than the gap.
const spaced = ({ ticks, x, axis }: ReturnType<typeof ticksFor>) => {
  for (let i = 1; i < ticks.length; i++) {
    const right = x(ticks[i - 1]) + measure(axis.format(ticks[i - 1])) / 2
    const left = x(ticks[i]) - measure(axis.format(ticks[i])) / 2
    expect(left - right).toBeGreaterThanOrEqual(TIME_TICK_GAP)
  }
}

describe('pickTimeTicks', () => {
  test('a wide 24h chart takes every 3 hours', () => {
    const r = ticksFor('24h', 1, 900)
    expect(r.ticks.length).toBe(8)
    for (const t of r.ticks) expect(new Date(t).getHours() % 3).toBe(0)
    spaced(r)
  })

  test('a 320 px phone falls back to coarser hours, never crowded', () => {
    const r = ticksFor('24h', 1, 260)
    expect(r.ticks.length).toBeLessThan(8)
    expect(r.ticks.length).toBeGreaterThan(1)
    for (const t of r.ticks) expect(new Date(t).getHours() % 6).toBe(0)
    spaced(r)
  })

  test('1w keeps a daily tick on a phone (short weekday labels)', () => {
    const r = ticksFor('1w', 7, 300)
    expect(r.ticks.length).toBe(7)
    spaced(r)
  })

  test('1y on a phone thins the month starts until they fit', () => {
    const r = ticksFor('1y', 365, 260)
    expect(r.ticks.length).toBeGreaterThan(1)
    expect(r.ticks.length).toBeLessThan(12)
    for (const t of r.ticks) expect(new Date(t).getDate()).toBe(1)
    spaced(r)
  })

  test('when even the coarsest interval crowds, its labels are thinned', () => {
    const r = ticksFor('24h', 1, 60)
    expect(r.ticks.length).toBeGreaterThanOrEqual(1)
    spaced(r)
  })

  test('a span with no round time in it has no ticks', () => {
    const start = new Date('2026-08-02T10:20:00').getTime()
    const domain = [start, start + 10 * 60_000] as const
    const x = scaleLinear().domain(domain).range([0, 600])
    expect(pickTimeTicks({ domain, x, axis: makeTimeAxis('24h', 'sv-SE'), measure })).toEqual([])
  })

  test('the domain end is included when it falls on a tick', () => {
    const start = new Date('2026-08-02T00:00:00').getTime()
    const domain = [start, start + DAY] as const
    const x = scaleLinear().domain(domain).range([0, 900])
    const ticks = pickTimeTicks({ domain, x, axis: makeTimeAxis('24h', 'sv-SE'), measure })
    expect(ticks[0]).toBe(start)
    expect(ticks[ticks.length - 1]).toBe(start + DAY)
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
})

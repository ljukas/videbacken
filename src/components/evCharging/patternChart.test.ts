import { describe, expect, test } from 'vitest'
import {
  calendarIntensity,
  hasPatternData,
  heatmapIntensity,
  intensity,
  slotValue,
  ZERO_FILL,
} from './patternChart'

const step = (share: number) => `color-mix(in oklab, var(--brand) ${share}%, var(--card))`
const RAMP = [20, 40, 60, 80, 100].map(step)

describe('slotValue', () => {
  test('picks kWh or plugged-in hours', () => {
    const slot = { kwh: 12.5, pluggedHours: 3 }
    expect(slotValue(slot, 'kwh')).toBe(12.5)
    expect(slotValue(slot, 'plugged')).toBe(3)
  })
})

describe('intensity', () => {
  test('zero (and below) is the muted fill', () => {
    const { fill } = intensity([0, 1, 2, 3])
    expect(fill(0)).toBe(ZERO_FILL)
    expect(fill(-1)).toBe(ZERO_FILL)
  })

  test('all-zero data has no steps and fills everything muted', () => {
    const scale = intensity([0, 0, 0])
    expect(scale.steps).toEqual([])
    expect(scale.fill(0)).toBe(ZERO_FILL)
    expect(intensity([]).steps).toEqual([])
  })

  test('many values give five quantile steps, each holding real values', () => {
    const scale = intensity([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(scale.steps).toEqual([
      { color: RAMP[0], from: 1, to: 2 },
      { color: RAMP[1], from: 3, to: 4 },
      { color: RAMP[2], from: 5, to: 6 },
      { color: RAMP[3], from: 7, to: 8 },
      { color: RAMP[4], from: 9, to: 10 },
    ])
    expect([1, 2, 3, 5, 7, 9, 10].map(scale.fill)).toEqual([
      RAMP[0],
      RAMP[0],
      RAMP[1],
      RAMP[2],
      RAMP[3],
      RAMP[4],
      RAMP[4],
    ])
  })

  test('steps are monotonic: a bigger value is never a lighter step', () => {
    const values = [0.3, 0.3, 1, 2, 2, 2, 5, 8, 13, 21, 34, 55, 89]
    const scale = intensity(values)
    const rank = (v: number) => RAMP.indexOf(scale.fill(v))
    const sorted = [...values].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      expect(rank(sorted[i])).toBeGreaterThanOrEqual(rank(sorted[i - 1]))
    }
    for (let i = 1; i < scale.steps.length; i++) {
      expect(scale.steps[i].from).toBeGreaterThan(scale.steps[i - 1].to)
      expect(RAMP.indexOf(scale.steps[i].color)).toBeGreaterThan(
        RAMP.indexOf(scale.steps[i - 1].color),
      )
    }
  })

  test('fewer than five distinct values: fewer steps, never empty or duplicated', () => {
    // One value dominates: interpolated quantiles would repeat and leave empty steps.
    const two = intensity([1, 1, 1, 1, 10])
    expect(two.steps).toEqual([
      { color: RAMP[0], from: 1, to: 1 },
      { color: RAMP[4], from: 10, to: 10 },
    ])
    // A lone top value shares the top step rather than getting one of its own.
    expect(intensity([1, 10, 10, 10, 10, 20]).steps.map((s) => [s.from, s.to])).toEqual([
      [1, 1],
      [10, 20],
    ])
    const three = intensity([1, 5, 10])
    expect(three.steps.map((s) => [s.from, s.to])).toEqual([
      [1, 1],
      [5, 5],
      [10, 10],
    ])
    expect(three.steps.map((s) => s.color)).toEqual([RAMP[0], RAMP[2], RAMP[4]])
    for (const scale of [two, three]) {
      expect(new Set(scale.steps.map((s) => s.color)).size).toBe(scale.steps.length)
    }
  })

  test('a single distinct value is full brand', () => {
    const scale = intensity([0, 4, 4, 4])
    expect(scale.steps).toEqual([{ color: RAMP[4], from: 4, to: 4 }])
    expect(scale.fill(4)).toBe(RAMP[4])
  })

  test('a tiny non-zero value never gets the zero colour', () => {
    const scale = intensity([0.001, 50, 60, 70, 80, 90])
    expect(scale.fill(0.001)).toBe(RAMP[0])
    // Even one smaller than anything in the data.
    expect(scale.fill(0.0001)).toBe(RAMP[0])
  })

  test('the heatmap and calendar wrappers read the right values', () => {
    const grid = [
      [
        { kwh: 0, pluggedHours: 2 },
        { kwh: 5, pluggedHours: 0 },
      ],
    ]
    expect(heatmapIntensity(grid, 'kwh').steps).toEqual([{ color: RAMP[4], from: 5, to: 5 }])
    expect(heatmapIntensity(grid, 'plugged').steps).toEqual([{ color: RAMP[4], from: 2, to: 2 }])
    expect(
      calendarIntensity([
        { day: '2026-09-05', kwh: 32.1, sessions: 1 },
        { day: '2026-09-06', kwh: 0, sessions: 1 },
        { day: '2026-09-12', kwh: 10.5, sessions: 2 },
      ]).steps.map((s) => [s.from, s.color]),
    ).toEqual([
      [10.5, RAMP[0]],
      [32.1, RAMP[4]],
    ])
  })
})

const zeroSlot = { kwh: 0, pluggedHours: 0 }
const months = (kwh = 0, sessions = 0) =>
  Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    kwh: i === 0 ? kwh : 0,
    sessions: i === 0 ? sessions : 0,
  }))
const hours = (slot = zeroSlot) => Array.from({ length: 24 }, (_, h) => (h === 1 ? slot : zeroSlot))

describe('hasPatternData', () => {
  test('an empty year has nothing to draw', () => {
    expect(hasPatternData({ months: months(), hourOfDay: hours() })).toBe(false)
  })

  test('a session or kWh in some month counts', () => {
    expect(hasPatternData({ months: months(0, 1), hourOfDay: hours() })).toBe(true)
    expect(hasPatternData({ months: months(3.2, 0), hourOfDay: hours() })).toBe(true)
  })

  test('a zero-kWh spill-over from last year still counts by its plugged hours', () => {
    expect(
      hasPatternData({ months: months(), hourOfDay: hours({ kwh: 0, pluggedHours: 1.5 }) }),
    ).toBe(true)
  })
})

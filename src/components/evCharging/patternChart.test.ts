import { describe, expect, test } from 'vitest'
import { hasPatternData } from './patternChart'

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

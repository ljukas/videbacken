import { describe, expect, test } from 'vitest'
import { validateDaySlots } from './slots'
import { daySlots } from './testing/daySlots'

describe('validateDaySlots', () => {
  test.each([
    ['2026-09-28', 15, 96],
    ['2026-03-29', 15, 92], // spring forward
    ['2025-10-26', 15, 100], // fall back
    ['2025-09-28', 60, 24],
    ['2024-03-31', 60, 23],
    ['2024-10-27', 60, 25],
  ] as const)('accepts a complete %s of %i-min slots (%i slots)', (day, len, count) => {
    const slots = daySlots(day, len)
    expect(slots).toHaveLength(count)
    expect(validateDaySlots(day, slots)).toEqual([])
  })

  test('accepts negative and zero prices within market limits', () => {
    const slots = daySlots('2026-09-28', 15, (i) => (i % 2 ? -0.05 : 0))
    expect(validateDaySlots('2026-09-28', slots)).toEqual([])
  })

  test('rejects an empty day', () => {
    expect(validateDaySlots('2026-09-28', [])).toEqual(['no slots'])
  })

  test('rejects a gap, a missing end and a wrong length', () => {
    const slots = daySlots('2026-09-28', 15)
    const gap = slots.filter((_, i) => i !== 10)
    expect(validateDaySlots('2026-09-28', gap)).toContain(
      'slot 10 does not start where slot 9 ends',
    )

    const short = slots.slice(0, -1)
    expect(validateDaySlots('2026-09-28', short)).toContain(
      'last slot does not end at the next local midnight',
    )

    const odd = slots.map((s, i) => (i === 3 ? { ...s, endMs: s.endMs - 60_000 } : s))
    expect(validateDaySlots('2026-09-28', odd)).toContain('slot 3 differs in length from slot 0')
  })

  test('rejects slots for another day (UTC-midnight aligned)', () => {
    const shifted = daySlots('2026-09-28', 15).map((s) => ({
      ...s,
      startMs: s.startMs + 2 * 60 * 60 * 1000,
      endMs: s.endMs + 2 * 60 * 60 * 1000,
    }))
    expect(validateDaySlots('2026-09-28', shifted)).toContain(
      'first slot does not start at local midnight',
    )
  })

  test('rejects non-finite and implausible prices without echoing them', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 250, -150]) {
      const slots = daySlots('2026-09-28', 15, (i) => (i === 7 ? bad : 1))
      const problems = validateDaySlots('2026-09-28', slots)
      expect(problems).toEqual(['slot 7 has an implausible price'])
      expect(problems.join(' ')).not.toContain(String(bad))
    }
  })
})

test('accepts an extreme but real price spike (the market cap can rise)', () => {
  const slots = daySlots('2026-09-28', 15, (i) => (i === 70 ? 66 : 1)) // ≈ 6000 EUR/MWh
  expect(validateDaySlots('2026-09-28', slots)).toEqual([])
})

test('rejects a day mixing slot lengths, and one with a wrong base length', () => {
  const hourly = daySlots('2026-09-28', 60)
  const quarter = daySlots('2026-09-28', 15)
  const mixed = [...quarter.slice(0, 4), ...hourly.slice(1)]
  expect(validateDaySlots('2026-09-28', mixed)).toContain('slot 4 differs in length from slot 0')

  const thirty = quarter
    .filter((_, i) => i % 2 === 0)
    .map((s) => ({ ...s, endMs: s.startMs + 30 * 60_000 }))
  expect(validateDaySlots('2026-09-28', thirty)).toContain('slots are not 15 or 60 minutes long')
})

test('caps the problem list', () => {
  const garbage = daySlots('2026-09-28', 15, () => Number.NaN)
  const problems = validateDaySlots('2026-09-28', garbage)
  expect(problems).toHaveLength(6)
  expect(problems.at(-1)).toBe('and 91 more')
})

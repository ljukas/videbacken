import { describe, expect, test } from 'vitest'
import { rangePosition, summarySentence, timingVerdict } from './verdict'

describe('timingVerdict', () => {
  test('grades the score in thirds, with null as nothing to choose between', () => {
    expect(timingVerdict(1)).toBe('good')
    expect(timingVerdict(0.67)).toBe('good')
    expect(timingVerdict(0.669)).toBe('ok')
    expect(timingVerdict(0.5)).toBe('ok')
    expect(timingVerdict(0.33)).toBe('ok')
    expect(timingVerdict(0.329)).toBe('poor')
    expect(timingVerdict(0)).toBe('poor')
    expect(timingVerdict(null)).toBe('none')
  })
})

describe('rangePosition', () => {
  test('places a value between cheapest (0) and dearest (1)', () => {
    expect(rangePosition(59.44, 59.44, 130.82)).toBe(0)
    expect(rangePosition(130.82, 59.44, 130.82)).toBe(1)
    expect(rangePosition(95.13, 59.44, 130.82)).toBeCloseTo(0.5, 2)
  })

  test('clamps values outside the range', () => {
    expect(rangePosition(50, 60, 100)).toBe(0)
    expect(rangePosition(120, 60, 100)).toBe(1)
  })

  test('an empty range puts everything at the cheap end, never NaN', () => {
    expect(rangePosition(60, 60, 60)).toBe(0)
    expect(rangePosition(61, 60, 59)).toBe(0)
  })
})

describe('summarySentence', () => {
  const cf = (score: number | null, left: number, saved: number) => ({
    score,
    leftOnTableSek: left,
    savedVsImmediateSek: saved,
  })

  test('no score: the window offered no real choice', () => {
    expect(summarySentence(cf(null, 0.02, 0.01))).toBe('no_choice')
    // Even with figures that would otherwise read as a saving.
    expect(summarySentence(cf(null, 3, 2))).toBe('no_choice')
  })

  test('left on the table, but cheaper than charging at once', () => {
    expect(summarySentence(cf(0.5, 35.69, 33.14))).toBe('saved')
  })

  test('left on the table and dearer than charging at once', () => {
    expect(summarySentence(cf(0.1, 12, -4))).toBe('lost')
  })

  test('left on the table, about the same as charging at once', () => {
    expect(summarySentence(cf(0.2, 12, 0))).toBe('like_immediate')
    expect(summarySentence(cf(0.2, 12, 0.49))).toBe('like_immediate')
    expect(summarySentence(cf(0.2, 12, -0.49))).toBe('like_immediate')
  })

  test('next to nothing left (< 0,50 kr): nearly the cheapest', () => {
    expect(summarySentence(cf(0.99, 0.49, 20))).toBe('near_optimal_saved')
    expect(summarySentence(cf(1, 0, 0.5))).toBe('near_optimal_saved')
    expect(summarySentence(cf(1, 0, 0.2))).toBe('near_optimal_like_immediate')
    expect(summarySentence(cf(0.98, 0.5, 20))).toBe('saved')
  })
})

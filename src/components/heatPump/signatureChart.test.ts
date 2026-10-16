import { expect, test } from 'vitest'
import type { SignaturePoint, SignatureResult } from '~/lib/heatPump/signature'
import { fitSegment, nearestPoint, signatureDomains, signatureSegments } from './signatureChart'

const p = (
  deltaT: number,
  kwh: number,
  set: 'before' | 'after' = 'before',
  extrapolated = false,
): SignaturePoint => ({
  day: `d${deltaT}-${set}`,
  deltaT,
  kwh,
  set,
  extrapolated,
})
const fit = { a: 2, b: 0.5 }

test('a fitted line spans its own set’s ΔT range only', () => {
  expect(fitSegment(fit, [8, 4, 19])).toEqual({ x1: 4, y1: 4, x2: 19, y2: 11.5 })
  expect(fitSegment(fit, [])).toBeNull()
})

test('segments: before over the before points, after over the counted after points', () => {
  const points = [
    p(4, 4),
    p(19, 11.5),
    p(5, 4, 'after'),
    p(18, 10, 'after'),
    p(25, 12, 'after', true),
  ]
  const ok: SignatureResult = {
    state: 'ok',
    points,
    fit,
    afterFit: { a: 1.8, b: 0.45 },
    change: -0.1,
    margin: 0.01,
    beforeDays: 2,
    afterDays: 2,
  }
  expect(signatureSegments(ok)).toEqual({
    before: { x1: 4, y1: 4, x2: 19, y2: 11.5 },
    after: { x1: 5, y1: 4.05, x2: 18, y2: 9.9 },
  })
  expect(signatureSegments({ ...ok, afterFit: null }).after).toBeNull()
  expect(
    signatureSegments({ state: 'not_enough_after', after: 2, needed: 14, points, fit }).after,
  ).toBeNull()
  expect(signatureSegments({ state: 'not_enough_before', before: 2, points })).toEqual({
    before: null,
    after: null,
  })
})

test('domains: ΔT over every point, kWh from 0, both nice', () => {
  const points = [p(4, 4), p(19, 11.6), p(25, 3, 'after', true)]
  expect(signatureDomains(points, [])).toEqual({ x: [4, 26], y: [0, 12] })
  expect(signatureDomains([p(4, 4), p(19, 11.6)], [{ x1: 4, y1: 4, x2: 19, y2: 13.2 }]).y).toEqual([
    0, 14,
  ])
})

test('domains without points or with one ΔT stay drawable', () => {
  expect(signatureDomains([], [])).toEqual({ x: [0, 20], y: [0, 1] })
  expect(signatureDomains([p(10, 5)], []).x).toEqual([9, 11])
})

test('the nearest point within 24 px, the first on a tie, none farther away', () => {
  const pixels = [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
    { x: 100, y: 100 },
  ]
  expect(nearestPoint(pixels, 12, 11)).toBe(0)
  expect(nearestPoint(pixels, 20, 10)).toBe(0)
  expect(nearestPoint(pixels, 29, 14)).toBe(1)
  expect(nearestPoint(pixels, 60, 60)).toBeNull()
  expect(nearestPoint([], 0, 0)).toBeNull()
})

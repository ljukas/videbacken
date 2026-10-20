import { describe, expect, test } from 'vitest'
import { sensorAlertRuleInput } from './alertRuleInput'

const deviceId = '0b9f6a3e-6f0c-4b44-9a43-0d4d5d1f6a11'
const temperature = (over: Record<string, unknown> = {}) => ({
  kind: 'temperature',
  deviceId,
  direction: 'below',
  threshold: 4.5,
  count: 2,
  ...over,
})
const ok = (input: unknown) => sensorAlertRuleInput.safeParse(input).success

describe('sensorAlertRuleInput', () => {
  test('accepts a temperature rule on a half degree', () => {
    expect(ok(temperature())).toBe(true)
  })

  test('rejects temperature thresholds off the half degree or out of bounds', () => {
    expect(ok(temperature({ threshold: 4.3 }))).toBe(false)
    expect(ok(temperature({ threshold: -40.5 }))).toBe(false)
    expect(ok(temperature({ threshold: 60.5 }))).toBe(false)
    expect(ok(temperature({ threshold: -40 }))).toBe(true)
    expect(ok(temperature({ threshold: Number.NaN }))).toBe(false)
  })

  test('bounds the count', () => {
    expect(ok(temperature({ count: 1 }))).toBe(false)
    expect(ok(temperature({ count: 11 }))).toBe(false)
    expect(ok(temperature({ count: 10 }))).toBe(true)
  })

  test('humidity is a whole percent within bounds', () => {
    const humidity = (threshold: number) =>
      ok({ kind: 'humidity', deviceId, direction: 'above', threshold, count: 2 })
    expect(humidity(80.5)).toBe(false)
    expect(humidity(99)).toBe(true)
    expect(humidity(100)).toBe(false)
  })

  test('battery is a whole percent within bounds, no direction', () => {
    const battery = (threshold: number) => ok({ kind: 'battery', deviceId, threshold, count: 2 })
    expect(battery(4)).toBe(false)
    expect(battery(20)).toBe(true)
  })

  test('silence is whole hours within bounds and drops stray fields', () => {
    const silence = (silenceHours: number, extra = {}) =>
      sensorAlertRuleInput.safeParse({ kind: 'silence', deviceId, silenceHours, ...extra })
    expect(silence(2).success).toBe(false)
    expect(silence(73).success).toBe(false)
    const parsed = silence(3, { threshold: 5 })
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty('threshold')
  })

  test('rejects a device id that is not a uuid', () => {
    expect(ok(temperature({ deviceId: 'nope' }))).toBe(false)
  })
})

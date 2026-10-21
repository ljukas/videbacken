import { describe, expect, test } from 'vitest'
import { type AlertReading, judgeValueRule, type ValueRule } from './alertJudge'

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1) + minutes * 60_000)
const temp = (c: number | null, minutes: number): AlertReading => ({
  recordedAt: at(minutes),
  temperatureC: c,
  humidityPct: null,
  batteryPct: null,
})
const series = (values: number[]) => values.map((v, i) => temp(v, i * 120))

const cold: ValueRule = { kind: 'temperature', direction: 'below', threshold: 5, count: 2 }

describe('judgeValueRule', () => {
  test('fires once enough merged readings breach, since the oldest of them', () => {
    const readings = series([6, 4.9, 4.8])
    expect(judgeValueRule(cold, false, readings)).toEqual({
      action: 'fire',
      since: readings[1].recordedAt,
      value: 4.8,
    })
  })

  test('does nothing while a normal reading interrupts, and 5.0 is normal', () => {
    expect(judgeValueRule(cold, false, series([4.9, 5.1, 4.9]))).toEqual({ action: 'none' })
    expect(judgeValueRule(cold, true, series([4.9, 5.1, 4.9]))).toEqual({ action: 'none' })
    expect(judgeValueRule(cold, false, series([4.9, 5.0]))).toEqual({ action: 'none' })
  })

  test('recovers once enough readings are normal, from the oldest of them', () => {
    const readings = series([4.8, 5.0, 5.2])
    expect(judgeValueRule(cold, true, readings)).toEqual({
      action: 'recover',
      endedAt: readings[1].recordedAt,
      value: 5.2,
    })
  })

  test('a value hovering around the threshold never transitions', () => {
    const all = series([4.9, 5.0, 4.9, 5.1, 4.9, 5.0])
    let firing = false
    for (let n = 1; n <= all.length; n++) {
      const j = judgeValueRule(cold, firing, all.slice(0, n))
      expect(j.action).toBe('none')
      if (j.action === 'fire') firing = true
      if (j.action === 'recover') firing = false
    }
  })

  test('battery fires once, on batteryPct', () => {
    const rule: ValueRule = { kind: 'battery', direction: 'below', threshold: 20, count: 2 }
    const all = [19, 21, 19, 21, 19, 18].map(
      (v, i): AlertReading => ({
        recordedAt: at(i * 120),
        temperatureC: null,
        humidityPct: null,
        batteryPct: v,
      }),
    )
    let firing = false
    const fires: number[] = []
    for (let n = 1; n <= all.length; n++) {
      const j = judgeValueRule(rule, firing, all.slice(0, n))
      if (j.action === 'fire') {
        firing = true
        fires.push(n)
      }
      if (j.action === 'recover') firing = false
    }
    expect(fires).toEqual([6])
  })

  test('a burst counts as one reading, with its latest value', () => {
    const all = [temp(4.8, 0), temp(4.8, 120), temp(5.2, 121)]
    expect(judgeValueRule(cold, false, all.slice(0, 2)).action).toBe('fire')
    expect(judgeValueRule(cold, false, all)).toEqual({ action: 'none' })
  })

  test('readings without the measure are dropped', () => {
    const all: AlertReading[] = [
      temp(4.9, 0),
      { recordedAt: at(60), temperatureC: null, humidityPct: 70, batteryPct: null },
      temp(4.8, 120),
    ]
    expect(judgeValueRule(cold, false, all).action).toBe('fire')
  })

  test('too few readings do nothing', () => {
    expect(judgeValueRule(cold, false, series([4.9]))).toEqual({ action: 'none' })
    expect(judgeValueRule(cold, false, [])).toEqual({ action: 'none' })
  })

  test('humidity above', () => {
    const rule: ValueRule = { kind: 'humidity', direction: 'above', threshold: 80, count: 2 }
    const hum = (values: number[]): AlertReading[] =>
      values.map((v, i) => ({
        recordedAt: at(i * 120),
        temperatureC: null,
        humidityPct: v,
        batteryPct: null,
      }))
    expect(judgeValueRule(rule, false, hum([81, 82])).action).toBe('fire')
    expect(judgeValueRule(rule, true, hum([80, 80])).action).toBe('recover')
  })
})

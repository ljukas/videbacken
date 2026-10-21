// Client-safe pure judge for value alert rules (ADR-0028): given a rule, whether its alert is
// open, and the recent readings, say whether it fires, recovers or stays as it is.

import { mergeReadings } from './alertGroups'
import type { SensorAlertDirection, ValueAlertKind } from './alerts'

export type AlertReading = {
  recordedAt: Date
  temperatureC: number | null
  humidityPct: number | null
  batteryPct: number | null
}

export type ValueRule = {
  kind: ValueAlertKind
  direction: SensorAlertDirection
  threshold: number
  count: number
}

export type ValueJudgement =
  | { action: 'none' }
  | { action: 'fire'; since: Date; value: number }
  | { action: 'recover'; endedAt: Date; value: number }

const measure = (kind: ValueAlertKind, r: AlertReading): number | null =>
  kind === 'temperature' ? r.temperatureC : kind === 'humidity' ? r.humidityPct : r.batteryPct

/**
 * Looks at the last `count` merged readings (a burst is one; its latest value counts, its first
 * time marks it). Armed: all breach -> fire, since the oldest of them. Firing: all normal ->
 * recover, from the oldest of them. A value equal to the threshold is normal.
 */
export function judgeValueRule(
  rule: ValueRule,
  firing: boolean,
  ascending: AlertReading[],
): ValueJudgement {
  const withValue = ascending.filter((r) => measure(rule.kind, r) !== null)
  const groups = mergeReadings(withValue)
  if (groups.length < rule.count) return { action: 'none' }
  const last = groups.slice(-rule.count).map((g) => ({
    at: g[0].recordedAt,
    value: measure(rule.kind, g[g.length - 1]) as number,
  }))
  const breaches = (v: number) =>
    rule.direction === 'below' ? v < rule.threshold : v > rule.threshold
  const value = last[last.length - 1].value
  if (!firing) {
    return last.every((g) => breaches(g.value))
      ? { action: 'fire', since: last[0].at, value }
      : { action: 'none' }
  }
  return last.every((g) => !breaches(g.value))
    ? { action: 'recover', endedAt: last[0].at, value }
    : { action: 'none' }
}

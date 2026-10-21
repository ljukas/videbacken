import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import {
  sensorAlertEvent,
  sensorAlertRule,
  sensorDevice,
  sensorReading,
  user,
} from '~/lib/db/schema'
import { type AlertReading, judgeValueRule, type ValueRule } from '~/lib/sensor/alertJudge'
import {
  ALERT_LOOKBACK_MS,
  ALERT_READINGS_MAX,
  type SensorAlertDirection,
  VALUE_ALERT_KINDS,
  type ValueAlertKind,
} from '~/lib/sensor/alerts'
import { sensorDisplayName } from '~/lib/sensor/deviceName'

/** One alert that opened or closed in an evaluation: what the caller emails. */
export type SensorAlertTransition = {
  transition: 'fired' | 'recovered'
  ruleId: string
  eventId: string
  /** The owner's email. */
  to: string
  sensorName: string
  kind: ValueAlertKind
  direction: SensorAlertDirection
  threshold: number
  count: number
  value: number
  since: Date
  /** Set on 'recovered'. */
  endedAt: Date | null
}

/**
 * Judges the device's enabled value rules (of non-deleted owners) against its newest
 * ALERT_READINGS_MAX readings of the last ALERT_LOOKBACK_MS, and opens or closes their alerts.
 * One transaction that locks the sensor, then the rule rows, the same rule lock the rule
 * mutations take: a pause, edit or delete either commits before (the rule is skipped or judged
 * anew) or waits for the evaluation's commit. Only a write that returned a row becomes a
 * transition.
 */
export async function evaluateValueRules(
  deviceId: string,
  now: Date,
): Promise<SensorAlertTransition[]> {
  return db.transaction(async (tx) => {
    // The sensor first, in its own statement. A sensor delete locks the device, then its rules
    // (the cascade); an event insert's device FK needs KEY SHARE on the device. Locking rules
    // first and the device at the insert would deadlock with that delete: take them in its order,
    // so a delete in flight makes the evaluation wait, then find nothing.
    const [device] = await tx
      .select({ id: sensorDevice.id })
      .from(sensorDevice)
      .where(eq(sensorDevice.id, deviceId))
      .for('key share')
    if (!device) return []

    const rules = await tx
      .select({
        id: sensorAlertRule.id,
        userId: sensorAlertRule.userId,
        kind: sensorAlertRule.kind,
        direction: sensorAlertRule.direction,
        threshold: sensorAlertRule.threshold,
        count: sensorAlertRule.count,
        email: user.email,
        name: sensorDevice.name,
        shellyName: sensorDevice.shellyName,
        mac: sensorDevice.mac,
      })
      .from(sensorAlertRule)
      .innerJoin(user, and(eq(user.id, sensorAlertRule.userId), isNull(user.deletedAt)))
      .innerJoin(sensorDevice, eq(sensorDevice.id, sensorAlertRule.deviceId))
      .where(
        and(
          eq(sensorAlertRule.deviceId, deviceId),
          eq(sensorAlertRule.enabled, true),
          inArray(sensorAlertRule.kind, [...VALUE_ALERT_KINDS]),
        ),
      )
      .orderBy(asc(sensorAlertRule.id))
      .for('update', { of: sensorAlertRule })
    if (rules.length === 0) return []

    // Read after the lock is held, so it sees what a competing evaluation committed.
    const open = await tx
      .select({
        id: sensorAlertEvent.id,
        ruleId: sensorAlertEvent.ruleId,
        startedAt: sensorAlertEvent.startedAt,
      })
      .from(sensorAlertEvent)
      .where(
        and(
          inArray(
            sensorAlertEvent.ruleId,
            rules.map((r) => r.id),
          ),
          isNull(sensorAlertEvent.endedAt),
        ),
      )
    const openByRule = new Map(open.map((e) => [e.ruleId, e]))

    // The newest ones, read newest first and judged oldest first.
    const newest: AlertReading[] = await tx
      .select({
        recordedAt: sensorReading.recordedAt,
        temperatureC: sensorReading.temperatureC,
        humidityPct: sensorReading.humidityPct,
        batteryPct: sensorReading.batteryPct,
      })
      .from(sensorReading)
      .where(
        and(
          eq(sensorReading.deviceId, deviceId),
          gte(sensorReading.recordedAt, new Date(now.getTime() - ALERT_LOOKBACK_MS)),
          lte(sensorReading.recordedAt, now),
        ),
      )
      .orderBy(desc(sensorReading.recordedAt))
      .limit(ALERT_READINGS_MAX)
    const readings = newest.reverse()

    const transitions: SensorAlertTransition[] = []
    for (const rule of rules) {
      // The shape CHECK guarantees these for a value kind; the guard only narrows the types.
      if (rule.direction === null || rule.threshold === null || rule.count === null) continue
      const valueRule: ValueRule = {
        kind: rule.kind as ValueAlertKind,
        direction: rule.direction,
        threshold: rule.threshold,
        count: rule.count,
      }
      const openEvent = openByRule.get(rule.id)
      const judgement = judgeValueRule(valueRule, openEvent !== undefined, readings)
      const base = {
        ruleId: rule.id,
        to: rule.email,
        sensorName: sensorDisplayName(rule.name, rule.shellyName, rule.mac),
        ...valueRule,
      }

      if (judgement.action === 'fire') {
        const [row] = await tx
          .insert(sensorAlertEvent)
          .values({
            ruleId: rule.id,
            userId: rule.userId,
            deviceId,
            ...valueRule,
            silenceHours: null,
            startedAt: judgement.since,
          })
          .onConflictDoNothing({
            target: sensorAlertEvent.ruleId,
            where: sql`${sensorAlertEvent.endedAt} IS NULL`,
          })
          .returning({ id: sensorAlertEvent.id })
        if (row) {
          transitions.push({
            ...base,
            transition: 'fired',
            eventId: row.id,
            value: judgement.value,
            since: judgement.since,
            endedAt: null,
          })
        }
      } else if (judgement.action === 'recover' && openEvent) {
        // Never before the alert's start (the table's CHECK): readings don't arrive out of
        // order, so this only guards a hand-edited row.
        const endedAt =
          judgement.endedAt < openEvent.startedAt ? openEvent.startedAt : judgement.endedAt
        const [row] = await tx
          .update(sensorAlertEvent)
          .set({ endedAt, endReason: 'recovered' })
          .where(and(eq(sensorAlertEvent.id, openEvent.id), isNull(sensorAlertEvent.endedAt)))
          .returning({ id: sensorAlertEvent.id })
        if (row) {
          transitions.push({
            ...base,
            transition: 'recovered',
            eventId: row.id,
            value: judgement.value,
            since: openEvent.startedAt,
            endedAt,
          })
        }
      }
    }
    return transitions
  })
}

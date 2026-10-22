import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, max, min, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import {
  sensorAlertEvent,
  sensorAlertRule,
  sensorDevice,
  sensorReading,
  user,
} from '~/lib/db/schema'
import {
  type AlertReading,
  judgeSilenceRule,
  judgeValueRule,
  type ValueRule,
} from '~/lib/sensor/alertJudge'
import {
  ALERT_LOOKBACK_MS,
  ALERT_READINGS_MAX,
  type SensorAlertDirection,
  type SensorAlertKind,
  type ValueAlertKind,
} from '~/lib/sensor/alerts'
import { sensorDisplayName } from '~/lib/sensor/deviceName'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type TransitionBase = {
  transition: 'fired' | 'recovered'
  ruleId: string
  eventId: string
  /** The owner's email. */
  to: string
  sensorName: string
  /** Value: the first wrong-side reading. Silence: the last reading before the gap. */
  since: Date
  /** Set on 'recovered'. */
  endedAt: Date | null
}

/** One alert that opened or closed in an evaluation: what the caller emails. */
export type SensorAlertTransition = TransitionBase &
  (
    | {
        kind: ValueAlertKind
        direction: SensorAlertDirection
        threshold: number
        count: number
        value: number
      }
    | { kind: 'silence'; silenceHours: number }
  )

type OpenEvent = { id: string; startedAt: Date }

/**
 * Locks the sensor, then the device's enabled rules of non-deleted owners (every kind, or only
 * `kinds`), then reads their open events. The sensor first, in its own statement: a sensor delete
 * locks the device, then its rules (the cascade); an event insert's device FK needs KEY SHARE on
 * the device. Locking rules first and the device at the insert would deadlock with that delete:
 * take them in its order, so a delete in flight makes the evaluation wait, then find nothing.
 * The rule lock is the one the rule mutations take: a pause, edit or delete either commits
 * before (the rule is skipped or judged anew) or waits for the evaluation's commit. Both entry
 * points lock in rule id order (the cron a subset), so they never deadlock with each other.
 */
async function lockRules(tx: Tx, deviceId: string, kinds?: readonly SensorAlertKind[]) {
  const openByRule = new Map<string, OpenEvent>()
  const [device] = await tx
    .select({ id: sensorDevice.id })
    .from(sensorDevice)
    .where(eq(sensorDevice.id, deviceId))
    .for('key share')
  if (!device) return { rules: [], openByRule }

  const rules = await tx
    .select({
      id: sensorAlertRule.id,
      userId: sensorAlertRule.userId,
      kind: sensorAlertRule.kind,
      direction: sensorAlertRule.direction,
      threshold: sensorAlertRule.threshold,
      count: sensorAlertRule.count,
      silenceHours: sensorAlertRule.silenceHours,
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
        kinds ? inArray(sensorAlertRule.kind, [...kinds]) : undefined,
      ),
    )
    .orderBy(asc(sensorAlertRule.id))
    .for('update', { of: sensorAlertRule })
  if (rules.length === 0) return { rules, openByRule }

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
  for (const e of open) if (e.ruleId) openByRule.set(e.ruleId, e)
  return { rules, openByRule }
}

type LockedRule = Awaited<ReturnType<typeof lockRules>>['rules'][number]

const sensorNameOf = (rule: LockedRule) => sensorDisplayName(rule.name, rule.shellyName, rule.mac)

/** Opens the rule's alert unless it already has an open one: the new event's id, or null. */
async function openEvent(
  tx: Tx,
  values: Omit<typeof sensorAlertEvent.$inferInsert, 'id' | 'endedAt' | 'endReason'>,
): Promise<string | null> {
  const [row] = await tx
    .insert(sensorAlertEvent)
    .values(values)
    .onConflictDoNothing({
      target: sensorAlertEvent.ruleId,
      where: sql`${sensorAlertEvent.endedAt} IS NULL`,
    })
    .returning({ id: sensorAlertEvent.id })
  return row?.id ?? null
}

/**
 * Ends the open alert as recovered unless something ended it first; whether this did. Never
 * before the alert's start (the table's CHECK): readings don't arrive out of order, so the clamp
 * only guards a hand-edited row. Returns the end it wrote, or null.
 */
async function recoverEvent(tx: Tx, open: OpenEvent, at: Date): Promise<Date | null> {
  const endedAt = at < open.startedAt ? open.startedAt : at
  const [row] = await tx
    .update(sensorAlertEvent)
    .set({ endedAt, endReason: 'recovered' })
    .where(and(eq(sensorAlertEvent.id, open.id), isNull(sensorAlertEvent.endedAt)))
    .returning({ id: sensorAlertEvent.id })
  return row ? endedAt : null
}

/**
 * Judges the locked value rules against the device's newest ALERT_READINGS_MAX readings of the
 * last ALERT_LOOKBACK_MS.
 */
async function judgeValueRules(
  tx: Tx,
  deviceId: string,
  valueRules: LockedRule[],
  openByRule: Map<string, OpenEvent>,
  now: Date,
): Promise<SensorAlertTransition[]> {
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
  for (const rule of valueRules) {
    // The shape CHECK guarantees these for a value kind; the guard only narrows the types.
    if (rule.direction === null || rule.threshold === null || rule.count === null) continue
    const valueRule: ValueRule = {
      kind: rule.kind as ValueAlertKind,
      direction: rule.direction,
      threshold: rule.threshold,
      count: rule.count,
    }
    const open = openByRule.get(rule.id)
    const judgement = judgeValueRule(valueRule, open !== undefined, readings)
    const base = { ruleId: rule.id, to: rule.email, sensorName: sensorNameOf(rule), ...valueRule }

    if (judgement.action === 'fire') {
      const eventId = await openEvent(tx, {
        ruleId: rule.id,
        userId: rule.userId,
        deviceId,
        ...valueRule,
        silenceHours: null,
        startedAt: judgement.since,
      })
      if (eventId) {
        transitions.push({
          ...base,
          transition: 'fired',
          eventId,
          value: judgement.value,
          since: judgement.since,
          endedAt: null,
        })
      }
    } else if (judgement.action === 'recover' && open) {
      const endedAt = await recoverEvent(tx, open, judgement.endedAt)
      if (endedAt) {
        transitions.push({
          ...base,
          transition: 'recovered',
          eventId: open.id,
          value: judgement.value,
          since: open.startedAt,
          endedAt,
        })
      }
    }
  }
  return transitions
}

/**
 * Judges the locked silence rules against the device's newest reading, however old: no
 * lookback, so a sensor dead for weeks fires with its real last reading. An alert starts at that
 * reading and recovers at the first reading after its start. Unlike the value read, neither read
 * stops at `now`: the cron's `now` is taken when its run starts, and a reading stored since then
 * (whose own evaluation found nothing open) means the sensor is heard, not silent.
 */
async function judgeSilenceRules(
  tx: Tx,
  deviceId: string,
  silenceRules: LockedRule[],
  openByRule: Map<string, OpenEvent>,
  now: Date,
): Promise<SensorAlertTransition[]> {
  const [{ lastReadingAt }] = await tx
    .select({ lastReadingAt: max(sensorReading.recordedAt) })
    .from(sensorReading)
    .where(eq(sensorReading.deviceId, deviceId))

  const transitions: SensorAlertTransition[] = []
  for (const rule of silenceRules) {
    // The shape CHECK guarantees it for silence; the guard only narrows the type.
    if (rule.silenceHours === null) continue
    const silenceHours = rule.silenceHours
    const open = openByRule.get(rule.id)
    const judgement = judgeSilenceRule(silenceHours, open?.startedAt ?? null, lastReadingAt, now)
    const base = {
      ruleId: rule.id,
      to: rule.email,
      sensorName: sensorNameOf(rule),
      kind: 'silence' as const,
      silenceHours,
    }

    if (judgement.action === 'fire') {
      const eventId = await openEvent(tx, {
        ruleId: rule.id,
        userId: rule.userId,
        deviceId,
        kind: 'silence',
        direction: null,
        threshold: null,
        count: null,
        silenceHours,
        startedAt: judgement.since,
      })
      if (eventId) {
        transitions.push({
          ...base,
          transition: 'fired',
          eventId,
          since: judgement.since,
          endedAt: null,
        })
      }
    } else if (judgement.action === 'recover' && open) {
      const [{ first }] = await tx
        .select({ first: min(sensorReading.recordedAt) })
        .from(sensorReading)
        .where(
          and(eq(sensorReading.deviceId, deviceId), gt(sensorReading.recordedAt, open.startedAt)),
        )
      // The judge saw a newer reading under the device lock, so this finds one.
      if (!first) continue
      const endedAt = await recoverEvent(tx, open, first)
      if (endedAt) {
        transitions.push({
          ...base,
          transition: 'recovered',
          eventId: open.id,
          since: open.startedAt,
          endedAt,
        })
      }
    }
  }
  return transitions
}

/**
 * A stored reading's evaluation: judges the device's enabled rules of non-deleted owners, the
 * value rules against its recent readings and the silence rules against its newest reading (so a
 * silence alert recovers within seconds of the sensor's return). One transaction under the
 * shared lock order; only a write that returned a row becomes a transition.
 */
export async function evaluateReading(
  deviceId: string,
  now: Date,
): Promise<SensorAlertTransition[]> {
  return db.transaction(async (tx) => {
    const { rules, openByRule } = await lockRules(tx, deviceId)
    const valueRules = rules.filter((r) => r.kind !== 'silence')
    const silenceRules = rules.filter((r) => r.kind === 'silence')
    const transitions: SensorAlertTransition[] = []
    // The readings are read only when a value rule needs them.
    if (valueRules.length > 0) {
      transitions.push(...(await judgeValueRules(tx, deviceId, valueRules, openByRule, now)))
    }
    if (silenceRules.length > 0) {
      transitions.push(...(await judgeSilenceRules(tx, deviceId, silenceRules, openByRule, now)))
    }
    return transitions
  })
}

/** Devices with at least one enabled silence rule of a non-deleted user: the cron's work list. */
export async function listSilenceDeviceIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ deviceId: sensorAlertRule.deviceId })
    .from(sensorAlertRule)
    .innerJoin(user, and(eq(user.id, sensorAlertRule.userId), isNull(user.deletedAt)))
    .where(and(eq(sensorAlertRule.kind, 'silence'), eq(sensorAlertRule.enabled, true)))
    .orderBy(asc(sensorAlertRule.deviceId))
  return rows.map((r) => r.deviceId)
}

/**
 * The cron's per-device evaluation, in its own transaction: locks the device's enabled silence
 * rules (a subset of a reading's lock, in the same order), fires the silent ones and recovers
 * any a reading's evaluation missed (the backstop when that evaluation failed).
 */
export async function evaluateDeviceSilence(
  deviceId: string,
  now: Date,
): Promise<SensorAlertTransition[]> {
  return db.transaction(async (tx) => {
    const { rules, openByRule } = await lockRules(tx, deviceId, ['silence'])
    if (rules.length === 0) return []
    return judgeSilenceRules(tx, deviceId, rules, openByRule, now)
  })
}

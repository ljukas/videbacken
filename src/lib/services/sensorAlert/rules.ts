import { and, asc, count, eq, isNull } from 'drizzle-orm'
import { db } from '~/lib/db'
import { isForeignKeyViolation } from '~/lib/db/pgError'
import { sensorAlertEvent, sensorAlertRule } from '~/lib/db/schema'
import type { SensorAlertRuleInput } from '~/lib/sensor/alertRuleInput'
import {
  ALERT_RULES_PER_SENSOR_MAX,
  type SensorAlertEndReason,
  type SensorAlertRuleDto,
  type SensorAlertRuleListItem,
} from '~/lib/sensor/alerts'
import { SensorAlertDomainError } from './errors'

// The generated name of the device_id FK (drizzle: <table>_<column>_<ref table>_<ref column>_fk).
const DEVICE_FK = 'sensor_alert_rule_device_id_sensor_device_id_fk'

const DTO = {
  id: sensorAlertRule.id,
  deviceId: sensorAlertRule.deviceId,
  kind: sensorAlertRule.kind,
  enabled: sensorAlertRule.enabled,
  direction: sensorAlertRule.direction,
  threshold: sensorAlertRule.threshold,
  count: sensorAlertRule.count,
  silenceHours: sensorAlertRule.silenceHours,
}

// Every column a kind decides, the unused ones null: one write, so a kind change never leaves
// a stale field for the table's shape CHECK to reject.
function columns(input: SensorAlertRuleInput) {
  switch (input.kind) {
    case 'temperature':
    case 'humidity':
      return {
        deviceId: input.deviceId,
        kind: input.kind,
        direction: input.direction,
        threshold: input.threshold,
        count: input.count,
        silenceHours: null,
      }
    case 'battery':
      return {
        deviceId: input.deviceId,
        kind: input.kind,
        direction: 'below' as const,
        threshold: input.threshold,
        count: input.count,
        silenceHours: null,
      }
    case 'silence':
      return {
        deviceId: input.deviceId,
        kind: input.kind,
        direction: null,
        threshold: null,
        count: null,
        silenceHours: input.silenceHours,
      }
  }
}

// A device id that doesn't exist fails the FK: one query, no check-first race.
async function mapUnknownSensor<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (isForeignKeyViolation(error, DEVICE_FK)) throw new SensorAlertDomainError('UNKNOWN_SENSOR')
    throw error
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Ends the rule's open event quietly. The caller holds the owned rule row's lock first (the same
// lock the evaluation takes), so an evaluation can't re-open the alert in between.
async function endOpenEvent(tx: Tx, userId: string, ruleId: string, reason: SensorAlertEndReason) {
  await tx
    .update(sensorAlertEvent)
    .set({ endedAt: new Date(), endReason: reason })
    .where(
      and(
        eq(sensorAlertEvent.ruleId, ruleId),
        eq(sensorAlertEvent.userId, userId),
        isNull(sensorAlertEvent.endedAt),
      ),
    )
}

// A count-then-insert is enough: a race past the cap by one is harmless, it guards a runaway.
async function assertRoomOnDevice(tx: Tx, userId: string, deviceId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(sensorAlertRule)
    .where(and(eq(sensorAlertRule.userId, userId), eq(sensorAlertRule.deviceId, deviceId)))
  if (row.n >= ALERT_RULES_PER_SENSOR_MAX) throw new SensorAlertDomainError('TOO_MANY_RULES')
}

const owned = (userId: string, id: string) =>
  and(eq(sensorAlertRule.id, id), eq(sensorAlertRule.userId, userId))

/** The user's own rules, oldest first; firingSince is the open alert's start. */
export async function listOwnRules(userId: string): Promise<SensorAlertRuleListItem[]> {
  return db
    .select({ ...DTO, firingSince: sensorAlertEvent.startedAt })
    .from(sensorAlertRule)
    .leftJoin(
      sensorAlertEvent,
      and(eq(sensorAlertEvent.ruleId, sensorAlertRule.id), isNull(sensorAlertEvent.endedAt)),
    )
    .where(eq(sensorAlertRule.userId, userId))
    .orderBy(asc(sensorAlertRule.createdAt), asc(sensorAlertRule.id))
}

export async function createRule(
  userId: string,
  input: SensorAlertRuleInput,
): Promise<SensorAlertRuleDto> {
  const values = { ...columns(input), userId }
  return mapUnknownSensor(() =>
    db.transaction(async (tx) => {
      await assertRoomOnDevice(tx, userId, input.deviceId)
      const [row] = await tx.insert(sensorAlertRule).values(values).returning(DTO)
      return row
    }),
  )
}

/**
 * Rewrites every column from the input (the rule may change kind or device); keeps `enabled`.
 * A change to any defining column ends the rule's open alert (`edited`); identical values don't.
 */
export async function updateRule(
  userId: string,
  id: string,
  input: SensorAlertRuleInput,
): Promise<SensorAlertRuleDto> {
  const values = columns(input)
  return mapUnknownSensor(() =>
    db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(sensorAlertRule)
        .where(owned(userId, id))
        .for('update')
      if (!current) throw new SensorAlertDomainError('RULE_NOT_FOUND')
      const changed =
        current.deviceId !== values.deviceId ||
        current.kind !== values.kind ||
        current.direction !== values.direction ||
        current.threshold !== values.threshold ||
        current.count !== values.count ||
        current.silenceHours !== values.silenceHours
      if (current.deviceId !== values.deviceId) {
        await assertRoomOnDevice(tx, userId, values.deviceId)
      }
      const [row] = await tx
        .update(sensorAlertRule)
        .set(values)
        .where(owned(userId, id))
        .returning(DTO)
      if (changed) await endOpenEvent(tx, userId, id, 'edited')
      return row
    }),
  )
}

/** Pausing ends the rule's open alert (`paused`); resuming starts nothing. */
export async function setRuleEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): Promise<SensorAlertRuleDto> {
  return db.transaction(async (tx) => {
    // The owned UPDATE locks the row first.
    const [row] = await tx
      .update(sensorAlertRule)
      .set({ enabled })
      .where(owned(userId, id))
      .returning(DTO)
    if (!row) throw new SensorAlertDomainError('RULE_NOT_FOUND')
    if (!enabled) await endOpenEvent(tx, userId, id, 'paused')
    return row
  })
}

/** Returns the deleted rule's device and kind, for the caller's log line. */
export async function deleteRule(
  userId: string,
  id: string,
): Promise<Pick<SensorAlertRuleDto, 'deviceId' | 'kind'>> {
  return db.transaction(async (tx) => {
    const [rule] = await tx
      .select({ deviceId: sensorAlertRule.deviceId, kind: sensorAlertRule.kind })
      .from(sensorAlertRule)
      .where(owned(userId, id))
      .for('update')
    if (!rule) throw new SensorAlertDomainError('RULE_NOT_FOUND')
    await endOpenEvent(tx, userId, id, 'deleted')
    await tx.delete(sensorAlertRule).where(owned(userId, id))
    return rule
  })
}

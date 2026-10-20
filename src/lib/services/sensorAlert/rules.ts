import { and, asc, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { isForeignKeyViolation } from '~/lib/db/pgError'
import { sensorAlertRule } from '~/lib/db/schema'
import type { SensorAlertRuleInput } from '~/lib/sensor/alertRuleInput'
import type { SensorAlertRuleDto } from '~/lib/sensor/alerts'
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

const owned = (userId: string, id: string) =>
  and(eq(sensorAlertRule.id, id), eq(sensorAlertRule.userId, userId))

/** The user's own rules, oldest first. */
export async function listOwnRules(userId: string): Promise<SensorAlertRuleDto[]> {
  return db
    .select(DTO)
    .from(sensorAlertRule)
    .where(eq(sensorAlertRule.userId, userId))
    .orderBy(asc(sensorAlertRule.createdAt), asc(sensorAlertRule.id))
}

export async function createRule(
  userId: string,
  input: SensorAlertRuleInput,
): Promise<SensorAlertRuleDto> {
  const values = { ...columns(input), userId }
  return mapUnknownSensor(async () => {
    const [row] = await db.insert(sensorAlertRule).values(values).returning(DTO)
    return row
  })
}

/** Rewrites every column from the input (the rule may change kind or device); keeps `enabled`. */
export async function updateRule(
  userId: string,
  id: string,
  input: SensorAlertRuleInput,
): Promise<SensorAlertRuleDto> {
  const values = columns(input)
  const row = await mapUnknownSensor(async () => {
    const [updated] = await db
      .update(sensorAlertRule)
      .set(values)
      .where(owned(userId, id))
      .returning(DTO)
    return updated
  })
  if (!row) throw new SensorAlertDomainError('RULE_NOT_FOUND')
  return row
}

export async function setRuleEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): Promise<SensorAlertRuleDto> {
  const [row] = await db
    .update(sensorAlertRule)
    .set({ enabled })
    .where(owned(userId, id))
    .returning(DTO)
  if (!row) throw new SensorAlertDomainError('RULE_NOT_FOUND')
  return row
}

/** Returns the deleted rule's device and kind, for the caller's log line. */
export async function deleteRule(
  userId: string,
  id: string,
): Promise<Pick<SensorAlertRuleDto, 'deviceId' | 'kind'>> {
  const [deleted] = await db
    .delete(sensorAlertRule)
    .where(owned(userId, id))
    .returning({ deviceId: sensorAlertRule.deviceId, kind: sensorAlertRule.kind })
  if (!deleted) throw new SensorAlertDomainError('RULE_NOT_FOUND')
  return deleted
}

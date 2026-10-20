import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorAlertEvent, sensorAlertRule, sensorDevice, user } from '~/lib/db/schema'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ beside the other schema tests (e.g. heatPumpEventSchema.test.ts).
setupDatabase()

async function seed() {
  const [u] = await db
    .insert(user)
    .values({ name: 'A', email: 'a@example.com', role: 'user' })
    .returning({ id: user.id })
  const [d] = await db
    .insert(sensorDevice)
    .values({ mac: 'aabbccddeeff' })
    .returning({ id: sensorDevice.id })
  return { userId: u.id, deviceId: d.id }
}

test('a valid rule of each kind inserts', async () => {
  const { userId, deviceId } = await seed()
  await db.insert(sensorAlertRule).values([
    { userId, deviceId, kind: 'temperature', direction: 'below', threshold: 5, count: 2 },
    { userId, deviceId, kind: 'humidity', direction: 'above', threshold: 70, count: 3 },
    { userId, deviceId, kind: 'battery', direction: 'below', threshold: 20, count: 2 },
    { userId, deviceId, kind: 'silence', silenceHours: 6 },
  ])
  const rows = await db.select().from(sensorAlertRule)
  expect(rows).toHaveLength(4)
  expect(rows.every((r) => r.enabled)).toBe(true)
})

test('a silence rule with a threshold is rejected', async () => {
  const { userId, deviceId } = await seed()
  await expectConstraintViolation(
    db
      .insert(sensorAlertRule)
      .values({ userId, deviceId, kind: 'silence', silenceHours: 6, threshold: 5 }),
    'sensor_alert_rule_shape_check',
  )
})

test('a temperature rule without a direction is rejected', async () => {
  const { userId, deviceId } = await seed()
  await expectConstraintViolation(
    db
      .insert(sensorAlertRule)
      .values({ userId, deviceId, kind: 'temperature', threshold: 5, count: 2 }),
    'sensor_alert_rule_shape_check',
  )
})

test('a battery rule with direction above is rejected', async () => {
  const { userId, deviceId } = await seed()
  await expectConstraintViolation(
    db
      .insert(sensorAlertRule)
      .values({ userId, deviceId, kind: 'battery', direction: 'above', threshold: 20, count: 2 }),
    'sensor_alert_rule_shape_check',
  )
})

test('a battery rule without a direction is rejected', async () => {
  const { userId, deviceId } = await seed()
  await expectConstraintViolation(
    db
      .insert(sensorAlertRule)
      .values({ userId, deviceId, kind: 'battery', threshold: 20, count: 2 }),
    'sensor_alert_rule_shape_check',
  )
})

test('count 1 is rejected', async () => {
  const { userId, deviceId } = await seed()
  await expectConstraintViolation(
    db.insert(sensorAlertRule).values({
      userId,
      deviceId,
      kind: 'temperature',
      direction: 'below',
      threshold: 5,
      count: 1,
    }),
    'sensor_alert_rule_count_check',
  )
})

test('silence_hours 2 is rejected', async () => {
  const { userId, deviceId } = await seed()
  await expectConstraintViolation(
    db.insert(sensorAlertRule).values({ userId, deviceId, kind: 'silence', silenceHours: 2 }),
    'sensor_alert_rule_silence_hours_check',
  )
})

test('a humidity threshold of 100 is rejected', async () => {
  const { userId, deviceId } = await seed()
  await expectConstraintViolation(
    db
      .insert(sensorAlertRule)
      .values({ userId, deviceId, kind: 'humidity', direction: 'above', threshold: 100, count: 2 }),
    'sensor_alert_rule_threshold_check',
  )
})

test('deleting the device deletes its rules', async () => {
  const { userId, deviceId } = await seed()
  await db.insert(sensorAlertRule).values({ userId, deviceId, kind: 'silence', silenceHours: 6 })
  await db.delete(sensorDevice).where(eq(sensorDevice.id, deviceId))
  expect(await db.select().from(sensorAlertRule)).toHaveLength(0)
})

test('deleting the user deletes their rules', async () => {
  const { userId, deviceId } = await seed()
  await db.insert(sensorAlertRule).values({ userId, deviceId, kind: 'silence', silenceHours: 6 })
  await db.delete(user).where(eq(user.id, userId))
  expect(await db.select().from(sensorAlertRule)).toHaveLength(0)
})

test('thresholds must sit on their step: temperature halves, humidity and battery whole', async () => {
  const { userId, deviceId } = await seed()
  const base = { userId, deviceId, count: 2 }
  await db.insert(sensorAlertRule).values([
    { ...base, kind: 'temperature', direction: 'below', threshold: -0.5 },
    { ...base, kind: 'temperature', direction: 'above', threshold: 4.5 },
  ])
  await expectConstraintViolation(
    db
      .insert(sensorAlertRule)
      .values({ ...base, kind: 'temperature', direction: 'below', threshold: 4.3 }),
    'sensor_alert_rule_threshold_check',
  )
  await expectConstraintViolation(
    db
      .insert(sensorAlertRule)
      .values({ ...base, kind: 'humidity', direction: 'above', threshold: 70.5 }),
    'sensor_alert_rule_threshold_check',
  )
  await expectConstraintViolation(
    db
      .insert(sensorAlertRule)
      .values({ ...base, kind: 'battery', direction: 'below', threshold: 20.5 }),
    'sensor_alert_rule_threshold_check',
  )
})

// sensor_alert_event: one row per firing, open while ended_at is null (ADR-0028).
async function seedRule() {
  const { userId, deviceId } = await seed()
  const [rule] = await db
    .insert(sensorAlertRule)
    .values({ userId, deviceId, kind: 'temperature', direction: 'below', threshold: 5, count: 2 })
    .returning({ id: sensorAlertRule.id })
  return { userId, deviceId, ruleId: rule.id }
}

const T0 = new Date('2026-10-20T10:00:00Z')
const T1 = new Date('2026-10-20T11:00:00Z')

function eventBase(s: { userId: string; deviceId: string; ruleId: string | null }) {
  return {
    ruleId: s.ruleId,
    userId: s.userId,
    deviceId: s.deviceId,
    kind: 'temperature' as const,
    direction: 'below' as const,
    threshold: 5,
    count: 2,
    startedAt: T0,
  }
}

test('a firing and an ended event insert', async () => {
  const s = await seedRule()
  await db.insert(sensorAlertEvent).values([
    { ...eventBase(s), ruleId: null },
    { ...eventBase(s), endedAt: T1, endReason: 'recovered' },
  ])
  const rows = await db.select().from(sensorAlertEvent)
  expect(rows).toHaveLength(2)
})

test('a second open event for one rule is rejected, a second ended one is not', async () => {
  const s = await seedRule()
  await db.insert(sensorAlertEvent).values(eventBase(s))
  await expectConstraintViolation(
    db.insert(sensorAlertEvent).values(eventBase(s)),
    'sensor_alert_event_open_rule_idx',
  )
  await db.insert(sensorAlertEvent).values([
    { ...eventBase(s), endedAt: T1, endReason: 'recovered' },
    { ...eventBase(s), endedAt: T1, endReason: 'paused' },
  ])
})

test('ended_at without end_reason is rejected', async () => {
  const s = await seedRule()
  await expectConstraintViolation(
    db.insert(sensorAlertEvent).values({ ...eventBase(s), endedAt: T1 }),
    'sensor_alert_event_end_check',
  )
})

test('end_reason without ended_at is rejected', async () => {
  const s = await seedRule()
  await expectConstraintViolation(
    db.insert(sensorAlertEvent).values({ ...eventBase(s), endReason: 'recovered' }),
    'sensor_alert_event_end_check',
  )
})

test('ended_at before started_at is rejected', async () => {
  const s = await seedRule()
  await expectConstraintViolation(
    db.insert(sensorAlertEvent).values({
      ...eventBase(s),
      endedAt: new Date('2026-10-20T09:00:00Z'),
      endReason: 'recovered',
    }),
    'sensor_alert_event_ended_after_started_check',
  )
})

test('deleting the rule keeps its ended event with rule_id null', async () => {
  const s = await seedRule()
  await db.insert(sensorAlertEvent).values({ ...eventBase(s), endedAt: T1, endReason: 'deleted' })
  await db.delete(sensorAlertRule).where(eq(sensorAlertRule.id, s.ruleId))
  const [row] = await db.select().from(sensorAlertEvent)
  expect(row.ruleId).toBeNull()
})

test('deleting the device while an event is open removes the event', async () => {
  const s = await seedRule()
  await db.insert(sensorAlertEvent).values(eventBase(s))
  await db.delete(sensorDevice).where(eq(sensorDevice.id, s.deviceId))
  expect(await db.select().from(sensorAlertEvent)).toHaveLength(0)
})

test('hard-deleting the user while an event is open removes the event', async () => {
  const s = await seedRule()
  await db.insert(sensorAlertEvent).values(eventBase(s))
  await db.delete(user).where(eq(user.id, s.userId))
  expect(await db.select().from(sensorAlertEvent)).toHaveLength(0)
})

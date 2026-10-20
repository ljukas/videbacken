import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorAlertRule, sensorDevice, user } from '~/lib/db/schema'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not schema/): drizzle-kit scans the schema directory.
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

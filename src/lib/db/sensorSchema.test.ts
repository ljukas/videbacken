import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not src/lib/db/schema/) because drizzle-kit scans the
// schema directory as schema — a *.test.ts there breaks `db:generate`.
setupDatabase()

async function insertDevice(mac: string) {
  const [row] = await db.insert(sensorDevice).values({ mac }).returning({ id: sensorDevice.id })
  return row.id
}

// drizzle wraps the driver error: its `.message` is "Failed query: ...", and the
// violated constraint name lives on the postgres-js cause (`constraint_name` /
// message). Assert against that so the test pins the *specific* constraint.
async function expectConstraintViolation(promise: Promise<unknown>, constraint: string) {
  let error: unknown = null
  try {
    await promise
  } catch (e) {
    error = e
  }
  expect(error, 'expected the insert to be rejected').not.toBeNull()
  const cause = (error as { cause?: unknown }).cause ?? error
  const detail =
    (cause as { constraint_name?: string }).constraint_name ??
    (cause as { message?: string }).message ??
    String(error)
  expect(detail).toContain(constraint)
}

test('a device + reading round-trips with JS-number temperature', async () => {
  const deviceId = await insertDevice('aabbccddeeff')
  await db.insert(sensorReading).values({ deviceId, temperatureC: 21.5, humidityPct: 48 })
  const [row] = await db.select().from(sensorReading)
  expect(row.temperatureC).toBe(21.5)
  expect(row.humidityPct).toBe(48)
})

test('humidity outside 0..100 is rejected by the check constraint', async () => {
  const deviceId = await insertDevice('aabbccddee01')
  await expectConstraintViolation(
    db.insert(sensorReading).values({ deviceId, humidityPct: 150 }),
    'sensor_reading_humidity_range_check',
  )
})

test('temperature below -60 is rejected by the check constraint', async () => {
  const deviceId = await insertDevice('aabbccddee02')
  await expectConstraintViolation(
    db.insert(sensorReading).values({ deviceId, temperatureC: -100 }),
    'sensor_reading_temp_range_check',
  )
})

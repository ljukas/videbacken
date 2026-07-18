import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { deleteDevice, listDevices, normalizeMac, recordReading, renameDevice } from './sensor'

setupDatabase()

test('normalizeMac lowercases and strips separators', () => {
  expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aabbccddeeff')
  expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('aabbccddeeff')
})

test('recordReading auto-registers an unknown MAC and stores a reading', async () => {
  const { deviceId } = await recordReading({
    mac: 'AA:BB:CC:DD:EE:FF',
    temperatureC: 21.5,
    humidityPct: 48,
    batteryPct: 90,
  })
  const devices = await db.select().from(sensorDevice)
  expect(devices).toHaveLength(1)
  expect(devices[0].mac).toBe('aabbccddeeff')
  expect(devices[0].batteryPct).toBe(90)
  expect(devices[0].lastSeenAt).not.toBeNull()
  const readings = await db.select().from(sensorReading)
  expect(readings).toHaveLength(1)
  expect(readings[0].deviceId).toBe(deviceId)
  expect(readings[0].temperatureC).toBe(21.5)
})

test('a second webhook from the same MAC (any format) reuses the device', async () => {
  const first = await recordReading({ mac: 'aabbccddeeff', temperatureC: 20 })
  const second = await recordReading({ mac: 'AA-BB-CC-DD-EE-FF', temperatureC: 22 })
  expect(second.deviceId).toBe(first.deviceId)
  expect(await db.select().from(sensorDevice)).toHaveLength(1)
  expect(await db.select().from(sensorReading)).toHaveLength(2)
})

test('recordReading with a fresh battery updates the device battery', async () => {
  const { deviceId } = await recordReading({ mac: 'aa00', batteryPct: 80 })
  await recordReading({ mac: 'aa00', batteryPct: 55 })
  const [device] = await db.select().from(sensorDevice).where(eq(sensorDevice.id, deviceId))
  expect(device.batteryPct).toBe(55)
})

test('recordReading without a battery keeps the previously-stored battery', async () => {
  const { deviceId } = await recordReading({ mac: 'aa01', batteryPct: 70 })
  await recordReading({ mac: 'aa01', temperatureC: 21 })
  const [device] = await db.select().from(sensorDevice).where(eq(sensorDevice.id, deviceId))
  expect(device.batteryPct).toBe(70)
})

test('listDevices returns displayName fallback + latest reading', async () => {
  const { deviceId } = await recordReading({
    mac: 'aabbccddeeff',
    temperatureC: 19,
    humidityPct: 50,
  })
  await recordReading({ mac: 'aabbccddeeff', temperatureC: 21, humidityPct: 52 })
  const devices = await listDevices()
  expect(devices).toHaveLength(1)
  expect(devices[0].id).toBe(deviceId)
  // name is null → fallback "Sensor <last4 of mac>"
  expect(devices[0].displayName).toBe('Sensor eeff')
  expect(devices[0].latest?.temperatureC).toBe(21)
})

test('listDevices returns a null latest for a device with no readings', async () => {
  await db.insert(sensorDevice).values({ mac: 'deadbeef' })
  const devices = await listDevices()
  expect(devices).toHaveLength(1)
  expect(devices[0].latest).toBeNull()
})

test('renameDevice sets name + location and displayName follows the name', async () => {
  const { deviceId } = await recordReading({ mac: 'aabbccddeeff' })
  await renameDevice(deviceId, { name: 'NW corner', location: 'Under kitchen' })
  const devices = await listDevices()
  expect(devices[0].displayName).toBe('NW corner')
  expect(devices[0].location).toBe('Under kitchen')
})

test('renameDevice on a missing id throws DEVICE_NOT_FOUND', async () => {
  await expect(
    renameDevice('00000000-0000-0000-0000-000000000000', { name: 'x', location: null }),
  ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' })
})

test('deleteDevice removes the device and cascades readings', async () => {
  const { deviceId } = await recordReading({ mac: 'aabbccddeeff', temperatureC: 20 })
  await deleteDevice(deviceId)
  expect(await db.select().from(sensorDevice)).toHaveLength(0)
  expect(await db.select().from(sensorReading)).toHaveLength(0)
})

test('deleteDevice on a missing id throws DEVICE_NOT_FOUND', async () => {
  await expect(deleteDevice('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
    code: 'DEVICE_NOT_FOUND',
  })
})

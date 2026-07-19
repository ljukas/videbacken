import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { recordReading } from '~/lib/services/sensor'
import { setupDatabase } from '~test/setup'
import { sensorRouter } from './sensor'

setupDatabase()

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog
  },
}

const baseContext = () => ({ headers: new Headers(), log: noopLog, requestId: 'test-request' })

function mockSession(row: { id: string; email: string; role: 'user' | 'admin' }) {
  vi.spyOn(auth.api, 'getSession').mockResolvedValue({
    session: {
      id: 'session-id',
      userId: row.id,
      token: 'token',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: row.id,
      email: row.email,
      name: 'Test',
      role: row.role,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function signIn(role: 'user' | 'admin') {
  const [row] = await db
    .insert(user)
    .values({ name: role, email: `${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role })
  return row
}

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000'

test('listDevices returns registered devices to a signed-in user', async () => {
  await recordReading({ mac: 'aabbccddeeff', temperatureC: 20, humidityPct: 50 })
  await signIn('user')
  const devices = await call(sensorRouter.listDevices, undefined, { context: baseContext() })
  expect(devices).toHaveLength(1)
  expect(devices[0].displayName).toBe('Sensor eeff')
  expect(devices[0].latest?.temperatureC).toBe(20)
})

test('listDevices rejects an unauthenticated caller', async () => {
  await expect(
    call(sensorRouter.listDevices, undefined, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('series returns bucketed data to a signed-in user', async () => {
  await recordReading({ mac: 'aabbccddeeff', temperatureC: 21, humidityPct: 48 })
  await signIn('user')
  const result = await call(sensorRouter.series, { range: '24h' }, { context: baseContext() })
  expect(result.buckets.length).toBeGreaterThan(0)
})

test('series rejects an unauthenticated caller', async () => {
  await expect(
    call(sensorRouter.series, { range: '24h' }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('series rejects an unknown range value', async () => {
  await signIn('user')
  await expect(
    // @ts-expect-error — 'bogus' is not a SeriesRange; the input schema must reject it
    call(sensorRouter.series, { range: 'bogus' }, { context: baseContext() }),
  ).rejects.toBeDefined()
})

test('renameDevice lets an admin set the name and location', async () => {
  const { deviceId } = await recordReading({ mac: 'aabbccddeeff' })
  await signIn('admin')
  await call(
    sensorRouter.renameDevice,
    { id: deviceId, name: 'NW corner', location: 'Under kitchen' },
    { context: baseContext() },
  )
  const devices = await call(sensorRouter.listDevices, undefined, { context: baseContext() })
  expect(devices[0].displayName).toBe('NW corner')
  expect(devices[0].location).toBe('Under kitchen')
})

test('renameDevice with a blank name clears it back to the fallback displayName', async () => {
  const { deviceId } = await recordReading({ mac: 'aabbccddeeff' })
  await signIn('admin')
  await call(
    sensorRouter.renameDevice,
    { id: deviceId, name: 'NW corner', location: 'Under kitchen' },
    { context: baseContext() },
  )
  // A blank name is the "clear it" signal → displayName reverts to the MAC.
  await call(
    sensorRouter.renameDevice,
    { id: deviceId, name: '  ', location: null },
    { context: baseContext() },
  )
  const devices = await call(sensorRouter.listDevices, undefined, { context: baseContext() })
  expect(devices[0].displayName).toBe('Sensor eeff')
  expect(devices[0].name).toBeNull()
})

test('renameDevice maps a missing device to a DEVICE_NOT_FOUND error', async () => {
  await signIn('admin')
  await expect(
    call(
      sensorRouter.renameDevice,
      { id: UNKNOWN_ID, name: 'x', location: null },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' })
})

test('renameDevice rejects an unauthenticated caller', async () => {
  await expect(
    call(
      sensorRouter.renameDevice,
      { id: UNKNOWN_ID, name: 'x', location: null },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('renameDevice is forbidden for a non-admin user', async () => {
  const { deviceId } = await recordReading({ mac: 'aabbccddeeff' })
  await signIn('user')
  await expect(
    call(
      sensorRouter.renameDevice,
      { id: deviceId, name: 'x', location: null },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

test('deleteDevice lets an admin remove a device', async () => {
  const { deviceId } = await recordReading({ mac: 'aabbccddeeff' })
  await signIn('admin')
  await call(sensorRouter.deleteDevice, { id: deviceId }, { context: baseContext() })
  const devices = await call(sensorRouter.listDevices, undefined, { context: baseContext() })
  expect(devices).toHaveLength(0)
})

test('deleteDevice maps a missing device to a DEVICE_NOT_FOUND error', async () => {
  await signIn('admin')
  await expect(
    call(sensorRouter.deleteDevice, { id: UNKNOWN_ID }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' })
})

test('deleteDevice is forbidden for a non-admin user', async () => {
  const { deviceId } = await recordReading({ mac: 'aabbccddeeff' })
  await signIn('user')
  await expect(
    call(sensorRouter.deleteDevice, { id: deviceId }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

test('deleteDevice rejects an unauthenticated caller', async () => {
  await expect(
    call(sensorRouter.deleteDevice, { id: UNKNOWN_ID }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

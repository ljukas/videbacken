import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading, user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import * as sensorAlert from '~/lib/services/sensorAlert'
import { setupDatabase } from '~test/setup'
import { handleSilenceCron } from './silenceCron'

vi.mock('~/lib/services/sensorAlert', async (importOriginal) => {
  const original = await importOriginal<typeof import('~/lib/services/sensorAlert')>()
  return {
    ...original,
    evaluateDeviceSilence: vi.fn(original.evaluateDeviceSilence),
    listSilenceDeviceIds: vi.fn(original.listSilenceDeviceIds),
  }
})

setupDatabase()

const SECRET = 'test-cron-secret'
const request = (auth?: string) =>
  new Request('http://localhost/api/cron/sensor-silence', {
    headers: auth ? { authorization: auth } : {},
  })
const authed = () => request(`Bearer ${SECRET}`)

// Two devices whose last reading is 8 h old, each with a 6 h silence rule.
async function seedSilentDevices() {
  const [u] = await db
    .insert(user)
    .values({ name: 'A', email: 'a@test.videbacken.local' })
    .returning({ id: user.id })
  const devices = await db
    .insert(sensorDevice)
    .values([
      { mac: 'aaaaaaaaaaaa', name: 'Frysen' },
      { mac: 'bbbbbbbbbbbb', name: 'Källare' },
    ])
    .returning({ id: sensorDevice.id })
  const old = new Date(Date.now() - 8 * 3_600_000)
  for (const d of devices) {
    await db.insert(sensorReading).values({
      deviceId: d.id,
      temperatureC: 5,
      humidityPct: 50,
      batteryPct: 80,
      recordedAt: old,
    })
    await sensorAlert.createRule(u.id, { kind: 'silence', deviceId: d.id, silenceHours: 6 })
  }
  return devices.map((d) => d.id)
}

let publish: ReturnType<typeof vi.spyOn>
// The handler logs through a request child of the shared logger: this one.
let log: { [K in keyof Logger]: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined as never)
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  vi.spyOn(logger, 'child').mockReturnValue(log as Logger)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('401 without the secret or with a wrong one, and nothing is published', async () => {
  await seedSilentDevices()
  for (const auth of [undefined, 'Bearer nope', `Basic ${SECRET}`]) {
    expect((await handleSilenceCron(request(auth))).status).toBe(401)
  }
  expect(publish).not.toHaveBeenCalled()
})

test('401 when the server has no CRON_SECRET', async () => {
  vi.stubEnv('CRON_SECRET', '')
  expect((await handleSilenceCron(request('Bearer '))).status).toBe(401)
  expect(publish).not.toHaveBeenCalled()
})

test('two silent devices fire once each; a second run fires nothing', async () => {
  await seedSilentDevices()
  const res = await handleSilenceCron(authed())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ devices: 2, failed: 0, fired: 2, recovered: 0 })
  expect(publish).toHaveBeenCalledTimes(2)
  for (const [topic, payload] of publish.mock.calls) {
    expect(topic).toBe('email_sensor_alert')
    expect(payload).toMatchObject({ kind: 'silence', transition: 'fired' })
  }
  const again = await handleSilenceCron(authed())
  expect(await again.json()).toEqual({ devices: 2, failed: 0, fired: 0, recovered: 0 })
  expect(publish).toHaveBeenCalledTimes(2)
})

test("one device's evaluation throwing is logged and the others still run", async () => {
  const [first] = await seedSilentDevices()
  const real = vi.mocked(sensorAlert.evaluateDeviceSilence).getMockImplementation()
  vi.mocked(sensorAlert.evaluateDeviceSilence).mockImplementation((id, now) =>
    id === first ? Promise.reject(new Error('boom')) : (real as NonNullable<typeof real>)(id, now),
  )
  const res = await handleSilenceCron(authed())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ devices: 2, failed: 1, fired: 1, recovered: 0 })
  expect(publish).toHaveBeenCalledTimes(1)
  expect(log.error).toHaveBeenCalledWith(
    'sensor silence evaluation failed',
    expect.objectContaining({ deviceId: first }),
  )
  expect(log.info).toHaveBeenCalledWith(
    'sensor silence check',
    expect.objectContaining({ devices: 2, failed: 1, fired: 1, recovered: 0 }),
  )
})

test('a failing device listing is a 500 with its log', async () => {
  vi.mocked(sensorAlert.listSilenceDeviceIds).mockRejectedValueOnce(new Error('db down'))
  const res = await handleSilenceCron(authed())
  expect(res.status).toBe(500)
  expect(log.error).toHaveBeenCalledWith('sensor silence check failed', expect.anything())
})

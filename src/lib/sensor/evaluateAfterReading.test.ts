import { afterEach, describe, expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading, user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import { logger } from '~/lib/logger/server'
import { createRule, evaluateDeviceSilence } from '~/lib/services/sensorAlert'
import { setupDatabase } from '~test/setup'
import { evaluateAfterReading } from './evaluateAfterReading'

const NOW = new Date()
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

async function seed(emails: string[]) {
  const users = await db
    .insert(user)
    .values(emails.map((email) => ({ name: email, email })))
    .returning({ id: user.id })
  const [device] = await db
    .insert(sensorDevice)
    .values([{ mac: 'aaaaaaaaaaaa', name: 'Frysen' }])
    .returning({ id: sensorDevice.id })
  const cold: [number, number][] = [
    [180, 6],
    [150, 4.9],
    [120, 4.8],
  ]
  await db.insert(sensorReading).values(
    cold.map(([m, temperatureC]) => ({
      deviceId: device.id,
      temperatureC,
      humidityPct: 50,
      batteryPct: 80,
      recordedAt: minutesAgo(m),
    })),
  )
  for (const u of users) {
    await createRule(u.id, {
      kind: 'temperature',
      deviceId: device.id,
      direction: 'below',
      threshold: 5,
      count: 2,
    })
  }
  return { deviceId: device.id }
}

describe('evaluateAfterReading', () => {
  setupDatabase()
  afterEach(() => vi.restoreAllMocks())

  test('publishes one email_sensor_alert for a firing rule', async () => {
    const { deviceId } = await seed(['a@test.videbacken.local'])
    const publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined as never)

    await evaluateAfterReading(deviceId, NOW)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(
      'email_sensor_alert',
      expect.objectContaining({
        to: 'a@test.videbacken.local',
        locale: 'sv',
        transition: 'fired',
        sensorName: 'Frysen',
        kind: 'temperature',
        direction: 'below',
        threshold: 5,
        count: 2,
        value: 4.8,
        endedAt: null,
        since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    )
  })

  test('a publish that rejects for one transition still publishes the other', async () => {
    const { deviceId } = await seed(['a@test.videbacken.local', 'b@test.videbacken.local'])
    const publish = vi
      .spyOn(queue, 'publish')
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValue(undefined as never)
    const logError = vi.spyOn(logger, 'error')

    await expect(evaluateAfterReading(deviceId, NOW)).resolves.toBeUndefined()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      'sensor alert email publish failed',
      expect.objectContaining({ transition: 'fired', error: expect.any(Error) }),
    )
  })

  test('a new reading recovers a firing silence alert and publishes one silence email', async () => {
    const [u] = await db
      .insert(user)
      .values([{ name: 'a', email: 'a@test.videbacken.local' }])
      .returning({ id: user.id })
    const [device] = await db
      .insert(sensorDevice)
      .values([{ mac: 'bbbbbbbbbbbb', name: 'Frysen' }])
      .returning({ id: sensorDevice.id })
    const reading = (m: number) => ({
      deviceId: device.id,
      temperatureC: 4,
      humidityPct: 50,
      batteryPct: 80,
      recordedAt: minutesAgo(m),
    })
    await db.insert(sensorReading).values(reading(8 * 60))
    await createRule(u.id, { kind: 'silence', deviceId: device.id, silenceHours: 6 })
    expect(await evaluateDeviceSilence(device.id, NOW)).toHaveLength(1)
    await db.insert(sensorReading).values(reading(1))
    const publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined as never)

    await evaluateAfterReading(device.id, NOW)

    expect(publish).toHaveBeenCalledTimes(1)
    const [, payload] = publish.mock.calls[0]
    expect(payload).toMatchObject({
      kind: 'silence',
      silenceHours: 6,
      transition: 'recovered',
      since: minutesAgo(8 * 60).toISOString(),
      endedAt: minutesAgo(1).toISOString(),
    })
    expect(payload).not.toHaveProperty('value')
  })

  test('resolves when the evaluation fails, publishing nothing', async () => {
    const publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined as never)
    const logError = vi.spyOn(logger, 'error')
    // Not a uuid: the query throws.
    await expect(evaluateAfterReading('not-a-uuid', NOW)).resolves.toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'sensor alert evaluation failed',
      expect.objectContaining({ deviceId: 'not-a-uuid', error: expect.anything() }),
    )
  })
})

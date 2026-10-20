import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { typicalGapsByDevice } from './index'

setupDatabase()

const NOW = new Date('2026-10-20T12:00:00Z')
const minutesBefore = (min: number) => new Date(NOW.getTime() - min * 60_000)

test('typical gaps per device over the last 7 days', async () => {
  const [d1, d2, d3, d4] = await db
    .insert(sensorDevice)
    .values([
      { mac: '000000000001' },
      { mac: '000000000002' },
      { mac: '000000000003' },
      { mac: '000000000004' },
    ])
    .returning({ id: sensorDevice.id })
  // Device 1: every 2 hours for 3 days.
  const regular = Array.from({ length: 36 }, (_, i) => minutesBefore(10 + i * 120))
  // Device 2: bursts, median gap 121 minutes.
  const bursty = [241, 240, 121, 120, 119, 0].map((m) => minutesBefore(10 + m))
  // Device 4: only readings older than 7 days.
  const old = [8 * 1440, 8 * 1440 + 60, 8 * 1440 + 120].map(minutesBefore)
  await db
    .insert(sensorReading)
    .values([
      ...regular.map((recordedAt) => ({ deviceId: d1.id, recordedAt })),
      ...bursty.map((recordedAt) => ({ deviceId: d2.id, recordedAt })),
      ...old.map((recordedAt) => ({ deviceId: d4.id, recordedAt })),
    ])
  expect(await typicalGapsByDevice(NOW)).toEqual({
    [d1.id]: 120,
    [d2.id]: 121,
    [d3.id]: null,
    [d4.id]: null,
  })
})

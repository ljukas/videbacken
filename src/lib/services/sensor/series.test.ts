import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { getSeries } from './sensor'

setupDatabase()

// Direct device insert (bypasses recordReading's MAC validation) so the tests
// can set explicit recorded_at values to pin bucketing behavior.
async function device(mac: string) {
  const [row] = await db.insert(sensorDevice).values({ mac }).returning({ id: sensorDevice.id })
  return row.id
}

test('getSeries averages readings within a 24h bucket per device', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa01')
  // Two readings 2 min apart → same 10-min bucket → averaged.
  await db.insert(sensorReading).values([
    {
      deviceId: d,
      temperatureC: 20,
      humidityPct: 40,
      recordedAt: new Date('2026-07-18T11:31:00Z'),
    },
    {
      deviceId: d,
      temperatureC: 22,
      humidityPct: 50,
      recordedAt: new Date('2026-07-18T11:33:00Z'),
    },
  ])
  const { buckets } = await getSeries({ range: '24h', now })
  expect(buckets).toHaveLength(1)
  expect(buckets[0].perDevice[d].tempAvg).toBe(21)
  expect(buckets[0].perDevice[d].humAvg).toBe(45)
})

test('getSeries splits readings in different 10-min buckets', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa05')
  await db.insert(sensorReading).values([
    { deviceId: d, temperatureC: 20, recordedAt: new Date('2026-07-18T11:31:00Z') },
    { deviceId: d, temperatureC: 30, recordedAt: new Date('2026-07-18T11:45:00Z') },
  ])
  const { buckets } = await getSeries({ range: '24h', now })
  expect(buckets).toHaveLength(2)
  expect(buckets[0].perDevice[d].tempAvg).toBe(20)
  expect(buckets[1].perDevice[d].tempAvg).toBe(30)
  // buckets are ordered ascending by time
  expect(buckets[0].t).toBeLessThan(buckets[1].t)
})

test('getSeries excludes readings outside the 24h window', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa02')
  await db.insert(sensorReading).values([
    { deviceId: d, temperatureC: 10, recordedAt: new Date('2026-07-16T12:00:00Z') }, // 2 days old
    { deviceId: d, temperatureC: 20, recordedAt: new Date('2026-07-18T11:00:00Z') }, // in window
  ])
  const { buckets } = await getSeries({ range: '24h', now })
  const temps = buckets.flatMap((b) => Object.values(b.perDevice).map((v) => v.tempAvg))
  expect(temps).toEqual([20])
})

test('getSeries filters by deviceIds when provided', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const a = await device('aa03')
  const b = await device('aa04')
  await db.insert(sensorReading).values([
    { deviceId: a, temperatureC: 20, recordedAt: new Date('2026-07-18T11:00:00Z') },
    { deviceId: b, temperatureC: 30, recordedAt: new Date('2026-07-18T11:00:00Z') },
  ])
  const { buckets } = await getSeries({ range: '24h', deviceIds: [a], now })
  expect(buckets.every((bk) => b in bk.perDevice === false)).toBe(true)
  expect(buckets.some((bk) => a in bk.perDevice)).toBe(true)
})

test('getSeries "all" returns empty buckets when there are no readings', async () => {
  const { buckets } = await getSeries({ range: 'all', now: new Date('2026-07-18T12:00:00Z') })
  expect(buckets).toEqual([])
})

test('getSeries "all" spans from the first reading with daily buckets', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa06')
  await db.insert(sensorReading).values([
    { deviceId: d, temperatureC: 10, recordedAt: new Date('2026-07-10T09:00:00Z') },
    { deviceId: d, temperatureC: 12, recordedAt: new Date('2026-07-15T09:00:00Z') },
  ])
  const { buckets } = await getSeries({ range: 'all', now })
  // Two readings on two different days → two daily buckets.
  expect(buckets).toHaveLength(2)
  expect(buckets[0].perDevice[d].tempAvg).toBe(10)
  expect(buckets[1].perDevice[d].tempAvg).toBe(12)
})

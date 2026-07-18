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

test('getSeries "1m" buckets by 3 hours', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa20')
  await db.insert(sensorReading).values([
    // 06:00 & 08:00 fall in the same [06:00,09:00) 3h bucket → averaged.
    { deviceId: d, temperatureC: 10, recordedAt: new Date('2026-07-18T06:00:00Z') },
    { deviceId: d, temperatureC: 20, recordedAt: new Date('2026-07-18T08:00:00Z') },
    // 10:00 falls in the next [09:00,12:00) bucket.
    { deviceId: d, temperatureC: 30, recordedAt: new Date('2026-07-18T10:00:00Z') },
  ])
  const { buckets } = await getSeries({ range: '1m', now })
  expect(buckets).toHaveLength(2)
  expect(buckets[0].perDevice[d].tempAvg).toBe(15) // avg(10, 20)
  expect(buckets[1].perDevice[d].tempAvg).toBe(30)
})

test('getSeries "6m" buckets by day', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa21')
  await db.insert(sensorReading).values([
    // Same calendar day, 8h apart → one daily bucket.
    { deviceId: d, temperatureC: 10, recordedAt: new Date('2026-07-10T01:00:00Z') },
    { deviceId: d, temperatureC: 20, recordedAt: new Date('2026-07-10T09:00:00Z') },
    // Next day → separate bucket.
    { deviceId: d, temperatureC: 30, recordedAt: new Date('2026-07-11T09:00:00Z') },
  ])
  const { buckets } = await getSeries({ range: '6m', now })
  expect(buckets).toHaveLength(2)
  expect(buckets[0].perDevice[d].tempAvg).toBe(15)
  expect(buckets[1].perDevice[d].tempAvg).toBe(30)
})

test('getSeries includes a reading exactly at the since edge, excludes one just before', async () => {
  const now = new Date('2026-07-18T12:00:00Z') // 24h window → since = 2026-07-17T12:00:00Z
  const d = await device('aa22')
  await db.insert(sensorReading).values([
    { deviceId: d, temperatureC: 10, recordedAt: new Date('2026-07-17T12:00:00Z') }, // == since → in
    { deviceId: d, temperatureC: 99, recordedAt: new Date('2026-07-17T11:59:59Z') }, // just before → out
  ])
  const { buckets } = await getSeries({ range: '24h', now })
  const temps = buckets.flatMap((b) => Object.values(b.perDevice).map((v) => v.tempAvg))
  expect(temps).toEqual([10])
})

test('getSeries averages each metric independently, skipping NULLs', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa23')
  await db.insert(sensorReading).values([
    // Same bucket: one temp-only reading, one humidity-only reading.
    {
      deviceId: d,
      temperatureC: 20,
      humidityPct: null,
      recordedAt: new Date('2026-07-18T11:31:00Z'),
    },
    {
      deviceId: d,
      temperatureC: null,
      humidityPct: 60,
      recordedAt: new Date('2026-07-18T11:33:00Z'),
    },
  ])
  const { buckets } = await getSeries({ range: '24h', now })
  expect(buckets).toHaveLength(1)
  expect(buckets[0].perDevice[d].tempAvg).toBe(20) // null humidity row ignored for temp
  expect(buckets[0].perDevice[d].humAvg).toBe(60) // null temp row ignored for humidity
})

test('getSeries returns null (not 0) for a bucket whose metric is entirely NULL', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa24')
  await db.insert(sensorReading).values([
    {
      deviceId: d,
      temperatureC: null,
      humidityPct: 40,
      recordedAt: new Date('2026-07-18T11:31:00Z'),
    },
  ])
  const { buckets } = await getSeries({ range: '24h', now })
  expect(buckets[0].perDevice[d].tempAvg).toBeNull()
  expect(buckets[0].perDevice[d].humAvg).toBe(40)
})

test('getSeries places two devices in the same bucket, and omits a device with no reading there', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const a = await device('aa25')
  const b = await device('aa26')
  await db.insert(sensorReading).values([
    // Bucket 1 (11:30–11:40): only device a.
    { deviceId: a, temperatureC: 10, recordedAt: new Date('2026-07-18T11:31:00Z') },
    // Bucket 2 (11:40–11:50): both devices.
    { deviceId: a, temperatureC: 12, recordedAt: new Date('2026-07-18T11:41:00Z') },
    { deviceId: b, temperatureC: 22, recordedAt: new Date('2026-07-18T11:41:00Z') },
  ])
  const { buckets } = await getSeries({ range: '24h', now })
  expect(buckets).toHaveLength(2)
  // Bucket 1: a present, b absent (a gap in b's line — no key, not null).
  expect(buckets[0].perDevice[a].tempAvg).toBe(10)
  expect(b in buckets[0].perDevice).toBe(false)
  // Bucket 2: both present with their own values.
  expect(buckets[1].perDevice[a].tempAvg).toBe(12)
  expect(buckets[1].perDevice[b].tempAvg).toBe(22)
})

test('getSeries "all" uses weekly buckets when the span exceeds ~400 days', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa27')
  const rows = [
    // Anchor far in the past → span > 400 days → weekly bucketing engages.
    { deviceId: d, temperatureC: 5, recordedAt: new Date('2024-01-01T00:00:00Z') },
  ]
  // 7 consecutive days: daily bucketing would yield 7 buckets; weekly ≤ 2.
  for (let i = 1; i <= 7; i++) {
    rows.push({ deviceId: d, temperatureC: 10, recordedAt: new Date(`2026-06-0${i}T12:00:00Z`) })
  }
  await db.insert(sensorReading).values(rows)
  const { buckets } = await getSeries({ range: 'all', now })
  // 1 anchor bucket + at most 2 weekly buckets for the 7-day cluster — never 8.
  expect(buckets.length).toBeGreaterThan(1)
  expect(buckets.length).toBeLessThanOrEqual(3)
})

test('getSeries "all" with deviceIds ignores other devices when choosing bucket width', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const a = await device('aa28')
  const b = await device('aa29')
  await db.insert(sensorReading).values([
    // b's ~500-day-old row would force weekly buckets IF min() ignored deviceIds.
    { deviceId: b, temperatureC: 0, recordedAt: new Date('2025-03-01T00:00:00Z') },
    { deviceId: a, temperatureC: 10, recordedAt: new Date('2026-07-10T09:00:00Z') },
    { deviceId: a, temperatureC: 20, recordedAt: new Date('2026-07-15T09:00:00Z') },
  ])
  const { buckets } = await getSeries({ range: 'all', deviceIds: [a], now })
  // A alone spans < 400 days → daily buckets → two separate days, not merged.
  expect(buckets).toHaveLength(2)
  expect(buckets[0].perDevice[a].tempAvg).toBe(10)
  expect(buckets[1].perDevice[a].tempAvg).toBe(20)
})

test('getSeries with an explicit empty deviceIds returns no buckets', async () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const d = await device('aa30')
  await db
    .insert(sensorReading)
    .values({ deviceId: d, temperatureC: 20, recordedAt: new Date('2026-07-18T11:00:00Z') })
  const { buckets } = await getSeries({ range: '24h', deviceIds: [], now })
  expect(buckets).toEqual([])
})

import { expect, test } from 'vitest'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { setupDatabase } from '~test/setup'
import { HouseEnergyDomainError } from './errors'
import { firstReadingAt, type HouseReading, listReadings, replaceDay } from './houseEnergy'

setupDatabase()

const FIVE_MIN = 300_000

const dayOf = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return { dayStart: new Date(startMs), dayEnd: new Date(endMs) }
}

// Synthetic values only — never real household readings (the repo is public).
const reading = (bucketStart: Date, kwh = 0.1): HouseReading => ({
  bucketStart,
  gridImportKwh: kwh,
  gridExportKwh: 0,
  solarKwh: 0.02,
  loadKwh: kwh,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  batteryChargeAcKwh: 0,
})

/** Every 5-minute bucket of the Stockholm day (276 / 288 / 300 of them). */
const fullDay = (day: string): HouseReading[] => {
  const { dayStart, dayEnd } = dayOf(day)
  const n = (dayEnd.getTime() - dayStart.getTime()) / FIVE_MIN
  return Array.from({ length: n }, (_, i) => reading(new Date(dayStart.getTime() + i * FIVE_MIN)))
}

const all = () =>
  listReadings({ from: new Date('2000-01-01T00:00:00Z'), to: new Date('2100-01-01T00:00:00Z') })

test('stores a whole spring-forward day (276 buckets) and reads it back ascending', async () => {
  const day = dayOf('2026-03-29')
  const buckets = fullDay('2026-03-29').reverse()
  expect(buckets).toHaveLength(276)

  expect(await replaceDay(day, buckets)).toBe(276)

  const stored = await listReadings({ from: day.dayStart, to: day.dayEnd })
  expect(stored).toHaveLength(276)
  expect(stored[0]).toEqual(reading(day.dayStart))
  expect(stored.at(-1)?.bucketStart).toEqual(new Date(day.dayEnd.getTime() - FIVE_MIN))
})

test('stores a whole fall-back day (300 buckets)', async () => {
  expect(await replaceDay(dayOf('2026-10-25'), fullDay('2026-10-25'))).toBe(300)
})

test('a re-fetched day replaces its rows and leaves the neighbouring days alone', async () => {
  await replaceDay(dayOf('2026-03-31'), fullDay('2026-03-31'))
  await replaceDay(dayOf('2026-04-01'), fullDay('2026-04-01'))
  await replaceDay(dayOf('2026-04-02'), fullDay('2026-04-02'))
  const d = dayOf('2026-04-01')

  // Gaps stay gaps: the new answer has two buckets, so only those two remain.
  await replaceDay(d, [
    reading(d.dayStart, 0.3),
    reading(new Date(d.dayStart.getTime() + 2 * FIVE_MIN), 0.4),
  ])

  const day = await listReadings({ from: d.dayStart, to: d.dayEnd })
  expect(day.map((r) => r.gridImportKwh)).toEqual([0.3, 0.4])
  expect(await all()).toHaveLength(288 + 2 + 288)
})

test('listReadings is [from, to): a bucket at `to` belongs to the next range', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, [reading(d.dayStart)])
  await replaceDay(dayOf('2026-04-02'), [reading(d.dayEnd)])
  const day = await listReadings({ from: d.dayStart, to: d.dayEnd })
  expect(day.map((r) => r.bucketStart)).toEqual([d.dayStart])
})

test('an empty list clears the day and writes nothing', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, fullDay('2026-04-01'))
  expect(await replaceDay(d, [])).toBe(0)
  expect(await all()).toHaveLength(0)
})

test('rejects readings outside the day, repeated, or with a bad kWh — and keeps the stored day', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, fullDay('2026-04-01'))
  const bad: [string, HouseReading[]][] = [
    ['before the day', [reading(new Date(d.dayStart.getTime() - FIVE_MIN))]],
    ['at the next midnight', [reading(d.dayEnd)]],
    ['a repeated start', [reading(d.dayStart), reading(d.dayStart)]],
    ['off the 5-minute grid', [reading(new Date(d.dayStart.getTime() + 60_000))]],
    ['a negative value', [{ ...reading(d.dayStart), solarKwh: -0.01 }]],
    ['NaN', [{ ...reading(d.dayStart), loadKwh: Number.NaN }]],
    ['Infinity', [{ ...reading(d.dayStart), gridExportKwh: Number.POSITIVE_INFINITY }]],
    ['an absurd value', [{ ...reading(d.dayStart), gridImportKwh: 1000 }]],
    ['an invalid date', [reading(new Date(Number.NaN))]],
  ]
  for (const [label, buckets] of bad) {
    await expect(replaceDay(d, buckets), label).rejects.toMatchObject({
      name: 'HouseEnergyDomainError',
      code: 'INVALID_READINGS',
    })
  }
  expect(await all()).toHaveLength(288)
})

test('an error names the bucket and field, never the value', async () => {
  const d = dayOf('2026-04-01')
  const error = await replaceDay(d, [
    { ...reading(d.dayStart), batteryChargeAcKwh: -0.123456 },
  ]).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(HouseEnergyDomainError)
  expect((error as Error).message).toContain('bucket 0')
  expect((error as Error).message).toContain('batteryChargeAcKwh')
  expect((error as Error).message).not.toContain('0.123456')
})

test('rejects a day that is not 1 ms–25 h long', async () => {
  const start = new Date('2026-04-01T22:00:00Z')
  for (const dayEnd of [
    start,
    new Date(start.getTime() - 1),
    new Date(start.getTime() + 26 * 3_600_000),
    new Date(Number.NaN),
  ]) {
    await expect(replaceDay({ dayStart: start, dayEnd }, [])).rejects.toMatchObject({
      code: 'INVALID_DAY',
    })
  }
})

test('firstReadingAt is null before any reading, then the earliest bucket', async () => {
  expect(await firstReadingAt()).toBeNull()
  await replaceDay(dayOf('2026-04-02'), fullDay('2026-04-02'))
  const early = new Date(dayOf('2026-03-30').dayStart.getTime() + 7 * FIVE_MIN)
  await replaceDay(dayOf('2026-03-30'), [reading(early)])
  expect(await firstReadingAt()).toEqual(early)
})

// src/lib/services/houseEnergy/energyOverview.test.ts
import { expect, test } from 'vitest'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { insertCharger, insertInterval, insertSession } from '~test/fixtures/evCharging'
import { type Flows, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { getEnergyOverview } from './energyOverview'
import { replaceDay } from './houseEnergy'

setupDatabase()

const FIVE_MIN = 300_000
const dayOf = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return { dayStart: new Date(startMs), dayEnd: new Date(endMs) }
}
/** Stores `day` with `flows` on every bucket (or only the first `keep` buckets). */
async function storeDay(day: string, flows: Flows = {}, keep?: number) {
  const buckets = syntheticDay(day, () => flows)
  await replaceDay(dayOf(day), keep === undefined ? buckets : buckets.slice(0, keep))
}

test('an empty house: no periods, no months, the current year only', async () => {
  const o = await getEnergyOverview({ now: new Date('2026-06-15T12:00:00Z') })
  expect(o).toEqual({
    year: 2026,
    availableYears: [2026],
    firstReadingDay: null,
    tiles: { thisMonth: null, thisYear: null, allTime: null },
    months: Array(12).fill(null),
  })
})

test('sums each Stockholm month and keeps months apart', async () => {
  await storeDay('2026-03-31', {
    gridImportKwh: 0.1,
    loadKwh: 0.2,
    solarKwh: 0.05,
    batteryChargeAcKwh: 0.01,
  })
  await storeDay('2026-04-01', { gridImportKwh: 0.2, loadKwh: 0.3 })
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-04-01T20:00:00Z') })
  const march = o.months[2]
  const april = o.months[3]
  expect(march?.gridImportKwh).toBeCloseTo(288 * 0.1, 9)
  expect(march?.loadKwh).toBeCloseTo(288 * 0.2, 9)
  expect(march?.solarKwh).toBeCloseTo(288 * 0.05, 9)
  // charge_ac counts as grid-charged.
  expect(march?.batteryChargeGridKwh).toBeCloseTo(288 * 0.01, 9)
  expect(april?.gridImportKwh).toBeCloseTo(288 * 0.2, 9)
  expect(o.months[1]).toBeNull()
  expect(o.months[4]).toBeNull()
  expect(o.firstReadingDay).toBe('2026-03-31')
})

test('first and last SoC of a month come from its first and last buckets with a SoC', async () => {
  const day = '2026-05-10'
  const buckets = syntheticDay(day, (_t, i) => ({
    batterySocPct: i === 0 ? null : i === 287 ? null : i % 100,
  }))
  await replaceDay(dayOf(day), buckets)
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-05-11T12:00:00Z') })
  expect(o.months[4]?.firstSocPct).toBe(1) // bucket 0 has none, bucket 1 → 1
  expect(o.months[4]?.lastSocPct).toBe(86) // bucket 287 has none, bucket 286 → 86
})

test('spring-forward: a full March is complete', async () => {
  // Every day of March 2026 stored (743 h); now is in April so March isn't the newest month… plus one April day.
  for (let d = 1; d <= 31; d++) await storeDay(`2026-03-${String(d).padStart(2, '0')}`)
  await storeDay('2026-04-01')
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  expect(o.months[2]?.buckets).toBe((743 * 60) / 5)
  expect(o.months[2]?.expectedBuckets).toBe((743 * 60) / 5)
})

test('first reading day: coverage counts from the day readings start, not the 1st', async () => {
  await storeDay('2026-01-20')
  await storeDay('2026-02-01')
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-02-02T12:00:00Z') })
  // 2026-01-20 → 2026-02-01 00:00 = 12 days; one stored.
  expect(o.months[0]?.buckets).toBe(288)
  expect(o.months[0]?.expectedBuckets).toBe(12 * 288)
})

test('current month: expected buckets end at the newest reading', async () => {
  await storeDay('2026-06-01')
  await storeDay('2026-06-02', {}, 100) // newest bucket = 2026-06-02 00:00 + 99 × 5 min
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-06-02T15:00:00Z') })
  expect(o.months[5]?.buckets).toBe(388)
  expect(o.months[5]?.expectedBuckets).toBe(388)
})

test('a gap inside a month is counted', async () => {
  await storeDay('2026-08-05')
  await storeDay('2026-08-06', {}, 175) // the rest of the day missing (113 buckets ≈ 9.4 h)
  await storeDay('2026-08-07')
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-09-01T12:00:00Z') })
  const aug = o.months[7]
  expect(aug && aug.expectedBuckets - aug.buckets).toBe(113)
})

test('car kWh per month and in the tiles: every vehicle, by interval month', async () => {
  await storeDay('2026-03-10', { loadKwh: 0.2 })
  const chargerId = await insertCharger()
  const ours = await insertSession({
    chargerId,
    startAt: new Date('2026-03-10T18:00:00Z'),
    endAt: new Date('2026-03-10T20:00:00Z'),
    energyKwh: 7,
  })
  await insertInterval(ours, new Date('2026-03-10T18:00:00Z'), new Date('2026-03-10T20:00:00Z'), 7)
  // A guest session with no intervals: its own energy_kwh, in its start month.
  await insertSession({
    chargerId,
    vehicle: 'other',
    vehicleSource: 'admin',
    startAt: new Date('2026-03-11T08:00:00Z'),
    endAt: new Date('2026-03-11T09:00:00Z'),
    energyKwh: 3,
  })
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-03-20T12:00:00Z') })
  expect(o.months[2]?.carKwh).toBe(10)
  expect(o.tiles.thisMonth?.carKwh).toBe(10)
  expect(o.tiles.thisYear?.carKwh).toBe(10)
  expect(o.tiles.allTime?.carKwh).toBe(10)
})

test('tiles are the current periods whatever year the chart shows; all time spans years', async () => {
  await storeDay('2025-12-31', { gridImportKwh: 0.1 })
  await storeDay('2026-01-01', { gridImportKwh: 0.2 })
  const o = await getEnergyOverview({ year: 2025, now: new Date('2026-01-01T20:00:00Z') })
  expect(o.year).toBe(2025)
  expect(o.availableYears).toEqual([2026, 2025])
  expect(o.months[11]?.gridImportKwh).toBeCloseTo(28.8, 9)
  expect(o.months[0]).toBeNull() // January 2025
  expect(o.tiles.thisMonth?.gridImportKwh).toBeCloseTo(57.6, 9)
  expect(o.tiles.thisYear?.gridImportKwh).toBeCloseTo(57.6, 9)
  expect(o.tiles.allTime?.gridImportKwh).toBeCloseTo(86.4, 9)
  expect(o.tiles.allTime?.buckets).toBe(576)
})

test('year fallback: a year without readings shows the current year', async () => {
  await storeDay('2026-02-10')
  const now = new Date('2026-02-11T12:00:00Z')
  expect((await getEnergyOverview({ year: 2021, now })).year).toBe(2026)
  expect((await getEnergyOverview({ year: 2030, now })).year).toBe(2026)
  expect((await getEnergyOverview({ now })).year).toBe(2026)
})

test('the current month without a reading yet is null, the year tile still sums', async () => {
  await storeDay('2026-02-10', { gridImportKwh: 0.1 })
  const o = await getEnergyOverview({ now: new Date('2026-03-01T00:30:00Z') })
  expect(o.tiles.thisMonth).toBeNull()
  expect(o.tiles.thisYear?.gridImportKwh).toBeCloseTo(28.8, 9)
})

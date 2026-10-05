// src/lib/services/houseEnergy/energyOverview.test.ts
import { expect, test } from 'vitest'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { insertCharger, insertInterval, insertSession } from '~test/fixtures/evCharging'
import { type Flows, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { getEnergyOverview } from './energyOverview'
import { replaceDay } from './houseEnergy'

setupDatabase()

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

test('first and last SoC stay inside their own month at a month edge', async () => {
  // 31 March's last bucket and 1 April's first lack a SoC; the neighbours across the
  // edge (CEST: 21:55Z / 22:00Z) must not stand in for them.
  const withSoc = (day: string, base: number, skip: number) =>
    replaceDay(
      dayOf(day),
      syntheticDay(day, (_t, i) => ({ batterySocPct: i === skip ? null : base + (i % 10) })),
    )
  await withSoc('2026-03-31', 10, 287)
  await withSoc('2026-04-01', 50, 0)
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  expect(o.months[2]?.firstSocPct).toBe(10) // bucket 0 of 31 March
  expect(o.months[2]?.lastSocPct).toBe(16) // bucket 286 → 10 + 6
  expect(o.months[3]?.firstSocPct).toBe(51) // bucket 1 of 1 April
  expect(o.months[3]?.lastSocPct).toBe(57) // bucket 287 → 50 + 7
})

test('a month with readings but no SoC has no first or last SoC, even between months that do', async () => {
  const withSoc = (day: string, soc: number | null) =>
    replaceDay(
      dayOf(day),
      syntheticDay(day, () => ({ batterySocPct: soc })),
    )
  await withSoc('2026-02-28', 30)
  await withSoc('2026-03-15', null)
  await withSoc('2026-04-01', 70)
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  expect(o.months[2]?.buckets).toBe(288)
  expect(o.months[2]?.firstSocPct).toBeNull()
  expect(o.months[2]?.lastSocPct).toBeNull()
  expect(o.months[1]?.lastSocPct).toBe(30)
  expect(o.months[3]?.firstSocPct).toBe(70)
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
  expect(o.tiles.allTime?.expectedBuckets).toBe(576)
  expect(o.tiles.thisMonth?.expectedBuckets).toBe(288)
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

test('tile coverage counts months without readings as missing', async () => {
  for (let d = 20; d <= 31; d++) await storeDay(`2026-01-${String(d).padStart(2, '0')}`)
  for (let d = 1; d <= 31; d++) await storeDay(`2026-03-${String(d).padStart(2, '0')}`)
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  const year = o.tiles.thisYear
  expect(year && year.expectedBuckets - year.buckets).toBe(28 * 288)
  const all = o.tiles.allTime
  expect(all && all.expectedBuckets - all.buckets).toBe(28 * 288)
})

test('the newest month, current or not, ends its expected buckets at the newest reading', async () => {
  // 145 buckets = 00:00 through 12:00 local inclusive: the newest reading starts at 12:00.
  await storeDay('2026-09-10', {}, 145)
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-10-15T12:00:00Z') })
  expect(o.months[8]?.buckets).toBe(145)
  expect(o.months[8]?.expectedBuckets).toBe(145)
})

test('car kWh: chart year follows the chart, tiles follow the current periods', async () => {
  await storeDay('2025-05-10')
  await storeDay('2026-05-10')
  const chargerId = await insertCharger()
  const mk = async (start: string, end: string, kwh: number) => {
    const id = await insertSession({
      chargerId,
      startAt: new Date(start),
      endAt: new Date(end),
      energyKwh: kwh,
    })
    await insertInterval(id, new Date(start), new Date(end), kwh)
  }
  await mk('2025-05-10T10:00:00Z', '2025-05-10T11:00:00Z', 4)
  await mk('2026-05-10T10:00:00Z', '2026-05-10T11:00:00Z', 6)
  const o = await getEnergyOverview({ year: 2025, now: new Date('2026-05-20T12:00:00Z') })
  expect(o.months[4]?.carKwh).toBe(4)
  expect(o.tiles.thisMonth?.carKwh).toBe(6)
  expect(o.tiles.thisYear?.carKwh).toBe(6)
  expect(o.tiles.allTime?.carKwh).toBe(10)
})

test('car kWh follows the interval month, not the session start month', async () => {
  await storeDay('2026-03-31')
  await storeDay('2026-04-01')
  const chargerId = await insertCharger()
  // The session starts 23:30 local on 31 March (21:30Z) but its only interval starts
  // 00:30 local on 1 April (22:30Z, CEST), so the kWh belong to April.
  const id = await insertSession({
    chargerId,
    startAt: new Date('2026-03-31T21:30:00Z'),
    endAt: new Date('2026-04-01T00:30:00Z'),
    energyKwh: 5,
  })
  await insertInterval(id, new Date('2026-03-31T22:30:00Z'), new Date('2026-04-01T00:30:00Z'), 5)
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  expect(o.months[2]?.carKwh).toBe(0)
  expect(o.months[3]?.carKwh).toBe(5)
})

test('records the house scan and car timings', async () => {
  await storeDay('2026-02-10')
  const timings: { houseScanMs?: number; carMs?: number } = {}
  await getEnergyOverview({ now: new Date('2026-02-11T12:00:00Z'), timings })
  expect(typeof timings.houseScanMs).toBe('number')
  expect(typeof timings.carMs).toBe('number')
})

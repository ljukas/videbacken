// src/lib/services/houseEnergy/energyOverview.test.ts
import { expect, test } from 'vitest'
import { energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'
import { upsertUnits } from '~/lib/services/heatPump'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { insertCharger, insertInterval, insertSession } from '~test/fixtures/evCharging'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { type Flows, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { getEnergyOverview } from './energyOverview'
import { refreshMonthSums, replaceDay } from './houseEnergy'

setupDatabase()

const dayOf = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return { dayStart: new Date(startMs), dayEnd: new Date(endMs) }
}
/** The pages read the view: refresh it first, as the sync does after storing. */
async function overview(input: Parameters<typeof getEnergyOverview>[0]) {
  await refreshMonthSums()
  return getEnergyOverview(input)
}
/** Stores `day` with `flows` on every bucket (or only the first `keep` buckets). */
async function storeDay(day: string, flows: Flows = {}, keep?: number) {
  const buckets = syntheticDay(day, () => flows)
  await replaceDay(dayOf(day), keep === undefined ? buckets : buckets.slice(0, keep))
}

test('an empty house: no periods, no months, the current year only', async () => {
  const o = await overview({ now: new Date('2026-06-15T12:00:00Z') })
  expect(o).toEqual({
    year: 2026,
    availableYears: [2026],
    firstReadingDay: null,
    monthsWithReadings: [],
    yearTotal: null,
    allTime: null,
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
  const o = await overview({ year: 2026, now: new Date('2026-04-01T20:00:00Z') })
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
  const o = await overview({ year: 2026, now: new Date('2026-05-11T12:00:00Z') })
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
  const o = await overview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
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
  const o = await overview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
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
  const o = await overview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  expect(o.months[2]?.buckets).toBe((743 * 60) / 5)
  expect(o.months[2]?.expectedBuckets).toBe((743 * 60) / 5)
})

test('first reading day: coverage counts from the day readings start, not the 1st', async () => {
  await storeDay('2026-01-20')
  await storeDay('2026-02-01')
  const o = await overview({ year: 2026, now: new Date('2026-02-02T12:00:00Z') })
  // 2026-01-20 → 2026-02-01 00:00 = 12 days; one stored.
  expect(o.months[0]?.buckets).toBe(288)
  expect(o.months[0]?.expectedBuckets).toBe(12 * 288)
})

test('current month: expected buckets end at the newest reading', async () => {
  await storeDay('2026-06-01')
  await storeDay('2026-06-02', {}, 100) // newest bucket = 2026-06-02 00:00 + 99 × 5 min
  const o = await overview({ year: 2026, now: new Date('2026-06-02T15:00:00Z') })
  expect(o.months[5]?.buckets).toBe(388)
  expect(o.months[5]?.expectedBuckets).toBe(388)
})

test('a gap inside a month is counted', async () => {
  await storeDay('2026-08-05')
  await storeDay('2026-08-06', {}, 175) // the rest of the day missing (113 buckets ≈ 9.4 h)
  await storeDay('2026-08-07')
  const o = await overview({ year: 2026, now: new Date('2026-09-01T12:00:00Z') })
  const aug = o.months[7]
  expect(aug && aug.expectedBuckets - aug.buckets).toBe(113)
})

test('car kWh per month and in the totals: every vehicle, by interval month', async () => {
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
  const o = await overview({ year: 2026, now: new Date('2026-03-20T12:00:00Z') })
  expect(o.months[2]?.carKwh).toBe(10)
  expect(o.yearTotal?.carKwh).toBe(10)
  expect(o.allTime?.carKwh).toBe(10)
})

test('yearTotal follows the chart year; allTime spans years', async () => {
  await storeDay('2025-12-31', { gridImportKwh: 0.1 })
  await storeDay('2026-01-01', { gridImportKwh: 0.2 })
  const o = await overview({ year: 2025, now: new Date('2026-01-01T20:00:00Z') })
  expect(o.year).toBe(2025)
  expect(o.availableYears).toEqual([2026, 2025])
  expect(o.months[11]?.gridImportKwh).toBeCloseTo(28.8, 9)
  expect(o.months[0]).toBeNull() // January 2025
  expect(o.yearTotal?.gridImportKwh).toBeCloseTo(28.8, 9)
  expect(o.allTime?.gridImportKwh).toBeCloseTo(86.4, 9)
  expect(o.allTime?.buckets).toBe(576)
  expect(o.allTime?.expectedBuckets).toBe(576)
  expect(o.monthsWithReadings).toEqual(['2025-12', '2026-01'])
  // The chart year 2026: January keeps the dropped current-month coverage (first-day clip, newest month).
  const o26 = await overview({ year: 2026, now: new Date('2026-01-01T20:00:00Z') })
  expect(o26.months[0]?.gridImportKwh).toBeCloseTo(57.6, 9)
  expect(o26.months[0]?.expectedBuckets).toBe(288)
})

test('yearTotal for a past year: its own car kWh, and a month without readings counts as missing', async () => {
  await storeDay('2025-05-10')
  await storeDay('2025-07-10')
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
  await mk('2025-07-10T10:00:00Z', '2025-07-10T11:00:00Z', 3)
  await mk('2026-05-10T10:00:00Z', '2026-05-10T11:00:00Z', 6)
  const o = await overview({ year: 2025, now: new Date('2026-05-20T12:00:00Z') })
  expect(o.yearTotal?.carKwh).toBe(7)
  // 2025-05-10 00:00 → 2026-01-01 00:00 expected (first reading day → year end), 2 days stored.
  const y = o.yearTotal
  expect(y && y.expectedBuckets - y.buckets).toBe((236 - 2) * 288 + 12) // 236 days; the October DST day has 25 h (+12)
  expect(o.allTime?.carKwh).toBe(13)
})

test('monthsWithReadings lists every month with readings, oldest first, across years', async () => {
  await storeDay('2025-11-02')
  await storeDay('2026-02-14')
  await storeDay('2026-02-15')
  const o = await overview({ now: new Date('2026-03-01T12:00:00Z') })
  expect(o.monthsWithReadings).toEqual(['2025-11', '2026-02'])
})

test('monthsWithReadings is ordered whatever the insertion order', async () => {
  await storeDay('2026-02-10')
  await storeDay('2025-11-10')
  await storeDay('2026-01-10')
  await storeDay('2025-12-10')
  const o = await overview({ now: new Date('2026-03-01T12:00:00Z') })
  expect(o.monthsWithReadings).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
})

test("the new year's first hour: the year is 2027, empty, with 2026 still listed", async () => {
  await storeDay('2026-10-10')
  await storeDay('2026-12-31')
  const o = await overview({ now: new Date('2026-12-31T23:30:00Z') })
  expect(o.year).toBe(2027)
  expect(o.availableYears).toEqual([2027, 2026])
  expect(o.months).toEqual(Array(12).fill(null))
  expect(o.yearTotal).toBeNull()
  expect(o.allTime).not.toBeNull()
  expect(o.monthsWithReadings).toEqual(['2026-10', '2026-12'])
})

test('year fallback: a year without readings shows the current year', async () => {
  await storeDay('2026-02-10')
  const now = new Date('2026-02-11T12:00:00Z')
  expect((await overview({ year: 2021, now })).year).toBe(2026)
  expect((await overview({ year: 2030, now })).year).toBe(2026)
  expect((await overview({ now })).year).toBe(2026)
})

test('the current month without a reading yet is null, the year total still sums', async () => {
  await storeDay('2026-02-10', { gridImportKwh: 0.1 })
  const o = await overview({ now: new Date('2026-03-01T00:30:00Z') })
  expect(o.months[2]).toBeNull()
  expect(o.yearTotal?.gridImportKwh).toBeCloseTo(28.8, 9)
})

test('total coverage counts months without readings as missing', async () => {
  for (let d = 20; d <= 31; d++) await storeDay(`2026-01-${String(d).padStart(2, '0')}`)
  for (let d = 1; d <= 31; d++) await storeDay(`2026-03-${String(d).padStart(2, '0')}`)
  const o = await overview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  const year = o.yearTotal
  expect(year && year.expectedBuckets - year.buckets).toBe(28 * 288)
  const all = o.allTime
  expect(all && all.expectedBuckets - all.buckets).toBe(28 * 288)
})

test('the newest month, current or not, ends its expected buckets at the newest reading', async () => {
  // 145 buckets = 00:00 through 12:00 local inclusive: the newest reading starts at 12:00.
  await storeDay('2026-09-10', {}, 145)
  const o = await overview({ year: 2026, now: new Date('2026-10-15T12:00:00Z') })
  expect(o.months[8]?.buckets).toBe(145)
  expect(o.months[8]?.expectedBuckets).toBe(145)
})

test('car kWh: the chart year and its total follow the chart; all time spans years', async () => {
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
  const o = await overview({ year: 2025, now: new Date('2026-05-20T12:00:00Z') })
  expect(o.months[4]?.carKwh).toBe(4)
  expect(o.yearTotal?.carKwh).toBe(4)
  const o26 = await overview({ year: 2026, now: new Date('2026-05-20T12:00:00Z') })
  expect(o26.months[4]?.carKwh).toBe(6)
  expect(o26.yearTotal?.carKwh).toBe(6)
  expect(o.allTime?.carKwh).toBe(10)
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
  const o = await overview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  expect(o.months[2]?.carKwh).toBe(0)
  expect(o.months[3]?.carKwh).toBe(5)
})

test('records the house scan and car timings', async () => {
  await storeDay('2026-02-10')
  const timings: { houseScanMs?: number; carMs?: number; heatPumpMs?: number } = {}
  await overview({ now: new Date('2026-02-11T12:00:00Z'), timings })
  expect(typeof timings.houseScanMs).toBe('number')
  expect(typeof timings.carMs).toBe('number')
  expect(typeof timings.heatPumpMs).toBe('number')
})

test('reads the view: a day stored after the last refresh is not seen until the next one', async () => {
  await storeDay('2026-05-10', { loadKwh: 0.1 })
  await refreshMonthSums()
  await storeDay('2026-05-11', { loadKwh: 0.1 })
  const now = new Date('2026-05-12T12:00:00Z')
  const stale = await getEnergyOverview({ year: 2026, now })
  expect(stale.months[4]?.buckets).toBe(288)
  const fresh = await overview({ year: 2026, now })
  expect(fresh.months[4]?.buckets).toBe(576)
})

test('heat pumps per month in name order, expected hours from each unit’s first hour', async () => {
  // House: 10 May → 1 June 2026 (Stockholm), now 2 June. Coverage starts 2026-05-09T22:00Z; the newest bucket ends
  // 2026-06-01T22:00Z.
  for (let d = 10; d <= 31; d++)
    await storeDay(`2026-05-${String(d).padStart(2, '0')}`, { loadKwh: 0.1 })
  await storeDay('2026-06-01', { loadKwh: 0.1 })
  const id = await seedUnits('Övervåning', 'Matsal')
  await storeHours(id.Matsal, '2026-05-09T22:00:00Z', '2026-06-01T22:00:00Z')
  // Övervåning starts on 20 May at 10:00Z: May expects 276 h of it, not 528.
  await storeHours(id.Övervåning, '2026-05-20T10:00:00Z', '2026-06-01T22:00:00Z', () => ({
    energyKwh: 0.2,
  }))
  const o = await overview({ year: 2026, now: new Date('2026-06-02T08:00:00Z') })
  const may = o.months[4]?.heatPumps ?? []
  expect(may.map((u) => [u.name, u.hours, u.expectedHours])).toEqual([
    ['Matsal', 528, 528],
    ['Övervåning', 276, 276],
  ])
  expect(may[0].kwh).toBeCloseTo(52.8, 9)
  expect(may[1].kwh).toBeCloseTo(55.2, 9)
  expect(may[0].id).toBe(id.Matsal)
  // June: the newest month ends at the newest house bucket (24 h).
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([
    [24, 24],
    [24, 24],
  ])
  // The totals: each unit from its first hour (or the first house day) to the newest bucket.
  expect(o.yearTotal?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([
    [552, 552],
    [300, 300],
  ])
  expect(o.allTime?.heatPumps.map((u) => u.name)).toEqual(['Matsal', 'Övervåning'])
})

test('heat pump hours outside the house data’s range are not read', async () => {
  await storeDay('2026-05-10', { loadKwh: 0.1 })
  const id = await seedUnits('Matsal')
  // 9 May (before the first house day) and 10 May: only the 10th's 24 Stockholm hours count.
  await storeHours(id.Matsal, '2026-05-08T22:00:00Z', '2026-05-10T23:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-05-11T08:00:00Z') })
  expect(o.months[4]?.heatPumps[0].hours).toBe(24)
  expect(o.months[4]?.heatPumps[0].kwh).toBeCloseTo(2.4, 9)
})

test('a period before a unit’s first reading has no heat pump', async () => {
  await storeDay('2026-04-15', { loadKwh: 0.1 })
  await storeDay('2026-05-10', { loadKwh: 0.1 })
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-05-09T22:00:00Z', '2026-05-10T22:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-05-11T08:00:00Z') })
  expect(o.months[3]?.heatPumps).toEqual([])
  expect(o.months[4]?.heatPumps).toHaveLength(1)
})

test('a unit offline for a whole month is listed with all its hours missing', async () => {
  await storeDay('2026-05-10', { loadKwh: 0.1 })
  await storeDay('2026-06-15', { loadKwh: 0.1 })
  await storeDay('2026-07-01', { loadKwh: 0.1 })
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-05-09T22:00:00Z', '2026-05-10T22:00:00Z')
  await storeHours(id.Matsal, '2026-06-30T22:00:00Z', '2026-07-01T22:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-07-02T08:00:00Z') })
  expect(o.months[5]?.heatPumps).toEqual([
    { id: id.Matsal, name: 'Matsal', kwh: 0, hours: 0, expectedHours: 720 },
  ])
})

test('a trailing lag under 13 h is the sync’s normal delay, not missing', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 }) // newest bucket ends 2026-06-01T22:00Z
  const id = await seedUnits('Matsal')
  // The last Comfort Cloud run stored up to 15:00Z: six hours behind the house data.
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-01T16:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-06-01T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[18, 18]])
  expect(energyFigures(o.months[5] as PeriodSums).heatPumpMissingHours).toBe(0)
})

test('a trailing gap of 13 h or more counts as missing in full', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 })
  await storeDay('2026-06-02', { loadKwh: 0.1 }) // newest bucket ends 2026-06-02T22:00Z
  const id = await seedUnits('Matsal')
  // Stored up to 07:00Z: 14 h behind.
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-02T08:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-06-02T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[34, 48]])
  expect(energyFigures(o.months[5] as PeriodSums).heatPumpMissingHours).toBe(14)
})

test('the stale threshold: a 13 h trailing gap counts, a 12 h one does not', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 }) // newest bucket ends 2026-06-01T22:00Z
  const id = await seedUnits('Matsal', 'Övervåning')
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-01T09:00:00Z') // stored end 09:00Z → 13 h
  await storeHours(id.Övervåning, '2026-05-31T22:00:00Z', '2026-06-01T10:00:00Z') // stored end 10:00Z → 12 h
  const o = await overview({ year: 2026, now: new Date('2026-06-01T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.name, u.hours, u.expectedHours])).toEqual([
    ['Matsal', 11, 24],
    ['Övervåning', 12, 12],
  ])
})

test('a gap inside the stored hours always counts', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 })
  const id = await seedUnits('Matsal')
  // 10:00Z and 11:00Z missing; the rest of the day stored up to the newest house bucket.
  const gap = (t: number) =>
    t >= Date.parse('2026-06-01T10:00:00Z') && t < Date.parse('2026-06-01T12:00:00Z') ? null : {}
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-01T22:00:00Z', gap)
  const o = await overview({ year: 2026, now: new Date('2026-06-01T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[22, 24]])
  expect(energyFigures(o.months[5] as PeriodSums).heatPumpMissingHours).toBe(2)
})

test('a partly covered newest hour counts as expected', async () => {
  // 100 buckets: the newest starts 08:15 local, so the 08:00 hour is expected (9 h from midnight).
  await storeDay('2026-06-02', {}, 100)
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-06-01T22:00:00Z', '2026-06-02T07:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-06-02T07:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[9, 9]])
})

test('DST: October 2025 expects 745 heat pump hours', async () => {
  for (let d = 1; d <= 31; d++) await storeDay(`2025-10-${String(d).padStart(2, '0')}`)
  await storeDay('2025-11-01')
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2025-09-30T22:00:00Z', '2025-10-31T23:00:00Z')
  const o = await overview({ year: 2025, now: new Date('2025-11-02T12:00:00Z') })
  expect(o.months[9]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[745, 745]])
})

test('year total and all time sum the units across years', async () => {
  await storeDay('2025-12-31')
  await storeDay('2026-01-01')
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2025-12-30T23:00:00Z', '2026-01-01T23:00:00Z')
  const o = await overview({ year: 2025, now: new Date('2026-01-02T12:00:00Z') })
  expect(o.yearTotal?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[24, 24]])
  expect(o.allTime?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[48, 48]])
  expect(o.allTime?.heatPumps[0].kwh).toBeCloseTo(4.8, 9)
})

test('without heat pump readings every period has no heat pumps', async () => {
  await storeDay('2026-02-10')
  const o = await overview({ year: 2026, now: new Date('2026-02-11T12:00:00Z') })
  expect(o.months[1]?.heatPumps).toEqual([])
  expect(o.yearTotal?.heatPumps).toEqual([])
  expect(o.allTime?.heatPumps).toEqual([])
})

test('a unit removed from Comfort Cloud is expected only until it was last listed', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 })
  await storeDay('2026-06-02', { loadKwh: 0.1 }) // newest bucket ends 2026-06-02T22:00Z
  const id = await seedUnits('Matsal', 'Övervåning')
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-02T22:00:00Z')
  // Övervåning stored up to 10:00Z and last listed then; Matsal listed by a later run, so Övervåning was removed.
  await storeHours(id.Övervåning, '2026-05-31T22:00:00Z', '2026-06-01T10:00:00Z')
  await upsertUnits(
    [{ guid: 'CS-HZ25ZKE+0000000002', name: 'Övervåning', model: 'CS-HZ25ZKE' }],
    new Date('2026-06-01T10:00:00Z'),
  )
  await upsertUnits(
    [{ guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' }],
    new Date('2026-06-03T00:00:00Z'),
  )
  const o = await overview({ year: 2026, now: new Date('2026-06-02T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.name, u.hours, u.expectedHours])).toEqual([
    ['Matsal', 48, 48],
    ['Övervåning', 12, 12],
  ])
  expect(energyFigures(o.months[5] as PeriodSums).heatPumpMissingHours).toBe(0)
})

test('the whole source failing: every unit’s trailing gap counts', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 })
  await storeDay('2026-06-02', { loadKwh: 0.1 }) // newest bucket ends 2026-06-02T22:00Z
  const id = await seedUnits('Matsal', 'Övervåning')
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-01T10:00:00Z')
  await storeHours(id.Övervåning, '2026-05-31T22:00:00Z', '2026-06-01T10:00:00Z')
  // The last run that listed them both: every last_seen_at froze together.
  await upsertUnits(
    [
      { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' },
      { guid: 'CS-HZ25ZKE+0000000002', name: 'Övervåning', model: 'CS-HZ25ZKE' },
    ],
    new Date('2026-06-01T10:00:00Z'),
  )
  const o = await overview({ year: 2026, now: new Date('2026-06-02T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.name, u.hours, u.expectedHours])).toEqual([
    ['Matsal', 12, 48],
    ['Övervåning', 12, 48],
  ])
  expect(energyFigures(o.months[5] as PeriodSums).heatPumpMissingHours).toBe(36)
})

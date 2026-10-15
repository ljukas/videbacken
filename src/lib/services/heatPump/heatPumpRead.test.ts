import { expect, test } from 'vitest'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { upsertUnits } from './heatPump'
import { getHeatPumpDays, getHeatPumpMonths, type HeatPumpMonthCell } from './heatPumpRead'

setupDatabase()

const HOUR_MS = 3_600_000
const plusHours = (iso: string, n: number) => new Date(Date.parse(iso) + n * HOUR_MS).toISOString()
const cellOf = (cells: HeatPumpMonthCell[], heatPumpId: string, year: number, month: number) =>
  cells.find((c) => c.heatPumpId === heatPumpId && c.year === year && c.month === month)

// Matsal: 2025-10-25 00:00 Z … 10-27 23:00 Z; its end, 10-28 00:00 Z, is also `now` floored to the hour (AUTUMN_NOW).
// Övervåning: from 2025-10-26 10:00 Z for `overvaningHours` h; by default 14 (to 10-26 23:00 Z), then offline for
// 24 h, past the 13-hour trailing-lag threshold, so its silence counts as missing.
const AUTUMN_NOW = new Date('2025-10-28T00:30:00Z')
async function seedAutumn(overvaningHours = 14) {
  const ids = await seedUnits('Matsal', 'Övervåning')
  await storeHours(ids.Matsal, '2025-10-25T00:00:00Z', '2025-10-28T00:00:00Z')
  await storeHours(
    ids.Övervåning,
    '2025-10-26T10:00:00Z',
    plusHours('2025-10-26T10:00:00Z', overvaningHours),
  )
  return ids
}

test('days: expected hours per Stockholm day, DST-aware, clipped to the first hour and the coverage end', async () => {
  const ids = await seedAutumn()
  const out = await getHeatPumpDays({ from: '2025-10-25', to: '2025-10-28', now: AUTUMN_NOW })
  expect(out.units).toEqual([
    { id: ids.Matsal, name: 'Matsal' },
    { id: ids.Övervåning, name: 'Övervåning' },
  ])
  const pick = (id: string) =>
    out.days.filter((d) => d.heatPumpId === id).map((d) => [d.day, d.hours, d.expectedHours])
  expect(pick(ids.Matsal)).toEqual([
    ['2025-10-25', 22, 22], // from its first hour
    ['2025-10-26', 25, 25], // the 25-hour DST day, complete
    ['2025-10-27', 24, 24],
    ['2025-10-28', 1, 1], // up to the coverage end
  ])
  expect(pick(ids.Övervåning)).toEqual([
    // nothing before its first hour (2025-10-25 is absent)
    ['2025-10-26', 13, 13], // 10:00–22:00 Z; its 23:00 Z hour is Stockholm's 10-27
    ['2025-10-27', 1, 24], // offline for 24 h (≥ 13 h): 23 h missing
    ['2025-10-28', 0, 1], // a day inside the coverage with no readings: a gap, kWh 0
  ])
  const gap = out.days.find((d) => d.heatPumpId === ids.Övervåning && d.day === '2025-10-28')
  expect(gap).toMatchObject({
    kwh: 0,
    heatKwh: 0,
    coolKwh: 0,
    insideC: null,
    outsideC: null,
    setpointC: null,
  })
})

test.each([
  // 33 h: its newest hour is 10-27 18:00 Z, 5 h behind the coverage end: a lagging sync, not missing.
  [
    33,
    [
      ['2025-10-26', 13, 13],
      ['2025-10-27', 20, 20],
    ],
  ],
  // 25 h: newest 10-27 10:00 Z, exactly 13 h behind: the trailing hours count as missing.
  [
    25,
    [
      ['2025-10-26', 13, 13],
      ['2025-10-27', 12, 24],
      ['2025-10-28', 0, 1],
    ],
  ],
] as const)('days: a unit %i h long trails the coverage end; its tail is missing only from 13 h', async (hours, expected) => {
  const ids = await seedAutumn(hours)
  const out = await getHeatPumpDays({ from: '2025-10-25', to: '2025-10-28', now: AUTUMN_NOW })
  expect(
    out.days
      .filter((d) => d.heatPumpId === ids.Övervåning)
      .map((d) => [d.day, d.hours, d.expectedHours]),
  ).toEqual(expected)
})

test('both units silent for 2 days (Comfort Cloud stalled): the coverage runs to now, 48 h missing each', async () => {
  const ids = await seedUnits('Matsal', 'Övervåning')
  for (const id of [ids.Matsal, ids.Övervåning]) {
    await storeHours(id, '2026-03-01T00:00:00Z', '2026-03-08T00:00:00Z') // newest hour 03-07 23:00 Z
  }
  const now = new Date('2026-03-10T00:30:00Z') // floored: 03-10 00:00 Z, 48 h after the newest stored hour's end
  const months = await getHeatPumpMonths({ year: 2026, now })
  for (const id of [ids.Matsal, ids.Övervåning]) {
    // From the first hour (03-01 00:00 Z) to 03-10 00:00 Z: 216 expected, 168 stored → under 99 %, no change tile.
    expect(cellOf(months.months, id, 2026, 3)).toMatchObject({ hours: 168, expectedHours: 216 })
  }
  const days = await getHeatPumpDays({ from: '2026-03-07', to: '2026-03-10', now })
  expect(
    days.days
      .filter((d) => d.heatPumpId === ids.Matsal)
      .map((d) => [d.day, d.hours, d.expectedHours]),
  ).toEqual([
    ['2026-03-07', 24, 24],
    ['2026-03-08', 1, 24],
    ['2026-03-09', 0, 24],
    ['2026-03-10', 0, 1],
  ])
  const missing = days.days.reduce((sum, d) => sum + d.expectedHours - d.hours, 0)
  expect(missing).toBe(2 * 48)
})

test('days: the 23-hour spring DST day is complete', async () => {
  const ids = await seedUnits('Matsal')
  await storeHours(ids.Matsal, '2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z')
  const out = await getHeatPumpDays({
    from: '2026-03-29',
    to: '2026-03-29',
    now: new Date('2026-04-01T00:00:00Z'),
  })
  expect(out.days).toEqual([
    expect.objectContaining({ day: '2026-03-29', hours: 23, expectedHours: 23 }),
  ])
})

test('days: no future days, and nothing without readings', async () => {
  expect(await getHeatPumpDays({ from: '2025-10-01', to: '2025-10-31' })).toEqual({
    units: [],
    days: [],
  })
  await seedAutumn()
  const out = await getHeatPumpDays({ from: '2025-10-27', to: '2025-11-30', now: AUTUMN_NOW })
  expect(Math.max(...out.days.map((d) => Number(d.day.slice(8))))).toBe(28)
  expect(out.days.every((d) => d.day <= '2025-10-28')).toBe(true)
})

// Matsal: Stockholm 2025-03-01 and -02 (48 h), then 2026-02-28 20:00 Z … 2026-03-01 11:00 Z (16 h; its end, 12:00 Z,
// is also `now` floored). Övervåning: 2026-03-01 05:00–07:00 Z only.
async function seedSpring() {
  const ids = await seedUnits('Matsal', 'Övervåning')
  // Two calls for Matsal are safe: they touch different UTC days.
  await storeHours(ids.Matsal, '2025-02-28T23:00:00Z', '2025-03-02T23:00:00Z')
  await storeHours(ids.Matsal, '2026-02-28T20:00:00Z', '2026-03-01T12:00:00Z')
  await storeHours(ids.Övervåning, '2026-03-01T05:00:00Z', '2026-03-01T08:00:00Z')
  return ids
}
const NOW = new Date('2026-03-01T12:30:00Z')

test("months, a year: cells inside each unit's history, gaps included, with expected hours", async () => {
  const ids = await seedSpring()
  const o = await getHeatPumpMonths({ year: 2026, now: NOW })
  expect(o.year).toBe(2026)
  expect(o.units.map((u) => u.name)).toEqual(['Matsal', 'Övervåning'])
  expect(o.availableYears).toEqual([2026, 2025])
  expect(o.firstReadingDay).toBe('2025-03-01')
  expect(o.monthsWithReadings).toEqual(['2025-03', '2026-02', '2026-03'])
  expect(o.newestMonth).toBe('2026-03')
  // January: a whole month offline inside the history: 0 of 744 h.
  expect(cellOf(o.months, ids.Matsal, 2026, 1)).toMatchObject({
    kwh: 0,
    hours: 0,
    expectedHours: 744,
  })
  // February ends at 2026-02-28 23:00 Z: 20, 21, 22 Z are February, 23 Z is March.
  expect(cellOf(o.months, ids.Matsal, 2026, 2)).toMatchObject({ hours: 3, expectedHours: 672 })
  expect(cellOf(o.months, ids.Matsal, 2026, 2)?.kwh).toBeCloseTo(0.3, 9)
  expect(cellOf(o.months, ids.Matsal, 2026, 3)).toMatchObject({ hours: 13, expectedHours: 13 })
  // Övervåning's history starts on 2026-03-01 05:00 Z: one cell. Its newest hour (07:00 Z) trails the coverage end
  // (12:00 Z) by 4 h, under the 13-hour threshold: those hours aren't missing.
  expect(o.months.filter((c) => c.heatPumpId === ids.Övervåning)).toEqual([
    expect.objectContaining({ year: 2026, month: 3, hours: 3, expectedHours: 3 }),
  ])
  // Last year: Matsal March–December 2025; March 2025 has 743 h (DST on the 30th), October 745.
  expect(o.lastYear.filter((c) => c.heatPumpId === ids.Matsal).map((c) => c.month)).toEqual([
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ])
  expect(cellOf(o.lastYear, ids.Matsal, 2025, 3)).toMatchObject({ hours: 48, expectedHours: 743 })
  expect(cellOf(o.lastYear, ids.Matsal, 2025, 10)?.expectedHours).toBe(745)
})

test('months: the newest month a year earlier is cut at the same Stockholm hour (the running comparison)', async () => {
  const ids = await seedSpring()
  const o = await getHeatPumpMonths({ year: 2026, now: NOW })
  // Coverage ends 2026-03-01 12:00 Z → cut at 2025-03-01 12:00 Z: 13 of March 2025's 48 stored hours.
  expect(o.lastYearSoFar).toEqual([
    expect.objectContaining({
      heatPumpId: ids.Matsal,
      year: 2025,
      month: 3,
      hours: 13,
      expectedHours: 13,
    }),
  ])
  expect(o.lastYearSoFar?.some((c) => c.heatPumpId === ids.Övervåning)).toBe(false)
  expect((await getHeatPumpMonths({ year: 2025, now: NOW })).lastYearSoFar).toBeNull()
})

test("months: each cell's span is the month's calendar hours, never clipped to the unit's first hour or end", async () => {
  const ids = await seedSpring()
  const o = await getHeatPumpMonths({ year: 2026, now: NOW })
  // Whole months: February 2026 (672 h), March 2025 (743 h, DST on the 30th), however few hours the unit had there.
  expect(cellOf(o.months, ids.Matsal, 2026, 2)?.spanHours).toBe(672)
  expect(cellOf(o.lastYear, ids.Matsal, 2025, 3)?.spanHours).toBe(743)
  // The running month runs to the newest stored hour's end: 2026-02-28 23:00 Z (March 1, Stockholm) … 12:00 Z = 13 h,
  // for Övervåning too, though its first hour is 05:00 Z (expected 3, span 13: its partial first month).
  expect(cellOf(o.months, ids.Matsal, 2026, 3)?.spanHours).toBe(13)
  expect(cellOf(o.months, ids.Övervåning, 2026, 3)).toMatchObject({
    hours: 3,
    expectedHours: 3,
    spanHours: 13,
  })
  // Last year's running month runs to the cut: 2025-02-28 23:00 Z … 2025-03-01 12:00 Z.
  expect(o.lastYearSoFar?.[0]?.spanHours).toBe(13)
})

test("months, Totalt (no year): every month of each unit's history, no last year", async () => {
  const ids = await seedSpring()
  const o = await getHeatPumpMonths({ now: NOW })
  expect(o.year).toBeNull()
  expect(o.months.filter((c) => c.heatPumpId === ids.Matsal)).toHaveLength(13) // 2025-03 … 2026-03
  expect(o.months).toHaveLength(14)
  expect(o.lastYear).toEqual([])
  expect(o.lastYearSoFar).toBeNull()
})

test('months: a year without readings opens on the current year; no readings at all is empty', async () => {
  const empty = await getHeatPumpMonths({ year: 2026, now: NOW })
  expect(empty).toEqual({
    units: [],
    year: 2026,
    availableYears: [2026],
    firstReadingDay: null,
    monthsWithReadings: [],
    newestMonth: null,
    months: [],
    lastYear: [],
    lastYearSoFar: null,
  })
  expect((await getHeatPumpMonths({ now: NOW })).year).toBeNull()
  await seedSpring()
  expect((await getHeatPumpMonths({ year: 2023, now: NOW })).year).toBe(2026)
})

test('a unit Comfort Cloud no longer lists, silent for over 13 h: its missing hours stop at its last listing', async () => {
  // Both seeded as listed at 2026-10-08 12:00 Z; a later run (10-09 12:00 Z) lists only Matsal, so Övervåning is
  // removed. Matsal: 10-06 00:00 Z … 10-09 23:00 Z. Övervåning: 10-06 00:00 Z … 10-07 23:00 Z (its end, 10-08 00:00 Z,
  // is 48 h before the coverage end): it ends at its last listing, 10-08 12:00 Z, not at the coverage end.
  const ids = await seedUnits('Matsal', 'Övervåning')
  await upsertUnits(
    [{ guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' }],
    new Date('2026-10-09T12:00:00Z'),
  )
  await storeHours(ids.Matsal, '2026-10-06T00:00:00Z', '2026-10-10T00:00:00Z')
  await storeHours(ids.Övervåning, '2026-10-06T00:00:00Z', '2026-10-08T00:00:00Z')
  const now = new Date('2026-10-10T00:30:00Z') // floored: 10-10 00:00 Z, Matsal's end too
  const days = await getHeatPumpDays({ from: '2026-10-06', to: '2026-10-10', now })
  // Stockholm (CEST) days start at 22:00 Z the day before.
  expect(
    days.days
      .filter((d) => d.heatPumpId === ids.Övervåning)
      .map((d) => [d.day, d.hours, d.expectedHours]),
  ).toEqual([
    ['2026-10-06', 22, 22], // from its first hour (00:00 Z)
    ['2026-10-07', 24, 24],
    ['2026-10-08', 2, 14], // 10-07 22:00 Z … its last listing, 10-08 12:00 Z: 12 h missing
    // 10-09 and 10-10 lie after its end: absent, not missing
  ])
  expect(
    days.days
      .filter((d) => d.heatPumpId === ids.Matsal)
      .map((d) => [d.day, d.hours, d.expectedHours]),
  ).toEqual([
    ['2026-10-06', 22, 22],
    ['2026-10-07', 24, 24],
    ['2026-10-08', 24, 24],
    ['2026-10-09', 24, 24],
    ['2026-10-10', 2, 2],
  ])
  const months = await getHeatPumpMonths({ year: 2026, now })
  // October: 10-06 00:00 Z … 10-08 12:00 Z = 60 expected, 48 stored.
  expect(cellOf(months.months, ids.Övervåning, 2026, 10)).toMatchObject({
    hours: 48,
    expectedHours: 60,
  })
  expect(cellOf(months.months, ids.Matsal, 2026, 10)).toMatchObject({
    hours: 96,
    expectedHours: 96,
  })
})

import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { heatPump } from '~/lib/db/schema'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { daySums, type HeatPumpDayRow, readingSpans } from './daySums'
import { refreshDaySums } from './monthSums'

setupDatabase()

const find = (rows: HeatPumpDayRow[], heatPumpId: string, day: string) =>
  rows.find((r) => r.heatPumpId === heatPumpId && r.day === day)

test('the autumn DST day (2025-10-26) holds 25 hours; the day before 22 (from the first hour), the day after 24', async () => {
  const ids = await seedUnits('Matsal')
  // 2025-10-25 00:00 Z … 10-27 23:00 Z. Stockholm 2025-10-26 = [10-25 22:00 Z, 10-26 23:00 Z).
  await storeHours(ids.Matsal, '2025-10-25T00:00:00Z', '2025-10-28T00:00:00Z')
  const rows = await daySums({ from: '2025-10-25', to: '2025-10-27' })
  expect(rows.map((r) => [r.day, r.hours])).toEqual([
    ['2025-10-25', 22],
    ['2025-10-26', 25],
    ['2025-10-27', 24],
  ])
  expect(find(rows, ids.Matsal, '2025-10-26')?.kwh).toBeCloseTo(2.5, 9)
})

test('the spring DST day (2026-03-29) holds 23 hours', async () => {
  const ids = await seedUnits('Matsal')
  await storeHours(ids.Matsal, '2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z')
  const [row] = await daySums({ from: '2026-03-29', to: '2026-03-29' })
  expect(row).toMatchObject({ heatPumpId: ids.Matsal, day: '2026-03-29', hours: 23 })
  expect(row.kwh).toBeCloseTo(2.3, 9)
})

test('a day is its Stockholm hours only; shares weight the kWh; means skip hours without a value', async () => {
  const ids = await seedUnits('Matsal')
  // Stockholm 2026-01-15 = [2026-01-14 23:00 Z, 2026-01-15 23:00 Z). Hours 2026-01-14 22:00 Z (i 0) … 01-15 23:00 Z
  // (i 25); only i 0–3 and 25 are stored.
  await storeHours(ids.Matsal, '2026-01-14T22:00:00Z', '2026-01-16T00:00:00Z', (_t, i) => {
    if (i === 0 || i === 25) return { energyKwh: 1 } // 23:00 on the 14th / 00:00 on the 16th: outside the day
    if (i === 1)
      return {
        energyKwh: 0.4,
        heatShare: 0.5,
        coolShare: 0.25,
        insideC: 20,
        outsideC: -4,
        setpointC: 22,
      }
    if (i <= 3)
      return {
        energyKwh: 0.2,
        heatShare: null,
        coolShare: null,
        insideC: null,
        outsideC: -2,
        setpointC: null,
      }
    return null
  })
  const [row] = await daySums({ from: '2026-01-15', to: '2026-01-15' })
  expect(row.hours).toBe(3)
  expect(row.kwh).toBeCloseTo(0.8, 9)
  expect(row.heatKwh).toBeCloseTo(0.2, 9) // 0,4 × 0,5; a null share counts as 0
  expect(row.coolKwh).toBeCloseTo(0.1, 9)
  expect(row.insideC).toBeCloseTo(20, 9)
  expect(row.outsideC).toBeCloseTo(-8 / 3, 9)
  expect(row.setpointC).toBeCloseTo(22, 9)
})

test('one row per unit and day; readingSpans gives each unit its first and newest hour', async () => {
  const ids = await seedUnits('Matsal', 'Övervåning')
  expect(await readingSpans()).toEqual([])
  expect(await daySums({ from: '2026-01-15', to: '2026-01-15' })).toEqual([])
  await storeHours(ids.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T05:00:00Z')
  await storeHours(ids.Övervåning, '2026-01-15T03:00:00Z', '2026-01-15T05:00:00Z')
  const rows = await daySums({ from: '2026-01-15', to: '2026-01-15' })
  expect(rows).toHaveLength(2)
  expect(find(rows, ids.Matsal, '2026-01-15')?.hours).toBe(5)
  expect(find(rows, ids.Övervåning, '2026-01-15')?.hours).toBe(2)
  const spans = await readingSpans()
  expect(spans).toHaveLength(2)
  expect(spans.find((s) => s.heatPumpId === ids.Övervåning)).toEqual({
    heatPumpId: ids.Övervåning,
    firstHour: new Date('2026-01-15T03:00:00Z'),
    lastHour: new Date('2026-01-15T04:00:00Z'),
  })
})

test('the reads come from the day view: hours stored after a refresh show only once the view is refreshed', async () => {
  const ids = await seedUnits('Matsal')
  await storeHours(ids.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T05:00:00Z')
  await storeHours(ids.Matsal, '2026-01-16T00:00:00Z', '2026-01-16T03:00:00Z', undefined, {
    refresh: false,
  })
  expect(await daySums({ from: '2026-01-15', to: '2026-01-16' })).toHaveLength(1)
  expect((await readingSpans())[0].lastHour).toEqual(new Date('2026-01-15T04:00:00Z'))
  await refreshDaySums()
  const rows = await daySums({ from: '2026-01-15', to: '2026-01-16' })
  expect(rows.map((r) => [r.day, r.hours])).toEqual([
    ['2026-01-15', 5],
    ['2026-01-16', 3],
  ])
  expect((await readingSpans())[0].lastHour).toEqual(new Date('2026-01-16T02:00:00Z'))
})

test('a unit deleted since the last refresh drops out with the join (its day rows linger in the view)', async () => {
  const ids = await seedUnits('Matsal', 'Övervåning')
  await storeHours(ids.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T05:00:00Z')
  await storeHours(ids.Övervåning, '2026-01-15T00:00:00Z', '2026-01-15T05:00:00Z')
  // Deleted after the refresh, and the view not refreshed again: its rows are still in heat_pump_day.
  await db.delete(heatPump).where(eq(heatPump.id, ids.Övervåning))
  const rows = await daySums({ from: '2026-01-15', to: '2026-01-15' })
  expect(rows.map((r) => r.heatPumpId)).toEqual([ids.Matsal])
  expect((await readingSpans()).map((s) => s.heatPumpId)).toEqual([ids.Matsal])
})

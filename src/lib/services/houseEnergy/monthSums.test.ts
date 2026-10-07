// src/lib/services/houseEnergy/monthSums.test.ts
import { asc } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { houseEnergyMonth } from '~/lib/db/schema'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { reading, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { refreshMonthSums, replaceDay } from './houseEnergy'

setupDatabase()

const dayOf = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return { dayStart: new Date(startMs), dayEnd: new Date(endMs) }
}
const months = () =>
  db
    .select()
    .from(houseEnergyMonth)
    .orderBy(asc(houseEnergyMonth.year), asc(houseEnergyMonth.month))

test('an empty table refreshes to an empty view', async () => {
  await refreshMonthSums()
  expect(await months()).toEqual([])
})

test('a stored day is invisible until the refresh, then summed per month', async () => {
  await replaceDay(
    dayOf('2026-02-10'),
    syntheticDay('2026-02-10', () => ({
      gridImportKwh: 0.1,
      gridExportKwh: 0.02,
      solarKwh: 0.05,
      loadKwh: 0.2,
      batteryDischargeKwh: 0.03,
      batteryChargeSolarKwh: 0.01,
      batteryChargeGridKwh: 0.04,
      batteryChargeAcKwh: 0.01,
    })),
  )
  expect(await months()).toEqual([])
  await refreshMonthSums()
  const [feb] = await months()
  expect(feb).toMatchObject({ year: 2026, month: 2, buckets: 288 })
  expect(feb.gridImportKwh).toBeCloseTo(28.8, 9)
  expect(feb.gridExportKwh).toBeCloseTo(5.76, 9)
  expect(feb.solarKwh).toBeCloseTo(14.4, 9)
  expect(feb.loadKwh).toBeCloseTo(57.6, 9)
  expect(feb.batteryDischargeKwh).toBeCloseTo(8.64, 9)
  expect(feb.batteryChargeSolarKwh).toBeCloseTo(2.88, 9)
  // charge_grid + charge_ac (ADR-0023: ac counts as grid)
  expect(feb.batteryChargeGridKwh).toBeCloseTo(14.4, 9)
  expect(feb.firstBucket).toEqual(dayOf('2026-02-10').dayStart)
  expect(feb.lastBucket).toEqual(new Date(dayOf('2026-02-10').dayEnd.getTime() - 5 * 60_000))
})

test('a re-fetched day that shrinks lowers the month: the view is recomputed, not added to', async () => {
  const day = syntheticDay('2026-05-03', () => ({ loadKwh: 0.1 }))
  await replaceDay(dayOf('2026-05-03'), day)
  await refreshMonthSums()
  await replaceDay(dayOf('2026-05-03'), day.slice(0, 100))
  await refreshMonthSums()
  const [may] = await months()
  expect(may.buckets).toBe(100)
  expect(may.loadKwh).toBeCloseTo(10, 9)
})

test("first and last SoC skip the month's edge buckets without one", async () => {
  await replaceDay(
    dayOf('2026-09-01'),
    syntheticDay('2026-09-01', (_t, i) => ({
      batterySocPct: i < 3 || i > 284 ? null : 10 + (i % 50),
    })),
  )
  await refreshMonthSums()
  const [sep] = await months()
  expect(sep.firstSocPct).toBe(13) // bucket 3
  expect(sep.lastSocPct).toBe(10 + (284 % 50)) // bucket 284
})

test('a month without any SoC has null first and last SoC', async () => {
  await replaceDay(dayOf('2026-07-04'), syntheticDay('2026-07-04'))
  await refreshMonthSums()
  const [jul] = await months()
  expect(jul.firstSocPct).toBeNull()
  expect(jul.lastSocPct).toBeNull()
})

test('the first local hour of a month lands in that month across both DST offsets', async () => {
  // 2026-04-01 00:00 CEST = 2026-03-31T22:00Z; 2026-11-01 00:00 CET = 2026-10-31T23:00Z
  await replaceDay(
    dayOf('2026-03-31'),
    syntheticDay('2026-03-31', () => ({ loadKwh: 1 })),
  )
  await replaceDay(dayOf('2026-04-01'), [
    reading(Date.parse('2026-03-31T22:00:00Z'), { loadKwh: 2 }),
  ])
  await replaceDay(
    dayOf('2026-10-31'),
    syntheticDay('2026-10-31', () => ({ loadKwh: 1 })),
  )
  await replaceDay(dayOf('2026-11-01'), [
    reading(Date.parse('2026-10-31T23:00:00Z'), { loadKwh: 2 }),
  ])
  await refreshMonthSums()
  const rows = await months()
  expect(rows.map((r) => [r.month, r.buckets, r.loadKwh])).toEqual([
    [3, 288, 288],
    [4, 1, 2],
    [10, 288, 288],
    [11, 1, 2],
  ])
})

test('a second refresh with nothing new changes nothing', async () => {
  await replaceDay(
    dayOf('2026-02-10'),
    syntheticDay('2026-02-10', () => ({ loadKwh: 0.1 })),
  )
  await refreshMonthSums()
  const before = await months()
  await refreshMonthSums()
  expect(await months()).toEqual(before)
})

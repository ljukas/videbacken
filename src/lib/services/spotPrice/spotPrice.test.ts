import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { spotPrice } from '~/lib/db/schema'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { setupDatabase } from '~test/setup'
import { SpotPriceDomainError } from './errors'
import { daysWithSlots, listSlotsOverlapping, replaceDay } from './spotPrice'

setupDatabase()

const utc = (iso: string) => new Date(iso).getTime()

async function storedCount() {
  return (await db.select().from(spotPrice)).length
}

test('replaceDay stores a validated day and reports what it wrote', async () => {
  const result = await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, (i) => i / 100),
  )
  expect(result).toEqual({ written: 96 })
  expect(await storedCount()).toBe(96)
})

test('re-storing a day at another granularity leaves no stale slots behind', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15))
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 60, () => 2),
  )

  const rows = await db.select().from(spotPrice)
  expect(rows).toHaveLength(24)
  expect(rows.every((r) => r.sekPerKwh === 2)).toBe(true)
  // Pricing an hour now sees exactly one slot, never the old quarters too.
  const slots = await listSlotsOverlapping('SE3', [
    { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z') },
  ])
  expect(slots).toHaveLength(1)
})

test('replaceDay only touches its own Stockholm day', async () => {
  await replaceDay('SE3', '2026-09-27', daySlots('2026-09-27', 15))
  await replaceDay('SE3', '2026-09-29', daySlots('2026-09-29', 15))
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 60))
  expect(await storedCount()).toBe(96 + 96 + 24)
})

test('an invalid day is rejected before anything is written', async () => {
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, () => 1),
  )
  const holey = daySlots('2026-09-28', 15, () => 5).filter((_, i) => i !== 40)

  await expect(replaceDay('SE3', '2026-09-28', holey)).rejects.toMatchObject({
    name: 'SpotPriceDomainError',
    code: 'INVALID_DAY_SLOTS',
  })
  await expect(replaceDay('SE3', '2026-09-28', [])).rejects.toBeInstanceOf(SpotPriceDomainError)
  // The previous day is intact.
  const rows = await db.select().from(spotPrice)
  expect(rows).toHaveLength(96)
  expect(rows.every((r) => r.sekPerKwh === 1)).toBe(true)
})

test('stores DST days of 92 and 100 slots', async () => {
  await replaceDay('SE3', '2026-03-29', daySlots('2026-03-29', 15))
  await replaceDay('SE3', '2025-10-26', daySlots('2025-10-26', 15))
  expect(await storedCount()).toBe(192)
})

test('listSlotsOverlapping returns each overlapping slot once, including one starting before the range', async () => {
  await replaceDay(
    'SE3',
    '2025-09-30',
    daySlots('2025-09-30', 60, (i) => i),
  )

  // Two overlapping ranges inside local 10:00–12:00 (08:00Z–10:00Z CEST).
  const slots = await listSlotsOverlapping('SE3', [
    { startMs: utc('2025-09-30T08:30Z'), endMs: utc('2025-09-30T09:15Z') },
    { startMs: utc('2025-09-30T09:00Z'), endMs: utc('2025-09-30T09:45Z') },
  ])

  expect(slots.map((s) => new Date(s.startMs).toISOString())).toEqual([
    '2025-09-30T08:00:00.000Z',
    '2025-09-30T09:00:00.000Z',
  ])
  expect(slots.map((s) => s.sekPerKwh)).toEqual([10, 11])
  expect(slots[0].endMs - slots[0].startMs).toBe(60 * 60 * 1000)
})

test('listSlotsOverlapping ignores touching slots and handles no ranges', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15))
  expect(await listSlotsOverlapping('SE3', [])).toEqual([])
  const slots = await listSlotsOverlapping('SE3', [
    { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T08:15Z') },
  ])
  expect(slots).toHaveLength(1)
})

test('daysWithSlots groups by Stockholm day across the UTC boundary', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15)) // starts 2026-09-27T22:00Z
  await replaceDay('SE3', '2026-09-30', daySlots('2026-09-30', 15))

  expect(await daysWithSlots('SE3', '2026-09-27', '2026-10-01')).toEqual(
    new Set(['2026-09-28', '2026-09-30']),
  )
  expect(await daysWithSlots('SE3', '2026-09-29', '2026-09-29')).toEqual(new Set())
  expect(await daysWithSlots('SE3', '2026-09-28', '2026-09-28')).toEqual(new Set(['2026-09-28']))
})

test('daysWithSlots sees a whole 25-hour fall-back day as one day', async () => {
  await replaceDay('SE3', '2025-10-26', daySlots('2025-10-26', 15))
  expect(await daysWithSlots('SE3', '2025-10-25', '2025-10-27')).toEqual(new Set(['2025-10-26']))
})

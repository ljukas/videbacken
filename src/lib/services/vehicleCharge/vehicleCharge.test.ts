import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { vehicleChargeRecord } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { coverage, importRecords } from './vehicleCharge'

setupDatabase()

const row = (
  id: string,
  start: string,
  end: string,
  extra: Partial<Parameters<typeof importRecords>[0][number]> = {},
) => ({
  sourceSessionId: id,
  startAt: new Date(start),
  endAt: new Date(end),
  energyKwh: 10,
  startSocPercent: 20,
  endSocPercent: 60,
  isPublic: false,
  ...extra,
})

test('imports rows and reports them inserted', async () => {
  const result = await importRecords([
    row('a', '2026-02-01T10:00:00Z', '2026-02-01T12:00:00Z'),
    row('b', '2026-02-03T10:00:00Z', '2026-02-03T11:00:00Z', { isPublic: true }),
  ])
  expect(result).toEqual({ inserted: 2, unchanged: 0 })
  expect(await db.select().from(vehicleChargeRecord)).toHaveLength(2)
})

test('re-importing the same export is a no-op', async () => {
  const rows = [row('a', '2026-02-01T10:00:00Z', '2026-02-01T12:00:00Z')]
  await importRecords(rows)
  expect(await importRecords(rows)).toEqual({ inserted: 0, unchanged: 1 })
  expect(await db.select().from(vehicleChargeRecord)).toHaveLength(1)
})

test('a duplicate id inside one import counts once', async () => {
  const r = row('a', '2026-02-01T10:00:00Z', '2026-02-01T12:00:00Z')
  expect(await importRecords([r, r])).toEqual({ inserted: 1, unchanged: 1 })
})

test('an empty import writes nothing', async () => {
  expect(await importRecords([])).toEqual({ inserted: 0, unchanged: 0 })
})

test('coverage spans every record, public ones included', async () => {
  expect(await coverage()).toBeNull()
  await importRecords([
    row('a', '2026-02-01T10:00:00Z', '2026-02-01T12:00:00Z'),
    row('b', '2026-03-05T08:00:00Z', '2026-03-05T09:00:00Z', { isPublic: true }),
  ])
  expect(await coverage()).toEqual({
    from: new Date('2026-02-01T10:00:00Z'),
    to: new Date('2026-03-05T09:00:00Z'),
    count: 2,
  })
})

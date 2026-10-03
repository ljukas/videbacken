import { asc } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { vehicleStateSnapshot } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { latestSnapshot, recordSnapshot, type SnapshotInput } from './vehicleState'

setupDatabase()

const input = (overrides: Partial<SnapshotInput> = {}): SnapshotInput => ({
  polledAt: new Date('2026-05-04T08:58:24Z'),
  capturedAt: new Date('2026-05-04T08:57:51Z'),
  chargingState: 'CHARGING',
  chargeType: 'AC',
  plugState: 'CONNECTED',
  chargePowerKw: 3.5,
  parkingState: 'PARKED',
  atHome: true,
  socPercent: 55,
  odometerKm: 12345,
  odometerCapturedAt: new Date('2026-05-04T08:55:01Z'),
  ...overrides,
})
const rows = () =>
  db.select().from(vehicleStateSnapshot).orderBy(asc(vehicleStateSnapshot.polledAt))

test('stores every poll as its own row, even with the same capture time', async () => {
  await recordSnapshot(input())
  await recordSnapshot(input({ polledAt: new Date('2026-05-04T09:13:24Z') }))
  const stored = await rows()
  expect(stored).toHaveLength(2)
  expect(stored[0]).toMatchObject({
    plugState: 'CONNECTED',
    atHome: true,
    socPercent: 55,
    odometerKm: 12345,
  })
})

test('stores a poll with no charging part as unknown', async () => {
  await recordSnapshot(
    input({
      capturedAt: null,
      chargingState: null,
      chargeType: null,
      plugState: null,
      chargePowerKw: null,
    }),
  )
  expect((await rows())[0]).toMatchObject({ capturedAt: null, plugState: null })
})

test('latestSnapshot is the newest poll (times only), or null before any', async () => {
  expect(await latestSnapshot()).toBeNull()
  await recordSnapshot(
    input({ polledAt: new Date('2026-05-04T12:18:11Z'), plugState: 'DISCONNECTED' }),
  )
  await recordSnapshot(input({ polledAt: new Date('2026-05-04T09:00:00Z') }))
  expect(await latestSnapshot()).toEqual({
    polledAt: new Date('2026-05-04T12:18:11Z'),
    capturedAt: new Date('2026-05-04T08:57:51Z'),
  })
})

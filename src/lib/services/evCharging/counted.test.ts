import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeSession } from '~/lib/db/schema'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { countedSessionFilter } from './counted'

setupDatabase()

async function countedIds(opts?: { vehicle?: VehicleScope }) {
  const rows = await db
    .select({ id: evChargeSession.id })
    .from(evChargeSession)
    .where(countedSessionFilter(opts))
  return rows.map((r) => r.id).sort()
}

test('the vehicle scope narrows counted sessions; all or omitted adds nothing', async () => {
  const ours = await insertSession()
  const guest = await insertSession({ vehicle: 'other', vehicleSource: 'admin' })
  await insertSession({ energyKwh: 0.1 })
  await insertSession({ vehicle: 'other', vehicleSource: 'admin', voided: true })
  const both = [ours, guest].sort()

  expect(await countedIds({ vehicle: 'ours' })).toEqual([ours])
  expect(await countedIds({ vehicle: 'other' })).toEqual([guest])
  expect(await countedIds({ vehicle: 'all' })).toEqual(both)
  expect(await countedIds({})).toEqual(both)
  expect(await countedIds()).toEqual(both)
})

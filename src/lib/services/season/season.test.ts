import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { seasonEra } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { listEras } from './season'

setupDatabase()

test('listEras returns the seeded anchor era', async () => {
  expect(await listEras()).toEqual([{ fromYear: 2024, startWeek: 21, startShare: 'J' }])
})

test('listEras returns eras ordered by fromYear ascending', async () => {
  await db.insert(seasonEra).values({ fromYear: 2030, startWeek: 22, startShare: 'D' })
  expect((await listEras()).map((e) => e.fromYear)).toEqual([2024, 2030])
})

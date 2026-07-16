import { expect, test } from 'vitest'
import { setupDatabase } from '~test/setup'
import { listTags } from './tag'

setupDatabase()

test('listTags returns the seeded vocabulary ordered by sortOrder', async () => {
  const tags = await listTags()
  expect(tags.length).toBe(10)
  expect(tags[0].slug).toBe('restaurant')
  expect(tags.at(-1)?.slug).toBe('viewpoint')
  expect(tags.map((t) => t.sortOrder)).toEqual(
    [...tags.map((t) => t.sortOrder)].sort((a, b) => a - b),
  )
})

import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { file, recommendation, recommendationPhoto, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'

setupDatabase()

async function insertAuthor(email = 'anna@test.oceanview.local') {
  const [row] = await db
    .insert(user)
    .values({ name: email, email, role: 'user' })
    .returning({ id: user.id })
  return row.id
}

test('recommendation accepts valid coordinates', async () => {
  const authorId = await insertAuthor()
  const [row] = await db
    .insert(recommendation)
    .values({ authorId, title: 'Grytan', lat: 38.7, lng: 20.65 })
    .returning({ id: recommendation.id })
  expect(row.id).toBeTypeOf('string')
})

test('recommendation lat CHECK rejects out-of-range latitude', async () => {
  const authorId = await insertAuthor()
  await expect(
    db.insert(recommendation).values({ authorId, title: 'Bad', lat: 200, lng: 0 }),
  ).rejects.toThrow()
})

test('recommendation_photo.file_id is unique', async () => {
  const authorId = await insertAuthor()
  const [rec] = await db
    .insert(recommendation)
    .values({ authorId, title: 'Grytan', lat: 38.7, lng: 20.65 })
    .returning({ id: recommendation.id })
  const [f] = await db
    .insert(file)
    .values({
      ownerId: authorId,
      pathname: 'recommendations/x/a.jpg',
      mime: 'image/jpeg',
      sizeBytes: 1,
      access: 'public',
    })
    .returning({ id: file.id })
  await db
    .insert(recommendationPhoto)
    .values({ recommendationId: rec.id, fileId: f.id, sortOrder: 0 })
  await expect(
    db.insert(recommendationPhoto).values({ recommendationId: rec.id, fileId: f.id, sortOrder: 1 }),
  ).rejects.toThrow()
})

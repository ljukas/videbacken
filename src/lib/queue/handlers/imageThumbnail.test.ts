import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { confirmUpload, findActiveById, setThumbnailPathname } from '~/lib/services/document'
import { setupDatabase } from '~test/setup'
import { handleImageThumbnailMessage } from './imageThumbnail'

setupDatabase()

const META = { messageId: 'test-msg', deliveryCount: 1 }

async function insertUser(email = 'anna@test.oceanview.local') {
  const [row] = await db
    .insert(user)
    .values({ name: email, email, role: 'user' })
    .returning({ id: user.id })
  return row.id
}

const docInput = (
  ownerId: string,
  overrides: Partial<Parameters<typeof confirmUpload>[0]> = {},
) => ({
  ownerId,
  pathname: `dev/documents/${crypto.randomUUID()}/photo.png`,
  name: 'photo.png',
  mime: 'image/png',
  sizeBytes: 1000,
  ...overrides,
})

// These cover the handler's early-return guards, which short-circuit before
// any storage read — so they run against the real DB harness without mocking
// storage/fetch (matching the codebase's no-mock convention). The happy path
// (download → render → put) needs real bytes and is covered by the manual
// end-to-end smoke test in the plan; `generateImageThumbnail` itself is unit
// tested in `~/lib/image/thumbnail.test.ts`.

test('skips silently when the document is gone', async () => {
  await expect(
    handleImageThumbnailMessage({ documentId: crypto.randomUUID() }, META),
  ).resolves.toBeUndefined()
})

test('skips when a thumbnail (or sentinel) is already recorded', async () => {
  const ownerId = await insertUser()
  const inserted = await confirmUpload(docInput(ownerId))
  const existing = `thumbnails/${inserted.document.id}.webp`
  await setThumbnailPathname({ documentId: inserted.document.id, pathname: existing })

  await expect(
    handleImageThumbnailMessage({ documentId: inserted.document.id }, META),
  ).resolves.toBeUndefined()

  const after = await findActiveById(inserted.document.id)
  expect(after?.document.thumbnailPathname).toBe(existing)
})

test('skips undecodable mimes without recording a thumbnail', async () => {
  const ownerId = await insertUser()
  const inserted = await confirmUpload(
    docInput(ownerId, {
      mime: 'image/heic',
      pathname: `dev/documents/${crypto.randomUUID()}/photo.heic`,
      name: 'photo.heic',
    }),
  )

  await expect(
    handleImageThumbnailMessage({ documentId: inserted.document.id }, META),
  ).resolves.toBeUndefined()

  const after = await findActiveById(inserted.document.id)
  expect(after?.document.thumbnailPathname).toBeNull()
})

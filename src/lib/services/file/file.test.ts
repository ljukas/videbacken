import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { file, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { FileDomainError } from './errors'
import {
  findActiveById,
  findById,
  replaceAvatarForUser,
  replaceTranscoded,
  setBlurhash,
  setTranscodeFailed,
  softDelete,
  updatePathname,
} from './file'

setupDatabase()

async function insertMember(email: string, name = email, role: 'user' | 'admin' = 'user') {
  const [row] = await db.insert(user).values({ name, email, role }).returning({ id: user.id })
  return row.id
}

async function insertPrivateFile(ownerId: string, pathname: string) {
  const [row] = await db
    .insert(file)
    .values({ ownerId, pathname, mime: 'application/pdf', sizeBytes: 100, access: 'private' })
    .returning()
  return row
}

test('replaceAvatarForUser inserts a new public row and soft-deletes previous public rows', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  const [first] = await db
    .insert(file)
    .values({
      ownerId: userId,
      pathname: 'dev/avatars/anna-v1',
      mime: 'image/jpeg',
      sizeBytes: 100,
      access: 'public',
    })
    .returning()

  const result = await replaceAvatarForUser({
    userId,
    newRow: { pathname: 'dev/avatars/anna-v2', mime: 'image/jpeg', sizeBytes: 150 },
  })
  expect(result.previousPathnames).toEqual([first.pathname])
  expect(result.newRow.pathname).toBe('dev/avatars/anna-v2')
  expect(result.newRow.access).toBe('public')

  const oldRow = await findById(first.id)
  expect(oldRow?.deletedAt).not.toBeNull()
})

test('replaceAvatarForUser returns empty previousPathnames when no prior avatar exists', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  const result = await replaceAvatarForUser({
    userId,
    newRow: { pathname: 'dev/avatars/anna-fresh', mime: 'image/jpeg', sizeBytes: 80 },
  })
  expect(result.previousPathnames).toEqual([])
  expect(result.newRow.access).toBe('public')
})

test('softDelete marks deleted_at on the file row', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const row = await insertPrivateFile(ownerId, 'dev/documents/notes.pdf')
  const deleted = await softDelete(row.id)
  expect(deleted.deletedAt).not.toBeNull()
  expect(await findActiveById(row.id)).toBeNull()
})

test('softDelete is idempotent', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const row = await insertPrivateFile(ownerId, 'dev/documents/notes.pdf')
  await softDelete(row.id)
  const second = await softDelete(row.id)
  expect(second.deletedAt).not.toBeNull()
})

test('softDelete on a missing file raises NOT_FOUND', async () => {
  await expect(softDelete('00000000-0000-0000-0000-000000000000')).rejects.toThrow(FileDomainError)
})

test('updatePathname repoints the file row at a new pathname', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const row = await insertPrivateFile(ownerId, 'dev/documents/uuid/Batmanual.pdf')
  await updatePathname({ fileId: row.id, pathname: 'dev/documents/uuid/Motormanual.pdf' })
  const after = await findById(row.id)
  expect(after?.pathname).toBe('dev/documents/uuid/Motormanual.pdf')
})

test('setBlurhash writes the hash to an active row', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const row = await insertPrivateFile(ownerId, 'dev/documents/photo.png')
  expect(row.blurhash).toBeNull()
  await setBlurhash({ fileId: row.id, blurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH' })
  const after = await findById(row.id)
  expect(after?.blurhash).toBe('LKO2?U%2Tw=w]~RBVZRi};RPxuwH')
})

test('setBlurhash leaves soft-deleted rows untouched', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const row = await insertPrivateFile(ownerId, 'dev/documents/old.png')
  await db.update(file).set({ deletedAt: new Date() }).where(eq(file.id, row.id))
  await setBlurhash({ fileId: row.id, blurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH' })
  const after = await findById(row.id)
  expect(after?.blurhash).toBeNull()
})

test('replaceTranscoded repoints pathname, mime, sizeBytes', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const [row] = await db
    .insert(file)
    .values({ ownerId, pathname: 'p/x.heic', mime: 'image/heic', sizeBytes: 100, access: 'public' })
    .returning({ id: file.id })
  await replaceTranscoded({
    fileId: row.id,
    pathname: 'p/x.jpg',
    mime: 'image/jpeg',
    sizeBytes: 80,
  })
  const after = await findById(row.id)
  expect(after).toMatchObject({ pathname: 'p/x.jpg', mime: 'image/jpeg', sizeBytes: 80 })
})

test('setTranscodeFailed stamps transcodeFailedAt', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const [row] = await db
    .insert(file)
    .values({ ownerId, pathname: 'p/y.heic', mime: 'image/heic', sizeBytes: 100, access: 'public' })
    .returning({ id: file.id })
  await setTranscodeFailed(row.id)
  const after = await findById(row.id)
  expect(after?.transcodeFailedAt).toBeInstanceOf(Date)
})

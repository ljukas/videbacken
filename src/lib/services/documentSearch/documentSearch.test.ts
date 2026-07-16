import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { document, user } from '~/lib/db/schema'
import * as documentService from '~/lib/services/document'
import * as folderService from '~/lib/services/folder'
import { setupDatabase } from '~test/setup'
import { search } from './documentSearch'

setupDatabase()

async function insertMember(email: string, name = email, role: 'user' | 'admin' = 'user') {
  const [row] = await db.insert(user).values({ name, email, role }).returning({ id: user.id })
  return row.id
}

async function seed() {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')

  const manualer = await folderService.createFolder({
    parentId: null,
    name: 'Manualer',
    createdBy: adminId,
  })
  const motor = await folderService.createFolder({
    parentId: manualer.id,
    name: 'Motor',
    createdBy: adminId,
  })
  const foto = await folderService.createFolder({
    parentId: null,
    name: 'Foto',
    createdBy: adminId,
  })

  const bottom = await documentService.confirmUpload({
    ownerId,
    pathname: 'dev/documents/x/bottenmalning.pdf',
    name: 'bottenmalning-2024.pdf',
    mime: 'application/pdf',
    sizeBytes: 100,
  })
  const engineManual = await documentService.confirmUpload({
    ownerId,
    pathname: 'dev/documents/y/engine.pdf',
    name: 'Manual for the engine.pdf',
    mime: 'application/pdf',
    sizeBytes: 100,
    folderId: motor.id,
  })
  const photo = await documentService.confirmUpload({
    ownerId,
    pathname: 'dev/documents/z/img.jpg',
    name: 'IMG_001.jpg',
    mime: 'image/jpeg',
    sizeBytes: 100,
    folderId: foto.id,
  })
  const ghost = await documentService.confirmUpload({
    ownerId,
    pathname: 'dev/documents/w/ghost.pdf',
    name: 'ghost-bottenmalning.pdf',
    mime: 'application/pdf',
    sizeBytes: 100,
  })
  await db.update(document).set({ deletedAt: new Date() }).where(eq(document.id, ghost.document.id))

  return {
    ownerId,
    adminId,
    folders: { manualer, motor, foto },
    docs: { bottom, engineManual, photo, ghost },
  }
}

test('search with fewer than 2 characters returns empty', async () => {
  await seed()
  expect(await search('a')).toEqual([])
  expect(await search(' ')).toEqual([])
})

test('search finds a folder by its name', async () => {
  const { folders } = await seed()
  const hits = await search('Foto')
  const folderHit = hits.find((h) => h.kind === 'folder')
  expect(folderHit?.id).toBe(folders.foto.id)
})

test('search finds a document via name with mild typo', async () => {
  const { docs } = await seed()
  // "bottnmalning" — drops the "e" in "bottenmalning"; trigram overlap still high.
  const hits = await search('bottnmalning')
  const docHit = hits.find((h) => h.kind === 'document')
  expect(docHit?.id).toBe(docs.bottom.document.id)
  // The hit's name is the joined display name (base + extension).
  expect(docHit?.name).toBe('bottenmalning-2024.pdf')
})

test('document hits carry mime and extension for type-specific icons', async () => {
  const { docs } = await seed()
  const hits = await search('bottnmalning')
  const docHit = hits.find((h) => h.kind === 'document')
  expect(docHit?.id).toBe(docs.bottom.document.id)
  if (docHit?.kind !== 'document') throw new Error('expected a document hit')
  expect(docHit.mime).toBe('application/pdf')
  expect(docHit.extension).toBe('pdf')
})

test('search matches on the file extension (haystack includes it)', async () => {
  const { docs } = await seed()
  const hits = await search('IMG_001 jpg')
  expect(hits.find((h) => h.id === docs.photo.document.id)).toBeDefined()
})

test('search is case-insensitive', async () => {
  const { docs } = await seed()
  const lower = await search('manual for the engine')
  const upper = await search('MANUAL FOR THE ENGINE')
  expect(lower.find((h) => h.id === docs.engineManual.document.id)).toBeDefined()
  expect(upper.find((h) => h.id === docs.engineManual.document.id)).toBeDefined()
})

test('search does not return soft-deleted documents', async () => {
  const { docs } = await seed()
  const hits = await search('ghost-bottenmalning')
  expect(hits.find((h) => h.id === docs.ghost.document.id)).toBeUndefined()
})

test('mergeAndRank: folders sort ahead of documents on equal scores', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  await folderService.createFolder({ parentId: null, name: 'Pictures', createdBy: adminId })
  await documentService.confirmUpload({
    ownerId: adminId,
    pathname: 'dev/documents/p/pictures.pdf',
    name: 'pictures.pdf',
    mime: 'application/pdf',
    sizeBytes: 100,
  })
  const hits = await search('pictures')
  // The folder and document both match 'pictures' with similar scores; folder
  // should come first when scores tie.
  const folderIdx = hits.findIndex((h) => h.kind === 'folder')
  const docIdx = hits.findIndex((h) => h.kind === 'document')
  // Either folder is the only hit, or it comes before the document at equal score.
  if (folderIdx !== -1 && docIdx !== -1 && hits[folderIdx].score === hits[docIdx].score) {
    expect(folderIdx).toBeLessThan(docIdx)
  } else {
    expect(folderIdx === -1 || docIdx === -1 || folderIdx < docIdx).toBe(true)
  }
})

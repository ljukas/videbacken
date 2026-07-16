import { and, desc, eq, isNull } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { document, documentEvent, file, folder, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import {
  confirmUpload,
  findActiveById,
  findById,
  hardDeleteDocument,
  listDocumentsByFolderId,
  moveDocument,
  renameDocument,
  restoreDocument,
  setThumbnailPathname,
  softDelete,
} from './document'

setupDatabase()

async function insertMember(email: string, name = email, role: 'user' | 'admin' = 'user') {
  const [row] = await db.insert(user).values({ name, email, role }).returning({ id: user.id })
  return row.id
}

const docInput = (
  ownerId: string,
  overrides: Partial<Parameters<typeof confirmUpload>[0]> = {},
) => ({
  ownerId,
  pathname: `dev/documents/${crypto.randomUUID()}/manual.pdf`,
  name: 'manual.pdf',
  mime: 'application/pdf',
  sizeBytes: 12345,
  ...overrides,
})

test('confirmUpload writes a file row + a document row in one transaction', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const row = await confirmUpload(docInput(ownerId))

  expect(row.document.id).toBeTypeOf('string')
  expect(row.file.id).toBeTypeOf('string')
  expect(row.document.fileId).toBe(row.file.id)
  expect(row.file.access).toBe('private')
  expect(row.file.ownerId).toBe(ownerId)
  // The uploaded filename is split: base in `name`, extension in `extension`.
  expect(row.document.name).toBe('manual')
  expect(row.document.extension).toBe('pdf')
  // The haystack keeps the full display name (so a search for "pdf" matches).
  expect(row.document.searchHaystack).toBe('manual.pdf')

  const fileCount = await db.select({ id: file.id }).from(file).where(eq(file.id, row.file.id))
  const documentCount = await db
    .select({ id: document.id })
    .from(document)
    .where(eq(document.id, row.document.id))
  expect(fileCount).toHaveLength(1)
  expect(documentCount).toHaveLength(1)
})

test('findActiveById returns the joined row; null for soft-deleted', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId))

  const fetched = await findActiveById(inserted.document.id)
  expect(fetched?.document.id).toBe(inserted.document.id)
  expect(fetched?.file.pathname).toBe(inserted.file.pathname)

  await db
    .update(document)
    .set({ deletedAt: new Date() })
    .where(eq(document.id, inserted.document.id))
  expect(await findActiveById(inserted.document.id)).toBeNull()
})

test('findById returns soft-deleted rows too', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId))
  await db
    .update(document)
    .set({ deletedAt: new Date() })
    .where(eq(document.id, inserted.document.id))

  const fetched = await findById(inserted.document.id)
  expect(fetched?.document.deletedAt).not.toBeNull()
})

test('listDocumentsByFolderId(null) returns root documents with owner name, newest first', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')
  const bobId = await insertMember('bob@test.oceanview.local', 'Bob')
  await confirmUpload(docInput(aliceId, { name: 'alice.pdf' }))
  await confirmUpload(docInput(bobId, { name: 'bob.pdf' }))

  const docs = await listDocumentsByFolderId(null)
  // Stored base names (extension lives in its own column).
  expect(docs.map((d) => d.document.name).sort()).toEqual(['alice', 'bob'])
  const alice = docs.find((d) => d.document.name === 'alice')
  expect(alice?.document.extension).toBe('pdf')
  expect(alice?.ownerName).toBe('Alice')
})

test('listDocumentsByFolderId scopes to a single folder', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const folderId = (await insertFolder('Manuals', ownerId)).id
  await confirmUpload(docInput(ownerId, { name: 'root.pdf' }))
  await confirmUpload(docInput(ownerId, { name: 'inside.pdf', folderId }))

  const inFolder = await listDocumentsByFolderId(folderId)
  expect(inFolder.map((d) => d.document.name)).toEqual(['inside'])

  const atRoot = await listDocumentsByFolderId(null)
  expect(atRoot.map((d) => d.document.name)).toEqual(['root'])
})

test('listDocumentsByFolderId excludes avatars (files without a document row)', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  await db.insert(file).values({
    ownerId,
    pathname: 'dev/avatars/anna.jpg',
    mime: 'image/jpeg',
    sizeBytes: 100,
    access: 'public',
  })
  await confirmUpload(docInput(ownerId, { name: 'doc.pdf' }))

  const docs = await listDocumentsByFolderId(null)
  expect(docs.map((d) => d.document.name)).toEqual(['doc'])
})

test('listDocumentsByFolderId hides soft-deleted documents', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId, { name: 'old.pdf' }))
  await db
    .update(document)
    .set({ deletedAt: new Date() })
    .where(eq(document.id, inserted.document.id))
  expect(await listDocumentsByFolderId(null)).toEqual([])
})

test('softDelete by the owner marks deleted_at on the document but not the file', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId))

  const deleted = await softDelete({
    id: inserted.document.id,
    actingUserId: ownerId,
    actingUserRole: 'user',
  })
  expect(deleted.document.deletedAt).not.toBeNull()
  expect(deleted.file.deletedAt).toBeNull()
  expect(await findActiveById(inserted.document.id)).toBeNull()

  const [fileRow] = await db.select().from(file).where(eq(file.id, inserted.file.id))
  expect(fileRow.deletedAt).toBeNull()
})

test('softDelete by another non-admin user raises CANNOT_DELETE_OTHERS_DOCUMENT', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const otherId = await insertMember('bob@test.oceanview.local', 'Bob')
  const inserted = await confirmUpload(docInput(ownerId))

  await expect(
    softDelete({ id: inserted.document.id, actingUserId: otherId, actingUserRole: 'user' }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'CANNOT_DELETE_OTHERS_DOCUMENT' })
})

test("softDelete by an admin succeeds even on another user's document", async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const inserted = await confirmUpload(docInput(ownerId))

  const deleted = await softDelete({
    id: inserted.document.id,
    actingUserId: adminId,
    actingUserRole: 'admin',
  })
  expect(deleted.document.deletedAt).not.toBeNull()
})

test('softDelete on a missing document raises NOT_FOUND', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  await expect(
    softDelete({
      id: '00000000-0000-0000-0000-000000000000',
      actingUserId: adminId,
      actingUserRole: 'admin',
    }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'NOT_FOUND' })
})

test('softDelete is idempotent — second call returns the already-deleted row', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId))
  await softDelete({ id: inserted.document.id, actingUserId: ownerId, actingUserRole: 'user' })
  const second = await softDelete({
    id: inserted.document.id,
    actingUserId: ownerId,
    actingUserRole: 'user',
  })
  expect(second.document.deletedAt).not.toBeNull()
})

test('setThumbnailPathname writes to an active document', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId))
  expect(inserted.document.thumbnailPathname).toBeNull()

  await setThumbnailPathname({
    documentId: inserted.document.id,
    pathname: `thumbnails/${inserted.document.id}.webp`,
  })
  const fetched = await findActiveById(inserted.document.id)
  expect(fetched?.document.thumbnailPathname).toBe(`thumbnails/${inserted.document.id}.webp`)
})

test('setThumbnailPathname leaves soft-deleted documents untouched', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId))
  await db
    .update(document)
    .set({ deletedAt: new Date() })
    .where(eq(document.id, inserted.document.id))

  await setThumbnailPathname({
    documentId: inserted.document.id,
    pathname: 'thumbnails/should-not-write.webp',
  })
  const after = await findById(inserted.document.id)
  expect(after?.document.thumbnailPathname).toBeNull()
})

// ─── Phase 2 (ADR-0010): folders, events, rename/move/restore/hardDelete ───

async function insertFolder(name: string, createdBy: string, parentId: string | null = null) {
  const parentPath = parentId
    ? (await db.select({ path: folder.path }).from(folder).where(eq(folder.id, parentId)))[0].path
    : '/'
  const path = `${parentPath}${name}/`
  const [row] = await db
    .insert(folder)
    .values({
      parentId,
      name,
      path,
      searchHaystack: `${path} ${name}`.toLowerCase(),
      createdBy,
    })
    .returning()
  return row
}

async function latestEvent(documentId: string) {
  const [row] = await db
    .select()
    .from(documentEvent)
    .where(eq(documentEvent.documentId, documentId))
    .orderBy(desc(documentEvent.occurredAt))
    .limit(1)
  return row
}

test('confirmUpload writes a document_event { upload }', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId, { name: 'minutes.pdf' }))
  const event = await latestEvent(inserted.document.id)
  expect(event.kind).toBe('upload')
  expect(event.actorId).toBe(ownerId)
  expect(event.toValue).toEqual({ name: 'minutes.pdf', folderId: null })
})

test('confirmUpload with folderId enriches search_haystack with folder path', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const f = await insertFolder('Manuals', ownerId)
  const inserted = await confirmUpload(docInput(ownerId, { name: 'Engine.pdf', folderId: f.id }))
  expect(inserted.document.folderId).toBe(f.id)
  expect(inserted.document.searchHaystack).toBe('/manuals/ engine.pdf')
})

test('confirmUpload with a deleted folderId raises FOLDER_DELETED', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const f = await insertFolder('Manuals', ownerId)
  await db.update(folder).set({ deletedAt: new Date() }).where(eq(folder.id, f.id))
  await expect(
    confirmUpload(docInput(ownerId, { name: 'Engine.pdf', folderId: f.id })),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'FOLDER_DELETED' })
})

test('confirmUpload with a non-existent folderId raises FOLDER_NOT_FOUND', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  await expect(
    confirmUpload(
      docInput(ownerId, {
        name: 'Engine.pdf',
        folderId: '00000000-0000-0000-0000-000000000000',
      }),
    ),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'FOLDER_NOT_FOUND' })
})

test('renameDocument by owner updates the base name (extension is immutable) + search_haystack + emits rename event', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId, { name: 'old.pdf' }))
  // newName is the base only; the extension must not change.
  const renamed = await renameDocument({
    id: inserted.document.id,
    newName: 'new',
    actorId: ownerId,
    actorRole: 'user',
  })
  expect(renamed.document.name).toBe('new')
  expect(renamed.document.extension).toBe('pdf')
  expect(renamed.document.searchHaystack).toBe('new.pdf')
  const event = await latestEvent(inserted.document.id)
  expect(event.kind).toBe('rename')
  // Events store the human-readable display name (base + extension).
  expect(event.fromValue).toEqual({ name: 'old.pdf' })
  expect(event.toValue).toEqual({ name: 'new.pdf' })
})

test('renameDocument cannot alter the extension even if the base contains dots', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId, { name: 'report.pdf' }))
  // A base containing a dot is kept verbatim; the stored extension is untouched.
  const renamed = await renameDocument({
    id: inserted.document.id,
    newName: 'report.final',
    actorId: ownerId,
    actorRole: 'user',
  })
  expect(renamed.document.name).toBe('report.final')
  expect(renamed.document.extension).toBe('pdf')
  expect(renamed.document.searchHaystack).toBe('report.final.pdf')
})

test('confirmUpload of an extension-less file stores a null extension', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId, { name: 'README' }))
  expect(inserted.document.name).toBe('README')
  expect(inserted.document.extension).toBeNull()
  expect(inserted.document.searchHaystack).toBe('readme')
})

test('confirmUpload of a multi-dot filename splits only the last segment', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId, { name: 'archive.tar.gz' }))
  expect(inserted.document.name).toBe('archive.tar')
  expect(inserted.document.extension).toBe('gz')
})

test('renameDocument by non-owner non-admin raises CANNOT_EDIT_OTHERS_DOCUMENT', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const otherId = await insertMember('bob@test.oceanview.local', 'Bob')
  const inserted = await confirmUpload(docInput(ownerId))
  await expect(
    renameDocument({
      id: inserted.document.id,
      newName: 'bob.pdf',
      actorId: otherId,
      actorRole: 'user',
    }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'CANNOT_EDIT_OTHERS_DOCUMENT' })
})

test('moveDocument to a new folder updates folderId + search_haystack', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const target = await insertFolder('Manuals', ownerId)
  const inserted = await confirmUpload(docInput(ownerId, { name: 'engine.pdf' }))
  const moved = await moveDocument({
    id: inserted.document.id,
    newFolderId: target.id,
    actorId: ownerId,
    actorRole: 'user',
  })
  expect(moved.document.folderId).toBe(target.id)
  expect(moved.document.searchHaystack).toBe('/manuals/ engine.pdf')
  const event = await latestEvent(inserted.document.id)
  expect(event.kind).toBe('move')
  // Events snapshot folder names (null = root) so history renders "from → to".
  expect(event.fromValue).toEqual({ folderId: null, name: null })
  expect(event.toValue).toEqual({ folderId: target.id, name: 'Manuals' })
})

test('moveDocument between two folders snapshots both folder names', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const manuals = await insertFolder('Manuals', ownerId)
  const archive = await insertFolder('Archive', ownerId)
  const inserted = await confirmUpload(
    docInput(ownerId, { name: 'engine.pdf', folderId: manuals.id }),
  )
  await moveDocument({
    id: inserted.document.id,
    newFolderId: archive.id,
    actorId: ownerId,
    actorRole: 'user',
  })
  const event = await latestEvent(inserted.document.id)
  expect(event.kind).toBe('move')
  expect(event.fromValue).toEqual({ folderId: manuals.id, name: 'Manuals' })
  expect(event.toValue).toEqual({ folderId: archive.id, name: 'Archive' })
})

test('moveDocument back to root records a null destination name + drops the haystack prefix', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const manuals = await insertFolder('Manuals', ownerId)
  const inserted = await confirmUpload(
    docInput(ownerId, { name: 'engine.pdf', folderId: manuals.id }),
  )
  const moved = await moveDocument({
    id: inserted.document.id,
    newFolderId: null,
    actorId: ownerId,
    actorRole: 'user',
  })
  expect(moved.document.folderId).toBeNull()
  expect(moved.document.searchHaystack).toBe('engine.pdf')
  const event = await latestEvent(inserted.document.id)
  expect(event.kind).toBe('move')
  expect(event.fromValue).toEqual({ folderId: manuals.id, name: 'Manuals' })
  expect(event.toValue).toEqual({ folderId: null, name: null })
})

test('moveDocument into a deleted folder raises FOLDER_DELETED', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const target = await insertFolder('Manuals', ownerId)
  await db.update(folder).set({ deletedAt: new Date() }).where(eq(folder.id, target.id))
  const inserted = await confirmUpload(docInput(ownerId))
  await expect(
    moveDocument({
      id: inserted.document.id,
      newFolderId: target.id,
      actorId: ownerId,
      actorRole: 'user',
    }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'FOLDER_DELETED' })
})

test('softDelete emits a document_event { soft_delete }', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId, { name: 'notes.pdf' }))
  await softDelete({ id: inserted.document.id, actingUserId: ownerId, actingUserRole: 'user' })
  const event = await latestEvent(inserted.document.id)
  expect(event.kind).toBe('soft_delete')
  expect(event.toValue).toEqual({ name: 'notes.pdf' })
})

test('restoreDocument by admin clears deletedAt + emits restore event', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const inserted = await confirmUpload(docInput(ownerId))
  await softDelete({ id: inserted.document.id, actingUserId: adminId, actingUserRole: 'admin' })
  const restored = await restoreDocument({
    id: inserted.document.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  expect(restored.document.deletedAt).toBeNull()
  const event = await latestEvent(inserted.document.id)
  expect(event.kind).toBe('restore')
})

test('restoreDocument on an active document raises NOT_DELETED', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const inserted = await confirmUpload(docInput(ownerId))
  await expect(
    restoreDocument({ id: inserted.document.id, actorId: adminId, actorRole: 'admin' }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'NOT_DELETED' })
})

test('restoreDocument by non-admin raises NOT_ADMIN', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId))
  await softDelete({ id: inserted.document.id, actingUserId: ownerId, actingUserRole: 'user' })
  await expect(
    restoreDocument({ id: inserted.document.id, actorId: ownerId, actorRole: 'user' }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'NOT_ADMIN' })
})

test('hardDeleteDocument writes the event row, deletes the file, and history survives', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const inserted = await confirmUpload(docInput(ownerId, { name: 'wreck.pdf' }))
  // Hard-delete is bin-only: soft-delete first (mirrors the admin bin workflow).
  await softDelete({ id: inserted.document.id, actingUserId: adminId, actingUserRole: 'admin' })

  const result = await hardDeleteDocument({
    id: inserted.document.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  expect(result.pathname).toBe(inserted.file.pathname)

  // File + document rows gone (cascade).
  const remainingFile = await db
    .select({ id: file.id })
    .from(file)
    .where(eq(file.id, inserted.file.id))
  expect(remainingFile).toEqual([])
  const remainingDoc = await db
    .select({ id: document.id })
    .from(document)
    .where(eq(document.id, inserted.document.id))
  expect(remainingDoc).toEqual([])

  // History survives the cascade with document_id NULLed and identifying info in toValue.
  const events = await db
    .select()
    .from(documentEvent)
    .where(and(eq(documentEvent.kind, 'hard_delete'), isNull(documentEvent.documentId)))
  expect(events).toHaveLength(1)
  expect(events[0].actorId).toBe(adminId)
  expect(events[0].toValue).toEqual({ name: 'wreck.pdf', pathname: inserted.file.pathname })
})

test('hardDeleteDocument by non-admin raises NOT_ADMIN', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await confirmUpload(docInput(ownerId))
  await expect(
    hardDeleteDocument({ id: inserted.document.id, actorId: ownerId, actorRole: 'user' }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'NOT_ADMIN' })
})

test('hardDeleteDocument on an active (non-binned) document raises NOT_DELETED', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const inserted = await confirmUpload(docInput(ownerId))
  await expect(
    hardDeleteDocument({ id: inserted.document.id, actorId: adminId, actorRole: 'admin' }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'NOT_DELETED' })
})

test('hardDeleteDocument on a missing document raises NOT_FOUND', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  await expect(
    hardDeleteDocument({
      id: '00000000-0000-0000-0000-000000000000',
      actorId: adminId,
      actorRole: 'admin',
    }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'NOT_FOUND' })
})

test('renameDocument on a missing document raises NOT_FOUND', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  await expect(
    renameDocument({
      id: '00000000-0000-0000-0000-000000000000',
      newName: 'whatever.pdf',
      actorId: ownerId,
      actorRole: 'user',
    }),
  ).rejects.toMatchObject({ name: 'DocumentDomainError', code: 'NOT_FOUND' })
})

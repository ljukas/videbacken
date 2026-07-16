import { and, eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { document, documentEvent, file, folder, folderEvent, user } from '~/lib/db/schema'
import * as documentService from '~/lib/services/document'
import { setupDatabase } from '~test/setup'
import {
  createFolder,
  findActiveFolderById,
  findFolderById,
  hardDeleteFolderAsAdmin,
  listBin,
  listChildren,
  listDescendants,
  listTree,
  moveFolderAsAdmin,
  renameFolderAsAdmin,
  restoreByCorrelationAsAdmin,
  softDeleteFolderAsAdmin,
} from './folder'

setupDatabase()

async function insertMember(email: string, name = email, role: 'user' | 'admin' = 'user') {
  const [row] = await db.insert(user).values({ name, email, role }).returning({ id: user.id })
  return row.id
}

async function insertDocumentInFolder(ownerId: string, folderId: string, name = 'doc.pdf') {
  return documentService.confirmUpload({
    ownerId,
    pathname: `dev/documents/${crypto.randomUUID()}/${name}`,
    name,
    mime: 'application/pdf',
    sizeBytes: 100,
    folderId,
  })
}

test('createFolder at root assigns path = /<name>/', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: userId })
  expect(f.path).toBe('/Manuals/')
  expect(f.parentId).toBeNull()
  expect(f.searchHaystack).toBe('/manuals/ manuals')
})

test('createFolder nested under parent inherits its path', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  const parent = await createFolder({ parentId: null, name: 'Manuals', createdBy: userId })
  const child = await createFolder({ parentId: parent.id, name: 'Engine', createdBy: userId })
  expect(child.path).toBe('/Manuals/Engine/')
  expect(child.parentId).toBe(parent.id)
})

test('createFolder emits a folder_event { create }', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: userId })
  const [event] = await db.select().from(folderEvent).where(eq(folderEvent.folderId, f.id))
  expect(event.kind).toBe('create')
  expect(event.actorId).toBe(userId)
  expect(event.toValue).toEqual({ name: 'Manuals', parentId: null, path: '/Manuals/' })
})

test('createFolder duplicate name in same parent raises NAME_TAKEN_IN_PARENT', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  await createFolder({ parentId: null, name: 'Manuals', createdBy: userId })
  await expect(
    createFolder({ parentId: null, name: 'Manuals', createdBy: userId }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NAME_TAKEN_IN_PARENT' })
})

test('createFolder with `/` in name raises INVALID_NAME', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  await expect(
    createFolder({ parentId: null, name: 'Bad/Name', createdBy: userId }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'INVALID_NAME' })
})

test('renameFolderAsAdmin updates own + descendants paths + document haystacks', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const root = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const child = await createFolder({ parentId: root.id, name: 'Engine', createdBy: adminId })
  const doc = await insertDocumentInFolder(ownerId, child.id, 'oil.pdf')

  await renameFolderAsAdmin({
    id: root.id,
    newName: 'Manualer',
    actorId: adminId,
    actorRole: 'admin',
  })

  const after = await findActiveFolderById(root.id)
  expect(after?.path).toBe('/Manualer/')
  expect(after?.name).toBe('Manualer')

  const afterChild = await findActiveFolderById(child.id)
  expect(afterChild?.path).toBe('/Manualer/Engine/')
  expect(afterChild?.searchHaystack).toBe('/manualer/engine/ engine')

  const refreshed = await documentService.findActiveById(doc.document.id)
  expect(refreshed?.document.searchHaystack).toBe('/manualer/engine/ oil.pdf')
})

test('renameFolderAsAdmin to a name taken in parent raises NAME_TAKEN_IN_PARENT', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const other = await createFolder({ parentId: null, name: 'Photos', createdBy: adminId })
  await expect(
    renameFolderAsAdmin({ id: other.id, newName: 'Manuals', actorId: adminId, actorRole: 'admin' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NAME_TAKEN_IN_PARENT' })
})

test('renameFolderAsAdmin by non-admin raises NOT_ADMIN', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: userId })
  await expect(
    renameFolderAsAdmin({ id: f.id, newName: 'Other', actorId: userId, actorRole: 'user' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NOT_ADMIN' })
})

const MISSING_ID = '00000000-0000-0000-0000-000000000000'

test('renameFolderAsAdmin on a missing folder raises NOT_FOUND', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  await expect(
    renameFolderAsAdmin({ id: MISSING_ID, newName: 'X', actorId: adminId, actorRole: 'admin' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NOT_FOUND' })
})

test('createFolder under a non-existent parent raises PARENT_NOT_FOUND', async () => {
  const userId = await insertMember('anna@test.oceanview.local', 'Anna')
  await expect(
    createFolder({ parentId: MISSING_ID, name: 'Orphan', createdBy: userId }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'PARENT_NOT_FOUND' })
})

test('moveFolderAsAdmin / softDeleteFolderAsAdmin / restoreByCorrelationAsAdmin reject non-admins', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const target = await createFolder({ parentId: null, name: 'Archive', createdBy: adminId })
  await expect(
    moveFolderAsAdmin({ id: f.id, newParentId: target.id, actorId: adminId, actorRole: 'user' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NOT_ADMIN' })
  await expect(
    softDeleteFolderAsAdmin({ id: f.id, actorId: adminId, actorRole: 'user' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NOT_ADMIN' })
  await expect(
    restoreByCorrelationAsAdmin({ correlationId: MISSING_ID, actorId: adminId, actorRole: 'user' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NOT_ADMIN' })
})

test('moveFolderAsAdmin from root into another parent updates paths', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const archive = await createFolder({ parentId: null, name: 'Archive', createdBy: adminId })
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const child = await createFolder({ parentId: f.id, name: 'Engine', createdBy: adminId })

  await moveFolderAsAdmin({
    id: f.id,
    newParentId: archive.id,
    actorId: adminId,
    actorRole: 'admin',
  })

  expect((await findActiveFolderById(f.id))?.path).toBe('/Archive/Manuals/')
  expect((await findActiveFolderById(child.id))?.path).toBe('/Archive/Manuals/Engine/')
})

test('moveFolderAsAdmin updates descendant document haystacks (files follow the folder)', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const archive = await createFolder({ parentId: null, name: 'Archive', createdBy: adminId })
  const manuals = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const engine = await createFolder({ parentId: manuals.id, name: 'Engine', createdBy: adminId })
  const doc = await insertDocumentInFolder(ownerId, engine.id, 'oil.pdf')

  await moveFolderAsAdmin({
    id: manuals.id,
    newParentId: archive.id,
    actorId: adminId,
    actorRole: 'admin',
  })

  // The document's folderId is unchanged (it rode along), but its denormalized
  // search haystack reflects the new ancestor path.
  const refreshed = await documentService.findActiveById(doc.document.id)
  expect(refreshed?.document.folderId).toBe(engine.id)
  expect(refreshed?.document.searchHaystack).toBe('/archive/manuals/engine/ oil.pdf')
})

test('moveFolderAsAdmin into own descendant raises CANNOT_MOVE_INTO_DESCENDANT', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const child = await createFolder({ parentId: f.id, name: 'Engine', createdBy: adminId })
  await expect(
    moveFolderAsAdmin({
      id: f.id,
      newParentId: child.id,
      actorId: adminId,
      actorRole: 'admin',
    }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'CANNOT_MOVE_INTO_DESCENDANT' })
})

test('moveFolderAsAdmin into itself raises CANNOT_MOVE_INTO_DESCENDANT', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  await expect(
    moveFolderAsAdmin({ id: f.id, newParentId: f.id, actorId: adminId, actorRole: 'admin' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'CANNOT_MOVE_INTO_DESCENDANT' })
})

test('softDeleteFolderAsAdmin cascades to descendants + contained documents under one correlation_id', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const root = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const child = await createFolder({ parentId: root.id, name: 'Engine', createdBy: adminId })
  const doc1 = await insertDocumentInFolder(ownerId, child.id, 'oil.pdf')
  const doc2 = await insertDocumentInFolder(ownerId, root.id, 'history.pdf')

  const result = await softDeleteFolderAsAdmin({
    id: root.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  expect(result.foldersAffected).toBe(2)
  expect(result.documentsAffected).toBe(2)

  expect((await findFolderById(root.id))?.deletedAt).not.toBeNull()
  expect((await findFolderById(child.id))?.deletedAt).not.toBeNull()
  expect(await documentService.findActiveById(doc1.document.id)).toBeNull()
  expect(await documentService.findActiveById(doc2.document.id)).toBeNull()

  const folderEvents = await db
    .select({ id: folderEvent.id })
    .from(folderEvent)
    .where(
      and(eq(folderEvent.correlationId, result.correlationId), eq(folderEvent.kind, 'soft_delete')),
    )
  expect(folderEvents).toHaveLength(2)
  const docEvents = await db
    .select({ id: documentEvent.id })
    .from(documentEvent)
    .where(
      and(
        eq(documentEvent.correlationId, result.correlationId),
        eq(documentEvent.kind, 'soft_delete'),
      ),
    )
  expect(docEvents).toHaveLength(2)
})

test('softDeleteFolderAsAdmin on already-deleted folder raises ALREADY_DELETED', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  await softDeleteFolderAsAdmin({ id: f.id, actorId: adminId, actorRole: 'admin' })
  await expect(
    softDeleteFolderAsAdmin({ id: f.id, actorId: adminId, actorRole: 'admin' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'ALREADY_DELETED' })
})

test('restoreByCorrelationAsAdmin restores the whole subtree with a fresh correlation_id', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const root = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const child = await createFolder({ parentId: root.id, name: 'Engine', createdBy: adminId })
  const doc = await insertDocumentInFolder(ownerId, child.id, 'oil.pdf')

  const del = await softDeleteFolderAsAdmin({
    id: root.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  const restore = await restoreByCorrelationAsAdmin({
    correlationId: del.correlationId,
    actorId: adminId,
    actorRole: 'admin',
  })
  expect(restore.foldersRestored).toBe(2)
  expect(restore.documentsRestored).toBe(1)
  expect(restore.restoreCorrelationId).not.toBe(del.correlationId)

  expect((await findActiveFolderById(root.id))?.deletedAt).toBeNull()
  expect((await findActiveFolderById(child.id))?.deletedAt).toBeNull()
  expect(await documentService.findActiveById(doc.document.id)).not.toBeNull()

  const restoreEvents = await db
    .select({ id: folderEvent.id })
    .from(folderEvent)
    .where(eq(folderEvent.correlationId, restore.restoreCorrelationId))
  expect(restoreEvents.length).toBe(2)
})

test('restoreByCorrelationAsAdmin when a sibling reused the deleted name raises NAME_TAKEN_IN_PARENT', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const del = await softDeleteFolderAsAdmin({
    id: f.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  await expect(
    restoreByCorrelationAsAdmin({
      correlationId: del.correlationId,
      actorId: adminId,
      actorRole: 'admin',
    }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NAME_TAKEN_IN_PARENT' })
})

test('hardDeleteFolderAsAdmin purges a nested subtree (folders + documents + files) leaf-first', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  // Three levels deep exercises the leaf-first ordering against the `restrict` FK.
  const root = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const child = await createFolder({ parentId: root.id, name: 'Engine', createdBy: adminId })
  const grandchild = await createFolder({ parentId: child.id, name: 'Oil', createdBy: adminId })
  const doc1 = await insertDocumentInFolder(ownerId, grandchild.id, 'spec.pdf')
  const doc2 = await insertDocumentInFolder(ownerId, root.id, 'history.pdf')

  const del = await softDeleteFolderAsAdmin({ id: root.id, actorId: adminId, actorRole: 'admin' })

  const result = await hardDeleteFolderAsAdmin({
    id: root.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  expect(result.foldersPurged).toBe(3)
  expect(result.documentsPurged).toBe(2)
  expect(result.privatePathnames.sort()).toEqual([doc1.file.pathname, doc2.file.pathname].sort())
  expect(result.correlationId).not.toBe(del.correlationId)

  // Folders, documents and file rows are physically gone.
  expect(await findFolderById(root.id)).toBeNull()
  expect(await findFolderById(child.id)).toBeNull()
  expect(await findFolderById(grandchild.id)).toBeNull()
  expect(await documentService.findById(doc1.document.id)).toBeNull()
  expect(await documentService.findById(doc2.document.id)).toBeNull()
  for (const fileId of [doc1.file.id, doc2.file.id]) {
    const [row] = await db.select({ id: file.id }).from(file).where(eq(file.id, fileId))
    expect(row).toBeUndefined()
  }

  // hard_delete history survives with the folder_id/document_id nulled.
  const folderEvents = await db
    .select({ id: folderEvent.id })
    .from(folderEvent)
    .where(
      and(eq(folderEvent.correlationId, result.correlationId), eq(folderEvent.kind, 'hard_delete')),
    )
  expect(folderEvents).toHaveLength(3)
  const docEvents = await db
    .select({ id: documentEvent.id })
    .from(documentEvent)
    .where(
      and(
        eq(documentEvent.correlationId, result.correlationId),
        eq(documentEvent.kind, 'hard_delete'),
      ),
    )
  expect(docEvents).toHaveLength(2)
  // DB-heaviest test in the suite (~20 sequential round-trips: 3 folders + 2 docs
  // of setup, soft+hard delete, then the verification reads). Comfortable locally
  // (~3s) but the ephemeral Neon branch in CI is several × slower per round-trip,
  // so it needs more than the 15s default to avoid a latency-only timeout.
}, 30_000)

test('hardDeleteFolderAsAdmin also purges a document soft-deleted individually inside the subtree', async () => {
  // The correlation-id edge case: a document binned on its own keeps a different
  // correlation id yet still physically lives in the folder. A purge-by-subtree
  // must sweep it too, or its `restrict` FK would block the folder delete.
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const root = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const stray = await insertDocumentInFolder(ownerId, root.id, 'stray.pdf')

  // Bin the document on its own first, then the folder.
  await documentService.softDelete({
    id: stray.document.id,
    actingUserId: adminId,
    actingUserRole: 'admin',
  })
  await softDeleteFolderAsAdmin({ id: root.id, actorId: adminId, actorRole: 'admin' })

  const result = await hardDeleteFolderAsAdmin({
    id: root.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  expect(result.documentsPurged).toBe(1)
  expect(await findFolderById(root.id)).toBeNull()
  const [fileRow] = await db.select({ id: file.id }).from(file).where(eq(file.id, stray.file.id))
  expect(fileRow).toBeUndefined()
})

test('hardDeleteFolderAsAdmin by non-admin raises NOT_ADMIN', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  await softDeleteFolderAsAdmin({ id: f.id, actorId: adminId, actorRole: 'admin' })
  await expect(
    hardDeleteFolderAsAdmin({ id: f.id, actorId: adminId, actorRole: 'user' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NOT_ADMIN' })
})

test('hardDeleteFolderAsAdmin on a missing folder raises NOT_FOUND', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  await expect(
    hardDeleteFolderAsAdmin({ id: MISSING_ID, actorId: adminId, actorRole: 'admin' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NOT_FOUND' })
})

test('hardDeleteFolderAsAdmin on a live (not-binned) folder raises NOT_DELETED', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const f = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  await expect(
    hardDeleteFolderAsAdmin({ id: f.id, actorId: adminId, actorRole: 'admin' }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'NOT_DELETED' })
})

test('listChildren / listDescendants honor deletedAt IS NULL', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const root = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const live = await createFolder({ parentId: root.id, name: 'Engine', createdBy: adminId })
  const ghost = await createFolder({ parentId: root.id, name: 'Hull', createdBy: adminId })
  await db.update(folder).set({ deletedAt: new Date() }).where(eq(folder.id, ghost.id))

  const children = await listChildren(root.id)
  expect(children.map((c) => c.id)).toEqual([live.id])

  const desc = await listDescendants(root.id)
  expect(desc.map((c) => c.id).sort()).toEqual([root.id, live.id].sort())
})

test('listBin returns flat rows ordered by deletedAt DESC with correlationId', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const root = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  const doc = await insertDocumentInFolder(ownerId, root.id, 'oil.pdf')

  const del = await softDeleteFolderAsAdmin({
    id: root.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  const bin = await listBin()
  expect(bin.length).toBe(2)
  for (const entry of bin) {
    expect(entry.correlationId).toBe(del.correlationId)
  }
  const folderEntry = bin.find((e) => e.kind === 'folder')
  const docEntry = bin.find((e) => e.kind === 'document')
  expect(folderEntry?.id).toBe(root.id)
  expect(docEntry?.id).toBe(doc.document.id)
  // Document entries carry mime + extension so the bin UI can render type icons.
  expect(docEntry?.mime).toBe('application/pdf')
  expect(docEntry?.extension).toBe('pdf')

  // Sanity: file row survives soft-delete cascade (only document.deletedAt is set).
  const [fileRow] = await db.select({ id: file.id }).from(file).where(eq(file.id, doc.file.id))
  expect(fileRow).toBeDefined()
  // Sanity: document.deletedAt is set, file.deletedAt is not.
  const [docRow] = await db.select().from(document).where(eq(document.id, doc.document.id))
  expect(docRow.deletedAt).not.toBeNull()
})

test('softDeleteFolderAsAdmin does not over-match siblings via LIKE wildcards in folder names', async () => {
  // Regression: a folder named with a LIKE wildcard ('_' matches any single
  // char) must not cause the subtree `path LIKE` query to cascade into an
  // unrelated sibling. Without escaping, `/My_Docs/%` would match `/MyXDocs/`.
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const target = await createFolder({ parentId: null, name: 'My_Docs', createdBy: adminId })
  const sibling = await createFolder({ parentId: null, name: 'MyXDocs', createdBy: adminId })

  const result = await softDeleteFolderAsAdmin({
    id: target.id,
    actorId: adminId,
    actorRole: 'admin',
  })

  expect(result.foldersAffected).toBe(1)
  expect((await findFolderById(target.id))?.deletedAt).not.toBeNull()
  expect((await findActiveFolderById(sibling.id))?.deletedAt).toBeNull()
})

test('renameFolderAsAdmin does not rewrite a prefix-sibling folder', async () => {
  // Regression for the classic denormalized-path bug: `/Eng/` must not be
  // treated as a prefix of `/Engineering/`. The trailing slash on path is what
  // makes `LIKE '/Eng/%'` exclude `/Engineering/`.
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const eng = await createFolder({ parentId: null, name: 'Eng', createdBy: adminId })
  const engineering = await createFolder({
    parentId: null,
    name: 'Engineering',
    createdBy: adminId,
  })

  await renameFolderAsAdmin({ id: eng.id, newName: 'Engine', actorId: adminId, actorRole: 'admin' })

  expect((await findActiveFolderById(eng.id))?.path).toBe('/Engine/')
  expect((await findActiveFolderById(engineering.id))?.path).toBe('/Engineering/')
})

test('listTree returns all active folders ordered by path, excluding deleted', async () => {
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const manuals = await createFolder({ parentId: null, name: 'Manuals', createdBy: adminId })
  await createFolder({ parentId: manuals.id, name: 'Engine', createdBy: adminId })
  await createFolder({ parentId: null, name: 'Archive', createdBy: adminId })
  const ghost = await createFolder({ parentId: null, name: 'Ghost', createdBy: adminId })
  await db.update(folder).set({ deletedAt: new Date() }).where(eq(folder.id, ghost.id))

  const tree = await listTree()
  expect(tree.map((f) => f.path)).toEqual(['/Archive/', '/Manuals/', '/Manuals/Engine/'])
})

test('restoreByCorrelationAsAdmin rejects PARENT_DELETED when the subtree root parent is still deleted', async () => {
  // Selective restore: delete an inner subtree (batch X), then its parent
  // (batch Y); restoring only X would orphan the inner folders under a deleted
  // parent. The guard must reject it.
  const adminId = await insertMember('admin@test.oceanview.local', 'Admin', 'admin')
  const root = await createFolder({ parentId: null, name: 'Root', createdBy: adminId })
  const inner = await createFolder({ parentId: root.id, name: 'Inner', createdBy: adminId })

  const batchX = await softDeleteFolderAsAdmin({
    id: inner.id,
    actorId: adminId,
    actorRole: 'admin',
  })
  await softDeleteFolderAsAdmin({ id: root.id, actorId: adminId, actorRole: 'admin' })

  await expect(
    restoreByCorrelationAsAdmin({
      correlationId: batchX.correlationId,
      actorId: adminId,
      actorRole: 'admin',
    }),
  ).rejects.toMatchObject({ name: 'FolderDomainError', code: 'PARENT_DELETED' })
})

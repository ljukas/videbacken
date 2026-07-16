import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { document, documentEvent, file, folder, user } from '~/lib/db/schema'
import type { FileRow } from '~/lib/services/file'
import { joinFilename, splitExtension } from '~/utils/filename'
import { DocumentDomainError } from './errors'

/**
 * Drizzle's tx handle exposes the same query API as the root `db`; the union
 * keeps services composable so a caller can run a sequence of writes (e.g.
 * folder rename + document haystack recompute) inside one transaction.
 */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export type DocumentRow = {
  id: string
  fileId: string
  name: string
  extension: string | null
  folderId: string | null
  thumbnailPathname: string | null
  searchHaystack: string
  deletedAt: Date | null
}

export type DocumentWithFile = {
  document: DocumentRow
  file: FileRow
}

export type DocumentListRow = DocumentWithFile & { ownerName: string }

export type ConfirmDocumentUploadInput = {
  ownerId: string
  pathname: string
  name: string
  mime: string
  sizeBytes: number
  folderId?: string | null
}

const documentColumns = {
  id: document.id,
  fileId: document.fileId,
  name: document.name,
  extension: document.extension,
  folderId: document.folderId,
  thumbnailPathname: document.thumbnailPathname,
  searchHaystack: document.searchHaystack,
  deletedAt: document.deletedAt,
}

const fileColumns = {
  id: file.id,
  ownerId: file.ownerId,
  pathname: file.pathname,
  mime: file.mime,
  sizeBytes: file.sizeBytes,
  access: file.access,
  blurhash: file.blurhash,
  transcodeFailedAt: file.transcodeFailedAt,
  uploadedAt: file.uploadedAt,
  deletedAt: file.deletedAt,
}

// Haystack is stored lowercased so pg_trgm's case-sensitive trigrams hit
// case-insensitively when the search service also lowercases the query. Don't
// strip diacritics — Phase 2 leaves that to pg_trgm's own behaviour.
// `displayName` is the full filename (base + extension) so a search for the
// extension (e.g. "pdf") still matches.
function computeHaystack(folderPath: string | null, displayName: string): string {
  return (folderPath ? `${folderPath} ${displayName}` : displayName).toLowerCase()
}

async function loadActiveFolder(
  tx: DbOrTx,
  folderId: string,
): Promise<{ name: string; path: string }> {
  const [row] = await tx
    .select({ name: folder.name, path: folder.path, deletedAt: folder.deletedAt })
    .from(folder)
    .where(eq(folder.id, folderId))
    .limit(1)
  if (!row) throw new DocumentDomainError('FOLDER_NOT_FOUND')
  if (row.deletedAt) throw new DocumentDomainError('FOLDER_DELETED')
  return { name: row.name, path: row.path }
}

/**
 * Unguarded folder name lookup for audit labels (move events). Returns null for
 * a missing folder rather than throwing — the source folder of an active
 * document is always active, but a label lookup must never block the move.
 */
async function loadFolderName(tx: DbOrTx, folderId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: folder.name })
    .from(folder)
    .where(eq(folder.id, folderId))
    .limit(1)
  return row?.name ?? null
}

export async function findById(id: string): Promise<DocumentWithFile | null> {
  const [row] = await db
    .select({ document: documentColumns, file: fileColumns })
    .from(document)
    .innerJoin(file, eq(document.fileId, file.id))
    .where(eq(document.id, id))
    .limit(1)
  return row ?? null
}

export async function findActiveById(id: string): Promise<DocumentWithFile | null> {
  const row = await findById(id)
  if (!row || row.document.deletedAt) return null
  return row
}

export async function confirmUpload(
  input: ConfirmDocumentUploadInput & { actorId?: string },
): Promise<DocumentWithFile> {
  return db.transaction(async (tx) => {
    const folderPath = input.folderId ? (await loadActiveFolder(tx, input.folderId)).path : null
    // Split the uploaded filename so the extension lives in its own column and
    // can't be altered by a later rename. `input.name` is the full filename.
    const { base, extension } = splitExtension(input.name)

    const [fileRow] = await tx
      .insert(file)
      .values({
        ownerId: input.ownerId,
        pathname: input.pathname,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        access: 'private',
      })
      .returning(fileColumns)

    const [documentRow] = await tx
      .insert(document)
      .values({
        fileId: fileRow.id,
        name: base,
        extension,
        folderId: input.folderId ?? null,
        searchHaystack: computeHaystack(folderPath, input.name),
      })
      .returning(documentColumns)

    await tx.insert(documentEvent).values({
      documentId: documentRow.id,
      actorId: input.actorId ?? input.ownerId,
      kind: 'upload',
      toValue: { name: input.name, folderId: input.folderId ?? null },
    })

    return { document: documentRow, file: fileRow }
  })
}

/**
 * Active documents in a single folder, newest first. `folderId === null` lists
 * the virtual root (documents with no folder). Served by `document_folder_id_idx`
 * with a heap recheck of the `deleted_at IS NULL` predicate.
 */
export async function listDocumentsByFolderId(
  folderId: string | null,
): Promise<Array<DocumentListRow>> {
  const rows = await db
    .select({
      document: documentColumns,
      file: fileColumns,
      ownerName: user.name,
    })
    .from(document)
    .innerJoin(file, eq(document.fileId, file.id))
    .innerJoin(user, eq(file.ownerId, user.id))
    .where(
      and(
        folderId === null ? isNull(document.folderId) : eq(document.folderId, folderId),
        isNull(document.deletedAt),
      ),
    )
    .orderBy(desc(file.uploadedAt))
  return rows
}

export async function renameDocument(input: {
  id: string
  newName: string
  actorId: string
  actorRole: string | null
}): Promise<DocumentWithFile> {
  return db.transaction(async (tx) => {
    const target = await loadActiveForEdit(tx, input.id, input.actorId, input.actorRole)
    const folderPath = target.document.folderId
      ? (await loadActiveFolder(tx, target.document.folderId)).path
      : null
    // The extension is immutable: rename only touches the base name. The
    // display name (base + existing extension) feeds the haystack and events.
    const extension = target.document.extension
    const newName = input.newName.trim()
    const fromDisplay = joinFilename(target.document)
    const toDisplay = joinFilename({ name: newName, extension })
    const [updated] = await tx
      .update(document)
      .set({
        name: newName,
        searchHaystack: computeHaystack(folderPath, toDisplay),
      })
      .where(eq(document.id, input.id))
      .returning(documentColumns)
    await tx.insert(documentEvent).values({
      documentId: input.id,
      actorId: input.actorId,
      kind: 'rename',
      fromValue: { name: fromDisplay },
      toValue: { name: toDisplay },
    })
    return { document: updated, file: target.file }
  })
}

export async function moveDocument(input: {
  id: string
  newFolderId: string | null
  actorId: string
  actorRole: string | null
}): Promise<DocumentWithFile> {
  return db.transaction(async (tx) => {
    const target = await loadActiveForEdit(tx, input.id, input.actorId, input.actorRole)
    // Snapshot folder names into the event so history can render "from → to"
    // even after a folder is later renamed or deleted (mirrors rename's name
    // snapshot). null name = the virtual root.
    const fromName = target.document.folderId
      ? await loadFolderName(tx, target.document.folderId)
      : null
    const dest = input.newFolderId ? await loadActiveFolder(tx, input.newFolderId) : null
    const [updated] = await tx
      .update(document)
      .set({
        folderId: input.newFolderId,
        searchHaystack: computeHaystack(dest?.path ?? null, joinFilename(target.document)),
      })
      .where(eq(document.id, input.id))
      .returning(documentColumns)
    await tx.insert(documentEvent).values({
      documentId: input.id,
      actorId: input.actorId,
      kind: 'move',
      fromValue: { folderId: target.document.folderId, name: fromName },
      toValue: { folderId: input.newFolderId, name: dest?.name ?? null },
    })
    return { document: updated, file: target.file }
  })
}

export async function softDelete(input: {
  id: string
  actingUserId: string
  actingUserRole: string | null
}): Promise<DocumentWithFile> {
  return db.transaction(async (tx) => {
    const target = await loadById(tx, input.id)
    if (!target) throw new DocumentDomainError('NOT_FOUND')
    // Authorize before the idempotent short-circuit: otherwise a non-owner
    // could probe an already-deleted document and receive its file metadata.
    if (input.actingUserRole !== 'admin' && target.file.ownerId !== input.actingUserId) {
      throw new DocumentDomainError('CANNOT_DELETE_OTHERS_DOCUMENT')
    }
    if (target.document.deletedAt) return target
    const [row] = await tx
      .update(document)
      .set({ deletedAt: new Date() })
      .where(eq(document.id, input.id))
      .returning(documentColumns)
    await tx.insert(documentEvent).values({
      documentId: input.id,
      actorId: input.actingUserId,
      kind: 'soft_delete',
      toValue: { name: joinFilename(target.document) },
    })
    return { document: row, file: target.file }
  })
}

export async function restoreDocument(input: {
  id: string
  actorId: string
  actorRole: string | null
}): Promise<DocumentWithFile> {
  if (input.actorRole !== 'admin') throw new DocumentDomainError('NOT_ADMIN')
  return db.transaction(async (tx) => {
    const target = await loadById(tx, input.id)
    if (!target) throw new DocumentDomainError('NOT_FOUND')
    if (!target.document.deletedAt) throw new DocumentDomainError('NOT_DELETED')
    const [row] = await tx
      .update(document)
      .set({ deletedAt: null })
      .where(eq(document.id, input.id))
      .returning(documentColumns)
    await tx.insert(documentEvent).values({
      documentId: input.id,
      actorId: input.actorId,
      kind: 'restore',
    })
    return { document: row, file: target.file }
  })
}

export async function hardDeleteDocument(input: {
  id: string
  actorId: string
  actorRole: string | null
}): Promise<{ pathname: string; thumbnailPathname: string | null }> {
  if (input.actorRole !== 'admin') throw new DocumentDomainError('NOT_ADMIN')
  return db.transaction(async (tx) => {
    const target = await loadById(tx, input.id)
    if (!target) throw new DocumentDomainError('NOT_FOUND')
    // Hard-delete is a bin-only operation: the document must already be
    // soft-deleted. Guards the soft-delete → bin → hard-delete workflow so an
    // admin can't permanently destroy a live document in one step.
    if (!target.document.deletedAt) throw new DocumentDomainError('NOT_DELETED')
    // Write the audit row BEFORE the delete: the FK `ON DELETE SET NULL`
    // nulls the document_id, but the toValue payload preserves identity.
    await tx.insert(documentEvent).values({
      documentId: input.id,
      actorId: input.actorId,
      kind: 'hard_delete',
      toValue: { name: joinFilename(target.document), pathname: target.file.pathname },
    })
    // Delete the file; cascade removes the document row.
    await tx.delete(file).where(eq(file.id, target.file.id))
    return {
      pathname: target.file.pathname,
      thumbnailPathname: target.document.thumbnailPathname,
    }
  })
}

/**
 * Bulk-rewrite the denormalized `search_haystack` for every active document
 * whose folder belongs to the given subtree. Used by folderService after a
 * rename/move that changed folder paths. Accepts a tx handle so it runs inside
 * the caller's transaction — folder bookkeeping + document haystacks must
 * commit together to preserve the haystack invariant.
 */
export async function recomputeSearchHaystack(
  input: { folderIds: string[] },
  tx: DbOrTx = db,
): Promise<void> {
  if (input.folderIds.length === 0) return
  await tx
    .update(document)
    .set({
      // Mirrors computeHaystack over the display name: lower(path || ' ' ||
      // name [|| '.' || extension]). Keeping the SQL form here so the bulk
      // join doesn't pull rows into JS.
      searchHaystack: sql`lower(${folder.path} || ' ' || ${document.name} || case when ${document.extension} is null then '' else '.' || ${document.extension} end)`,
    })
    .from(folder)
    .where(
      and(
        eq(document.folderId, folder.id),
        inArray(folder.id, input.folderIds),
        isNull(document.deletedAt),
      ),
    )
}

/**
 * Mark a set of documents as soft-deleted inside an existing transaction.
 * Used by folderService cascade soft-delete. Each affected document gets a
 * `soft_delete` event row sharing the caller's correlationId.
 */
export async function cascadeSoftDelete(
  input: { documentIds: string[]; actorId: string; correlationId: string },
  tx: DbOrTx,
): Promise<Array<{ id: string; name: string }>> {
  if (input.documentIds.length === 0) return []
  const affected = await tx
    .update(document)
    .set({ deletedAt: new Date() })
    .where(and(inArray(document.id, input.documentIds), isNull(document.deletedAt)))
    .returning({ id: document.id, name: document.name, extension: document.extension })
  if (affected.length === 0) return []
  await tx.insert(documentEvent).values(
    affected.map((row) => ({
      documentId: row.id,
      actorId: input.actorId,
      kind: 'soft_delete' as const,
      toValue: { name: joinFilename(row) },
      correlationId: input.correlationId,
    })),
  )
  return affected.map((row) => ({ id: row.id, name: joinFilename(row) }))
}

/**
 * Inverse of cascadeSoftDelete; clears deletedAt for the given documents and
 * emits restore events sharing the caller's new correlationId.
 */
export async function cascadeRestore(
  input: { documentIds: string[]; actorId: string; correlationId: string },
  tx: DbOrTx,
): Promise<Array<{ id: string }>> {
  if (input.documentIds.length === 0) return []
  // Symmetric with cascadeSoftDelete's isNull guard: only flip currently-deleted
  // rows so a repeated restore is a no-op and doesn't emit phantom events.
  const affected = await tx
    .update(document)
    .set({ deletedAt: null })
    .where(and(inArray(document.id, input.documentIds), isNotNull(document.deletedAt)))
    .returning({ id: document.id })
  if (affected.length === 0) return []
  await tx.insert(documentEvent).values(
    affected.map((row) => ({
      documentId: row.id,
      actorId: input.actorId,
      kind: 'restore' as const,
      correlationId: input.correlationId,
    })),
  )
  return affected
}

export async function setThumbnailPathname(input: {
  documentId: string
  pathname: string
}): Promise<void> {
  await db
    .update(document)
    .set({ thumbnailPathname: input.pathname })
    .where(and(eq(document.id, input.documentId), isNull(document.deletedAt)))
}

async function loadById(tx: DbOrTx, id: string): Promise<DocumentWithFile | null> {
  const [row] = await tx
    .select({ document: documentColumns, file: fileColumns })
    .from(document)
    .innerJoin(file, eq(document.fileId, file.id))
    .where(eq(document.id, id))
    .limit(1)
  return row ?? null
}

async function loadActiveForEdit(
  tx: DbOrTx,
  id: string,
  actorId: string,
  actorRole: string | null,
): Promise<DocumentWithFile> {
  const target = await loadById(tx, id)
  if (!target || target.document.deletedAt) throw new DocumentDomainError('NOT_FOUND')
  if (actorRole !== 'admin' && target.file.ownerId !== actorId) {
    throw new DocumentDomainError('CANNOT_EDIT_OTHERS_DOCUMENT')
  }
  return target
}

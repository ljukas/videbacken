import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, like, ne, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { document, documentEvent, file, folder, folderEvent } from '~/lib/db/schema'
import * as documentService from '~/lib/services/document'
import { joinFilename } from '~/utils/filename'
import { FolderDomainError } from './errors'

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

// Build a LIKE pattern that matches a folder path and all its descendants,
// escaping the literal prefix so user-typed folder names containing LIKE
// wildcards (`%`, `_`, or a literal `\`) match literally instead of as
// patterns. Postgres LIKE's default escape char is `\`. Folder names legitimately
// contain underscores, so escaping — not rejecting — is the correct fix.
function descendantLikePattern(path: string): string {
  return `${path.replace(/[\\%_]/g, '\\$&')}%`
}

export type FolderRow = {
  id: string
  parentId: string | null
  name: string
  path: string
  searchHaystack: string
  createdBy: string
  createdAt: Date
  deletedAt: Date | null
}

export type BinEntry = {
  kind: 'folder' | 'document'
  id: string
  name: string
  path: string | null
  deletedAt: Date
  correlationId: string | null
  mime: string | null
  extension: string | null
}

export type SoftDeleteResult = {
  correlationId: string
  foldersAffected: number
  documentsAffected: number
}

export type RestoreResult = {
  restoreCorrelationId: string
  foldersRestored: number
  documentsRestored: number
}

const folderColumns = {
  id: folder.id,
  parentId: folder.parentId,
  name: folder.name,
  path: folder.path,
  searchHaystack: folder.searchHaystack,
  createdBy: folder.createdBy,
  createdAt: folder.createdAt,
  deletedAt: folder.deletedAt,
}

// Sentinel: root is virtual (no row). Its "path" for child computation is '/'.
const ROOT_PATH = '/'

// Pre-check for a name collision among the active siblings of `parentId`.
// Mirrors the rest of the service layer (share.ts, user.ts), which validate
// invariants with a SELECT and raise a typed error before writing rather than
// decoding Postgres constraint violations after the fact. The partial unique
// index `folder_unique_name_per_parent_idx` stays as a DB-level backstop for
// the (vanishingly rare, single-boat-club-scale) concurrent-insert race.
async function nameClashExists(
  tx: DbOrTx,
  parentId: string | null,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const [clash] = await tx
    .select({ id: folder.id })
    .from(folder)
    .where(
      and(
        parentId === null ? isNull(folder.parentId) : eq(folder.parentId, parentId),
        eq(folder.name, name),
        isNull(folder.deletedAt),
        excludeId ? ne(folder.id, excludeId) : undefined,
      ),
    )
    .limit(1)
  return clash !== undefined
}

function validateNameOrThrow(name: string): void {
  if (name.length === 0 || name.includes('/')) {
    throw new FolderDomainError('INVALID_NAME')
  }
}

export async function findFolderById(id: string): Promise<FolderRow | null> {
  const [row] = await db.select(folderColumns).from(folder).where(eq(folder.id, id)).limit(1)
  return row ?? null
}

export async function findActiveFolderById(id: string): Promise<FolderRow | null> {
  const row = await findFolderById(id)
  if (!row || row.deletedAt) return null
  return row
}

export async function listChildren(parentId: string | null): Promise<Array<FolderRow>> {
  return db
    .select(folderColumns)
    .from(folder)
    .where(
      and(
        parentId === null ? isNull(folder.parentId) : eq(folder.parentId, parentId),
        isNull(folder.deletedAt),
      ),
    )
    .orderBy(folder.name)
}

export async function listDescendants(folderId: string): Promise<Array<FolderRow>> {
  const target = await findActiveFolderById(folderId)
  if (!target) return []
  return db
    .select(folderColumns)
    .from(folder)
    .where(and(like(folder.path, descendantLikePattern(target.path)), isNull(folder.deletedAt)))
    .orderBy(folder.path)
}

// Every active folder, ordered by path so a caller can build the whole tree in
// one pass (the denormalized path encodes ancestry). Used by the tree procedure.
export async function listTree(): Promise<Array<FolderRow>> {
  return db.select(folderColumns).from(folder).where(isNull(folder.deletedAt)).orderBy(folder.path)
}

export async function createFolder(input: {
  parentId: string | null
  name: string
  createdBy: string
}): Promise<FolderRow> {
  validateNameOrThrow(input.name)

  return db.transaction(async (tx) => {
    let parentPath = ROOT_PATH
    if (input.parentId !== null) {
      const [parent] = await tx
        .select({ path: folder.path, deletedAt: folder.deletedAt })
        .from(folder)
        .where(eq(folder.id, input.parentId))
        .limit(1)
      if (!parent || parent.deletedAt) throw new FolderDomainError('PARENT_NOT_FOUND')
      parentPath = parent.path
    }

    const path = `${parentPath}${input.name}/`
    // Lowercased on write so pg_trgm hits case-insensitively (see
    // documentService.computeHaystack — same convention).
    const searchHaystack = `${path} ${input.name}`.toLowerCase()

    if (await nameClashExists(tx, input.parentId, input.name)) {
      throw new FolderDomainError('NAME_TAKEN_IN_PARENT')
    }

    const [row] = await tx
      .insert(folder)
      .values({
        parentId: input.parentId,
        name: input.name,
        path,
        searchHaystack,
        createdBy: input.createdBy,
      })
      .returning(folderColumns)

    await tx.insert(folderEvent).values({
      folderId: row.id,
      actorId: input.createdBy,
      kind: 'create',
      toValue: { name: row.name, parentId: row.parentId, path: row.path },
    })

    return row
  })
}

export async function renameFolderAsAdmin(input: {
  id: string
  newName: string
  actorId: string
  actorRole: string | null
}): Promise<FolderRow> {
  if (input.actorRole !== 'admin') throw new FolderDomainError('NOT_ADMIN')
  validateNameOrThrow(input.newName)

  return db.transaction(async (tx) => {
    const target = await loadActiveFolderInTx(tx, input.id)
    if (target.name === input.newName) return target

    const parentPath = parentPathOf(target.path, target.name)
    const newOwnPath = `${parentPath}${input.newName}/`
    const oldOwnPath = target.path

    if (await nameClashExists(tx, target.parentId, input.newName, target.id)) {
      throw new FolderDomainError('NAME_TAKEN_IN_PARENT')
    }

    const descendantIds = await rewriteSubtreePaths(tx, {
      targetId: target.id,
      oldOwnPath,
      newOwnPath,
      newOwnName: input.newName,
    })

    await documentService.recomputeSearchHaystack({ folderIds: [target.id, ...descendantIds] }, tx)

    await tx.insert(folderEvent).values({
      folderId: target.id,
      actorId: input.actorId,
      kind: 'rename',
      fromValue: { name: target.name, path: target.path },
      toValue: { name: input.newName, path: newOwnPath },
    })

    return await loadActiveFolderInTx(tx, target.id)
  })
}

export async function moveFolderAsAdmin(input: {
  id: string
  newParentId: string | null
  actorId: string
  actorRole: string | null
}): Promise<FolderRow> {
  if (input.actorRole !== 'admin') throw new FolderDomainError('NOT_ADMIN')

  return db.transaction(async (tx) => {
    const target = await loadActiveFolderInTx(tx, input.id)

    let newParentPath = ROOT_PATH
    if (input.newParentId !== null) {
      if (input.newParentId === target.id) {
        throw new FolderDomainError('CANNOT_MOVE_INTO_DESCENDANT')
      }
      const [parent] = await tx
        .select({ path: folder.path, deletedAt: folder.deletedAt })
        .from(folder)
        .where(eq(folder.id, input.newParentId))
        .limit(1)
      if (!parent || parent.deletedAt) throw new FolderDomainError('PARENT_NOT_FOUND')
      // Moving into own subtree?
      if (parent.path.startsWith(target.path)) {
        throw new FolderDomainError('CANNOT_MOVE_INTO_DESCENDANT')
      }
      newParentPath = parent.path
    }

    if (target.parentId === input.newParentId) return target

    if (await nameClashExists(tx, input.newParentId, target.name, target.id)) {
      throw new FolderDomainError('NAME_TAKEN_IN_PARENT')
    }

    const newOwnPath = `${newParentPath}${target.name}/`
    const oldOwnPath = target.path

    const descendantIds = await rewriteSubtreePaths(tx, {
      targetId: target.id,
      oldOwnPath,
      newOwnPath,
      newOwnName: target.name,
      newParentId: input.newParentId,
    })

    await documentService.recomputeSearchHaystack({ folderIds: [target.id, ...descendantIds] }, tx)

    await tx.insert(folderEvent).values({
      folderId: target.id,
      actorId: input.actorId,
      kind: 'move',
      fromValue: { parentId: target.parentId, path: target.path },
      toValue: { parentId: input.newParentId, path: newOwnPath },
    })

    return await loadActiveFolderInTx(tx, target.id)
  })
}

export async function softDeleteFolderAsAdmin(input: {
  id: string
  actorId: string
  actorRole: string | null
}): Promise<SoftDeleteResult> {
  if (input.actorRole !== 'admin') throw new FolderDomainError('NOT_ADMIN')

  return db.transaction(async (tx) => {
    const target = await loadActiveFolderInTx(tx, input.id)
    const correlationId = randomUUID()

    const subtree = await tx
      .select({ id: folder.id, name: folder.name, path: folder.path })
      .from(folder)
      .where(
        and(
          sql`(${folder.id} = ${target.id} OR ${folder.path} LIKE ${descendantLikePattern(target.path)})`,
          isNull(folder.deletedAt),
        ),
      )
    const subtreeIds = subtree.map((row) => row.id)

    const documentIds = (
      await tx
        .select({ id: document.id })
        .from(document)
        .where(and(inArray(document.folderId, subtreeIds), isNull(document.deletedAt)))
    ).map((row) => row.id)

    await tx
      .update(folder)
      .set({ deletedAt: new Date() })
      .where(and(inArray(folder.id, subtreeIds), isNull(folder.deletedAt)))

    await tx.insert(folderEvent).values(
      subtree.map((row) => ({
        folderId: row.id,
        actorId: input.actorId,
        kind: 'soft_delete' as const,
        toValue: { name: row.name, path: row.path },
        correlationId,
      })),
    )

    const docsAffected = await documentService.cascadeSoftDelete(
      { documentIds, actorId: input.actorId, correlationId },
      tx,
    )

    return {
      correlationId,
      foldersAffected: subtree.length,
      documentsAffected: docsAffected.length,
    }
  })
}

export async function restoreByCorrelationAsAdmin(input: {
  correlationId: string
  actorId: string
  actorRole: string | null
}): Promise<RestoreResult> {
  if (input.actorRole !== 'admin') throw new FolderDomainError('NOT_ADMIN')

  return db.transaction(async (tx) => {
    const folderIds = (
      await tx
        .select({ folderId: folderEvent.folderId })
        .from(folderEvent)
        .where(
          and(
            eq(folderEvent.correlationId, input.correlationId),
            eq(folderEvent.kind, 'soft_delete'),
          ),
        )
    )
      .map((row) => row.folderId)
      .filter((id): id is string => id !== null)

    const documentIds = (
      await tx
        .select({ documentId: documentEvent.documentId })
        .from(documentEvent)
        .where(
          and(
            eq(documentEvent.correlationId, input.correlationId),
            eq(documentEvent.kind, 'soft_delete'),
          ),
        )
    )
      .map((row) => row.documentId)
      .filter((id): id is string => id !== null)

    const restoreCorrelationId = randomUUID()

    // Restoring re-activates rows; if a sibling reused a deleted folder's name
    // while it was in the bin, restoring would resurrect a duplicate. Check
    // each restoring folder against the currently-active siblings first.
    if (folderIds.length > 0) {
      const restoring = await tx
        .select({ id: folder.id, parentId: folder.parentId, name: folder.name })
        .from(folder)
        .where(inArray(folder.id, folderIds))
      for (const f of restoring) {
        if (await nameClashExists(tx, f.parentId, f.name, f.id)) {
          throw new FolderDomainError('NAME_TAKEN_IN_PARENT')
        }
      }

      // Orphaned-parent guard: a subtree root in this batch (parent not also
      // being restored) must land under an active parent. Otherwise a selective
      // restore — inner batch restored while a later batch still has the parent
      // deleted — would resurrect folders unreachable via tree traversal.
      const restoreSet = new Set(folderIds)
      const rootParentIds = restoring
        .map((f) => f.parentId)
        .filter((pid): pid is string => pid !== null && !restoreSet.has(pid))
      if (rootParentIds.length > 0) {
        const activeParents = await tx
          .select({ id: folder.id })
          .from(folder)
          .where(and(inArray(folder.id, rootParentIds), isNull(folder.deletedAt)))
        const activeParentIds = new Set(activeParents.map((row) => row.id))
        for (const pid of rootParentIds) {
          if (!activeParentIds.has(pid)) throw new FolderDomainError('PARENT_DELETED')
        }
      }
    }

    let foldersRestored = 0
    if (folderIds.length > 0) {
      // `isNotNull` guard so re-running a restore is a true no-op: without it
      // RETURNING yields already-active rows and we'd emit phantom restore events.
      const affected = await tx
        .update(folder)
        .set({ deletedAt: null })
        .where(and(inArray(folder.id, folderIds), isNotNull(folder.deletedAt)))
        .returning({ id: folder.id })
      foldersRestored = affected.length

      if (affected.length > 0) {
        await tx.insert(folderEvent).values(
          affected.map((row) => ({
            folderId: row.id,
            actorId: input.actorId,
            kind: 'restore' as const,
            correlationId: restoreCorrelationId,
          })),
        )
      }
    }

    const docsAffected = await documentService.cascadeRestore(
      { documentIds, actorId: input.actorId, correlationId: restoreCorrelationId },
      tx,
    )

    return {
      restoreCorrelationId,
      foldersRestored,
      documentsRestored: docsAffected.length,
    }
  })
}

export type HardDeleteResult = {
  privatePathnames: Array<string>
  publicPathnames: Array<string>
  foldersPurged: number
  documentsPurged: number
  correlationId: string
}

// Permanently purge a soft-deleted folder and its entire physical subtree —
// every descendant folder plus every document inside them. Operates on the
// physical subtree (path prefix), NOT the soft-delete correlationId: a document
// soft-deleted individually keeps its own correlation id yet still lives inside
// the folder, and its `restrict` FK would block the folder delete. Returns the
// blob pathnames so the caller can drop bytes after the tx commits (mirrors
// documentService.hardDeleteDocument).
export async function hardDeleteFolderAsAdmin(input: {
  id: string
  actorId: string
  actorRole: string | null
}): Promise<HardDeleteResult> {
  if (input.actorRole !== 'admin') throw new FolderDomainError('NOT_ADMIN')

  return db.transaction(async (tx) => {
    const [target] = await tx
      .select(folderColumns)
      .from(folder)
      .where(eq(folder.id, input.id))
      .limit(1)
    if (!target) throw new FolderDomainError('NOT_FOUND')
    // Bin-only operation: refuse to purge a live folder in one step.
    if (!target.deletedAt) throw new FolderDomainError('NOT_DELETED')

    const subtree = await tx
      .select({ id: folder.id, name: folder.name, path: folder.path })
      .from(folder)
      .where(
        sql`(${folder.id} = ${target.id} OR ${folder.path} LIKE ${descendantLikePattern(target.path)})`,
      )
    const subtreeIds = subtree.map((row) => row.id)

    // Every document physically inside the subtree, regardless of correlation id
    // or deletedAt — joined to file for the blob pathnames.
    const docs = await tx
      .select({
        id: document.id,
        fileId: document.fileId,
        name: document.name,
        extension: document.extension,
        pathname: file.pathname,
        thumbnailPathname: document.thumbnailPathname,
      })
      .from(document)
      .innerJoin(file, eq(document.fileId, file.id))
      .where(inArray(document.folderId, subtreeIds))

    const correlationId = randomUUID()

    // Write audit rows BEFORE deleting: both event tables FK with ON DELETE SET
    // NULL, so the *_id is nulled but the toValue payload preserves identity.
    if (docs.length > 0) {
      await tx.insert(documentEvent).values(
        docs.map((d) => ({
          documentId: d.id,
          actorId: input.actorId,
          kind: 'hard_delete' as const,
          toValue: { name: joinFilename(d), pathname: d.pathname },
          correlationId,
        })),
      )
    }
    await tx.insert(folderEvent).values(
      subtree.map((row) => ({
        folderId: row.id,
        actorId: input.actorId,
        kind: 'hard_delete' as const,
        toValue: { name: row.name, path: row.path },
        correlationId,
      })),
    )

    // Delete documents first (their `restrict` FK to folder would otherwise
    // block the folder delete): drop the file rows, cascade removes documents.
    const fileIds = docs.map((d) => d.fileId)
    if (fileIds.length > 0) {
      await tx.delete(file).where(inArray(file.id, fileIds))
    }

    // Then delete folders leaf-first: `parentId` is ON DELETE RESTRICT, so a
    // parent can't be deleted before its children even within one statement.
    const ordered = [...subtree].sort((a, b) => b.path.split('/').length - a.path.split('/').length)
    for (const f of ordered) {
      await tx.delete(folder).where(eq(folder.id, f.id))
    }

    return {
      privatePathnames: docs.map((d) => d.pathname),
      publicPathnames: docs.map((d) => d.thumbnailPathname).filter((p): p is string => p !== null),
      foldersPurged: subtree.length,
      documentsPurged: docs.length,
      correlationId,
    }
  })
}

export async function listBin(): Promise<Array<BinEntry>> {
  const folders = await db
    .select({
      id: folder.id,
      name: folder.name,
      path: folder.path,
      deletedAt: folder.deletedAt,
    })
    .from(folder)
    .where(isNotNull(folder.deletedAt))

  const documents = await db
    .select({
      id: document.id,
      name: document.name,
      extension: document.extension,
      deletedAt: document.deletedAt,
      mime: file.mime,
    })
    .from(document)
    .innerJoin(file, eq(document.fileId, file.id))
    .where(isNotNull(document.deletedAt))

  const folderIds = folders.map((row) => row.id)
  const documentIds = documents.map((row) => row.id)

  // The correlation id of the batch that binned an entity lives only on its
  // soft_delete event. Fetch newest-first and take first-per-entity in the
  // maps below — DISTINCT ON in JS (newest row per entity). (inArray
  // over a single bound uuid[] param; raw ANY(${ids}) doesn't round-trip.)
  const folderEventRows = folderIds.length
    ? await db
        .select({ folderId: folderEvent.folderId, correlationId: folderEvent.correlationId })
        .from(folderEvent)
        .where(and(eq(folderEvent.kind, 'soft_delete'), inArray(folderEvent.folderId, folderIds)))
        .orderBy(desc(folderEvent.occurredAt))
    : []
  const documentEventRows = documentIds.length
    ? await db
        .select({
          documentId: documentEvent.documentId,
          correlationId: documentEvent.correlationId,
        })
        .from(documentEvent)
        .where(
          and(
            eq(documentEvent.kind, 'soft_delete'),
            inArray(documentEvent.documentId, documentIds),
          ),
        )
        .orderBy(desc(documentEvent.occurredAt))
    : []

  const folderCorrelationById = new Map<string, string | null>()
  for (const row of folderEventRows) {
    if (row.folderId && !folderCorrelationById.has(row.folderId)) {
      folderCorrelationById.set(row.folderId, row.correlationId)
    }
  }
  const documentCorrelationById = new Map<string, string | null>()
  for (const row of documentEventRows) {
    if (row.documentId && !documentCorrelationById.has(row.documentId)) {
      documentCorrelationById.set(row.documentId, row.correlationId)
    }
  }

  const entries: Array<BinEntry> = [
    ...folders.map((row) => ({
      kind: 'folder' as const,
      id: row.id,
      name: row.name,
      path: row.path,
      // biome-ignore lint/style/noNonNullAssertion: WHERE clause guarantees deletedAt is non-null
      deletedAt: row.deletedAt!,
      correlationId: folderCorrelationById.get(row.id) ?? null,
      mime: null,
      extension: null,
    })),
    ...documents.map((row) => ({
      kind: 'document' as const,
      id: row.id,
      name: joinFilename(row),
      path: null,
      // biome-ignore lint/style/noNonNullAssertion: WHERE clause guarantees deletedAt is non-null
      deletedAt: row.deletedAt!,
      correlationId: documentCorrelationById.get(row.id) ?? null,
      mime: row.mime,
      extension: row.extension,
    })),
  ]
  entries.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
  return entries
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function loadActiveFolderInTx(tx: DbOrTx, id: string): Promise<FolderRow> {
  const [row] = await tx.select(folderColumns).from(folder).where(eq(folder.id, id)).limit(1)
  if (!row) throw new FolderDomainError('NOT_FOUND')
  if (row.deletedAt) throw new FolderDomainError('ALREADY_DELETED')
  return row
}

/**
 * Derives the parent's path from a folder's own path + name. Example:
 *   path='/Manuals/Engine/', name='Engine' → '/Manuals/'.
 * The parent is virtual (root) when the result is '/'.
 */
function parentPathOf(ownPath: string, ownName: string): string {
  const segmentLen = ownName.length + 1 // '<name>/'
  return ownPath.slice(0, ownPath.length - segmentLen)
}

/**
 * Update the target folder's own row (name/parent/path/haystack) and rewrite
 * every descendant's path/haystack via a single prefix-substring SQL. Callers
 * pre-check name collisions (nameClashExists); this is pure path mechanics.
 * Returns the descendant folder ids so the caller can recompute document
 * haystacks within the same tx.
 */
async function rewriteSubtreePaths(
  tx: DbOrTx,
  input: {
    targetId: string
    oldOwnPath: string
    newOwnPath: string
    newOwnName: string
    newParentId?: string | null
  },
): Promise<Array<string>> {
  await tx
    .update(folder)
    .set({
      name: input.newOwnName,
      path: input.newOwnPath,
      searchHaystack: `${input.newOwnPath} ${input.newOwnName}`.toLowerCase(),
      ...(input.newParentId !== undefined ? { parentId: input.newParentId } : {}),
    })
    .where(eq(folder.id, input.targetId))

  if (input.oldOwnPath === input.newOwnPath) return []

  // Descendant path = newOwnPath || tail-after-oldOwnPath; haystack mirrors
  // the JS lowercasing above via SQL `lower()`. The `::int` cast is load-
  // bearing: postgres-js binds JS numbers as text by default, and `substring
  // (text FROM text)` is SQL-standard regex substring — it would return NULL
  // for every row instead of the position-based slice we want.
  const oldLen = input.oldOwnPath.length
  const rewriteExpr = sql`${input.newOwnPath} || substring(${folder.path} FROM (${oldLen + 1})::int)`
  const updated = await tx
    .update(folder)
    .set({
      path: rewriteExpr,
      searchHaystack: sql`lower(${rewriteExpr} || ' ' || ${folder.name})`,
    })
    .where(
      and(
        ne(folder.id, input.targetId),
        like(folder.path, descendantLikePattern(input.oldOwnPath)),
      ),
    )
    .returning({ id: folder.id })

  return updated.map((row) => row.id)
}

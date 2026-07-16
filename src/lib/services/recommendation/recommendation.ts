import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '~/lib/db'
import { file, recommendation, recommendationPhoto, recommendationTag, user } from '~/lib/db/schema'
import {
  MAX_PHOTOS,
  MIN_PHOTOS,
  RecommendationDomainError,
  type RecommendationDomainErrorCode,
} from './errors'

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface CreateRecommendationInput {
  authorId: string
  title: string
  description?: string | null
  lat: number
  lng: number
  tagIds: string[]
  photos: Array<{ pathname: string; mime: string; sizeBytes: number }>
}

export async function createRecommendation(
  input: CreateRecommendationInput,
): Promise<{ id: string; photoFileIds: string[] }> {
  if (input.photos.length < MIN_PHOTOS) throw new RecommendationDomainError('NO_PHOTOS')
  if (input.photos.length > MAX_PHOTOS) throw new RecommendationDomainError('TOO_MANY_PHOTOS')
  const pathnames = input.photos.map((p) => p.pathname)
  if (new Set(pathnames).size !== pathnames.length)
    throw new RecommendationDomainError('DUPLICATE_PHOTOS')
  if (new Set(input.tagIds).size !== input.tagIds.length)
    throw new RecommendationDomainError('DUPLICATE_TAGS')

  return db.transaction(async (tx) => {
    const [rec] = await tx
      .insert(recommendation)
      .values({
        authorId: input.authorId,
        title: input.title,
        description: input.description ?? null,
        lat: input.lat,
        lng: input.lng,
      })
      .returning({ id: recommendation.id })

    const photoFileIds: string[] = []
    for (const [index, p] of input.photos.entries()) {
      const [f] = await tx
        .insert(file)
        .values({
          ownerId: input.authorId,
          pathname: p.pathname,
          mime: p.mime,
          sizeBytes: p.sizeBytes,
          access: 'public',
        })
        .returning({ id: file.id })
      await tx
        .insert(recommendationPhoto)
        .values({ recommendationId: rec.id, fileId: f.id, sortOrder: index })
      photoFileIds.push(f.id)
    }

    if (input.tagIds.length > 0) {
      await tx
        .insert(recommendationTag)
        .values(input.tagIds.map((tagId) => ({ recommendationId: rec.id, tagId })))
    }

    return { id: rec.id, photoFileIds }
  })
}

export interface RecommendationListItem {
  id: string
  title: string
  description: string | null
  lat: number
  lng: number
  authorId: string | null
  authorName: string | null
  createdAt: Date
  updatedAt: Date
  photos: Array<{
    id: string
    fileId: string
    pathname: string
    mime: string
    blurhash: string | null
    transcodeFailedAt: Date | null
    sortOrder: number
  }>
  tagIds: string[]
}

async function assemble(
  rows: Array<{
    id: string
    title: string
    description: string | null
    lat: number
    lng: number
    authorId: string | null
    authorName: string | null
    createdAt: Date
    updatedAt: Date
  }>,
): Promise<RecommendationListItem[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)

  const photoRows = await db
    .select({
      id: recommendationPhoto.id,
      recommendationId: recommendationPhoto.recommendationId,
      fileId: recommendationPhoto.fileId,
      pathname: file.pathname,
      mime: file.mime,
      blurhash: file.blurhash,
      transcodeFailedAt: file.transcodeFailedAt,
      sortOrder: recommendationPhoto.sortOrder,
    })
    .from(recommendationPhoto)
    .innerJoin(file, eq(recommendationPhoto.fileId, file.id))
    .where(inArray(recommendationPhoto.recommendationId, ids))
    .orderBy(asc(recommendationPhoto.sortOrder))

  const tagRows = await db
    .select({
      recommendationId: recommendationTag.recommendationId,
      tagId: recommendationTag.tagId,
    })
    .from(recommendationTag)
    .where(inArray(recommendationTag.recommendationId, ids))

  return rows.map((r) => ({
    ...r,
    photos: photoRows
      .filter((p) => p.recommendationId === r.id)
      .map(({ recommendationId: _omit, ...p }) => p),
    tagIds: tagRows.filter((t) => t.recommendationId === r.id).map((t) => t.tagId),
  }))
}

const baseColumns = {
  id: recommendation.id,
  title: recommendation.title,
  description: recommendation.description,
  lat: recommendation.lat,
  lng: recommendation.lng,
  authorId: recommendation.authorId,
  authorName: user.name,
  createdAt: recommendation.createdAt,
  updatedAt: recommendation.updatedAt,
}

export async function listRecommendations(): Promise<RecommendationListItem[]> {
  const rows = await db
    .select(baseColumns)
    .from(recommendation)
    .leftJoin(user, eq(recommendation.authorId, user.id))
    .where(isNull(recommendation.deletedAt))
    .orderBy(desc(recommendation.createdAt))
  return assemble(rows)
}

export type UpdatePhoto =
  | { kind: 'existing'; photoId: string }
  | { kind: 'new'; pathname: string; mime: string; sizeBytes: number }

export interface UpdateRecommendationInput {
  id: string
  actorId: string
  // actorRole is string | null because Better Auth's session user types role as string — the
  // `!== 'admin'` comparison is correct for any value (including undefined coerced via ?? null).
  actorRole: string | null
  title: string
  description?: string | null
  lat: number
  lng: number
  tagIds: string[]
  photos: UpdatePhoto[] // the full desired ordered set (existing kept by id + new uploads)
}

export async function updateRecommendation(
  input: UpdateRecommendationInput,
): Promise<{ id: string; newPhotoFileIds: string[] }> {
  // Count + duplicate checks mirror createRecommendation (check-first, ADR-0002).
  if (input.photos.length < MIN_PHOTOS) throw new RecommendationDomainError('NO_PHOTOS')
  if (input.photos.length > MAX_PHOTOS) throw new RecommendationDomainError('TOO_MANY_PHOTOS')
  const newPhotos = input.photos.filter((p) => p.kind === 'new') as Extract<
    UpdatePhoto,
    { kind: 'new' }
  >[]
  const newPathnames = newPhotos.map((p) => p.pathname)
  if (new Set(newPathnames).size !== newPathnames.length)
    throw new RecommendationDomainError('DUPLICATE_PHOTOS')
  const existingIds = input.photos.flatMap((p) => (p.kind === 'existing' ? [p.photoId] : []))
  if (new Set(existingIds).size !== existingIds.length)
    throw new RecommendationDomainError('NOT_FOUND') // duplicate existing ref = malformed set
  if (new Set(input.tagIds).size !== input.tagIds.length)
    throw new RecommendationDomainError('DUPLICATE_TAGS')

  return db.transaction(async (tx) => {
    const row = await loadActiveRecommendationInTx(tx, input.id)
    assertCanMutate(row, input.actorId, input.actorRole, 'CANNOT_EDIT_OTHERS_RECOMMENDATION')

    await tx
      .update(recommendation)
      .set({
        title: input.title,
        description: input.description ?? null,
        lat: input.lat,
        lng: input.lng,
      })
      .where(eq(recommendation.id, input.id))

    await tx.delete(recommendationTag).where(eq(recommendationTag.recommendationId, input.id))
    if (input.tagIds.length > 0) {
      await tx
        .insert(recommendationTag)
        .values(input.tagIds.map((tagId) => ({ recommendationId: input.id, tagId })))
    }

    // --- photo reconciliation -------------------------------------------------
    const current = await tx
      .select({ id: recommendationPhoto.id, fileId: recommendationPhoto.fileId })
      .from(recommendationPhoto)
      .where(eq(recommendationPhoto.recommendationId, input.id))
    const currentIds = new Set(current.map((p) => p.id))

    // Every kept 'existing' ref must belong to this recommendation (else NOT_FOUND,
    // consistent with reorderPhotos' bad-id-set rule).
    const keptIds = new Set<string>()
    for (const photoId of existingIds) {
      if (!currentIds.has(photoId)) throw new RecommendationDomainError('NOT_FOUND')
      keptIds.add(photoId)
    }

    // Remove dropped photos: delete the join row, soft-delete the file row (no byte
    // delete — mirrors softDeleteRecommendation; a future bin/GC reclaims bytes).
    const removed = current.filter((p) => !keptIds.has(p.id))
    if (removed.length > 0) {
      await tx.delete(recommendationPhoto).where(
        inArray(
          recommendationPhoto.id,
          removed.map((p) => p.id),
        ),
      )
      await tx
        .update(file)
        .set({ deletedAt: new Date() })
        .where(
          inArray(
            file.id,
            removed.map((p) => p.fileId),
          ),
        )
    }

    // Insert new photos (file + join, temp sort_order rewritten below).
    const newPhotoFileIds: string[] = []
    const newPhotoIdByPathname = new Map<string, string>()
    for (const p of newPhotos) {
      const [f] = await tx
        .insert(file)
        .values({
          ownerId: input.actorId,
          pathname: p.pathname,
          mime: p.mime,
          sizeBytes: p.sizeBytes,
          access: 'public',
        })
        .returning({ id: file.id })
      const [rp] = await tx
        .insert(recommendationPhoto)
        .values({ recommendationId: input.id, fileId: f.id, sortOrder: 0 })
        .returning({ id: recommendationPhoto.id })
      newPhotoFileIds.push(f.id)
      newPhotoIdByPathname.set(p.pathname, rp.id)
    }

    // Rewrite sort_order across the full desired order (sort_order is not uniquely
    // constrained, so a plain rewrite is safe — ADR-0012 schema notes).
    for (const [index, p] of input.photos.entries()) {
      const photoId =
        p.kind === 'existing' ? p.photoId : (newPhotoIdByPathname.get(p.pathname) as string)
      await tx
        .update(recommendationPhoto)
        .set({ sortOrder: index })
        .where(eq(recommendationPhoto.id, photoId))
    }

    return { id: input.id, newPhotoFileIds }
  })
}

export async function findRecommendation(id: string): Promise<RecommendationListItem> {
  const rows = await db
    .select(baseColumns)
    .from(recommendation)
    .leftJoin(user, eq(recommendation.authorId, user.id))
    .where(and(eq(recommendation.id, id), isNull(recommendation.deletedAt)))
    .limit(1)
  if (rows.length === 0) throw new RecommendationDomainError('NOT_FOUND')
  const [item] = await assemble(rows)
  return item
}

/**
 * Resolve the recommendation a photo file belongs to, by the photo's `file_id`.
 * Used by the `heic_transcode` worker, which only carries `fileId` but must
 * publish `recommendation.changed` keyed by recommendation id. Returns null when
 * the photo was removed mid-flight (no join row), so the caller skips the publish.
 */
export async function findRecommendationIdByFileId(fileId: string): Promise<string | null> {
  const [row] = await db
    .select({ recommendationId: recommendationPhoto.recommendationId })
    .from(recommendationPhoto)
    .where(eq(recommendationPhoto.fileId, fileId))
    .limit(1)
  return row?.recommendationId ?? null
}

export async function reorderPhotos(input: {
  id: string
  actorId: string
  actorRole: string | null
  orderedPhotoIds: string[]
}): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const row = await loadActiveRecommendationInTx(tx, input.id)
    assertCanMutate(row, input.actorId, input.actorRole, 'CANNOT_EDIT_OTHERS_RECOMMENDATION')

    const current = await tx
      .select({ id: recommendationPhoto.id })
      .from(recommendationPhoto)
      .where(eq(recommendationPhoto.recommendationId, input.id))
    const currentSet = new Set(current.map((p) => p.id))
    const valid =
      input.orderedPhotoIds.length === currentSet.size &&
      new Set(input.orderedPhotoIds).size === input.orderedPhotoIds.length &&
      input.orderedPhotoIds.every((id) => currentSet.has(id))
    if (!valid) throw new RecommendationDomainError('NOT_FOUND')

    for (const [index, photoId] of input.orderedPhotoIds.entries()) {
      await tx
        .update(recommendationPhoto)
        .set({ sortOrder: index })
        .where(eq(recommendationPhoto.id, photoId))
    }
    return { id: input.id }
  })
}

export async function softDeleteRecommendation(input: {
  id: string
  actorId: string
  actorRole: string | null
}): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const row = await loadActiveRecommendationInTx(tx, input.id)
    assertCanMutate(row, input.actorId, input.actorRole, 'CANNOT_DELETE_OTHERS_RECOMMENDATION')

    const now = new Date()
    const photoRows = await tx
      .select({ fileId: recommendationPhoto.fileId })
      .from(recommendationPhoto)
      .where(eq(recommendationPhoto.recommendationId, input.id))
    const fileIds = photoRows.map((p) => p.fileId)
    if (fileIds.length > 0) {
      await tx.update(file).set({ deletedAt: now }).where(inArray(file.id, fileIds))
    }
    await tx.update(recommendation).set({ deletedAt: now }).where(eq(recommendation.id, input.id))
    return { id: input.id }
  })
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** Load an active recommendation's authorId within a tx; throws NOT_FOUND if absent or deleted. */
async function loadActiveRecommendationInTx(
  tx: DbOrTx,
  id: string,
): Promise<{ authorId: string | null }> {
  const [row] = await tx
    .select({ authorId: recommendation.authorId })
    .from(recommendation)
    .where(and(eq(recommendation.id, id), isNull(recommendation.deletedAt)))
    .limit(1)
  if (!row) throw new RecommendationDomainError('NOT_FOUND')
  return row
}

/** Authorize a mutation: only the author or an admin may proceed; anyone else triggers `code`. */
function assertCanMutate(
  row: { authorId: string | null },
  actorId: string,
  actorRole: string | null,
  code: RecommendationDomainErrorCode,
): void {
  if (actorRole !== 'admin' && row.authorId !== actorId) {
    throw new RecommendationDomainError(code)
  }
}

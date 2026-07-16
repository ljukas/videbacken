import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { queue, realtime, storage } from '~/lib/effects'
import { stripEnvPrefix } from '~/lib/effects/storage'
import { SHARP_DECODABLE_MIME_SET } from '~/lib/image/blurhash'
import { HEIC_MIME } from '~/lib/image/heicMime'
import { UPLOAD_IMAGE_EXT, UPLOAD_IMAGE_MIME } from '~/lib/orpc/imageUpload'
import {
  createRecommendation,
  findRecommendation,
  listRecommendations,
  MAX_PHOTOS,
  MIN_PHOTOS,
  RecommendationDomainError,
  type RecommendationDomainErrorCode,
  reorderPhotos,
  softDeleteRecommendation,
  updateRecommendation,
} from '~/lib/services/recommendation'
import { protectedProcedure } from '../context'

const MAX_PHOTO_BYTES = 15_000_000

export const recommendationErrors = {
  NOT_FOUND: { status: 404 },
  CANNOT_EDIT_OTHERS_RECOMMENDATION: { status: 403 },
  CANNOT_DELETE_OTHERS_RECOMMENDATION: { status: 403 },
  NO_PHOTOS: { status: 400 },
  TOO_MANY_PHOTOS: { status: 400 },
  DUPLICATE_PHOTOS: { status: 400 },
  DUPLICATE_TAGS: { status: 400 },
} satisfies Record<RecommendationDomainErrorCode, { status: number }>

const photoInput = z.object({
  pathname: z.string().min(1).max(512),
  sizeBytes: z.number().int().positive().max(MAX_PHOTO_BYTES),
})

// A recommendation photo whose displayable asset isn't ready yet: still HEIC
// (server transcode pending) or whose transcode permanently failed. The single
// definition of this worker↔read-path contract, consumed by `list`/`get` so the
// map orb, detail dialog, and editor placeholders never drift. `pending` and
// `failed` are mutually exclusive; either means there's no public URL to resolve.
function photoTranscodeState(photo: { mime: string; transcodeFailedAt: Date | null }): {
  pending: boolean
  failed: boolean
} {
  return {
    pending: HEIC_MIME.has(photo.mime) && !photo.transcodeFailedAt,
    failed: !!photo.transcodeFailedAt,
  }
}

// After a recommendation create/update commits, enqueue the background job that
// derives each new photo's displayable asset: HEIC photos go to the transcode
// worker (its blurhash backstop runs post-re-encode), sharp-decodable photos go
// straight to blurhash, and anything else is a no-op (the explicit
// `Promise.resolve()` keeps the `Promise.all` well-typed). Enqueue failures are
// logged and swallowed (fire-and-forget, ADR-0001) — the row is already saved.
function enqueuePhotoDerivations(
  photos: Array<{ fileId: string; mime: string }>,
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void[]> {
  return Promise.all(
    photos.map(({ fileId, mime }) => {
      if (HEIC_MIME.has(mime)) {
        return queue
          .publish('heic_transcode', { fileId, kind: 'recommendation' })
          .catch((e) => log.warn('heic_transcode enqueue failed', { error: e }))
      }
      if (SHARP_DECODABLE_MIME_SET.has(mime)) {
        return queue
          .publish('blurhash', { fileId, kind: 'recommendation' })
          .catch((e) => log.warn('blurhash enqueue failed', { error: e }))
      }
      return Promise.resolve()
    }),
  )
}

const updatePhotoInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), photoId: z.string().uuid() }),
  z.object({
    kind: z.literal('new'),
    pathname: z.string().min(1).max(512),
    sizeBytes: z.number().int().positive().max(MAX_PHOTO_BYTES),
  }),
])

// The map/list render via the unpic transformer, which needs a URL — the service
// returns only the stored pathname. The procedure (glue, allowed to use effects;
// the service is not) maps pathname -> public read URL. For the public store
// getReadUrl returns a stable URL (vercelBlob: head().url; s3: deterministic), so
// ttl is effectively unused here.
//
// A public-store pathname carries a randomUUID and is never reused, so its URL is
// immutable — memoize it. On Vercel Blob each resolution is a head() round-trip, so
// without this every list load fires one HEAD per cover and every detail open one
// per photo; the cache collapses repeat/warm loads to zero. Bounded by total photo
// count (small here), so no eviction. The deeper fix — denormalize a url column
// populated once at upload-confirm (the avatar `image` precedent) — needs a
// migration + write-path change; revisit if list latency ever matters (ADR-0012).
const PUBLIC_URL_TTL_SECONDS = 3600
const publicUrlCache = new Map<string, Promise<string>>()
function publicPhotoUrl(pathname: string): Promise<string> {
  let url = publicUrlCache.get(pathname)
  if (!url) {
    // Evict on rejection: vercelBlob resolves the public URL via a fallible
    // head() round-trip, and the cache holds the pending promise — without this
    // a transient failure would poison the pathname for the instance lifetime,
    // re-returning the rejected promise instead of retrying. A resolved URL is
    // kept indefinitely (the pathname is an immutable randomUUID; see above).
    url = storage.getReadUrl('public', pathname, PUBLIC_URL_TTL_SECONDS).catch((e) => {
      publicUrlCache.delete(pathname)
      throw e
    })
    publicUrlCache.set(pathname, url)
  }
  return url
}

export const recommendationRouter = {
  mintImageUpload: protectedProcedure
    .input(
      z.object({
        contentType: z.enum(UPLOAD_IMAGE_MIME),
        sizeBytes: z.number().int().positive().max(MAX_PHOTO_BYTES),
        name: z.string().min(1).max(255),
      }),
    )
    .handler(async ({ input, context }) => {
      const pathname = `recommendations/${context.user.id}/${randomUUID()}.${UPLOAD_IMAGE_EXT[input.contentType]}`
      return storage.mintUploadToken({
        access: 'public',
        pathname,
        contentType: input.contentType,
        maxBytes: MAX_PHOTO_BYTES,
      })
    }),

  create: protectedProcedure
    .errors({
      ...recommendationErrors,
      INVALID_PATH: { status: 403 },
      FILE_NOT_IN_STORAGE: { status: 404 },
    })
    .input(
      z.object({
        title: z.string().min(1).max(255),
        description: z.string().max(2000).optional(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        tagIds: z.array(z.string().uuid()).max(20),
        photos: z.array(photoInput).min(MIN_PHOTOS).max(MAX_PHOTOS),
      }),
    )
    .handler(async ({ input, context, errors }) => {
      const prefix = `recommendations/${context.user.id}/`
      // Cheap ownership check first (no IO), then verify the uploaded blobs in
      // parallel — these heads are independent and on a user-facing submit path.
      for (const p of input.photos) {
        if (!stripEnvPrefix(p.pathname).startsWith(prefix)) throw errors.INVALID_PATH()
      }
      const verified = await Promise.all(
        input.photos.map(async (p) => {
          const blob = await storage.head('public', p.pathname)
          if (!blob) throw errors.FILE_NOT_IN_STORAGE()
          return { pathname: p.pathname, mime: blob.contentType, sizeBytes: p.sizeBytes }
        }),
      )

      let result: Awaited<ReturnType<typeof createRecommendation>>
      try {
        result = await createRecommendation({
          authorId: context.user.id,
          title: input.title,
          description: input.description,
          lat: input.lat,
          lng: input.lng,
          tagIds: input.tagIds,
          photos: verified,
        })
      } catch (err) {
        if (err instanceof RecommendationDomainError) throw errors[err.code]()
        throw err
      }

      await enqueuePhotoDerivations(
        result.photoFileIds.map((fileId, i) => ({ fileId, mime: verified[i].mime })),
        context.log,
      )
      await realtime.publish(
        { kind: 'recommendation.changed', ids: [result.id] },
        { source: context.user.id },
      )
      return result
    }),

  list: protectedProcedure.handler(async () => {
    const items = await listRecommendations()
    // Only the cover (lowest sort_order = photos[0], already ordered) shows on the
    // map/list, so enrich just that one per place to keep storage heads bounded.
    // A cover that's still HEIC (transcode pending) or whose transcode failed has no
    // displayable URL yet, so null coverUrl; per-photo pending/failed flags drive the
    // editor placeholders (task 11).
    return Promise.all(
      items.map(async (item) => {
        const cover = item.photos[0]
        const coverState = cover ? photoTranscodeState(cover) : null
        const coverReady = !!coverState && !coverState.pending && !coverState.failed
        return {
          ...item,
          photos: item.photos.map((p) => ({ ...p, ...photoTranscodeState(p) })),
          coverUrl: cover && coverReady ? await publicPhotoUrl(cover.pathname) : null,
        }
      }),
    )
  }),

  get: protectedProcedure
    .errors(recommendationErrors)
    .input(z.object({ id: z.string().uuid() }))
    .handler(async ({ input, errors }) => {
      let item: Awaited<ReturnType<typeof findRecommendation>>
      try {
        item = await findRecommendation(input.id)
      } catch (err) {
        if (err instanceof RecommendationDomainError) throw errors[err.code]()
        throw err
      }
      // The detail carousel shows every photo, so enrich all with public URLs —
      // except photos still HEIC (transcode pending) or whose transcode failed, which
      // have no displayable URL yet (url: null, plus pending/failed flags for the UI).
      const photos = await Promise.all(
        item.photos.map(async (p) => {
          const state = photoTranscodeState(p)
          return {
            ...p,
            ...state,
            url: state.pending || state.failed ? null : await publicPhotoUrl(p.pathname),
          }
        }),
      )
      return { ...item, photos }
    }),

  update: protectedProcedure
    .errors({
      ...recommendationErrors,
      INVALID_PATH: { status: 403 },
      FILE_NOT_IN_STORAGE: { status: 404 },
    })
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().min(1).max(255),
        description: z.string().max(2000).optional(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        tagIds: z.array(z.string().uuid()).max(20),
        photos: z.array(updatePhotoInput).min(MIN_PHOTOS).max(MAX_PHOTOS),
      }),
    )
    .handler(async ({ input, context, errors }) => {
      const prefix = `recommendations/${context.user.id}/`
      // Verify only the NEW photos' blobs (existing ones are already owned rows).
      // Same cheap-prefix-check-then-parallel-head shape as `create`.
      const newInputs = input.photos.filter((p) => p.kind === 'new') as Extract<
        (typeof input.photos)[number],
        { kind: 'new' }
      >[]
      for (const p of newInputs) {
        if (!stripEnvPrefix(p.pathname).startsWith(prefix)) throw errors.INVALID_PATH()
      }
      const verifiedNew = await Promise.all(
        newInputs.map(async (p) => {
          const blob = await storage.head('public', p.pathname)
          if (!blob) throw errors.FILE_NOT_IN_STORAGE()
          return { pathname: p.pathname, mime: blob.contentType, sizeBytes: p.sizeBytes }
        }),
      )
      const mimeByPathname = new Map(verifiedNew.map((v) => [v.pathname, v.mime]))

      // Preserve the full desired order; resolve new-photo mime from the heads.
      const servicePhotos = input.photos.map((p) =>
        p.kind === 'existing'
          ? { kind: 'existing' as const, photoId: p.photoId }
          : {
              kind: 'new' as const,
              pathname: p.pathname,
              mime: mimeByPathname.get(p.pathname) as string,
              sizeBytes: p.sizeBytes,
            },
      )

      let result: Awaited<ReturnType<typeof updateRecommendation>>
      try {
        result = await updateRecommendation({
          id: input.id,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
          title: input.title,
          description: input.description,
          lat: input.lat,
          lng: input.lng,
          tagIds: input.tagIds,
          photos: servicePhotos,
        })
      } catch (err) {
        if (err instanceof RecommendationDomainError) throw errors[err.code]()
        throw err
      }

      // newPhotoFileIds align with verifiedNew order (service filters kind:'new' in
      // input order, same subset the procedure built), so pair them by index.
      await enqueuePhotoDerivations(
        result.newPhotoFileIds.map((fileId, i) => ({ fileId, mime: verifiedNew[i].mime })),
        context.log,
      )
      await realtime.publish(
        { kind: 'recommendation.changed', ids: [result.id] },
        { source: context.user.id },
      )
      return result
    }),

  reorderPhotos: protectedProcedure
    .errors(recommendationErrors)
    .input(
      z.object({
        id: z.string().uuid(),
        orderedPhotoIds: z.array(z.string().uuid()).min(1).max(MAX_PHOTOS),
      }),
    )
    .handler(async ({ input, context, errors }) => {
      let result: Awaited<ReturnType<typeof reorderPhotos>>
      try {
        result = await reorderPhotos({
          id: input.id,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
          orderedPhotoIds: input.orderedPhotoIds,
        })
      } catch (err) {
        if (err instanceof RecommendationDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish(
        { kind: 'recommendation.changed', ids: [result.id] },
        { source: context.user.id },
      )
      return result
    }),

  softDelete: protectedProcedure
    .errors(recommendationErrors)
    .input(z.object({ id: z.string().uuid() }))
    .handler(async ({ input, context, errors }) => {
      let result: Awaited<ReturnType<typeof softDeleteRecommendation>>
      try {
        result = await softDeleteRecommendation({
          id: input.id,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof RecommendationDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish(
        { kind: 'recommendation.changed', ids: [result.id] },
        { source: context.user.id },
      )
      return result
    }),
}

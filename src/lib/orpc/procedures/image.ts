import { randomUUID } from 'node:crypto'
import { ORPCError } from '@orpc/server'
import { z } from 'zod'
import { auth } from '~/lib/auth'
import { queue, realtime, storage } from '~/lib/effects'
import { stripEnvPrefix } from '~/lib/effects/storage'
import { HEIC_MIME } from '~/lib/image/heicMime'
import { transcodeHeicToPreviewJpeg } from '~/lib/image/heicTranscode'
import { protectedProcedure } from '~/lib/orpc/context'
import { UPLOAD_IMAGE_EXT, UPLOAD_IMAGE_MIME } from '~/lib/orpc/imageUpload'
import * as fileService from '~/lib/services/file'
import { m } from '~/paraglide/messages'

const AVATAR_MAX_BYTES = 5_000_000
// Matches the recommendation photo cap (recommendation.ts MAX_PHOTO_BYTES); a
// server backstop for the client's own size gate before it reaches this endpoint.
const PREVIEW_MAX_BYTES = 15_000_000

export const imageRouter = {
  // Stateless HEIC→small-JPEG transcode for an in-editor preview. The client sends
  // the picked HEIC `File` (in parallel with its storage upload) and gets back a
  // base64 data URL to show while the post-save `heic_transcode` worker derives the
  // canonical asset. Nothing is read from or written to storage. Browsers can't
  // render an iPhone HEIC's HEVC `thmb`, so without this the tile shows a bare
  // placeholder that reads as an error (ADR-0006 / ADR-0012). Errors are swallowed
  // by the caller (falls back to the placeholder), so no localized message is needed.
  previewHeic: protectedProcedure
    .input(z.object({ file: z.instanceof(File) }))
    .handler(async ({ input }) => {
      if (input.file.size > PREVIEW_MAX_BYTES) throw new ORPCError('PAYLOAD_TOO_LARGE')
      const buf = Buffer.from(await input.file.arrayBuffer())
      const jpeg = await transcodeHeicToPreviewJpeg(buf)
      return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` }
    }),

  mintAvatarUpload: protectedProcedure
    .input(
      z.object({
        contentType: z.enum(UPLOAD_IMAGE_MIME),
        sizeBytes: z.number().int().positive().max(AVATAR_MAX_BYTES),
        name: z.string().min(1).max(255),
      }),
    )
    .handler(async ({ input, context }) => {
      return storage.mintUploadToken({
        access: 'public',
        pathname: `avatars/${context.user.id}/${randomUUID()}.${UPLOAD_IMAGE_EXT[input.contentType]}`,
        contentType: input.contentType,
        maxBytes: AVATAR_MAX_BYTES,
      })
    }),

  confirmAvatarUpload: protectedProcedure
    .input(
      z.object({
        pathname: z.string().min(1).max(512),
        name: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(AVATAR_MAX_BYTES),
      }),
    )
    .handler(async ({ input, context }) => {
      // Anchored ownership check on the logical pathname — `includes()` would
      // also accept `avatars/<id>/` appearing mid-path under someone else's key.
      if (!stripEnvPrefix(input.pathname).startsWith(`avatars/${context.user.id}/`)) {
        throw new ORPCError('FORBIDDEN', { message: m.image_error_not_yours() })
      }
      const blob = await storage.head('public', input.pathname)
      if (!blob) {
        throw new ORPCError('NOT_FOUND', { message: m.file_error_not_in_storage() })
      }

      const { newRow, previousPathnames } = await fileService.replaceAvatarForUser({
        userId: context.user.id,
        newRow: {
          pathname: input.pathname,
          mime: blob.contentType,
          sizeBytes: input.sizeBytes,
        },
      })
      await Promise.all(
        previousPathnames.map((p) =>
          storage.delete('public', p).catch((error) => {
            context.log.warn('failed to delete previous avatar blob', { pathname: p, error })
          }),
        ),
      )
      const isHeic = HEIC_MIME.has(blob.contentType)
      if (isHeic) {
        // Clear the avatar pointer now: confirm already deleted the previous
        // blob (previousPathnames), so leaving user.image pointing at it would
        // render a broken 404 <img> on shared surfaces during the pending
        // window. Clearing falls back to initials until the worker repoints it
        // to the transcoded JPEG (it calls userService.setImage + publishes
        // user.changed). Safe unconditionally: already-null stays null, a
        // replacement clears to initials. `image: null` is accepted by Better
        // Auth (nullable field). Defer blurhash to the worker too. (spec §E)
        await auth.api.updateUser({
          body: { image: null },
          headers: context.headers,
        })
        await queue
          .publish('heic_transcode', { fileId: newRow.id, kind: 'avatar', userId: context.user.id })
          .catch((error) => {
            context.log.warn('failed to enqueue avatar heic_transcode', {
              fileId: newRow.id,
              error,
            })
          })
      } else {
        await queue
          .publish('blurhash', { fileId: newRow.id, kind: 'avatar', userId: context.user.id })
          .catch((error) => {
            context.log.warn('failed to enqueue avatar blurhash', { fileId: newRow.id, error })
          })
        await auth.api.updateUser({
          body: { image: blob.url },
          headers: context.headers,
        })
      }
      context.log.info('avatar uploaded', {
        pathname: input.pathname,
        replacedCount: previousPathnames.length,
      })
      await realtime.publish(
        { kind: 'user.changed', ids: [context.user.id] },
        { source: context.user.id },
      )
      return { imageUrl: isHeic ? null : blob.url, pending: isHeic }
    }),
}

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { queue, realtime, storage } from '~/lib/effects'
import { isRemoteOriginPathname, stripEnvPrefix } from '~/lib/effects/storage'
import { SHARP_DECODABLE_MIME_SET } from '~/lib/image/blurhash'
import { HEIC_MIME } from '~/lib/image/heicMime'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as documentService from '~/lib/services/document'
import { DocumentDomainError, type DocumentDomainErrorCode } from '~/lib/services/document'
import * as documentEventService from '~/lib/services/documentEvent'
import * as fileService from '~/lib/services/file'
import { joinFilename, replacePathnameBasename, safeFilename } from '~/utils/filename'

// No mime whitelist (ADR-0010 §M): any contentType is accepted; the grid renders
// a mime icon for types without a thumbnail worker. 100 MB cap at the boundary.
const DOCUMENT_MAX_BYTES = 100_000_000

// Image tiles load a rendered WebP thumbnail from the *public* store (ADR-0010).
// Public read URLs are stable (non-expiring), so the tile never re-downloads and
// the thumbnail query never needs invalidating. The ttl is a no-op for public
// URLs but the adapter signature still requires one.
const THUMBNAIL_URL_TTL_SECONDS = 3600

// Code-only typed errors shared by the document mutating procedures and the bin
// router. Status only; the backend stays i18n-free and the client localizes by
// code (see ~/lib/orpc/documentErrorMessage). The `satisfies` locks the keys to
// the domain code union, so adding a DocumentDomainError code forces an entry.
export const documentErrors = {
  NOT_FOUND: { status: 404 },
  NOT_ADMIN: { status: 403 },
  NOT_DELETED: { status: 400 },
  CANNOT_DELETE_OTHERS_DOCUMENT: { status: 403 },
  CANNOT_EDIT_OTHERS_DOCUMENT: { status: 403 },
  FOLDER_NOT_FOUND: { status: 404 },
  FOLDER_DELETED: { status: 400 },
} satisfies Record<DocumentDomainErrorCode, { status: number }>

export const documentRouter = {
  mintDocumentUpload: protectedProcedure
    .input(
      z.object({
        contentType: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(DOCUMENT_MAX_BYTES),
        name: z.string().min(1).max(255),
      }),
    )
    .handler(async ({ input }) => {
      return storage.mintUploadToken({
        access: 'private',
        pathname: `documents/${randomUUID()}/${safeFilename(input.name)}`,
        contentType: input.contentType,
        maxBytes: DOCUMENT_MAX_BYTES,
      })
    }),

  confirmDocumentUpload: protectedProcedure
    // The two boundary codes are upload-only; the upload UI is status-only so it
    // never renders their message, hence no client mapping for them.
    .errors({
      ...documentErrors,
      INVALID_PATH: { status: 403 },
      FILE_NOT_IN_STORAGE: { status: 404 },
    })
    .input(
      z.object({
        pathname: z.string().min(1).max(512),
        name: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(DOCUMENT_MAX_BYTES),
        folderId: z.uuid().nullable().optional(),
      }),
    )
    .handler(async ({ input, context, errors }) => {
      // The round-tripped pathname is adapter-final — env-prefixed in prod
      // (`prod/documents/...`), so the shape check must strip the prefix or
      // every production upload gets rejected here.
      if (!stripEnvPrefix(input.pathname).startsWith('documents/')) {
        throw errors.INVALID_PATH()
      }
      const blob = await storage.head('private', input.pathname)
      if (!blob) {
        throw errors.FILE_NOT_IN_STORAGE()
      }
      let inserted: Awaited<ReturnType<typeof documentService.confirmUpload>>
      try {
        inserted = await documentService.confirmUpload({
          ownerId: context.user.id,
          pathname: input.pathname,
          name: input.name,
          mime: blob.contentType,
          sizeBytes: input.sizeBytes,
          folderId: input.folderId ?? null,
        })
      } catch (err) {
        if (err instanceof DocumentDomainError) throw errors[err.code]()
        throw err
      }
      context.log.info('document uploaded', {
        documentId: inserted.document.id,
        fileId: inserted.file.id,
        pathname: input.pathname,
      })
      if (HEIC_MIME.has(inserted.file.mime)) {
        // HEIC can't be decoded by the prebuilt sharp binary, so it gets neither
        // a blurhash nor an inline thumbnail above. The worker transcodes a WebP
        // preview off-process; the stored original HEIC file is kept untouched
        // (ADR-0010 — documents preserve the user's original bytes).
        await queue
          .publish('heic_transcode', {
            fileId: inserted.file.id,
            kind: 'document',
            documentId: inserted.document.id,
          })
          .catch((error) => context.log.warn('heic_transcode enqueue failed', { error }))
      } else if (SHARP_DECODABLE_MIME_SET.has(inserted.file.mime)) {
        await queue
          .publish('blurhash', { fileId: inserted.file.id, kind: 'document' })
          .catch((error) => {
            context.log.warn('failed to enqueue document blurhash', {
              fileId: inserted.file.id,
              error,
            })
          })
        // Same gate as blurhash: only image mimes the prebuilt sharp binary can
        // decode get a rendered preview. PDFs render a mime-type icon for now —
        // `pdf_thumbnail` dispatch is deferred (see ADR-0010 §thumbnails).
        await queue
          .publish('image_thumbnail', { documentId: inserted.document.id })
          .catch((error) => {
            context.log.warn('failed to enqueue image thumbnail', {
              documentId: inserted.document.id,
              error,
            })
          })
      }
      await realtime.publish(
        { kind: 'document.changed', ids: [inserted.document.id] },
        { source: context.user.id },
      )
      return { id: inserted.document.id }
    }),

  listDocuments: protectedProcedure
    .input(z.object({ folderId: z.uuid().nullable() }))
    .handler(async ({ input }) => {
      const rows = await documentService.listDocumentsByFolderId(input.folderId)
      // Flatten for the current UI contract; the Phase 4 UI rewrite moves to the
      // structured { document, file, ownerName } shape directly. No preview URLs
      // here — the grid renders immediately (blurhash placeholder) and resolves
      // each image tile's public thumbnail URL lazily via `thumbnail` below.
      return rows.map((row) => ({
        id: row.document.id,
        ownerId: row.file.ownerId,
        name: row.document.name,
        extension: row.document.extension,
        folderId: row.document.folderId,
        mime: row.file.mime,
        sizeBytes: row.file.sizeBytes,
        blurhash: row.file.blurhash,
        // null = not attempted, '' = render failed (sentinel), else logical path
        // in the public store; resolve to a URL via getReadUrl('public', …).
        thumbnailPathname: row.document.thumbnailPathname,
        uploadedAt: row.file.uploadedAt,
        ownerName: row.ownerName,
        // Dev-only: true when the bytes live in a remote Vercel Blob store this
        // (local) environment can't read — a prod row surfaced via the Neon
        // branch whose file was never synced into RustFS. Always false in prod.
        isRemoteOrigin: isRemoteOriginPathname(row.file.pathname),
      }))
    }),

  // Lazy, per-tile read URL for a document's rendered thumbnail (ADR-0010). The
  // grid fetches this only after render, and only for documents that already
  // have a thumbnail (`thumbnailPathname` is a real path). The WebP lives in the
  // *public* store, so the URL is stable — the tile loads it once and the query
  // never needs invalidating. A doc without a thumbnail returns `{ url: null }`
  // and the grid keeps showing its blurhash placeholder.
  thumbnail: protectedProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input }) => {
    const row = await documentService.findActiveById(input.id)
    // missing doc, or null (never attempted) / '' (render-failed sentinel): no URL.
    if (!row?.document.thumbnailPathname) return { url: null }
    const url = await storage.getReadUrl(
      'public',
      row.document.thumbnailPathname,
      THUMBNAIL_URL_TTL_SECONDS,
    )
    return { url }
  }),

  renameDocument: protectedProcedure
    .errors(documentErrors)
    .input(z.object({ id: z.uuid(), name: z.string().min(1).max(255) }))
    .handler(async ({ input, context, errors }) => {
      let updated: Awaited<ReturnType<typeof documentService.renameDocument>>
      try {
        updated = await documentService.renameDocument({
          id: input.id,
          newName: input.name,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof DocumentDomainError) throw errors[err.code]()
        throw err
      }
      // Rename the stored byte so its basename — the prod (Vercel Blob) download
      // filename — tracks the new display name. Copy → repoint file.pathname →
      // delete old keeps the pathname pointing at an existing object at every
      // step. A storage failure leaves the (already committed) name rename
      // intact: the download still works under the old basename, so we log and
      // swallow rather than fail the user's rename. Orphaned blobs on partial
      // failure are tolerated (same posture as avatar/hard-delete cleanup).
      const oldPathname = updated.file.pathname
      const newBasename = safeFilename(
        joinFilename({ name: updated.document.name, extension: updated.document.extension }),
      )
      const newPathname = replacePathnameBasename(oldPathname, newBasename)
      // A foreign-origin (prod) byte is shared into this env read-only (preview),
      // or absent locally (dev). Moving it would mutate prod's store / fail, so
      // skip the physical rename: the name change is already committed and the
      // byte keeps its old basename — the same tolerated degradation as a storage
      // failure below. Never reached in prod (prod files carry the prod prefix).
      if (newPathname !== oldPathname && !isRemoteOriginPathname(oldPathname)) {
        try {
          await storage.copy('private', oldPathname, newPathname, updated.file.mime)
          await fileService.updatePathname({ fileId: updated.file.id, pathname: newPathname })
          await storage.delete('private', oldPathname).catch((error) =>
            context.log.warn('failed to delete old document blob after rename', {
              fileId: updated.file.id,
              error,
            }),
          )
        } catch (error) {
          context.log.warn('failed to rename document blob; pathname unchanged', {
            documentId: updated.document.id,
            error,
          })
        }
      }
      await realtime.publish(
        { kind: 'document.changed', ids: [updated.document.id] },
        { source: context.user.id },
      )
      return { id: updated.document.id }
    }),

  moveDocument: protectedProcedure
    .errors(documentErrors)
    .input(z.object({ id: z.uuid(), folderId: z.uuid().nullable() }))
    .handler(async ({ input, context, errors }) => {
      let updated: Awaited<ReturnType<typeof documentService.moveDocument>>
      try {
        updated = await documentService.moveDocument({
          id: input.id,
          newFolderId: input.folderId,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof DocumentDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish(
        { kind: 'document.changed', ids: [updated.document.id] },
        { source: context.user.id },
      )
      return { id: updated.document.id }
    }),

  deleteDocument: protectedProcedure
    .errors(documentErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      let deleted: Awaited<ReturnType<typeof documentService.softDelete>>
      try {
        deleted = await documentService.softDelete({
          id: input.id,
          actingUserId: context.user.id,
          actingUserRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof DocumentDomainError) throw errors[err.code]()
        throw err
      }
      context.log.info('document deleted', {
        documentId: deleted.document.id,
        fileId: deleted.file.id,
        ownerId: deleted.file.ownerId,
        actorId: context.user.id,
      })
      await realtime.publish(
        { kind: 'document.changed', ids: [deleted.document.id] },
        { source: context.user.id },
      )
      // The document moved into the (admin) bin.
      await realtime.publish({ kind: 'bin.changed' }, { source: context.user.id })
    }),

  restoreDocument: adminProcedure
    .errors(documentErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      let restored: Awaited<ReturnType<typeof documentService.restoreDocument>>
      try {
        restored = await documentService.restoreDocument({
          id: input.id,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof DocumentDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish(
        { kind: 'document.changed', ids: [restored.document.id] },
        { source: context.user.id },
      )
      // The document moved out of the (admin) bin.
      await realtime.publish({ kind: 'bin.changed' }, { source: context.user.id })
      return { id: restored.document.id }
    }),

  documentHistory: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(({ input }) => documentEventService.listForDocument(input.id)),
}

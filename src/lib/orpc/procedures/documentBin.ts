import { z } from 'zod'
import { realtime, storage } from '~/lib/effects'
import { adminProcedure } from '~/lib/orpc/context'
import { documentErrors } from '~/lib/orpc/procedures/document'
import { folderErrors } from '~/lib/orpc/procedures/folder'
import * as documentService from '~/lib/services/document'
import { DocumentDomainError } from '~/lib/services/document'
import * as folderService from '~/lib/services/folder'
import { FolderDomainError } from '~/lib/services/folder'

export const binRouter = {
  list: adminProcedure.handler(() => folderService.listBin()),

  hardDeleteDocument: adminProcedure
    .errors(documentErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      let result: Awaited<ReturnType<typeof documentService.hardDeleteDocument>>
      try {
        result = await documentService.hardDeleteDocument({
          id: input.id,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof DocumentDomainError) throw errors[err.code]()
        throw err
      }
      // Row + history are committed; now drop the bytes. Best-effort — a failed
      // storage delete leaves an orphaned blob but the DB is already consistent.
      await storage.delete('private', result.pathname).catch((error) => {
        context.log.warn('failed to delete document blob', { pathname: result.pathname, error })
      })
      if (result.thumbnailPathname) {
        await storage.delete('public', result.thumbnailPathname).catch((error) => {
          context.log.warn('failed to delete thumbnail blob', {
            pathname: result.thumbnailPathname,
            error,
          })
        })
      }
      context.log.info('document hard-deleted', { documentId: input.id, actorId: context.user.id })
      await realtime.publish(
        { kind: 'document.changed', ids: [input.id] },
        { source: context.user.id },
      )
      // The document was purged from the (admin) bin.
      await realtime.publish({ kind: 'bin.changed' }, { source: context.user.id })
    }),

  // Permanently purge a soft-deleted folder and its whole subtree (subfolders +
  // documents + their blobs). Input is the subtree root folder id.
  hardDeleteFolder: adminProcedure
    .errors(folderErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      let result: Awaited<ReturnType<typeof folderService.hardDeleteFolderAsAdmin>>
      try {
        result = await folderService.hardDeleteFolderAsAdmin({
          id: input.id,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof FolderDomainError) throw errors[err.code]()
        throw err
      }
      // Rows + history are committed; now drop the bytes. Best-effort — a failed
      // storage delete leaves an orphaned blob but the DB is already consistent.
      for (const pathname of result.privatePathnames) {
        await storage.delete('private', pathname).catch((error) => {
          context.log.warn('failed to delete document blob', { pathname, error })
        })
      }
      for (const pathname of result.publicPathnames) {
        await storage.delete('public', pathname).catch((error) => {
          context.log.warn('failed to delete thumbnail blob', { pathname, error })
        })
      }
      context.log.info('folder hard-deleted', {
        folderId: input.id,
        actorId: context.user.id,
        ...result,
      })
      await realtime.publish({ kind: 'folder.changed' }, { source: context.user.id })
      await realtime.publish({ kind: 'document.changed' }, { source: context.user.id })
      // The folder and its documents were purged from the (admin) bin.
      await realtime.publish({ kind: 'bin.changed' }, { source: context.user.id })
    }),
}

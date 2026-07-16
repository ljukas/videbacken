import { z } from 'zod'
import { realtime } from '~/lib/effects'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as folderService from '~/lib/services/folder'
import { FolderDomainError, type FolderDomainErrorCode } from '~/lib/services/folder'

// Code-only typed errors shared by all folder mutating procedures. Status only;
// messages are NOT here — the backend stays i18n-free and the client localizes
// by code (see ~/lib/orpc/folderErrorMessage). The `satisfies` locks the keys to
// the domain code union, so adding a FolderDomainError code forces an entry here.
export const folderErrors = {
  NOT_FOUND: { status: 404 },
  NOT_ADMIN: { status: 403 },
  NAME_TAKEN_IN_PARENT: { status: 409 },
  INVALID_NAME: { status: 400 },
  PARENT_NOT_FOUND: { status: 404 },
  CANNOT_MOVE_INTO_DESCENDANT: { status: 400 },
  ALREADY_DELETED: { status: 400 },
  NOT_DELETED: { status: 400 },
  PARENT_DELETED: { status: 400 },
} satisfies Record<FolderDomainErrorCode, { status: number }>

export const folderRouter = {
  createFolder: protectedProcedure
    .errors(folderErrors)
    .input(
      z.object({
        parentId: z.uuid().nullable().optional(),
        name: z.string().min(1).max(255),
      }),
    )
    .handler(async ({ input, context, errors }) => {
      let created: Awaited<ReturnType<typeof folderService.createFolder>>
      try {
        created = await folderService.createFolder({
          parentId: input.parentId ?? null,
          name: input.name,
          createdBy: context.user.id,
        })
      } catch (err) {
        if (err instanceof FolderDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish(
        { kind: 'folder.changed', ids: [created.id] },
        { source: context.user.id },
      )
      return created
    }),

  renameFolder: adminProcedure
    .errors(folderErrors)
    .input(z.object({ id: z.uuid(), name: z.string().min(1).max(255) }))
    .handler(async ({ input, context, errors }) => {
      let updated: Awaited<ReturnType<typeof folderService.renameFolderAsAdmin>>
      try {
        updated = await folderService.renameFolderAsAdmin({
          id: input.id,
          newName: input.name,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof FolderDomainError) throw errors[err.code]()
        throw err
      }
      // Descendant document haystacks changed too.
      await realtime.publish(
        { kind: 'folder.changed', ids: [updated.id] },
        { source: context.user.id },
      )
      await realtime.publish({ kind: 'document.changed' }, { source: context.user.id })
      return updated
    }),

  moveFolder: adminProcedure
    .errors(folderErrors)
    .input(z.object({ id: z.uuid(), newParentId: z.uuid().nullable() }))
    .handler(async ({ input, context, errors }) => {
      let updated: Awaited<ReturnType<typeof folderService.moveFolderAsAdmin>>
      try {
        updated = await folderService.moveFolderAsAdmin({
          id: input.id,
          newParentId: input.newParentId,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof FolderDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish(
        { kind: 'folder.changed', ids: [updated.id] },
        { source: context.user.id },
      )
      await realtime.publish({ kind: 'document.changed' }, { source: context.user.id })
      return updated
    }),

  softDeleteFolder: adminProcedure
    .errors(folderErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      let result: Awaited<ReturnType<typeof folderService.softDeleteFolderAsAdmin>>
      try {
        result = await folderService.softDeleteFolderAsAdmin({
          id: input.id,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof FolderDomainError) throw errors[err.code]()
        throw err
      }
      context.log.info('folder soft-deleted', {
        folderId: input.id,
        actorId: context.user.id,
        ...result,
      })
      await realtime.publish({ kind: 'folder.changed' }, { source: context.user.id })
      await realtime.publish({ kind: 'document.changed' }, { source: context.user.id })
      // The folder and its documents moved in/out of the (admin) bin.
      await realtime.publish({ kind: 'bin.changed' }, { source: context.user.id })
      return result
    }),

  restoreFolder: adminProcedure
    .errors(folderErrors)
    .input(z.object({ correlationId: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      let result: Awaited<ReturnType<typeof folderService.restoreByCorrelationAsAdmin>>
      try {
        result = await folderService.restoreByCorrelationAsAdmin({
          correlationId: input.correlationId,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
        })
      } catch (err) {
        if (err instanceof FolderDomainError) throw errors[err.code]()
        throw err
      }
      context.log.info('folder subtree restored', {
        correlationId: input.correlationId,
        actorId: context.user.id,
        ...result,
      })
      await realtime.publish({ kind: 'folder.changed' }, { source: context.user.id })
      await realtime.publish({ kind: 'document.changed' }, { source: context.user.id })
      // The folder and its documents moved in/out of the (admin) bin.
      await realtime.publish({ kind: 'bin.changed' }, { source: context.user.id })
      return result
    }),

  listChildren: protectedProcedure
    .input(z.object({ folderId: z.uuid().nullable().optional() }))
    .handler(({ input }) => folderService.listChildren(input.folderId ?? null)),

  tree: protectedProcedure.handler(() => folderService.listTree()),
}

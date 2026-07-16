import { ORPCError } from '@orpc/server'
import { z } from 'zod'
import { realtime } from '~/lib/effects'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as shareService from '~/lib/services/share'
import { ShareDomainError } from '~/lib/services/share'
import * as userService from '~/lib/services/user'
import { SHARE_CODES, type ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'

const shareCodeSchema = z.enum(SHARE_CODES)

function rethrowAsORPC(err: unknown): never {
  if (!(err instanceof ShareDomainError)) throw err
  switch (err.code) {
    case 'USER_NOT_FOUND':
      throw new ORPCError('NOT_FOUND', {
        message: m.share_error_user_not_found(),
      })
    case 'ALREADY_CURRENT_OWNER':
      throw new ORPCError('CONFLICT', {
        message: m.share_error_already_owner(),
      })
    case 'FROM_DATE_NOT_AFTER_CURRENT':
    case 'DATE_NOT_AFTER_CURRENT':
      throw new ORPCError('CONFLICT', {
        message: m.share_error_date_not_after_current(),
      })
    case 'NOT_ASSIGNED':
      throw new ORPCError('CONFLICT', {
        message: m.share_error_not_assigned(),
      })
  }
}

type OwnerSummary = {
  id: string
  name: string
  image: string | null
  imageBlurhash: string | null
}

export type AdminShareRow = {
  shareCode: ShareCode
  currentOwner: OwnerSummary | null
}

export type AdminHistoryEntry = {
  id: string
  assignedFrom: Date
  assignedTo: Date | null
  isActive: boolean
  user: OwnerSummary | null
}

function toOwnerSummary(u: {
  id: string
  name: string
  image: string | null
  imageBlurhash: string | null
}): OwnerSummary {
  return { id: u.id, name: u.name, image: u.image, imageBlurhash: u.imageBlurhash }
}

export const shareRouter = {
  // Current user's owned shares, sorted A→J. The same set is applied to
  // every visible year on the client — ownership changes mid-season are rare.
  listMine: protectedProcedure.handler(
    ({ context }): Promise<Array<ShareCode>> =>
      shareService.listCurrentSharesForUser(context.user.id),
  ),

  // Admin grid view: every share with its current owner decorated.
  listAll: adminProcedure.handler(async (): Promise<Array<AdminShareRow>> => {
    const [shares, users] = await Promise.all([
      shareService.listSharesWithCurrentOwner(),
      userService.listAll(),
    ])
    const byId = new Map(users.map((u) => [u.id, u]))
    return shares.map((s) => {
      const owner = s.currentUserId ? byId.get(s.currentUserId) : null
      return {
        shareCode: s.shareCode,
        currentOwner: owner ? toOwnerSummary(owner) : null,
      }
    })
  }),

  // Per-share history Sheet payload: one entry per ownership stint, newest
  // first (shares are indivisible per ADR-0018 — no event grouping needed).
  listHistory: adminProcedure
    .input(z.object({ shareCode: shareCodeSchema }))
    .handler(async ({ input }): Promise<Array<AdminHistoryEntry>> => {
      const [rows, users] = await Promise.all([
        shareService.listShareHistory(input.shareCode),
        userService.listAll(),
      ])
      const byId = new Map(users.map((u) => [u.id, u]))
      return rows.map((r) => {
        const u = byId.get(r.userId)
        return {
          id: r.id,
          assignedFrom: r.assignedFrom,
          assignedTo: r.assignedTo,
          isActive: r.assignedTo === null,
          user: u ? toOwnerSummary(u) : null,
        }
      })
    }),

  assign: adminProcedure
    .input(
      z.object({
        shareCode: shareCodeSchema,
        userId: z.uuid(),
        from: z.date(),
      }),
    )
    .handler(async ({ input, context }) => {
      try {
        await shareService.assignShareAsAdmin(input, { actorUserId: context.user.id })
      } catch (err) {
        rethrowAsORPC(err)
      }
      context.log.info('admin assigned share', { shareCode: input.shareCode })
      await realtime.publish(
        { kind: 'share.changed', ids: [input.shareCode] },
        { source: context.user.id },
      )
    }),

  unassign: adminProcedure
    .input(z.object({ shareCode: shareCodeSchema, on: z.date() }))
    .handler(async ({ input, context }) => {
      try {
        await shareService.unassignShareAsAdmin(input)
      } catch (err) {
        rethrowAsORPC(err)
      }
      context.log.info('admin unassigned share', { shareCode: input.shareCode })
      await realtime.publish(
        { kind: 'share.changed', ids: [input.shareCode] },
        { source: context.user.id },
      )
    }),
}

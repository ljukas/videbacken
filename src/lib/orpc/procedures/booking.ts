import { ORPCError } from '@orpc/server'
import { z } from 'zod'
import { realtime } from '~/lib/effects'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as bookingService from '~/lib/services/booking'
import { BookingDomainError, type BookingDomainErrorCode } from '~/lib/services/booking'
import * as seasonService from '~/lib/services/season'
import * as shareService from '~/lib/services/share'
import { SHARE_CODES } from '~/lib/shares/codes'

// Code-only typed errors shared by all booking mutating procedures. Status
// only; messages are NOT here — the client localizes by code (see
// ~/lib/orpc/bookingErrorMessage). `satisfies` locks the keys to the domain
// code union, so adding a BookingDomainError code forces an entry here.
export const bookingErrors = {
  SEASON_LOCKED: { status: 409 },
  NOT_LOCKED: { status: 409 },
  NOT_YOUR_SHARE: { status: 403 },
  INVALID_TARGET: { status: 400 },
} satisfies Record<BookingDomainErrorCode, { status: number }>

const shareCodeSchema = z.enum(SHARE_CODES)

const wishInput = z.object({
  shareCode: shareCodeSchema,
  targetKind: z.enum(['share', 'extra_early', 'extra_late']),
  targetShare: shareCodeSchema.nullable(),
})

const weekSchema = z.number().int().min(1).max(53)

// Every read and mutation targets the single active round — the year is
// never client input (README locked decision 1), mirroring how
// season.listSchedules owns currentYear.
function activeYear() {
  return bookingService.activeSeasonYearFor(new Date())
}

// The governing era's season for the active year. Unreachable while the
// seed era (2024) exists — backstop, mirroring the logic.ts convention.
async function resolveActiveSeason(year: number) {
  const eras = await seasonService.listEras()
  const season = seasonService.seasonForYear(eras, year)
  if (!season) throw new ORPCError('NOT_FOUND')
  return season
}

export const bookingRouter = {
  // The one owner read (ADR-0020): nominal blocks + wish overlay, plus the
  // final schedule only once locked. The unlocked draft is admin-only state
  // and must not transit this shared cache.
  getActive: protectedProcedure.handler(async () => {
    const year = activeYear()
    const season = await resolveActiveSeason(year)
    const extras = bookingService.extraBlocksForSeason(season)
    const round = await bookingService.getRound(year)
    const assignments = await shareService.listSharesWithCurrentOwner()
    return {
      year,
      lockedAt: round.lockedAt,
      blocks: {
        early: extras.early,
        rotation: seasonService.shareBlocksForSeason(season),
        late: extras.late,
      },
      monthBands: seasonService.monthBandsForRange({
        year,
        firstWeek: extras.early.firstWeek,
        lastWeek: extras.late.lastWeek,
      }),
      wishes: round.wishes,
      assignedShares: assignments.filter((a) => a.currentUserId !== null).map((a) => a.shareCode),
      lockedSchedule: round.lockedAt ? round.slots : null,
    }
  }),

  // The arrange-mode read: persisted slots (or computed nominal while no
  // draft exists — this never writes) + the suggestion recomputed from
  // current wishes so the panel always reflects them.
  getDraft: adminProcedure.handler(async () => {
    const year = activeYear()
    const season = await resolveActiveSeason(year)
    const round = await bookingService.getRound(year)
    const suggestion = await bookingService.computeSuggestion(year)
    return {
      year,
      draftExists: round.slots.length > 0,
      slots: round.slots.length > 0 ? round.slots : bookingService.nominalSlotsForSeason(season),
      suggestion,
    }
  }),

  addWish: protectedProcedure
    .errors(bookingErrors)
    .input(wishInput)
    .handler(async ({ input, context, errors }) => {
      try {
        await bookingService.addWish({
          year: activeYear(),
          shareCode: input.shareCode,
          targetKind: input.targetKind,
          targetShare: input.targetShare,
          actorUserId: context.user.id,
        })
      } catch (err) {
        if (err instanceof BookingDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish({ kind: 'booking.changed' }, { source: context.user.id })
    }),

  removeWish: protectedProcedure
    .errors(bookingErrors)
    .input(wishInput)
    .handler(async ({ input, context, errors }) => {
      try {
        await bookingService.removeWish({
          year: activeYear(),
          shareCode: input.shareCode,
          targetKind: input.targetKind,
          targetShare: input.targetShare,
          actorUserId: context.user.id,
        })
      } catch (err) {
        if (err instanceof BookingDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish({ kind: 'booking.changed' }, { source: context.user.id })
    }),

  applySuggestion: adminProcedure.errors(bookingErrors).handler(async ({ context, errors }) => {
    try {
      await bookingService.applySuggestion(activeYear())
    } catch (err) {
      if (err instanceof BookingDomainError) throw errors[err.code]()
      throw err
    }
    await realtime.publish({ kind: 'booking.changed' }, { source: context.user.id })
  }),

  setSlotHolder: adminProcedure
    .errors(bookingErrors)
    .input(z.object({ firstWeek: weekSchema, holder: shareCodeSchema.nullable() }))
    .handler(async ({ input, context, errors }) => {
      try {
        await bookingService.setSlotHolder({ year: activeYear(), ...input })
      } catch (err) {
        if (err instanceof BookingDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish({ kind: 'booking.changed' }, { source: context.user.id })
    }),

  swapSlots: adminProcedure
    .errors(bookingErrors)
    .input(z.object({ firstWeekA: weekSchema, firstWeekB: weekSchema }))
    .handler(async ({ input, context, errors }) => {
      try {
        await bookingService.swapSlots({ year: activeYear(), ...input })
      } catch (err) {
        if (err instanceof BookingDomainError) throw errors[err.code]()
        throw err
      }
      await realtime.publish({ kind: 'booking.changed' }, { source: context.user.id })
    }),

  resetDraft: adminProcedure.errors(bookingErrors).handler(async ({ context, errors }) => {
    try {
      await bookingService.resetDraft(activeYear())
    } catch (err) {
      if (err instanceof BookingDomainError) throw errors[err.code]()
      throw err
    }
    await realtime.publish({ kind: 'booking.changed' }, { source: context.user.id })
  }),

  lock: adminProcedure.errors(bookingErrors).handler(async ({ context, errors }) => {
    try {
      await bookingService.lock({ year: activeYear(), userId: context.user.id })
    } catch (err) {
      if (err instanceof BookingDomainError) throw errors[err.code]()
      throw err
    }
    await realtime.publish({ kind: 'booking.changed' }, { source: context.user.id })
  }),

  unlock: adminProcedure.errors(bookingErrors).handler(async ({ context, errors }) => {
    try {
      await bookingService.unlock(activeYear())
    } catch (err) {
      if (err instanceof BookingDomainError) throw errors[err.code]()
      throw err
    }
    await realtime.publish({ kind: 'booking.changed' }, { source: context.user.id })
  }),
}

import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '~/lib/db'
import { ownershipAssignment, seasonBooking, seasonSlot, seasonWish } from '~/lib/db/schema'
import * as seasonService from '~/lib/services/season'
import * as shareService from '~/lib/services/share'
import type { ShareCode } from '~/lib/shares/codes'
import { BookingDomainError } from './errors'
import {
  type BookingTarget,
  buildSuggestion,
  nominalSlotsForSeason,
  type Slot,
  type Suggestion,
  type WishInput,
} from './logic'

// All booking DB access lives here (ADR-0002). Reading ownership_assignment
// directly is sanctioned read-only reuse of the table the share service
// owns (ADR-0020). Guards are check-first (explicit read → typed error);
// the schema CHECKs are silent backstops. Check-then-write races are
// accepted at this scale (ADR-0002).

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type WishRow = WishInput & { id: string }

export type BookingRound = {
  year: number
  lockedAt: Date | null
  wishes: Array<WishRow>
  slots: Array<Slot>
}

const slotSelection = {
  firstWeek: seasonSlot.firstWeek,
  lastWeek: seasonSlot.lastWeek,
  kind: seasonSlot.kind,
  holder: seasonSlot.holder,
}

// The whole round in one read. An absent booking row is an open, untouched
// round (rows are created lazily).
export async function getRound(year: number): Promise<BookingRound> {
  const [row] = await db.select().from(seasonBooking).where(eq(seasonBooking.year, year))
  const wishes = await db
    .select({
      id: seasonWish.id,
      shareCode: seasonWish.shareCode,
      targetKind: seasonWish.targetKind,
      targetShare: seasonWish.targetShare,
    })
    .from(seasonWish)
    .where(eq(seasonWish.year, year))
    .orderBy(asc(seasonWish.createdAt))
  const slots = await db
    .select(slotSelection)
    .from(seasonSlot)
    .where(eq(seasonSlot.year, year))
    .orderBy(asc(seasonSlot.firstWeek))
  return { year, lockedAt: row?.lockedAt ?? null, wishes, slots }
}

// The governing era's season values. Only years before the first era (2024)
// miss — the active round's year never does; backstop guard.
async function resolveSeason(year: number) {
  const eras = await seasonService.listEras()
  const season = seasonService.seasonForYear(eras, year)
  if (!season) throw new BookingDomainError('INVALID_TARGET')
  return season
}

// Upsert the round row (lazy creation) and require it open.
async function ensureOpenRoundInTx(tx: Tx, year: number) {
  await tx.insert(seasonBooking).values({ year }).onConflictDoNothing()
  const [row] = await tx.select().from(seasonBooking).where(eq(seasonBooking.year, year))
  // Unreachable after the upsert — backstop only.
  if (!row) throw new BookingDomainError('INVALID_TARGET')
  if (row.lockedAt) throw new BookingDomainError('SEASON_LOCKED')
}

// Require the round open without creating it (reads/removals must not
// materialize rows).
async function assertNotLockedInTx(tx: Tx, year: number) {
  const [row] = await tx.select().from(seasonBooking).where(eq(seasonBooking.year, year))
  if (row?.lockedAt) throw new BookingDomainError('SEASON_LOCKED')
}

// Only the CURRENT owner of a share manages its wishes (ADR-0020 product
// decision 10): an active assignment row for (share, user).
async function assertOwnsShareInTx(tx: Tx, userId: string, shareCode: ShareCode) {
  const [row] = await tx
    .select({ id: ownershipAssignment.id })
    .from(ownershipAssignment)
    .where(
      and(
        eq(ownershipAssignment.shareCode, shareCode),
        eq(ownershipAssignment.userId, userId),
        isNull(ownershipAssignment.assignedTo),
      ),
    )
    .limit(1)
  if (!row) throw new BookingDomainError('NOT_YOUR_SHARE')
}

function assertValidTarget(
  shareCode: ShareCode,
  input: {
    targetKind: BookingTarget
    targetShare: ShareCode | null
  },
) {
  if ((input.targetKind === 'share') !== (input.targetShare !== null)) {
    throw new BookingDomainError('INVALID_TARGET')
  }
  if (input.targetShare === shareCode) throw new BookingDomainError('INVALID_TARGET')
}

// ADR-0020: slots are created lazily on first admin action. Seeds the 12
// nominal slots if the year has none — era math is used only here and in
// resetDraft (seed time), never at read time.
async function ensureDraftInTx(
  tx: Tx,
  year: number,
  season: { startWeek: number; startShare: ShareCode },
) {
  const existing = await tx
    .select({ firstWeek: seasonSlot.firstWeek })
    .from(seasonSlot)
    .where(eq(seasonSlot.year, year))
    .limit(1)
  if (existing.length > 0) return
  await tx
    .insert(seasonSlot)
    .values(nominalSlotsForSeason(season).map((slot) => ({ ...slot, year })))
}

export async function addWish(input: {
  year: number
  shareCode: ShareCode
  targetKind: BookingTarget
  targetShare: ShareCode | null
  actorUserId: string
}): Promise<void> {
  assertValidTarget(input.shareCode, input)
  await db.transaction(async (tx) => {
    await ensureOpenRoundInTx(tx, input.year)
    await assertOwnsShareInTx(tx, input.actorUserId, input.shareCode)
    // Idempotent toggle-on: the (year, share, kind, target) UNIQUE NULLS NOT
    // DISTINCT constraint makes a repeat click a no-op.
    await tx
      .insert(seasonWish)
      .values({
        year: input.year,
        shareCode: input.shareCode,
        targetKind: input.targetKind,
        targetShare: input.targetShare,
        actorUserId: input.actorUserId,
      })
      .onConflictDoNothing()
  })
}

export async function removeWish(input: {
  year: number
  shareCode: ShareCode
  targetKind: BookingTarget
  targetShare: ShareCode | null
  actorUserId: string
}): Promise<void> {
  assertValidTarget(input.shareCode, input)
  await db.transaction(async (tx) => {
    await assertNotLockedInTx(tx, input.year)
    await assertOwnsShareInTx(tx, input.actorUserId, input.shareCode)
    // Removing an absent wish is a no-op (idempotent toggle-off).
    await tx
      .delete(seasonWish)
      .where(
        and(
          eq(seasonWish.year, input.year),
          eq(seasonWish.shareCode, input.shareCode),
          eq(seasonWish.targetKind, input.targetKind),
          input.targetShare === null
            ? isNull(seasonWish.targetShare)
            : eq(seasonWish.targetShare, input.targetShare),
        ),
      )
  })
}

// Recomputed server-side from current wishes + assignments — applySuggestion
// never trusts a client payload (ADR-0020).
export async function computeSuggestion(year: number): Promise<Suggestion> {
  const season = await resolveSeason(year)
  const round = await getRound(year)
  const assignments = await shareService.listSharesWithCurrentOwner()
  const assignedShares = new Set(
    assignments.filter((a) => a.currentUserId !== null).map((a) => a.shareCode),
  )
  return buildSuggestion({ season, wishes: round.wishes, assignedShares })
}

export async function applySuggestion(year: number): Promise<void> {
  const suggestion = await computeSuggestion(year)
  await db.transaction(async (tx) => {
    await ensureOpenRoundInTx(tx, year)
    await tx.delete(seasonSlot).where(eq(seasonSlot.year, year))
    await tx.insert(seasonSlot).values(suggestion.slots.map((slot) => ({ ...slot, year })))
  })
}

export async function setSlotHolder(input: {
  year: number
  firstWeek: number
  holder: ShareCode | null
}): Promise<void> {
  const season = await resolveSeason(input.year)
  await db.transaction(async (tx) => {
    await ensureOpenRoundInTx(tx, input.year)
    await ensureDraftInTx(tx, input.year, season)
    const [slot] = await tx
      .select(slotSelection)
      .from(seasonSlot)
      .where(and(eq(seasonSlot.year, input.year), eq(seasonSlot.firstWeek, input.firstWeek)))
    if (!slot) throw new BookingDomainError('INVALID_TARGET')
    // Clearing is only meaningful on extras — rotation slots are always held
    // (check-first; the season_slot_rotation_held CHECK backstops).
    if (slot.kind === 'rotation' && input.holder === null) {
      throw new BookingDomainError('INVALID_TARGET')
    }
    await tx
      .update(seasonSlot)
      .set({ holder: input.holder })
      .where(and(eq(seasonSlot.year, input.year), eq(seasonSlot.firstWeek, input.firstWeek)))
  })
}

export async function swapSlots(input: {
  year: number
  firstWeekA: number
  firstWeekB: number
}): Promise<void> {
  if (input.firstWeekA === input.firstWeekB) throw new BookingDomainError('INVALID_TARGET')
  const season = await resolveSeason(input.year)
  await db.transaction(async (tx) => {
    await ensureOpenRoundInTx(tx, input.year)
    await ensureDraftInTx(tx, input.year, season)
    const slots = await tx
      .select(slotSelection)
      .from(seasonSlot)
      .where(
        and(
          eq(seasonSlot.year, input.year),
          inArray(seasonSlot.firstWeek, [input.firstWeekA, input.firstWeekB]),
        ),
      )
    const a = slots.find((s) => s.firstWeek === input.firstWeekA)
    const b = slots.find((s) => s.firstWeek === input.firstWeekB)
    if (!a || !b) throw new BookingDomainError('INVALID_TARGET')
    // Swaps stay rotation ↔ rotation: an extra's NULL holder must never land
    // on a rotation slot (ADR-0020); extras change via setSlotHolder.
    if (a.kind !== 'rotation' || b.kind !== 'rotation') {
      throw new BookingDomainError('INVALID_TARGET')
    }
    await tx
      .update(seasonSlot)
      .set({ holder: b.holder })
      .where(and(eq(seasonSlot.year, input.year), eq(seasonSlot.firstWeek, a.firstWeek)))
    await tx
      .update(seasonSlot)
      .set({ holder: a.holder })
      .where(and(eq(seasonSlot.year, input.year), eq(seasonSlot.firstWeek, b.firstWeek)))
  })
}

// Escape hatch after messy experimentation: back to the nominal seed.
export async function resetDraft(year: number): Promise<void> {
  const season = await resolveSeason(year)
  await db.transaction(async (tx) => {
    await ensureOpenRoundInTx(tx, year)
    await tx.delete(seasonSlot).where(eq(seasonSlot.year, year))
    await tx
      .insert(seasonSlot)
      .values(nominalSlotsForSeason(season).map((slot) => ({ ...slot, year })))
  })
}

export async function lock(input: { year: number; userId: string }): Promise<void> {
  const season = await resolveSeason(input.year)
  await db.transaction(async (tx) => {
    await ensureOpenRoundInTx(tx, input.year) // already locked → SEASON_LOCKED
    // Locking an untouched draft publishes the nominal schedule (ADR-0020).
    await ensureDraftInTx(tx, input.year, season)
    await tx
      .update(seasonBooking)
      .set({ lockedAt: new Date(), lockedBy: input.userId })
      .where(eq(seasonBooking.year, input.year))
  })
}

export async function unlock(year: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(seasonBooking).where(eq(seasonBooking.year, year))
    if (!row?.lockedAt) throw new BookingDomainError('NOT_LOCKED')
    await tx
      .update(seasonBooking)
      .set({ lockedAt: null, lockedBy: null })
      .where(eq(seasonBooking.year, year))
  })
}

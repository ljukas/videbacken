import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { ownershipAssignment, user } from '~/lib/db/schema'
import type { ShareCode } from '~/lib/shares/codes'
import { setupDatabase } from '~test/setup'
import {
  addWish,
  applySuggestion,
  getRound,
  lock,
  removeWish,
  resetDraft,
  setSlotHolder,
  swapSlots,
  unlock,
} from './booking'

setupDatabase()

// The migration-seeded era (2024/21/J) makes 2026 start at share D, week 21.
const YEAR = 2026

async function insertMember(email: string, role: 'user' | 'admin' = 'user') {
  const [row] = await db
    .insert(user)
    .values({ name: email, email, role })
    .returning({ id: user.id })
  return row.id
}

async function assignShare(shareCode: ShareCode, userId: string) {
  await db
    .insert(ownershipAssignment)
    .values({ shareCode, userId, assignedFrom: new Date('2024-01-01') })
}

async function ownerOf(shareCode: ShareCode, email: string) {
  const id = await insertMember(email)
  await assignShare(shareCode, id)
  return id
}

test('addWish lazily creates the round and dedupes repeat wishes', async () => {
  const anna = await ownerOf('A', 'anna@test.oceanview.local')
  const wish = {
    year: YEAR,
    shareCode: 'A' as const,
    targetKind: 'share' as const,
    targetShare: 'D' as const,
    actorUserId: anna,
  }
  await addWish(wish)
  await addWish(wish) // idempotent toggle-on
  const round = await getRound(YEAR)
  expect(round.lockedAt).toBeNull()
  expect(round.slots).toEqual([]) // wishes never create slots
  expect(round.wishes).toHaveLength(1)
  expect(round.wishes[0]).toMatchObject({ shareCode: 'A', targetKind: 'share', targetShare: 'D' })
})

test('extra wishes dedupe too (NULLS NOT DISTINCT backstop)', async () => {
  const anna = await ownerOf('A', 'anna@test.oceanview.local')
  const wish = {
    year: YEAR,
    shareCode: 'A' as const,
    targetKind: 'extra_early' as const,
    targetShare: null,
    actorUserId: anna,
  }
  await addWish(wish)
  await addWish(wish)
  expect((await getRound(YEAR)).wishes).toHaveLength(1)
})

test('removeWish deletes the row and tolerates a missing one', async () => {
  const anna = await ownerOf('A', 'anna@test.oceanview.local')
  const wish = {
    year: YEAR,
    shareCode: 'A' as const,
    targetKind: 'share' as const,
    targetShare: 'D' as const,
    actorUserId: anna,
  }
  await addWish(wish)
  await removeWish(wish)
  expect((await getRound(YEAR)).wishes).toEqual([])
  await removeWish(wish) // idempotent toggle-off — no throw
})

test('addWish rejects malformed targets with INVALID_TARGET', async () => {
  const anna = await ownerOf('A', 'anna@test.oceanview.local')
  const base = { year: YEAR, shareCode: 'A' as const, actorUserId: anna }
  // Self-target.
  await expect(addWish({ ...base, targetKind: 'share', targetShare: 'A' })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'INVALID_TARGET',
  })
  // 'share' kind without a target.
  await expect(addWish({ ...base, targetKind: 'share', targetShare: null })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'INVALID_TARGET',
  })
  // Extra kind with a target.
  await expect(
    addWish({ ...base, targetKind: 'extra_early', targetShare: 'D' }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'INVALID_TARGET' })
})

test('addWish rejects an actor who does not currently own the wishing share', async () => {
  const bert = await ownerOf('B', 'bert@test.oceanview.local')
  // Bert owns B, wishes as A.
  await expect(
    addWish({
      year: YEAR,
      shareCode: 'A',
      targetKind: 'share',
      targetShare: 'D',
      actorUserId: bert,
    }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'NOT_YOUR_SHARE' })
  // A closed (historical) assignment does not count as ownership.
  const carl = await insertMember('carl@test.oceanview.local')
  await db.insert(ownershipAssignment).values({
    shareCode: 'C',
    userId: carl,
    assignedFrom: new Date('2024-01-01'),
    assignedTo: new Date('2025-01-01'),
  })
  await expect(
    addWish({
      year: YEAR,
      shareCode: 'C',
      targetKind: 'extra_early',
      targetShare: null,
      actorUserId: carl,
    }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'NOT_YOUR_SHARE' })
})

test('a locked round rejects wish changes with SEASON_LOCKED', async () => {
  const anna = await ownerOf('A', 'anna@test.oceanview.local')
  const admin = await insertMember('admin@test.oceanview.local', 'admin')
  const wish = {
    year: YEAR,
    shareCode: 'A' as const,
    targetKind: 'share' as const,
    targetShare: 'D' as const,
    actorUserId: anna,
  }
  await addWish(wish)
  await lock({ year: YEAR, userId: admin })
  await expect(addWish({ ...wish, targetShare: 'E' })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'SEASON_LOCKED',
  })
  await expect(removeWish(wish)).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'SEASON_LOCKED',
  })
})

test('setSlotHolder seeds the draft lazily and reassigns a rotation slot', async () => {
  await setSlotHolder({ year: YEAR, firstWeek: 21, holder: 'A' })
  const round = await getRound(YEAR)
  expect(round.slots).toHaveLength(12)
  expect(round.slots[0]).toEqual({ firstWeek: 19, lastWeek: 20, kind: 'extra', holder: null })
  expect(round.slots.find((s) => s.firstWeek === 21)).toMatchObject({
    kind: 'rotation',
    holder: 'A',
  })
  // The rest stayed nominal.
  expect(round.slots.find((s) => s.firstWeek === 23)?.holder).toBe('E')
})

test('setSlotHolder clears an extra but never a rotation slot', async () => {
  await setSlotHolder({ year: YEAR, firstWeek: 19, holder: 'G' })
  await setSlotHolder({ year: YEAR, firstWeek: 19, holder: null }) // extras may be cleared
  expect((await getRound(YEAR)).slots.find((s) => s.firstWeek === 19)?.holder).toBeNull()
  await expect(setSlotHolder({ year: YEAR, firstWeek: 21, holder: null })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'INVALID_TARGET',
  })
})

test('setSlotHolder rejects an unknown slot', async () => {
  await expect(setSlotHolder({ year: YEAR, firstWeek: 99, holder: 'A' })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'INVALID_TARGET',
  })
})

test('swapSlots swaps two rotation holders and refuses extras', async () => {
  await swapSlots({ year: YEAR, firstWeekA: 21, firstWeekB: 23 })
  const round = await getRound(YEAR)
  expect(round.slots.find((s) => s.firstWeek === 21)?.holder).toBe('E')
  expect(round.slots.find((s) => s.firstWeek === 23)?.holder).toBe('D')
  await expect(swapSlots({ year: YEAR, firstWeekA: 19, firstWeekB: 21 })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'INVALID_TARGET',
  })
  await expect(swapSlots({ year: YEAR, firstWeekA: 21, firstWeekB: 21 })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'INVALID_TARGET',
  })
})

test('applySuggestion persists the recomputed suggestion', async () => {
  const anna = await ownerOf('A', 'anna@test.oceanview.local')
  const dave = await ownerOf('D', 'dave@test.oceanview.local')
  await addWish({
    year: YEAR,
    shareCode: 'A',
    targetKind: 'share',
    targetShare: 'D',
    actorUserId: anna,
  })
  await addWish({
    year: YEAR,
    shareCode: 'D',
    targetKind: 'share',
    targetShare: 'A',
    actorUserId: dave,
  })
  await applySuggestion(YEAR)
  const round = await getRound(YEAR)
  expect(round.slots).toHaveLength(12)
  expect(round.slots.find((s) => s.firstWeek === 21)?.holder).toBe('A')
  expect(round.slots.find((s) => s.firstWeek === 35)?.holder).toBe('D')
})

test('resetDraft re-seeds the nominal slots', async () => {
  await setSlotHolder({ year: YEAR, firstWeek: 21, holder: 'J' })
  await resetDraft(YEAR)
  const round = await getRound(YEAR)
  expect(round.slots.find((s) => s.firstWeek === 21)?.holder).toBe('D')
  expect(round.slots).toHaveLength(12)
})

test('lock seeds nominal slots when the admin never touched the draft', async () => {
  const admin = await insertMember('admin@test.oceanview.local', 'admin')
  await lock({ year: YEAR, userId: admin })
  const round = await getRound(YEAR)
  expect(round.lockedAt).toBeInstanceOf(Date)
  expect(round.slots).toHaveLength(12)
  expect(round.slots.find((s) => s.firstWeek === 21)?.holder).toBe('D')
})

test('locking twice raises SEASON_LOCKED; locked drafts reject mutations', async () => {
  const admin = await insertMember('admin@test.oceanview.local', 'admin')
  await lock({ year: YEAR, userId: admin })
  await expect(lock({ year: YEAR, userId: admin })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'SEASON_LOCKED',
  })
  await expect(setSlotHolder({ year: YEAR, firstWeek: 21, holder: 'A' })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'SEASON_LOCKED',
  })
  await expect(swapSlots({ year: YEAR, firstWeekA: 21, firstWeekB: 23 })).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'SEASON_LOCKED',
  })
  await expect(applySuggestion(YEAR)).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'SEASON_LOCKED',
  })
  await expect(resetDraft(YEAR)).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'SEASON_LOCKED',
  })
})

test('unlock reopens the round; unlocking an open round raises NOT_LOCKED', async () => {
  const admin = await insertMember('admin@test.oceanview.local', 'admin')
  await expect(unlock(YEAR)).rejects.toMatchObject({
    name: 'BookingDomainError',
    code: 'NOT_LOCKED',
  })
  await lock({ year: YEAR, userId: admin })
  await unlock(YEAR)
  const round = await getRound(YEAR)
  expect(round.lockedAt).toBeNull()
  // The draft survives unlock — admins adjust and re-lock.
  expect(round.slots).toHaveLength(12)
  // And mutations work again.
  await setSlotHolder({ year: YEAR, firstWeek: 21, holder: 'B' })
})

# Plan 03 — Service + domain errors (TDD, DB)

> Part of [season-booking](./README.md). Requires plans 01–02 committed. Steps use checkbox syntax for tracking. Dev DB must be up (`pnpm db:up`).

**Goal:** `src/lib/services/booking/` gains `errors.ts` + `booking.ts` (all DB access, check-first guards per ADR-0002) with every `BookingDomainError` code exercised in `booking.test.ts`.

**Pattern to copy:** the folder service (`src/lib/services/folder/{errors,folder}.ts`) — error class shape, tx-based guarded ops, `rejects.toMatchObject({ name, code })` test assertions.

**DB facts the tests rely on:** migrations run per-test (schema-per-test in `test/setup.ts`), and migration `0020_seed_season_era_anchor.sql` seeds the era `(2024, 21, 'J')` — so year **2026 resolves to startShare D, startWeek 21** without any test fixture (blocks: 21–22 D … 39–40 C; extras 19–20 / 41–42).

---

### Task 1: `errors.ts` + `booking.ts` service ops

**Files:**
- Create: `src/lib/services/booking/errors.ts`
- Create: `src/lib/services/booking/booking.ts`
- Create: `src/lib/services/booking/index.ts`
- Test: `src/lib/services/booking/booking.test.ts`

**Interfaces:**
- Consumes: schema tables from `~/lib/db/schema` (plan 01); `nominalSlotsForSeason`, `buildSuggestion`, `Slot`, `WishInput`, `BookingTarget`, `Suggestion` from `./logic` (plan 02); `listEras`/`seasonForYear` from `~/lib/services/season`; `listSharesWithCurrentOwner` from `~/lib/services/share`.
- Produces (plan 04 relies on these exact signatures):

  ```ts
  export type BookingDomainErrorCode = 'SEASON_LOCKED' | 'NOT_LOCKED' | 'NOT_YOUR_SHARE' | 'INVALID_TARGET'
  export class BookingDomainError extends Error { readonly code: BookingDomainErrorCode }

  export type WishRow = WishInput & { id: string }
  export type BookingRound = { year: number; lockedAt: Date | null; wishes: Array<WishRow>; slots: Array<Slot> }

  export function getRound(year: number): Promise<BookingRound>
  export function computeSuggestion(year: number): Promise<Suggestion>
  export function addWish(input: { year: number; shareCode: ShareCode; targetKind: BookingTarget; targetShare: ShareCode | null; actorUserId: string }): Promise<void>
  export function removeWish(input: { year: number; shareCode: ShareCode; targetKind: BookingTarget; targetShare: ShareCode | null; actorUserId: string }): Promise<void>
  export function applySuggestion(year: number): Promise<void>
  export function setSlotHolder(input: { year: number; firstWeek: number; holder: ShareCode | null }): Promise<void>
  export function swapSlots(input: { year: number; firstWeekA: number; firstWeekB: number }): Promise<void>
  export function resetDraft(year: number): Promise<void>
  export function lock(input: { year: number; userId: string }): Promise<void>
  export function unlock(year: number): Promise<void>
  ```

- Service ops take an explicit `year` (testable); **only procedures** (plan 04) pin it to the active year.
- The ADR's `ensureDraft` op is the internal `ensureDraftInTx` helper here (README locked decision 5).

- [ ] **Step 1: Write `errors.ts`**

Create `src/lib/services/booking/errors.ts`:

```ts
export type BookingDomainErrorCode =
  | 'SEASON_LOCKED'
  | 'NOT_LOCKED'
  | 'NOT_YOUR_SHARE'
  | 'INVALID_TARGET'

export class BookingDomainError extends Error {
  constructor(public readonly code: BookingDomainErrorCode) {
    super(code)
    this.name = 'BookingDomainError'
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/services/booking/booking.test.ts`:

```ts
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
  const [row] = await db.insert(user).values({ name: email, email, role }).returning({ id: user.id })
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
  await expect(
    addWish({ ...base, targetKind: 'share', targetShare: 'A' }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'INVALID_TARGET' })
  // 'share' kind without a target.
  await expect(
    addWish({ ...base, targetKind: 'share', targetShare: null }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'INVALID_TARGET' })
  // Extra kind with a target.
  await expect(
    addWish({ ...base, targetKind: 'extra_early', targetShare: 'D' }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'INVALID_TARGET' })
})

test('addWish rejects an actor who does not currently own the wishing share', async () => {
  const bert = await ownerOf('B', 'bert@test.oceanview.local')
  // Bert owns B, wishes as A.
  await expect(
    addWish({ year: YEAR, shareCode: 'A', targetKind: 'share', targetShare: 'D', actorUserId: bert }),
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
    addWish({ year: YEAR, shareCode: 'C', targetKind: 'extra_early', targetShare: null, actorUserId: carl }),
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
  await expect(
    addWish({ ...wish, targetShare: 'E' }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'SEASON_LOCKED' })
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
  await expect(
    setSlotHolder({ year: YEAR, firstWeek: 21, holder: null }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'INVALID_TARGET' })
})

test('setSlotHolder rejects an unknown slot', async () => {
  await expect(
    setSlotHolder({ year: YEAR, firstWeek: 99, holder: 'A' }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'INVALID_TARGET' })
})

test('swapSlots swaps two rotation holders and refuses extras', async () => {
  await swapSlots({ year: YEAR, firstWeekA: 21, firstWeekB: 23 })
  const round = await getRound(YEAR)
  expect(round.slots.find((s) => s.firstWeek === 21)?.holder).toBe('E')
  expect(round.slots.find((s) => s.firstWeek === 23)?.holder).toBe('D')
  await expect(
    swapSlots({ year: YEAR, firstWeekA: 19, firstWeekB: 21 }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'INVALID_TARGET' })
  await expect(
    swapSlots({ year: YEAR, firstWeekA: 21, firstWeekB: 21 }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'INVALID_TARGET' })
})

test('applySuggestion persists the recomputed suggestion', async () => {
  const anna = await ownerOf('A', 'anna@test.oceanview.local')
  const dave = await ownerOf('D', 'dave@test.oceanview.local')
  await addWish({ year: YEAR, shareCode: 'A', targetKind: 'share', targetShare: 'D', actorUserId: anna })
  await addWish({ year: YEAR, shareCode: 'D', targetKind: 'share', targetShare: 'A', actorUserId: dave })
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
  await expect(
    setSlotHolder({ year: YEAR, firstWeek: 21, holder: 'A' }),
  ).rejects.toMatchObject({ name: 'BookingDomainError', code: 'SEASON_LOCKED' })
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
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test:node src/lib/services/booking/booking.test.ts`
Expected: FAIL — `./booking` does not exist.

- [ ] **Step 4: Implement `booking.ts`**

Create `src/lib/services/booking/booking.ts`:

```ts
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

function assertValidTarget(shareCode: ShareCode, input: {
  targetKind: BookingTarget
  targetShare: ShareCode | null
}) {
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
  await tx.insert(seasonSlot).values(nominalSlotsForSeason(season).map((slot) => ({ ...slot, year })))
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
    await tx.insert(seasonSlot).values(nominalSlotsForSeason(season).map((slot) => ({ ...slot, year })))
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
```

- [ ] **Step 5: Write the barrel**

Create `src/lib/services/booking/index.ts`:

```ts
export * from './booking'
export * from './errors'
export * from './logic'
```

- [ ] **Step 6: Run to verify all tests pass**

Run: `pnpm test:node src/lib/services/booking/`
Expected: PASS — `logic.test.ts` (14) + `booking.test.ts` (15). If `swapSlots` with equal weeks surprises you: the guard is deliberate (a self-swap is a no-op request = client bug).

- [ ] **Step 7: Review checkpoint — test-completeness**

Dispatch the `test-completeness` agent (a new service + `errors.ts` landed). It must confirm all four `BookingDomainErrorCode` literals are exercised: `SEASON_LOCKED`, `NOT_LOCKED`, `NOT_YOUR_SHARE`, `INVALID_TARGET`. Address findings.

- [ ] **Step 8: Commit**

```bash
git add src/lib/services/booking/
git commit --no-gpg-sign -m "feat(booking): booking service with check-first guards and tests"
```

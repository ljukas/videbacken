# Plan 04 — oRPC procedures + realtime + client error map

> Part of [season-booking](./README.md). Requires plans 01–03 committed. Steps use checkbox syntax for tracking.

**Goal:** The `booking` router (code-only typed errors, year always server-derived), the `booking.changed` realtime kind end-to-end, and `bookingErrorMessage.ts` with its i18n keys.

**Pattern to copy:** `src/lib/orpc/procedures/folder.ts` (errors map + try/catch rethrow + `realtime.publish` after success) and `src/lib/orpc/folderErrorMessage.ts`.

---

### Task 1: `booking.changed` realtime kind

**Files:**
- Modify: `src/lib/effects/realtime/types.ts`
- Modify: `src/hooks/useRealtimeSync.ts`

**Interfaces:**
- Produces: `{ kind: 'booking.changed' }` as a `RealtimeEvent` variant; the client dispatch invalidates the whole `orpc.booking` namespace (coarse, per ADR-0004 — wish badges, draft and lock state all live under it).

- [ ] **Step 1: Add the event variant**

In `src/lib/effects/realtime/types.ts`, add to the `z.discriminatedUnion` array (before the `// Add per-entity variants here as they adopt.` comment):

```ts
  // Booking round changed: wishes, draft slots, or lock state (ADR-0020).
  // No ids — the round is one aggregate; coarse invalidation is right-sized.
  z.object({ kind: z.literal('booking.changed') }),
```

- [ ] **Step 2: Add the dispatch case**

The `switch` in `src/hooks/useRealtimeSync.ts` is exhaustively typed over `RealtimeEvent['kind']`, so the build now fails until this case exists. Add alongside the existing cases:

```ts
    case 'booking.changed':
      void queryClient.invalidateQueries({ queryKey: orpc.booking.key() })
      return
```

(`orpc.booking.key()` only typechecks after Task 3 registers the router — build these two tasks in the same working tree before running `tsc`; they land in one commit at the end of this plan.)

---

### Task 2: error i18n keys + `bookingErrorMessage.ts`

**Files:**
- Modify: `messages/sv.json`, `messages/en.json`
- Create: `src/lib/orpc/bookingErrorMessage.ts`

**Interfaces:**
- Produces: `bookingErrorMessage(code: BookingDomainErrorCode): string` — plans 05/06 call it in every mutation's `onError`; `m.booking_error_generic()` is the non-typed fallback.

- [ ] **Step 1: Add the error message keys**

In `messages/sv.json`, inserted alphabetically (the `booking_*` block is new; keep it internally sorted — later plans extend it):

```json
  "booking_error_generic": "Något gick fel med bokningen",
  "booking_error_invalid_target": "Ogiltigt val",
  "booking_error_not_locked": "Säsongen är inte låst",
  "booking_error_not_your_share": "Du äger inte den andelen",
  "booking_error_season_locked": "Säsongen är låst",
```

In `messages/en.json`, same position:

```json
  "booking_error_generic": "Something went wrong with the booking",
  "booking_error_invalid_target": "Invalid selection",
  "booking_error_not_locked": "The season is not locked",
  "booking_error_not_your_share": "You don't own that share",
  "booking_error_season_locked": "The season is locked",
```

Run: `pnpm i18n:compile`
Expected: succeeds; `m.booking_error_*` functions exist.

- [ ] **Step 2: Write the client error map**

Create `src/lib/orpc/bookingErrorMessage.ts`:

```ts
import type { BookingDomainErrorCode } from '~/lib/services/booking'
import { m } from '~/paraglide/messages'

// Booking procedures throw code-only oRPC typed errors (see
// procedures/booking.ts); the client owns booking-error i18n (ADR-0002
// amendment, folder precedent). `import type` is erased at build, so this
// pulls only the code union — no server runtime leaks into the client
// bundle. The exhaustive switch makes a missing case a compile error.
/** Localize a typed booking error code. */
export function bookingErrorMessage(code: BookingDomainErrorCode): string {
  switch (code) {
    case 'SEASON_LOCKED':
      return m.booking_error_season_locked()
    case 'NOT_LOCKED':
      return m.booking_error_not_locked()
    case 'NOT_YOUR_SHARE':
      return m.booking_error_not_your_share()
    case 'INVALID_TARGET':
      return m.booking_error_invalid_target()
  }
}
```

---

### Task 3: the `booking` router

**Files:**
- Create: `src/lib/orpc/procedures/booking.ts`
- Modify: `src/lib/orpc/router.ts`

**Interfaces:**
- Consumes: everything from `~/lib/services/booking` (plan 03), `seasonForYear`/`listEras`/`shareBlocksForSeason`/`monthBandsForRange` from `~/lib/services/season`, `listSharesWithCurrentOwner` from `~/lib/services/share`.
- Produces (plans 05/06 consume these exact payloads):

  ```ts
  // orpc.booking.getActive (protected) →
  {
    year: number
    lockedAt: Date | null
    blocks: {
      early: { firstWeek: number; lastWeek: number }
      rotation: Array<{ firstWeek: number; lastWeek: number; shareCode: ShareCode }>
      late: { firstWeek: number; lastWeek: number }
    }
    monthBands: Array<MonthBand>            // over [early.firstWeek, late.lastWeek]
    wishes: Array<{ id: string; shareCode: ShareCode; targetKind: BookingTarget; targetShare: ShareCode | null }>
    assignedShares: Array<ShareCode>
    lockedSchedule: Array<Slot> | null      // slots ONLY when locked — the draft never transits this payload
  }
  // orpc.booking.getDraft (admin) →
  { year: number; draftExists: boolean; slots: Array<Slot>; suggestion: Suggestion }
  // Mutations (all return void, all publish booking.changed):
  //   addWish/removeWish (protected): { shareCode, targetKind, targetShare }
  //   applySuggestion(), resetDraft(), lock(), unlock() (admin, no input)
  //   setSlotHolder (admin): { firstWeek, holder }
  //   swapSlots (admin): { firstWeekA, firstWeekB }
  ```

- [ ] **Step 1: Write the procedures**

Create `src/lib/orpc/procedures/booking.ts`:

```ts
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
      assignedShares: assignments
        .filter((a) => a.currentUserId !== null)
        .map((a) => a.shareCode),
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
      slots:
        round.slots.length > 0 ? round.slots : bookingService.nominalSlotsForSeason(season),
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
```

- [ ] **Step 2: Register the router**

In `src/lib/orpc/router.ts`, add the import and the key (alphabetical — between `bin` and `document`):

```ts
import { bookingRouter } from './procedures/booking'
```

```ts
  bin: binRouter,
  booking: bookingRouter,
  document: documentRouter,
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm check && pnpm build`
Expected: Biome clean; build + `tsc --noEmit` pass. This proves the realtime union/dispatch exhaustiveness (Task 1), the error-map `satisfies`, and the router registration all line up. There are no unit tests for procedures — they are thin glue over the tested service (codebase convention).

- [ ] **Step 4: Commit**

```bash
git add src/lib/effects/realtime/types.ts src/hooks/useRealtimeSync.ts src/lib/orpc/procedures/booking.ts src/lib/orpc/router.ts src/lib/orpc/bookingErrorMessage.ts messages/sv.json messages/en.json
git commit --no-gpg-sign -m "feat(booking): booking router, realtime kind and client error map"
```

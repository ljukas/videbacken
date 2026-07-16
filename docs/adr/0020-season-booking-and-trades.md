# ADR 0020 — Season booking: trade wishes, suggested trades, and locking

- **Status**: Accepted
- **Date**: 2026-07-06
- **Deciders**: Lukas
- **Decision in one line**: A per-season **booking round** sits above the Disponeringslista on the calendar page: owners mark consent-based **trade wishes** against other shares and **extra-period marks** (weeks 19–20, 41–42, and unassigned shares' blocks); a pure **cycle-solver suggestion** helps admins rearrange a persisted, admin-only **draft** of 12 concrete-week **slots**; admins **lock** (reversibly) to publish everyone's final weeks. The Disponeringslista below stays purely nominal.

> **Handoff note.** This ADR is the complete design record — it was written to survive a full context clear. Together with CLAUDE.md it should be enough to plan and build the feature from scratch. Current state at time of writing: design approved, no implementation exists. Work lives on branch `feat/season-booking`, stacked on `feat/whole-share-calendar-cells` (5 unmerged commits the booking UI builds on — the whole-share block rendering of `DisponeringslistaTable`); rebase onto `main` once that PR squash-merges. Next step per `docs/feature-workflow.md`: Phase 2 (`superpowers:writing-plans` → `docs/plans/season-booking/`), then build layer by layer.

---

## Context

Seasons are computed from eras (ADR-0019): 10 indivisible shares (ADR-0018) × 2 consecutive weeks, weeks 21–40, start share rotating −3 positions/year (2024 J, 2025 G, 2026 D…). The Disponeringslista renders every year nominally; owners' blocks are highlighted via `share.listMine`.

The nominal rotation is only the *default*. In practice the group rearranges each season: owners who can't sail their assigned weeks swap with each other, the two shoulder periods (weeks 19–20 before and 41–42 after the season) are up for grabs, and any unassigned share's weeks are free capacity. Today this negotiation happens off-app and has no record. The group wants it in the app, with the admins keeping final say.

ADR-0019's revisit trigger anticipated exactly this: *"Bookings or usage records tied to specific weeks appear → they must store concrete dates/weeks, never derive them from era math at read time."* This ADR honors that verbatim.

### Product decisions (settled with the group, 2026-07-06)

These were explicit decisions during design — do not relitigate without new input:

1. **Trades are consent-based swaps/cycles.** A share marks other shares it would accept a trade with ("I'd take D's or F's weeks"). The suggestion only ever moves a share to weeks it explicitly wished for — as mutual swaps (A↔D) or longer cycles (A→D→F→A). Nobody is moved involuntarily *by the suggestion*; admins may still move anyone manually.
2. **The active season is the next coming one.** The booking view targets season year Y from the start of ISO week 43 of the previous year (right after extra weeks 41–42 end) until the start of ISO week 43 of year Y. There is exactly one active round; no admin "open round" step.
3. **Extra periods are not trades.** Weeks 19–20 and 41–42, plus the block of any **unassigned** share, are marked as "I'd also sail this" — the marker keeps its own weeks and gets the extra as a bonus.
4. **Extra allocation**: whoever holds the season's first block (weeks 21–22) *after trades* and marked 19–20 gets it automatically; likewise the last block (39–40) → 41–42. Any extra without an adjacency grant (a shoulder block the adjacent holder didn't mark, or an unassigned share's block) is auto-granted when **exactly one** share is interested; **contested** extras (several interested) are left for the admin to assign manually. No fairness algorithm.
5. **Everyone sees all wishes** while the round is open (transparency helps cycles form in a 10–20 person group).
6. **The draft is admin-only and persisted.** Owners keep seeing the nominal schedule + wish overlay until lock; the rearranged schedule becomes visible to everyone only at lock. (Explicitly chosen over a live shared draft and over a client-only editing session.)
7. **Lock is reversible.** Admins can unlock, adjust, and re-lock.
8. **The Disponeringslista stays nominal.** Reality lives in the booking section above it; the rotation table below never changes. ("Convention below, reality above.")
9. **No email at lock in v1.** The in-app schedule is the announcement. (Queue-topic effect is a natural later add, ADR-0007/0008.)
10. **Wishes are per share.** An owner holding several shares wishes separately as each share. Only current owners of a share may manage its wishes (checked against active `ownership_assignment` rows); admins without shares arrange but don't wish.

---

## Decision (TL;DR)

1. **Slot model.** A booking round materializes as **12 slots** — extra 19–20, the ten rotation blocks 21–22…39–40, extra 41–42 — each storing its **concrete `first_week`/`last_week`** and a nullable `holder` share. A share may hold several slots (its own block + an extra + an unassigned share's block); an unassigned share left holding its slot means nobody sails those weeks.
2. **Three tables** (`src/lib/db/schema/booking.ts`): `season_booking` (year PK + lock stamp), `season_wish`, `season_slot`. Schema below.
3. **Pure suggestion solver** in service logic (no DB): max-coverage vertex-disjoint cycles over the wish digraph (n=10, exhaustive, deterministic), then the extra auto-rules (§Product decision 4).
4. **Slots are created lazily** on first admin action (apply suggestion / manual move / lock). Until then owners' view is computed nominal + wish overlay. Lock seeds nominal slots if the admin never touched the draft.
5. **Code-only typed errors** (folder/document precedent, ADR-0002 amendment), mapped client-side in `bookingErrorMessage.ts`.
6. **Realtime** via new `booking.changed` kind (ADR-0004): wish badges and the lock flip live-update.
7. **UI**: a `BookingSection` above the Disponeringslista reusing its visual grammar (month bands, week row, pastel share blocks, owned-ring), with Linear-lifted interaction language — tinted status chips, avatar-stack wish chips, **select-then-act** admin editing (no drag-and-drop in v1), calm 120–160 ms reduced-motion-aware micro-motion (ADR-0015).

---

## Alternatives considered

- **Trade-record / event-sourced model** — store executed trades and extra grants as immutable rows (ADR-0018 history spirit); schedule = nominal ⊕ replay. Rejected: admin manual moves aren't cycles so record types get awkward; every read replays; corrections mean compensating records. More machinery than 20 users need.
- **Single `jsonb` draft document** on the booking row. Rejected: no per-row constraints, weaker Drizzle typing, clumsy optimistic/realtime diffing. Saves little.
- **Unilateral wishes** (marking D can move D's owner involuntarily). Rejected by the group — consent only.
- **Mutual-only swaps** (no cycles). Rejected: misses three-way rotations that satisfy everyone.
- **Client-only draft, persist at lock.** Rejected: a half-done rearrangement dies with the tab.
- **System-proposed fair allocation of contested extras** (rotation/random priority). Rejected: a fairness rule the group must agree on and the app must explain; admin judgment is cheaper at this scale.
- **Drag-and-drop arranging** (dnd-kit). Deferred, not rejected: real dependency, fiddly with a table layout and touch; select-then-act matches Linear's language and the command-palette direction (ADR-0014). Revisit trigger below.
- **Admin "open round" step / rolling rounds** for timing. Rejected in favor of the fixed ISO-week-43 flip — no round-management state or UI.

---

## Architecture

### Schema (`src/lib/db/schema/booking.ts`, re-export from `schema/index.ts`)

New enums: `booking_target` = `'share' | 'extra_early' | 'extra_late'`; `slot_kind` = `'rotation' | 'extra'`. Reuses `share_code` from `ownership.ts`.

```
season_booking                      -- one row per booking round, created lazily (upsert)
  year        integer PRIMARY KEY
  locked_at   timestamptz NULL      -- NULL = round open
  locked_by   uuid NULL → user.id ON DELETE SET NULL
  created_at  timestamptz NOT NULL DEFAULT now()

season_wish
  id             uuid PK DEFAULT gen_random_uuid()
  year           integer NOT NULL → season_booking.year ON DELETE CASCADE
  share_code     share_code NOT NULL        -- the wishing share
  target_kind    booking_target NOT NULL
  target_share   share_code NULL            -- set iff target_kind = 'share'
  actor_user_id  uuid NULL → user.id ON DELETE SET NULL   -- who clicked (ADR-0018 precedent)
  created_at     timestamptz NOT NULL DEFAULT now()
  UNIQUE (year, share_code, target_kind, target_share) NULLS NOT DISTINCT
    -- NULLS NOT DISTINCT is required: extra wishes have NULL target_share and
    -- would otherwise duplicate freely. Drizzle: unique(...).nullsNotDistinct().
  CHECK ((target_kind = 'share') = (target_share IS NOT NULL))
  CHECK (target_share IS NULL OR target_share <> share_code)

season_slot                         -- the admin draft; becomes THE schedule at lock
  year        integer NOT NULL → season_booking.year ON DELETE CASCADE
  first_week  integer NOT NULL     -- concrete weeks per ADR-0019's revisit trigger:
  last_week   integer NOT NULL     -- never derived from era math at read time
  kind        slot_kind NOT NULL
  holder      share_code NULL      -- NULL only on extras = nobody sails them
  PRIMARY KEY (year, first_week)
  CHECK (first_week BETWEEN 1 AND 53); CHECK (last_week BETWEEN 1 AND 53)
  CHECK (last_week > first_week)
  CHECK (kind = 'extra' OR holder IS NOT NULL)   -- rotation slots always held
```

Extra blocks are **derived from the governing era**, not hardcoded: one `WEEKS_PER_SHARE`-wide block ending just before `startWeek` (today 19–20) and one starting just after the last rotation block (today 41–42), so they follow a future convention change. Week numbers 19/41 appear nowhere in code.

Migration: one generated migration, `pnpm db:generate --name=add_season_booking`. Nothing destructive; no data seed.

### Service (`src/lib/services/booking/` — `booking.ts`, `logic.ts`, `errors.ts`, tests, `index.ts` barrel)

`logic.ts` — pure, era-fed, no DB (mirrors `services/season/logic.ts`):

- `activeSeasonYearFor(date)` — ISO-week flip: `getISOWeek(date) >= 43 ? getISOWeekYear(date) + 1 : getISOWeekYear(date)`. Using the ISO week-numbering year makes the early-January edge (Jan 1 falling in week 53 of the old year) resolve correctly.
- `extraBlocksForSeason(era math)` — the two shoulder blocks for a year.
- `nominalSlotsForSeason(...)` — the 12 seed slots (rotation holders from `shareBlocksForSeason`, extras holder-NULL).
- `buildSuggestion(input)` → `{ assignments, satisfiedShares, autoExtras, openExtras }`.
  - Input: the year's nominal blocks, the wish rows, and the set of currently **assigned** share codes (from active `ownership_assignment` rows).
  - Step 1 — trades: digraph over assigned shares only; edge A→D iff A has a `'share'` wish targeting D **and D is assigned** (a `'share'` wish targeting an unassigned share is an extra-interest, not an edge — semantics resolve at suggestion time, so a share getting assigned mid-round flips pending wishes on it from bonus-interest to trade-edge, which is accepted). Find the set of vertex-disjoint cycles (length ≥ 2) covering the **most vertices**; every covered share moves to a block it wished for, everyone else stays. Deterministic tie-break: exhaustive enumeration in canonical share order, first maximum wins.
  - Step 2 — adjacency extras: whoever holds the first rotation block after step 1 and wished `extra_early` gets the early block; same for the last block → `extra_late`.
  - Step 3 — sole-interest extras: an extra (shoulder block without an adjacency grant, or an unassigned share's block) with exactly one interested share is auto-granted; with several, it lands in `openExtras` (block + interested shares) for manual admin assignment.

`booking.ts` — all DB access (ADR-0002). Reads active `ownership_assignment` rows directly (read-only reuse of the table the share service owns). Ops, all check-first with `BookingDomainError`:

- `getRound(year)` — booking row + wishes + slots in one read.
- `addWish` / `removeWish` — guards: round not locked (`SEASON_LOCKED`); actor currently owns the wishing share (`NOT_YOUR_SHARE`); target isn't the wishing share itself (`INVALID_TARGET`). Creates the `season_booking` row lazily.
- `ensureDraft(year)` — upsert booking row + seed the 12 nominal slots if absent.
- `applySuggestion(year)` — recompute server-side from current wishes (never trusts a client payload) and overwrite all 12 slots.
- `setSlotHolder(year, firstWeek, holder | null)` / `swapSlots(year, a, b)` — manual moves; guard not-locked; unknown slot → `INVALID_TARGET`. Clearing (`null`) only on extras, and swaps only between rotation slots (an extra's NULL holder must never land on a rotation slot — the CHECK backstops both); extras change via `setSlotHolder`.
- `resetDraft(year)` — re-seed nominal slots (escape hatch after messy experimentation).
- `lock(year, userId)` — seeds the draft if the admin never touched it, then stamps `locked_at`/`locked_by`; already locked → `SEASON_LOCKED`.
- `unlock(year)` — not locked → `NOT_LOCKED`.

`errors.ts` — `BookingDomainError`, code union: `'SEASON_LOCKED' | 'NOT_LOCKED' | 'NOT_YOUR_SHARE' | 'INVALID_TARGET'`. Every code exercised in `booking.test.ts` (ADR-0002).

### Procedures (`src/lib/orpc/procedures/booking.ts`, registered in `router.ts`)

Thin glue; **code-only typed errors** via `.errors()` (status only), client maps codes → Swedish/English in `src/lib/orpc/bookingErrorMessage.ts` (type-only import, exhaustive switch, `isDefinedError` narrowing — same pattern as `folderErrorMessage.ts`).

- `booking.getActive` (protected) — the one owner read: `{ year, lockedAt, blocks, wishes, lockedSchedule? }` where `blocks` = nominal rotation + the two extras and `lockedSchedule` = the slots **only when locked**. The unlocked draft is never in this payload — admin-only state must not transit a shared cache. The server computes and ships `year` (`activeSeasonYearFor(now)`) so SSR and client share one clock (precedent: `currentYear` in `season.listSchedules`).
- `booking.getDraft` (admin) — slots + `buildSuggestion` computed on the fly (the panel always reflects current wishes).
- `booking.addWish` / `booking.removeWish` (protected) — input: target only; year is server-derived from the active round.
- `booking.applySuggestion` / `booking.setSlotHolder` / `booking.swapSlots` / `booking.resetDraft` / `booking.lock` / `booking.unlock` (admin).

All mutations publish `realtime.publish({ kind: 'booking.changed' })` after success (ADR-0001 ordering, ADR-0004 conventions); `useRealtimeSync` invalidates the `orpc.booking` namespace. Add the variant to `src/lib/effects/realtime/types.ts`.

### Route wiring

`src/routes/_authenticated/index.tsx`: loader adds `queryClient.ensureQueryData(orpc.booking.getActive.queryOptions())`; page mounts `<BookingSection …>` above `<DisponeringslistaTable …>`. Admins fetch `getDraft` lazily when entering arrange mode (keeps the owner payload lean).

### UI (`src/components/booking/`)

Design stance: ADR-0015's "quiet nautical confidence" with **Linear's interaction language** lifted — tinted status chips, avatar-stack chips, select-then-act editing, keyboard-first, tabular numerals, calm reduced-motion-aware micro-motion (120–160 ms ease-out). The strip reuses the Disponeringslista's visual grammar (month bands, week-number row, pastel `bg-share-*` blocks, `ring-2 ring-inset ring-foreground` owned-ring) so the page reads as one system. *The group expects visual refinement during the build's browser-verification phase (Phase 6) — treat the details below as the starting composition, not pixel law.*

- **`BookingSection.tsx`** — header (`Bokning {year}`, heading style matching the Disponeringslista title) + status chip: `● Öppen för önskemål` (brand-tinted) / `Låst {date}` (muted, lock icon; chip dropdown holds `Lås upp…` for admins). Admin buttons right: `Ordna`, `Lås säsong`. Multi-share owners get a compact `Önskar som: A · B` segmented control (hidden when owning one share). Helper line under the strip for share-owners while open: *"Klicka på ett block du vill byta till"*; share-less users see a view-only strip.
- **`BookingStrip.tsx`** (≥lg) — one-year table spanning weeks 19–42: dashed/ghost extra block, ten pastel rotation blocks, ghost extra. Month bands recomputed for the extended range (reuse `monthBandsForSeason` generalized or a local variant over 24 weeks). **`BookingCards.tsx`** (<lg) — card layout mirroring the Disponeringslista's `MobileLayout`; tap = same toggle.
- **`WishChips.tsx`** — per-block stack of small share-letter chips (share pastels) showing who wished for it; own wish brand-accented. Blocks are buttons: `aria-pressed`, label like `Önska byte med D, veckor 25–26`; Enter toggles.
- **`SuggestionPanel.tsx`** (admin, arrange mode) — quiet banner: *"Förslaget uppfyller {satisfied} av {total} önskemål"* + move pills (`A ↔ D`, `B → E → H → B`, `19–20 → D`) + `Använd förslaget`.
- **`ArrangeBar.tsx`** (admin) — select-then-act: click block → brand ring + slim action bar (*"Byt med … — välj ett annat block · Esc avbryter"*); click target → swap with a brief settle. Extra/unassigned slots open a popover: interested shares first, then all shares + `Töm`. `Utkast — endast synligt för admins` chip while a draft exists; ghost `Återställ`.
- **Locked view** — strip shows the final schedule (slots), extras show holder letters, wishes hidden, owner summary line: *"Dina veckor {year}: 25–26 + 41–42"*.

Mutation UX per the standing rules: wish toggles and admin moves are **optimistic instant** (paint in `onMutate`, always `invalidateQueries` in `onSettled`, callbacks in `mutationOptions` so they survive unmount); lock/unlock stay **pessimistic** behind `AlertDialog` confirms.

### i18n

Flat `booking_*` keys in `messages/{sv,en}.json`, sv source of truth, en key-complete. Parameterized: suggestion count, week ranges, year. Message *functions* in module constants, called at render.

---

## Consequences

- **CLAUDE.md updates** (during implementation): code map (`services/booking`, `procedures/booking`, `components/booking`), skill-router row ("Booking & trades → ADR-0020"), decision bullet, realtime kind list implicitly via ADR-0004 conventions.
- **ADR-0019 revisit trigger consumed**: bookings store concrete weeks in `season_slot`; era math is only used to *seed* and to render the nominal overlay pre-draft.
- If an era convention change ever lands (ADR-0019 runbook), open unlocked rounds seeded before it would hold stale weeks — acceptable: reset the draft. Locked history is frozen weeks by design.
- The active-year flip at ISO week 43 is computed server-side in UTC; around the flip boundary a client can be up to an hour "late" (same posture as ADR-0019's New-Year note). Irrelevant in practice.
- A locked season's slots are the durable record of what the group actually sailed — future features (usage stats, history views) read slots, never recompute.
- `season_wish` rows are kept after lock (frozen, hidden in UI) — they're the record of what was asked for; no pruning job.

## Files

- `src/lib/db/schema/booking.ts` (+ `schema/index.ts` barrel) — `drizzle/<next>_add_season_booking.sql` (number falls out of `pnpm db:generate --name=add_season_booking` at build time)
- `src/lib/services/booking/{booking,logic,errors}.ts` + `{booking,logic}.test.ts` + `index.ts`
- `src/lib/orpc/procedures/booking.ts`, `src/lib/orpc/bookingErrorMessage.ts`, `router.ts` registration
- `src/lib/effects/realtime/types.ts`, `src/hooks/useRealtimeSync.ts` — `booking.changed`
- `src/components/booking/{BookingSection,BookingStrip,BookingCards,WishChips,SuggestionPanel,ArrangeBar}.tsx` + `BookingSection.browser.test.tsx`
- `src/routes/_authenticated/index.tsx` — prefetch + mount
- `messages/{sv,en}.json` — `booking_*` keys

## Verification

- `pnpm test` green. `logic.test.ts`: week-43 flip incl. a 53-week ISO year; extra derivation from a non-default era; solver — mutual swap, 3-cycle, overlapping-cycle max coverage, deterministic tie-break, adjacency rule after trades, sole-interest grant vs contested-open, unassigned shares excluded from the digraph. `booking.test.ts`: every error code, wish uniqueness (incl. the NULLS NOT DISTINCT extra case), lazy round creation, lock-seeds-nominal, unlock.
- Browser pass: owner marks/unmarks wishes (badges live-update in a second tab), multi-share selector, admin suggestion → apply → manual swap → lock → owner sees final weeks + summary line, unlock reverts to open state, mobile cards, both themes, `prefers-reduced-motion`.

## Revisit triggers

- Group wants an email at lock → queue topic + React Email template (ADR-0007/0008), effect after `lock` succeeds.
- Arrange mode feels clunky → dnd-kit drag-and-drop as a progressive enhancement over the same slot mutations.
- Wish deadlines / reminders ("lock by week 15") → needs scheduled jobs; out of scope now.
- The group wants to see *past* locked seasons in the Disponeringslista → a read of historical `season_slot` rows; deliberately not in v1 (nominal-only table).
- Share count or weeks-per-share changes → new ADR (slots absorb it structurally; the solver and strip layout are share-count-agnostic).

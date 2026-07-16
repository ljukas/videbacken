# Season Booking Implementation Plan — ADR-0020

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute the numbered plan files **in order**; each ends in a commit and a review checkpoint.

**ADR (required reading before any task):** [`docs/adr/0020-season-booking-and-trades.md`](../../adr/0020-season-booking-and-trades.md) — the complete design record. This plan is the *how*; the ADR is the *what/why*. When plan and ADR disagree on intent, the ADR wins; when the ADR sketches and the plan concretizes (exact names, shapes, code), the plan wins.

**Goal:** A per-season booking round above the Disponeringslista on `/`: owners mark consent-based trade wishes and extra-period marks per share; admins get a pure cycle-solver suggestion, a persisted admin-only 12-slot draft, and a reversible lock that publishes everyone's final weeks.

**Architecture:** Three new tables (`season_booking`, `season_wish`, `season_slot`) storing concrete weeks; a pure, DB-free suggestion solver in `src/lib/services/booking/logic.ts`; a check-first service (`booking.ts`) raising `BookingDomainError`; code-only typed oRPC errors mapped client-side; a new `booking.changed` realtime kind; a `BookingSection` component family reusing the Disponeringslista's visual grammar.

**Tech stack:** TypeScript, Drizzle (Postgres 17 / Neon), oRPC + TanStack Query, React 19 + TanStack Start, Tailwind v4 + shadcn/ui, Paraglide i18n, Vitest (node + Browser Mode).

## Branch state (as of 2026-07-06)

- Work happens on **`feat/season-booking`** (already checked out; ADR-0020 is its latest commit `73f3c4f`).
- The branch is **stacked on `feat/whole-share-calendar-cells`** — the whole-share block rendering of `DisponeringslistaTable` that the booking UI reuses is in this branch's history but **not yet on `main`**.
- Before shipping (plan 07): if the whole-share PR has squash-merged, rebase `feat/season-booking` onto `main`. **Rebase + force-push require explicit user confirmation first** (user's global rule: no destructive git without asking).

## Locked decisions — do not relitigate without new input

**From the ADR** (product decisions 1–10 + TL;DR; see the ADR for rationale): consent-based swaps/cycles only; active round = next season, flipping at ISO week 43; extras are marks, not trades; adjacency-then-sole-interest extra allocation, contested extras left to admins; all wishes visible to everyone while open; draft persisted + admin-only; lock reversible; Disponeringslista below stays nominal; no email at lock; wishes are per share, managed only by current owners.

**Fixed by this plan** (concretizations an executor must not silently change):

1. **`year` is always server-derived.** No booking procedure accepts a year input — every read and mutation targets `activeSeasonYearFor(new Date())`. Locked history is therefore immutable through the API by construction.
2. **Solver = bitmask-DP max-coverage vertex-disjoint cycles** with canonical (A→J) enumeration and strictly-greater-coverage replacement, so the first maximum found wins ties deterministically (plan 02 contains the reference implementation; tests pin the tie-break).
3. **`Suggestion.slots` is the ADR's `assignments` field, concretized**: the full 12-slot draft. `applySuggestion` recomputes it server-side and persists exactly that.
4. **Wish rows from currently-unassigned shares are ignored entirely by the solver** (no edges, no extra-interest) — an unassigned share has no owner to sail its wishes. Rows may linger after mid-round unassignment; semantics resolve at suggestion time (ADR §Step 1 extended to the wisher side).
5. **The draft is seeded lazily by any admin mutation** (`setSlotHolder` / `swapSlots` / `applySuggestion` / `lock` seed nominal slots if none exist). The ADR's `ensureDraft` op is the internal `ensureDraftInTx` helper, not a procedure. `getDraft` never writes — it computes nominal slots on the fly while none are persisted and reports `draftExists`.
6. **The unlocked draft never transits `booking.getActive`** — owners get nominal blocks + wishes; `lockedSchedule` is only non-null when locked (admin-only state stays out of the shared cache, ADR §Procedures).
7. **`BookingSection` takes its data as props** (route owns the `useSuspenseQuery`), keeping it free of router hooks so it's browser-testable with the existing harness (no `RouterProvider` exists in `test/browser/render.tsx`).
8. **`monthBandsForSeason` is generalized via a new `monthBandsForRange`** in `src/lib/services/season/logic.ts` (season variant delegates; behavior unchanged) to band the 24-week booking strip.
9. **Wish-toggle disable rule:** a block is un-wishable only when locked, when the user holds no share, or when the block's target share **is the acting share itself** (a multi-share owner acting as A may legally wish own share B's block; only self-target is invalid).
10. **Mutation UX:** wish toggles and admin `setSlotHolder`/`swapSlots` are optimistic-instant (paint in `onMutate` via `optimisticReplace`, invalidate `orpc.booking.key()` in `onSettled`, callbacks in `mutationOptions`); `applySuggestion`/`resetDraft` are plain pending-disabled mutations; `lock`/`unlock` are pessimistic behind `AlertDialog` confirms.
11. **The ISO-week-43 flip is a named constant** (`ACTIVE_FLIP_WEEK = 43`) in booking logic — deliberately *not* era math, because deriving "the week after the late extra" needs the governing era, which needs the year (circular). ADR decision 2 fixed 43. The two shoulder blocks *are* era-derived (weeks 19/41 appear nowhere in code).

## Plans

| # | Plan | Layer | Review checkpoint |
|---|---|---|---|
| 01 | [Schema + migration](./01-schema.md) | `src/lib/db/schema/booking.ts`, migration 0022 | `migration-guard` agent |
| 02 | [Pure logic](./02-logic.md) | `booking/logic.ts` (+ `monthBandsForRange`), TDD | — |
| 03 | [Service + errors](./03-service.md) | `booking/{booking,errors}.ts` + DB tests | `test-completeness` agent |
| 04 | [API + realtime](./04-api.md) | procedures, `bookingErrorMessage`, `booking.changed` | — |
| 05 | [Owner UI](./05-ui-owner.md) | `BookingSection`/`BookingStrip`/`BookingCards`/`WishChips`, wish toggles, route mount | browser tests |
| 06 | [Admin UI](./06-ui-admin.md) | arrange mode, `SuggestionPanel`, `ArrangeBar`, lock/unlock | browser tests |
| 07 | [Verify + ship](./07-verify-ship.md) | full suite, reviews, live pass, CLAUDE.md, PR | `code-reviewer` agent |

Sequencing is strict (each layer consumes the previous one's exports); only i18n key entry inside 05/06 could be parallelized, and it isn't worth the coordination.

## Cross-cutting rules (every task implicitly includes these)

- **Commits:** Conventional Commits, always `git commit --no-gpg-sign` (signing prompts hang the session). One commit per task as specified.
- **i18n:** user-facing strings only via `m.<key>()` from `~/paraglide/messages`; `messages/sv.json` is source of truth, `en.json` stays key-complete; keys are flat `booking_*`, inserted alphabetically. After editing messages outside `pnpm dev`: `pnpm i18n:compile`. Module-level constants store the message *function*, called at render.
- **No `console.*`** (ADR-0003). Services/procedures use `context.log` / nothing; this feature needs no new logging.
- **All DB access in `src/lib/services/booking/`** (ADR-0002); reading `ownership_assignment` directly from booking code is sanctioned by ADR-0020 ("read-only reuse of the table the share service owns").
- **Styling:** semantic tokens only (`bg-muted`, `text-muted-foreground`, `bg-brand/10`, share pastels via `shareBackgroundClass`); `gap-*` not `space-y-*`; `size-*` for equal dimensions; en dash `–` (U+2013) in week ranges; every screen responsive; motion 120–160 ms with `motion-reduce:transition-none`.
- **No new dependencies.** Everything needed (date-fns 4, drizzle 0.45, shadcn components incl. `alert-dialog`, `popover`, `dropdown-menu`, `toggle-group`) is already installed.
- **Never hand-edit** `src/routeTree.gen.ts`, `src/paraglide/`, `betterAuth.ts`, or files under `drizzle/meta/`.
- Dev DB must be running for DB tests/migrations: `pnpm db:up` (or full `pnpm dev:up`).

## Execution handoff (next session starts here)

1. Read the ADR, this README, then plan 01.
2. Choose: **subagent-driven** (`superpowers:subagent-driven-development`, fresh subagent per task, review between tasks — recommended) or **inline** (`superpowers:executing-plans`).
3. `git log --oneline -3` to confirm you're on `feat/season-booking` at/after `73f3c4f`; run `pnpm db:up && pnpm test:node src/lib/services/season/logic.test.ts` as a green-baseline sanity check before Task 1.

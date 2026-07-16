# ADR 0018 — Indivisible Shares

- **Status**: Accepted
- **Date**: 2026-07-05
- **Deciders**: Lukas
- **Decision in one line**: A share (A–J) is **indivisible** — at any moment it is owned whole by exactly one user or unassigned. The `share_part` table, the split-assignment path, and the `ownership_assignment_event` grouping table are removed; `ownership_assignment` references the `share_code` enum directly and carries `actor_user_id` itself. Season/calendar math is untouched (20 weeks, 2 consecutive weeks per share, 6-week slip per season — the existing `-3` share-position rotation, now documented in weeks).

---

## Context

The original ownership model (ADR-0002 patterns, migrations `0001`/`0002`/`0007`/`0008`) split every share into two halves (`A1`/`A2`) in a seeded `share_part` table:

- **Ownership** pointed at parts. An admin could assign a share *whole* (both halves, one user) or *split* (each half to a different user). Because splits could fragment ownership, ADR-0009 Rule 1 ("every owner holds at least one whole share", `LEAVES_USER_WITH_ONLY_HALVES`) existed to police the fragments, and `collapseShares` existed to render an `A1+A2` pair as a single "A" badge.
- **History** grouped the two per-part rows of one admin decision under a parent `ownership_assignment_event` row ("assignment events are first-class", 2026-05-27), with a `whole`/`split`/`partial` kind computed from the children at read time.
- **Calendar** used parts as the week unit: `partForWeek` maps each of the 20 season weeks to a part, shares advancing every 2 weeks.

The co-ownership group has since settled the question the split feature hedged on: **shares are not divided between people**. A share is one unit — one owner, both of its season weeks. The split path, and all the machinery whose only purpose was to manage or contain splits, is now dead weight.

We are **pre-launch**: the production database can be reset and existing assignment rows are disposable, so the migration does not need to map part-level data forward.

### What is *not* changing

The season structure is a physical truth of the group and stays exactly as coded:

- 20 weeks per season, each share covering **2 consecutive weeks**.
- The schedule slips **6 weeks per season** for every share (e.g. share A: weeks 21/22 → 27/28 the next year). This is what `DEFAULT_YEAR_ROTATION = -3` *already produces* — the constant is measured in share positions (× 2 weeks each). The rework only re-documents the constant in weeks; behavior is identical.
- Per-share ownership **history** stays a first-class feature. Assignment rows are only ever *closed* (`assigned_to` set), never deleted, so each share keeps its complete timeline of ownership stints.

---

## Decision (TL;DR)

**The `share_code` enum *is* the share.** There is no share table at all — the same way `season.start_share` already references the enum directly.

1. **Schema**: drop `share_part`, `ownership_assignment_event`, and the old `ownership_assignment`; create a new `ownership_assignment` with `share_code` (enum, not null), `user_id`, `actor_user_id` (nullable, folded in from the event table), `assigned_from`/`assigned_to` (same half-open semantics), and `created_at`. One partial unique index enforces a single active owner per share. The event table's never-written `note` column is dropped, not carried over.
2. **Events collapse into assignments.** With whole-share assignment, every "event" would have exactly one child — a 1:1 wrapper that fails the deletion test. History becomes a flat list of assignment rows; the `whole`/`split`/`partial` kind disappears.
3. **ADR-0009 Rule 1 is retired** — *defined out of existence*. Every assignment is a whole share, so "a user left with only halves" is unrepresentable. `assertEveryAffectedUserHasWhole` and `LEAVES_USER_WITH_ONLY_HALVES` are deleted.
4. **Vocabulary**: `collapseShares` and the part badge variant are deleted (a user's holdings are a `ShareCode[]`); `PARTS_PER_SHARE` becomes `WEEKS_PER_SHARE = 2` (a calendar truth, not an ownership one); `sharePartId`/`SharePartId` die; `partForWeek` becomes `shareForWeek`.
5. **Migration strategy**: one appended migration (`0018`, `--name=indivisible_shares`) that drops and recreates — history `0000`–`0017` stays untouched (editing the share migrations in place would desync drizzle-kit's snapshot chain). Prod/dev databases are reset per the pre-launch posture.

---

## Alternatives considered

- **Keep `ownership_assignment_event`, drop only `share_part`.** Preserves the parent/child history structure "in case" a future admin decision spans multiple shares atomically. Rejected: every event becomes a 1:1 wrapper — a shallow module kept for a hypothetical (YAGNI). If multi-share decisions ever become real, a grouping id can be reintroduced then.
- **Constraint-only minimal change** (keep both tables, forbid splits in service + UI). Least churn, but every part-concept — the 20-row seed, `collapseShares`, part badges, Rule 1 — survives as permanent dead weight. The point of the rework is that the concept no longer exists.
- **Squash migrations to a fresh baseline.** Cleanest history, but rewrites all 18 migrations for a change that one appended migration expresses fine. Rejected in favor of the append.

---

## Architecture

### Schema (`src/lib/db/schema/ownership.ts`)

```
ownership_assignment
  id              uuid PK default gen_random_uuid()
  share_code      share_code enum  NOT NULL        -- the share itself; no FK table
  user_id         uuid NOT NULL  FK → user  ON DELETE CASCADE
  actor_user_id   uuid NULL      FK → user  ON DELETE SET NULL   -- admin who decided
  assigned_from   date NOT NULL                    -- half-open [from, to)
  assigned_to     date NULL                        -- NULL = active
  created_at      timestamptz NOT NULL default now()

  UNIQUE (share_code) WHERE assigned_to IS NULL    -- one active owner per share
  CHECK  (assigned_to IS NULL OR assigned_to > assigned_from)
  INDEX  (share_code), (user_id)
```

`share_part` and `ownership_assignment_event` are gone. `season` is untouched.

### Service (`src/lib/services/share/`)

Same check-first, in-tx shape as before (ADR-0002), minus the parts plumbing:

- Reads: `listSharesWithCurrentOwner()` (10 entries, driven by `SHARE_CODES`), `listCurrentSharesForUser(userId): ShareCode[]`, `getCurrentOwner(shareCode)`, `getOwnerAt(shareCode, date)`, `listShareHistory(shareCode)` (flat, newest first, for the history sheet).
- Writes: `assignShareAsAdmin({ shareCode, userId, from }, { actorUserId })` — active-user check, `ALREADY_CURRENT_OWNER` on same owner, `FROM_DATE_NOT_AFTER_CURRENT` guard, close-then-insert in one tx. `unassignShareAsAdmin({ shareCode, on })` — `NOT_ASSIGNED` / `DATE_NOT_AFTER_CURRENT`, closes the active row.
- Error codes shrink to: `USER_NOT_FOUND`, `ALREADY_CURRENT_OWNER`, `FROM_DATE_NOT_AFTER_CURRENT`, `NOT_ASSIGNED`, `DATE_NOT_AFTER_CURRENT`.

### Procedures (`src/lib/orpc/procedures/share.ts`)

- `listMine` → `ShareCode[]`; `listAll` → 10 rows with decorated `currentOwner`; `listHistory` → flat `{ assignedFrom, assignedTo, isActive, user }` entries (no `kind`); `assign` input `{ shareCode, userId, from }`; `unassign` input `{ shareCode, on }`.
- The share router **stays message-based** (`rethrowAsORPC` → Swedish `ORPCError`) per the standing ADR-0002 amendment — no error-architecture change is smuggled into this rework.
- `realtime.publish({ kind: 'share.changed', ids: [shareCode] })` unchanged (ADR-0004).
- `season.listSchedules` cells lose `partId` (a cell is `{ week, shareCode, month }`); the owners list in `user` procedures exposes `ShareCode[]`.

### UI

- `/admin/shares`: 10 cards (`SharePartCard` → `ShareCard`), one owner or empty state each; history sheet per share.
- `ShareAssignForm`: single user picker + from date (split toggle and second picker removed). `UnassignShareDialog`: parts radio removed.
- `AssignmentHistorySheet`: one row per ownership stint — owner, from → to (or active). No split/partial badges.
- `ShareBadge` / `OwnersTable`: a badge is just the share letter.
- Calendar: `ownedPartIds: Set<string>` → `Set<ShareCode>`; a "my week" highlight lights both weeks of an owned share (visually identical to today's whole-share owners).
- i18n: split-related keys pruned from `messages/{sv,en}.json`; `en` stays key-complete.

---

## Consequences

- **Supersedes** (CLAUDE.md "Decisions made" entries updated accordingly):
  - *"Admin assigns ownership in whole-share pairs by default; split via toggle"* (2026-05-26) — assignment is whole-share only; `src/lib/shares/collapse.ts` is deleted.
  - *"Assignment events are first-class"* (2026-05-27) — the event table is dropped; an assignment row *is* the decision record (`actor_user_id` lives on it).
  - **ADR-0009 Rule 1** — retired; the rule's disallowed states are unrepresentable. ADR-0009 gets an amendment noting the retirement and pointing here.
- The `0002_seed_share_parts.sql` migration remains in history but its table is dropped by `0018`; no seed replaces it (the enum needs none).
- Migration `0018` is **destructive by design** (drops assignment data); acceptable only because we are pre-launch and prod is reset. This is the documented exception to the usual additive-migration discipline.
- `WEEKS_PER_SEASON` is now `SHARE_CODES.length * WEEKS_PER_SHARE` — same value (20), honest name.
- If the group ever re-introduces shared ownership of a single share, that is a new ADR (likely as co-owners on one assignment, not as resurrected halves).

## Files

- `src/lib/db/schema/ownership.ts` — new `ownership_assignment`; `share_part` + event table removed
- `drizzle/0018_indivisible_shares.sql` — drop + recreate (hand-tuned, destructive, pre-launch only)
- `src/lib/shares/codes.ts` — `WEEKS_PER_SHARE`, rotation documented in weeks; `collapse.ts` deleted
- `src/lib/services/share/` — rewritten service + errors + tests
- `src/lib/services/season/season.ts` — `shareForWeek`, `ScheduleEntry` without parts
- `src/lib/orpc/procedures/{share,season,user}.ts` — new shapes
- `src/components/share/*` — `ShareCard`, simplified form/dialog/sheet/badge
- `src/components/user/OwnersTable.tsx`, `src/routes/_authenticated/index.tsx`, `src/routes/_authenticated/admin/shares.*` — consumers
- `messages/{sv,en}.json` — pruned keys
- `docs/adr/0009-organization-rules.md` — Rule 1 retirement amendment

## Verification

- `pnpm test` green: rewritten `share.test.ts` exercises every remaining `ShareDomainError` code (ADR-0002); season logic tests cover `shareForWeek` and the 6-week slip example (A: 21/22 → 27/28).
- Browser pass: assign → reassign → unassign → history at `/admin/shares`; calendar "my week" highlight; owners table badges.

## Revisit triggers

- The group wants any form of shared/temporary ownership of a single share again.
- A real need appears for one admin decision to span multiple shares atomically (would reintroduce a grouping id, not the event table wholesale).

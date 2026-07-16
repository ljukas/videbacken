# ADR 0019 — Season Eras

- **Status**: Accepted
- **Date**: 2026-07-05
- **Deciders**: Lukas
- **Decision in one line**: Seasons are **computed, not stored**. A tiny append-only `season_era` table (seeded `(2024, 21, 'J')`) holds the group's schedule convention, effective-dated by year; every season derives from its governing era — start week fixed by the era (week 21 today), start share rotating −3 positions per year from the era's anchor. The per-year `season` table and its entire CRUD surface (procedures, dialogs, domain errors, the `season.changed` realtime kind) are deleted; one read procedure remains. Convention changes are one-row data migrations, never edits.

---

## Context

The current model stores one `season` row per year (`year` PK, `start_week` CHECK 1–53 with a soft default of 21 per ADR-0009 Rule 2, `start_share` defaulting to the previous year rotated −3). Admins create each season from a dialog, and can edit or delete it; both fields are editable inputs.

The group has now settled what Rule 2 hedged on: **the start week is not chooseable — every season starts on ISO week 21.** With the week fixed, the last stored degree of freedom (`start_share`) is already a pure formula (`rotate(anchor, −3 × years since anchor)`), so per-year rows become ceremony: a yearly admin chore creating rows whose every value is derivable, plus edit paths that should never be used.

Two facts shaped the redesign:

- **Prod's `season` table is empty** (verified against Neon, 2026-07-05). There is no data to migrate; a destructive drop is free. Same pre-launch posture as ADR-0018.
- **History must be immutable under future rule changes.** The naive fix — bare code constants — fails this: if the group ever moves the start week (say to 22 in 2028), recompiling every year from one constant would silently rewrite the displayed 2024–2027 history. What's needed is an *effective-dated* rule record: new rules govern new years, old rules keep governing old years forever. The group wants that record in the **database**, not in a source file — a code-only era list is guarded solely by tests and git review, and it should have the durability of data.

### What is *not* changing

The season *structure* stays a code-level physical truth per ADR-0018: 10 shares × 2 consecutive weeks = 20 weeks per season, and the 6-week yearly slip (`DEFAULT_YEAR_ROTATION = -3` share positions). An era records *where the schedule is anchored*, not how the calendar works.

---

## Decision (TL;DR)

1. **New `season_era` table** — append-only, effective-dated:

   ```
   season_era
     from_year    integer PRIMARY KEY          -- first season year this era governs
     start_week   integer NOT NULL             -- CHECK (between 1 and 33)
     start_share  share_code NOT NULL          -- share opening the from_year season
     created_at   timestamptz NOT NULL default now()
   ```

   Seeded with the group's standing convention: `(2024, 21, 'J')`. Season year *Y* is governed by the era with the greatest `from_year ≤ Y`; within an era, `startWeek = era.start_week` and `startShare = rotateShare(era.start_share, −3 × (Y − era.from_year))` (2024 → J, 2025 → G, 2026 → D, …).

   The CHECK is 1–33, not 1–53: a season is 20 consecutive weeks and week 33 is the last start that keeps week 20-of-season ≤ 52 in every ISO year — a physical truth, encoded in the DB per the standing CHECK-constraint posture.

2. **The `season` table is dropped.** Nothing per-year is stored; schedules are computed on read.

3. **Displayed years fall out of the data**: `min(from_year) … currentYear + 1`. No hardcoded first year; the seed row carries 2024. The range is never empty and next season is always visible for planning.

4. **The season CRUD surface is deleted**: `suggestedNext` / `create` / `getByYear` / `update` / `delete` procedures, all three dialogs, `SeasonDomainError` + `seasonErrorMessage.ts`, the `season.changed` realtime kind, and the calendar page's URL-dialog wiring and admin button. The page becomes identical for admins and owners. One procedure remains: `season.listSchedules` (protected, no input, no `.errors()`), which reads the eras and returns the computed schedules.

5. **Era changes are data migrations** — the runbook below. No admin UI: this is a once-a-decade, deliberate group decision, and an append-only INSERT reviewed in a PR is the whole mechanism. Rows are never updated or deleted.

6. **ADR-0009 Rule 2 is superseded** — the week-21 rule stops being a soft default and becomes structural: no `start_week` input exists anywhere in the app.

---

## Alternatives considered

- **Keep per-season rows, drop only the `start_week` field/input.** Minimal churn, but keeps the yearly create chore, the mutable rows, and most of the machinery — for values that are 100% derivable. The point of the rework is that a season carries no information of its own.
- **Eras as code constants** (an append-only array in `src/lib/seasons.ts`). Functionally identical and even leaner — but the sole record of the group's schedule history would live in a source file, guarded only by pinned tests and diff review. Rejected as too flimsy for the one artifact that must never drift: the DB is the durable record.
- **Frozen snapshots** — compute current/future seasons from constants, write a season row once a year completes. Correct semantics, but needs a freeze mechanism (write-on-read or a yearly job) — standing machinery for an event (a convention change) that may never happen.
- **Admin UI for eras.** Self-service without a deploy, but revives mutation procedures, domain errors, validation, i18n, and a dialog for a once-a-decade operation. The revisit trigger below covers it if the frequency assumption proves wrong.

---

## Architecture

### Schema (`src/lib/db/schema/ownership.ts`)

`season_era` as above, replacing `season`. `share_code` enum and `ownership_assignment` untouched.

### Service (`src/lib/services/season/`)

- `season.ts` — `listEras()`: the only DB access (ADR-0002).
- `logic.ts` — pure era math, every function taking era rows as arguments (testable without a DB): `eraForYear`, `startShareForYear`, `shareBlocksForSeason`, `monthForISOWeek`, `monthBandsForSeason`, `buildSchedules(eras, currentYear)`. (2026-07-06: `shareForWeek` and the per-week `cells` were retired with the whole-share-block rendering — blocks are the atomic calendar unit per ADR-0018, and month bands derive every rendered week.)
- `errors.ts` — deleted. No mutations remain, so no domain errors. (ADR-0002's "every error code tested" rule is trivially satisfied.)
- `ANCHOR_START_SHARE` leaves `src/lib/shares/codes.ts` — the seed row carries the anchor now. `WEEKS_PER_SHARE`, `WEEKS_PER_SEASON`, `YEAR_WEEK_SLIP`, `DEFAULT_YEAR_ROTATION`, and `rotateShare` stay: calendar structure, not anchoring.

### Procedure (`src/lib/orpc/procedures/season.ts`)

`listSchedules` only: `listEras()` → `buildSchedules(eras, currentYear)` → `{ currentYear, schedules: [{ year, blocks: [{ firstWeek, lastWeek, shareCode }], monthBands }] }` (2026-07-06: per-week `cells` dropped — blocks + month bands derive every rendered week; `currentYear` ships with the payload so SSR and hydration share one clock for the current-year highlight, closing the New-Year UTC/Stockholm window noted under Consequences; `buildSchedules` returns chronological order, the component reverses for display). Loader prefetch + `useSuspenseQuery` flow unchanged.

### UI

- `src/routes/_authenticated/index.tsx`: keeps the `listSchedules` + `share.listMine` prefetches; loses `validateSearch`, `loaderDeps`, `useUrlDialog`, the dialog mounts, and the admin button.
- `CreateSeasonDialog` / `EditSeasonDialog` / `DeleteSeasonDialog`: deleted.
- `DisponeringslistaTable`: loses `onEditSeason` / `onDeleteSeason`, the actions column, and the empty-state branch (the seed era guarantees a non-empty range). Owned-week rings still come from `share.listMine` (unchanged, still realtime-synced via `share.changed`).
- i18n: every `season_*` key pruned except the 12 month labels, `season_disponeringslista_title`, `season_my_week`, `season_my_week_prefix`. `en` stays key-complete.

### Migrations

Three appended, named migrations (history `0000`–`0018` untouched; create and drop are split so `drizzle-kit generate` never sees a removed *and* an added table in one run — that combination triggers an interactive rename prompt):

- `--name=add_season_era` — CREATE `season_era`.
- `--custom --name=seed_season_era_anchor` — `INSERT INTO season_era (from_year, start_week, start_share) VALUES (2024, 21, 'J')`. Test setup runs all migrations per-test, so every test DB has the anchor era automatically.
- `--name=drop_season_table` — DROP `season`. **Destructive by design**; safe because prod's `season` table is empty (pre-launch posture per ADR-0018).

---

## How to change the convention (runbook)

When the group decides on a new start week or re-anchors the rotation:

1. `pnpm drizzle-kit generate --custom --name=season_era_<from_year>`
2. In the generated file: `INSERT INTO season_era (from_year, start_week, start_share) VALUES (<from_year>, <week>, '<share>');`
3. **`from_year` must be a future season year** (normally next year). An era whose `from_year` is current or past would retroactively recompute already-displayed seasons — the exact thing this design exists to prevent.
4. **Never UPDATE or DELETE existing rows.** Old eras *are* the history.
5. Pick `start_share` deliberately — it re-anchors the rotation. To continue the current sequence seamlessly, use what the old era would have produced for that year (`startShareForYear`).

---

## Consequences

- **Supersedes ADR-0009 Rule 2** (amendment added there): week 21 is structural now — `SEASON_START_WEEK`, the `createSeason` fallback, and every `start_week` input are gone.
- **CLAUDE.md updates**: season leaves the "code-only errors" router list (the router has no errors at all now); code map and decision bullets updated.
- **Era changes require a developer** — a one-row PR-reviewed data migration. Chosen deliberately over admin UI.
- The admin calendar page equals the owner calendar page; the only admin-visible season artifact left is this ADR's runbook.
- `season.changed` is removed from the realtime union — era rows only change alongside a deploy, so there is nothing to push.
- The server computes `currentYear` in UTC: around midnight New Year in Stockholm, next season can appear up to an hour "late". Irrelevant for a May–October schedule.
- If migration `0019` ever runs against a DB that *does* have season rows (a stale dev branch), those rows are dropped silently — acceptable: they were derivable ceremony.

## Files

- `src/lib/db/schema/ownership.ts` — `season_era` replaces `season`
- `drizzle/0019_add_season_era.sql`, `drizzle/0020_seed_season_era_anchor.sql`, `drizzle/0021_drop_season_table.sql`
- `src/lib/services/season/{season,logic}.ts` + tests — `listEras` + pure era math; `errors.ts` deleted
- `src/lib/orpc/procedures/season.ts` — `listSchedules` only; `src/lib/orpc/seasonErrorMessage.ts` deleted
- `src/lib/effects/realtime/types.ts`, `src/hooks/useRealtimeSync.ts` — pruned (`src/lib/orpc/router.ts` keeps its unchanged `season` registration)
- `src/lib/shares/codes.ts` — `ANCHOR_START_SHARE` removed
- `src/components/season/{Create,Edit,Delete}SeasonDialog.tsx` — deleted
- `src/components/season/DisponeringslistaTable.tsx`, `src/routes/_authenticated/index.tsx` — simplified
- `messages/{sv,en}.json` — pruned keys
- `docs/adr/0009-organization-rules.md` — Rule 2 supersession amendment

## Verification

- `pnpm test` green: logic tests cover era resolution across a boundary (year before / at / after a second era's `from_year`), rotation from the era anchor (2024 → J, 2025 → G, wrap-around), month bands, and the golden 2026 block row (2026-07-06: formerly the `shareForWeek` window edges); the service test asserts `listEras()` returns the seeded anchor.
- Browser pass: calendar shows 2024 … currentYear+1 starting at week 21 with the J/G/D rotation; owned-week rings intact; no admin affordances for any role.

## Revisit triggers

- The group wants self-service convention changes → a minimal append-only admin UI over `season_era` (list + "new era" form), not editable rows.
- Bookings or usage records tied to specific weeks appear → they must store concrete dates/weeks, never derive them from era math at read time.
- The share count or weeks-per-share changes → new ADR; the era table likely grows columns rather than the structure moving back into rows.

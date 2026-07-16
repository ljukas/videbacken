# Season Eras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-year `season` table with an append-only `season_era` rule table (ADR-0019); seasons become computed from their governing era, and the entire season CRUD surface is deleted.

**Architecture:** A tiny `season_era` table (seeded `(2024, 21, 'J')`) holds the group's schedule convention, effective-dated by `from_year`. Pure functions in `src/lib/services/season/logic.ts` compute any year's 20-week schedule from the era rows; one `season.listSchedules` read procedure remains. Dialogs, mutations, domain errors, and the `season.changed` realtime kind are all removed. Spec: `docs/adr/0019-season-eras.md`.

**Tech Stack:** TanStack Start + oRPC + Drizzle (postgres-js) + Vitest (`node` project; per-test schema runs all migrations, so the seed row exists in every test DB) + Paraglide i18n.

## Global Constraints

- **Unsigned commits**: every commit uses `git -c commit.gpgsign=false commit …` (signing prompts hang the session).
- **Conventional Commits**: `<type>(<scope>): <subject>` ≤ 72 chars, imperative; end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **All DB access through services** (`src/lib/services/season/`); procedures stay thin glue (ADR-0002).
- **Named migrations**: always `--name=`; data-only migrations via `pnpm drizzle-kit generate --custom --name=<name>`.
- **All timestamp columns** use `timestamp({ withTimezone: true })`.
- **i18n**: `messages/sv.json` is source of truth, `en.json` must stay key-complete; components call `m.<key>()`, never hardcoded strings.
- **Never `console.*`** — but nothing in this plan needs logging (the one remaining procedure has no side effects worth logging).
- **Before each commit**: run `pnpm check` (Biome, writes fixes) and include its changes.
- **Tests need the local DB**: `pnpm db:up` once before running `pnpm test:node` (tests create/drop their own schemas; no `db:migrate` needed for tests).
- **Worktree execution notes**: copy the gitignored `.env` into the worktree; any `docker compose` use needs `COMPOSE_PROJECT_NAME=oceanview`; the long-running `pnpm dev` on :14500 serves the main checkout, not the worktree.
- **Interactive drizzle-kit prompts must be avoided**: never have one `db:generate` run see both a dropped and an added table (it triggers an interactive rename prompt). This plan splits create and drop into separate migrations on purpose.

---

### Task 1: Pure era math in `logic.ts`

Move the existing pure season functions out of `season.ts` into a new `logic.ts`, and add the era functions (`eraForYear`, `startShareForYear`, `seasonForYear`, `buildSchedules`) test-first. Purely additive — the old table/service/procedures keep working.

**Files:**
- Create: `src/lib/services/season/logic.ts`
- Modify: `src/lib/services/season/season.ts` (remove the moved pure functions; import `shareForWeek` from `./logic`)
- Modify: `src/lib/services/season/index.ts` (add `export * from './logic'`)
- Modify: `src/lib/services/season/logic.test.ts` (imports move to `./logic`; new era tests added)

**Interfaces:**
- Consumes: `SHARE_CODES`, `WEEKS_PER_SEASON`, `WEEKS_PER_SHARE`, `DEFAULT_YEAR_ROTATION`, `rotateShare`, `shareIndexOf`, `ShareCode` from `~/lib/shares/codes`; `addDays`, `getMonth`, `parseISO` from `date-fns`.
- Produces (later tasks rely on these exact names/types):
  - `type SeasonEra = { fromYear: number; startWeek: number; startShare: ShareCode }`
  - `type ScheduleCell = { week: number; shareCode: ShareCode; month: number }`
  - `type MonthBand = { month: number; firstWeek: number; lastWeek: number; span: number }`
  - `type YearSchedule = { year: number; cells: Array<ScheduleCell>; monthBands: Array<MonthBand> }`
  - `eraForYear(eras: ReadonlyArray<SeasonEra>, year: number): SeasonEra | null`
  - `startShareForYear(era: SeasonEra, year: number): ShareCode`
  - `seasonForYear(eras: ReadonlyArray<SeasonEra>, year: number): { startWeek: number; startShare: ShareCode } | null`
  - `buildSchedules(eras: ReadonlyArray<SeasonEra>, currentYear: number): Array<YearSchedule>`
  - moved unchanged: `shareForWeek`, `monthForISOWeek`, `monthBandsForSeason`

- [ ] **Step 1: Write the failing era tests**

Append to `src/lib/services/season/logic.test.ts` (and change its existing import from `'./season'` to `'./logic'`):

```ts
import { buildSchedules, eraForYear, type SeasonEra, seasonForYear, startShareForYear } from './logic'

const ANCHOR_ERA: SeasonEra = { fromYear: 2024, startWeek: 21, startShare: 'J' }

test('eraForYear picks the era with the greatest fromYear <= year', () => {
  const later: SeasonEra = { fromYear: 2028, startWeek: 22, startShare: 'D' }
  const eras = [ANCHOR_ERA, later]
  expect(eraForYear(eras, 2023)).toBeNull()
  expect(eraForYear(eras, 2024)).toBe(ANCHOR_ERA)
  expect(eraForYear(eras, 2027)).toBe(ANCHOR_ERA)
  expect(eraForYear(eras, 2028)).toBe(later)
  expect(eraForYear(eras, 2031)).toBe(later)
  // Order-independent: same answers with the array reversed.
  expect(eraForYear([later, ANCHOR_ERA], 2027)).toBe(ANCHOR_ERA)
})

test('startShareForYear rotates -3 per year from the era anchor', () => {
  expect(startShareForYear(ANCHOR_ERA, 2024)).toBe('J')
  expect(startShareForYear(ANCHOR_ERA, 2025)).toBe('G')
  expect(startShareForYear(ANCHOR_ERA, 2026)).toBe('D')
  expect(startShareForYear(ANCHOR_ERA, 2027)).toBe('A')
  // Wraps around the 10-share ring: 2024 + 10 years = J again.
  expect(startShareForYear(ANCHOR_ERA, 2034)).toBe('J')
})

test('seasonForYear resolves week + rotated share across an era boundary', () => {
  const eras = [ANCHOR_ERA, { fromYear: 2028, startWeek: 22, startShare: 'D' as const }]
  expect(seasonForYear(eras, 2027)).toEqual({ startWeek: 21, startShare: 'A' })
  expect(seasonForYear(eras, 2028)).toEqual({ startWeek: 22, startShare: 'D' })
  expect(seasonForYear(eras, 2029)).toEqual({ startWeek: 22, startShare: 'A' })
  expect(seasonForYear(eras, 2023)).toBeNull()
})

test('buildSchedules spans min(fromYear) .. currentYear + 1', () => {
  const schedules = buildSchedules([ANCHOR_ERA], 2026)
  expect(schedules.map((s) => s.year)).toEqual([2024, 2025, 2026, 2027])
  for (const s of schedules) {
    expect(s.cells).toHaveLength(20)
    expect(s.cells[0]?.week).toBe(21)
    expect(s.cells[19]?.week).toBe(40)
  }
  // 2026 starts at D (J rotated -3 twice) — first two weeks belong to D.
  const y2026 = schedules.find((s) => s.year === 2026)
  expect(y2026?.cells[0]).toMatchObject({ week: 21, shareCode: 'D' })
  expect(y2026?.cells[1]).toMatchObject({ week: 22, shareCode: 'D' })
  // Month bands come from each year's real calendar.
  expect(y2026?.monthBands[0]).toEqual({ month: 4, firstWeek: 21, lastWeek: 22, span: 2 })
})

test('buildSchedules returns [] when no eras exist', () => {
  expect(buildSchedules([], 2026)).toEqual([])
})

test('buildSchedules ignores eras that only govern years beyond the range', () => {
  // currentYear 2025 → range 2024..2026; the 2028 era exists but governs nothing yet.
  const schedules = buildSchedules(
    [ANCHOR_ERA, { fromYear: 2028, startWeek: 22, startShare: 'D' as const }],
    2025,
  )
  expect(schedules.map((s) => s.year)).toEqual([2024, 2025, 2026])
  expect(schedules.every((s) => s.cells[0]?.week === 21)).toBe(true)
})
```

Also update the existing `monthBandsForSeason` 2027 test comment: the "soft default override" framing is obsolete — reword the comment to "a non-21 era start week (weeks 20..39) stays inside September", keeping the assertions unchanged.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm test:node src/lib/services/season/logic.test.ts`
Expected: FAIL — `./logic` module not found (the pre-existing tests fail on the import too; that's fine, they pass again in Step 4).

- [ ] **Step 3: Create `logic.ts` and slim `season.ts`**

Create `src/lib/services/season/logic.ts`. The `shareForWeek`, `monthForISOWeek`, `MonthBand`, and `monthBandsForSeason` blocks move **verbatim** from `season.ts` (same comments); the era types/functions are new:

```ts
import { addDays, getMonth, parseISO } from 'date-fns'
import {
  DEFAULT_YEAR_ROTATION,
  rotateShare,
  SHARE_CODES,
  type ShareCode,
  shareIndexOf,
  WEEKS_PER_SEASON,
  WEEKS_PER_SHARE,
} from '~/lib/shares/codes'

// A season-convention era (ADR-0019): governs every season year >= fromYear
// until a later era takes over. Rows come from the append-only season_era
// table; everything in this file is pure and takes eras as arguments so it
// tests without a database.
export type SeasonEra = {
  fromYear: number
  startWeek: number
  startShare: ShareCode
}

export type ScheduleCell = {
  week: number
  shareCode: ShareCode
  month: number
}

export type YearSchedule = {
  year: number
  cells: Array<ScheduleCell>
  monthBands: Array<MonthBand>
}

// The era with the greatest fromYear <= year, or null for years before the
// first era (never rendered — buildSchedules starts at min(fromYear)).
export function eraForYear(eras: ReadonlyArray<SeasonEra>, year: number): SeasonEra | null {
  let match: SeasonEra | null = null
  for (const era of eras) {
    if (era.fromYear <= year && (match === null || era.fromYear > match.fromYear)) {
      match = era
    }
  }
  return match
}

// The schedule slips 6 weeks per season (DEFAULT_YEAR_ROTATION = -3 share
// positions per year), continuing from the era's anchor share.
export function startShareForYear(era: SeasonEra, year: number): ShareCode {
  return rotateShare(era.startShare, DEFAULT_YEAR_ROTATION * (year - era.fromYear))
}

// Resolves the two values a year's schedule needs from its governing era.
export function seasonForYear(
  eras: ReadonlyArray<SeasonEra>,
  year: number,
): { startWeek: number; startShare: ShareCode } | null {
  const era = eraForYear(eras, year)
  if (!era) return null
  return { startWeek: era.startWeek, startShare: startShareForYear(era, year) }
}

// Pure: returns the share occupying `isoWeek` within the season, or null if
// the week sits outside the 20-week window. Weeks map to shares in blocks of
// WEEKS_PER_SHARE consecutive weeks, advancing from startShare and wrapping
// mod 10.
export function shareForWeek(
  input: { startWeek: number; startShare: ShareCode },
  isoWeek: number,
): ShareCode | null {
  const offset = isoWeek - input.startWeek
  if (offset < 0 || offset >= WEEKS_PER_SEASON) return null

  const shareOffset = Math.floor(offset / WEEKS_PER_SHARE)
  const shareIndex = (shareIndexOf(input.startShare) + shareOffset) % SHARE_CODES.length
  return SHARE_CODES[shareIndex]
}

// Pure: 0-indexed calendar month of the given ISO week, per the ISO 8601
// rule (the month containing the Thursday of that week). 4 = Maj, 9 = Okt.
export function monthForISOWeek(isoYear: number, isoWeek: number): number {
  const monday = parseISO(`${isoYear}-W${String(isoWeek).padStart(2, '0')}-1`)
  const thursday = addDays(monday, 3)
  return getMonth(thursday)
}

export type MonthBand = {
  month: number
  firstWeek: number
  lastWeek: number
  span: number
}

// Pure: collapses the 20 season weeks into contiguous same-month bands.
// Each band carries its calendar month (0-indexed), the inclusive week
// range, and the span (so callers can drive `<td colSpan>` directly).
export function monthBandsForSeason(input: { year: number; startWeek: number }): Array<MonthBand> {
  const bands: Array<MonthBand> = []
  for (let i = 0; i < WEEKS_PER_SEASON; i++) {
    const week = input.startWeek + i
    const month = monthForISOWeek(input.year, week)
    const last = bands[bands.length - 1]
    if (last && last.month === month) {
      last.lastWeek = week
      last.span += 1
    } else {
      bands.push({ month, firstWeek: week, lastWeek: week, span: 1 })
    }
  }
  return bands
}

// One YearSchedule per year from min(fromYear) through currentYear + 1 —
// full history plus next season for planning (ADR-0019).
export function buildSchedules(
  eras: ReadonlyArray<SeasonEra>,
  currentYear: number,
): Array<YearSchedule> {
  if (eras.length === 0) return []
  const firstYear = Math.min(...eras.map((e) => e.fromYear))
  const lastYear = currentYear + 1

  const schedules: Array<YearSchedule> = []
  for (let year = firstYear; year <= lastYear; year++) {
    const season = seasonForYear(eras, year)
    // Unreachable within [firstYear, lastYear] — firstYear is an era's
    // fromYear — but keeps the loop total if the range logic ever changes.
    if (!season) continue

    const cells = Array.from({ length: WEEKS_PER_SEASON }, (_, i) => {
      const week = season.startWeek + i
      const shareCode = shareForWeek(season, week)
      // Within [startWeek, startWeek + WEEKS_PER_SEASON) shareForWeek always
      // resolves; this guard exists so a future change to WEEKS_PER_SEASON
      // can't silently produce nulls.
      if (!shareCode) {
        throw new Error(`shareForWeek returned null for ${year} week ${week}`)
      }
      return { week, shareCode, month: monthForISOWeek(year, week) }
    })

    schedules.push({
      year,
      cells,
      monthBands: monthBandsForSeason({ year, startWeek: season.startWeek }),
    })
  }
  return schedules
}
```

In `season.ts`: delete the moved blocks (`shareForWeek`, `monthForISOWeek`, `MonthBand`, `monthBandsForSeason` — including their comments and the now-unused `addDays`/`getMonth`/`parseISO`/`SHARE_CODES`/`shareIndexOf`/`WEEKS_PER_SHARE` imports; keep `WEEKS_PER_SEASON` only if still referenced) and add `import { shareForWeek } from './logic'` (used by `scheduleForYear`).

In `index.ts` (barrel):

```ts
export * from './errors'
export * from './logic'
export * from './season'
```

- [ ] **Step 4: Run the full node suite to verify everything passes**

Run: `pnpm test:node`
Expected: PASS — new era tests green, moved tests green, `season.test.ts` and the rest of the suite untouched (`procedures/season.ts` resolves `monthForISOWeek` etc. through the barrel).

- [ ] **Step 5: Biome + commit**

```bash
pnpm check
git add -A src/lib/services/season
git -c commit.gpgsign=false commit -m "feat(season): add pure era math in logic.ts

Era types and eraForYear/startShareForYear/seasonForYear/buildSchedules
per ADR-0019, plus the existing pure functions moved verbatim from
season.ts. Additive — the season table and CRUD still work.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Strip the season admin UI

Delete the three dialogs and remove the calendar page's admin affordances. The old `listSchedules` wire (which still includes `startWeek`) keeps serving the page — extra fields are fine structurally.

**Files:**
- Delete: `src/components/season/CreateSeasonDialog.tsx`, `src/components/season/EditSeasonDialog.tsx`, `src/components/season/DeleteSeasonDialog.tsx`
- Modify: `src/routes/_authenticated/index.tsx`, `src/components/season/DisponeringslistaTable.tsx`

**Interfaces:**
- Consumes: `orpc.season.listSchedules` (old shape, still served), `orpc.share.listMine`.
- Produces: `DisponeringslistaTable` props become `{ schedules: Array<YearSchedule>; ownedShareCodes: ReadonlySet<ShareCode> }` with local `YearSchedule = { year: number; cells: Array<Cell>; monthBands: Array<MonthBand> }` (no `startWeek`, no admin callbacks). Task 4's new wire type must stay assignable to this.

- [ ] **Step 1: Delete the dialog components**

```bash
git rm src/components/season/CreateSeasonDialog.tsx src/components/season/EditSeasonDialog.tsx src/components/season/DeleteSeasonDialog.tsx
```

- [ ] **Step 2: Rewrite `src/routes/_authenticated/index.tsx`**

Full new content (drops `validateSearch`/`loaderDeps`/`useUrlDialog`/dialog mounts/admin button/role checks; keeps the passkey-prompt comment):

```tsx
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PageContainer } from '~/components/layout/PageContainer'
import { PasskeySetupPrompt } from '~/components/passkey/PasskeySetupPrompt'
import { DisponeringslistaTable } from '~/components/season/DisponeringslistaTable'
import { usePasskeySetupPrompt } from '~/hooks/usePasskeys'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/_authenticated/')({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(orpc.season.listSchedules.queryOptions())
    await queryClient.ensureQueryData(orpc.share.listMine.queryOptions())
  },
  component: Calendar,
})

function Calendar() {
  const { data: schedules } = useSuspenseQuery(orpc.season.listSchedules.queryOptions())
  const { data: ownedShares } = useSuspenseQuery(orpc.share.listMine.queryOptions())

  const ownedShareCodes = new Set(ownedShares)

  // Periodic passkey nudge: self-gates on zero passkeys + the per-device snooze window
  // (see usePasskeySetupPrompt), so it re-appears "sometimes" for anyone without a passkey
  // — including invitees who skipped the onboarding step — rather than only after sign-in.
  const passkeyPrompt = usePasskeySetupPrompt()

  return (
    <PageContainer width="full" fill>
      <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
        {m.nav_calendar()}
      </h1>
      <DisponeringslistaTable schedules={schedules} ownedShareCodes={ownedShareCodes} />
      <PasskeySetupPrompt
        open={passkeyPrompt.open}
        pending={passkeyPrompt.pending}
        onCreate={passkeyPrompt.create}
        onDismiss={passkeyPrompt.dismiss}
      />
    </PageContainer>
  )
}
```

- [ ] **Step 3: Simplify `src/components/season/DisponeringslistaTable.tsx`**

Targeted removals (the month-label array, band/cell rendering, `OWNED_RING`, and both layouts otherwise stay untouched):

1. Imports: remove `PencilIcon`, `Trash2Icon` (keep `StarIcon`), remove `Button`.
2. `YearSchedule` type: remove the `startWeek: number` field.
3. `Props`: remove `onEditSeason` / `onDeleteSeason` (and the admin-callback comment); resulting shape:

```tsx
type Props = {
  schedules: Array<YearSchedule>
  ownedShareCodes: ReadonlySet<ShareCode>
}
```

4. `DisponeringslistaTable`: remove the `schedules.length === 0` empty-state branch (the seeded anchor era makes an empty range impossible per ADR-0019) and drop the two callback props from the signature and from both layout call sites.
5. `WideLayout` / `MobileLayout` / `YearBlock` / `YearCard`: remove the `onEditSeason`/`onDeleteSeason` props and `showAdminActions` logic, the actions `<th>` in the month-header row, the `rowSpan={2}` actions `<td>` with both buttons, and the edit/delete button group in `YearCard`'s header. `LayoutProps` becomes `Props & { currentYear: number }` (unchanged shape, fewer members via `Props`).

- [ ] **Step 4: Typecheck + suite**

Run: `pnpm exec tsc --noEmit`
Expected: clean — nothing references the deleted dialogs or removed props anymore.

Run: `pnpm test:node`
Expected: PASS (no component tests exist for these files; the DB suite is untouched).

- [ ] **Step 5: Biome + commit**

```bash
pnpm check
git add -A src/components/season src/routes/_authenticated/index.tsx
git -c commit.gpgsign=false commit -m "feat(season): remove season admin UI from the calendar page

Seasons stop being admin-managed per ADR-0019: create/edit/delete
dialogs, URL-dialog wiring, and role gating go away. The page is now
identical for admins and owners.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Strip the season CRUD server surface

Reduce the season router to `listSchedules` (still reading the old table), delete the domain errors, the client error mapper, and the `season.changed` realtime kind.

**Files:**
- Modify: `src/lib/orpc/procedures/season.ts`, `src/lib/services/season/season.ts`, `src/lib/services/season/index.ts`, `src/lib/effects/realtime/types.ts`, `src/hooks/useRealtimeSync.ts`
- Delete: `src/lib/orpc/seasonErrorMessage.ts`, `src/lib/services/season/errors.ts`, `src/lib/services/season/season.test.ts`

**Interfaces:**
- Consumes: `seasonService.listSeasons()` (old table — replaced in Task 4), barrel-exported `shareForWeek`/`monthForISOWeek`/`monthBandsForSeason` from Task 1.
- Produces: `seasonRouter` containing only `listSchedules`; `RealtimeEvent` union without `season.changed`. `season.test.ts` is deleted here; Task 4 recreates it for `listEras`.

- [ ] **Step 1: Delete the dead files**

```bash
git rm src/lib/orpc/seasonErrorMessage.ts src/lib/services/season/errors.ts src/lib/services/season/season.test.ts
```

(`season.test.ts` only exercises the CRUD ops deleted in this task plus `listSeasons` — a bare ordered SELECT that Task 4 replaces with `listEras` and a fresh test. Carrying an interim test for one commit would test throwaway code.)

- [ ] **Step 2: Rewrite `src/lib/orpc/procedures/season.ts`**

Full new content (the `listSchedules` handler body is today's, verbatim):

```ts
import { protectedProcedure } from '~/lib/orpc/context'
import * as seasonService from '~/lib/services/season'
import { WEEKS_PER_SEASON } from '~/lib/shares/codes'

export const seasonRouter = {
  // Returns every configured season together with its 20-week share mapping,
  // shaped for the read-only Disponeringslista grid. Skips ownership data on
  // purpose — the grid only needs the share letter per cell. Includes the
  // per-year month bands (computed from each year's actual calendar) so the
  // client can group cells under Maj/Jun/Jul/Aug/Sep/Okt without re-doing
  // the date math.
  listSchedules: protectedProcedure.handler(async () => {
    const seasons = await seasonService.listSeasons()
    return seasons.map((s) => {
      const cells = Array.from({ length: WEEKS_PER_SEASON }, (_, i) => {
        const week = s.startWeek + i
        const shareCode = seasonService.shareForWeek(s, week)
        // Within [startWeek, startWeek + WEEKS_PER_SEASON) shareForWeek always
        // resolves; this guard exists so a future change to WEEKS_PER_SEASON
        // can't silently produce nulls.
        if (!shareCode) {
          throw new Error(`shareForWeek returned null for ${s.year} week ${week}`)
        }
        return {
          week,
          shareCode,
          month: seasonService.monthForISOWeek(s.year, week),
        }
      })
      const monthBands = seasonService.monthBandsForSeason({
        year: s.year,
        startWeek: s.startWeek,
      })
      return { year: s.year, cells, monthBands }
    })
  }),
}
```

Note: the returned object no longer includes `startWeek` — Task 2 already removed the client's use of it.

- [ ] **Step 3: Slim `src/lib/services/season/season.ts`**

Full new content:

```ts
import { asc } from 'drizzle-orm'
import { db } from '~/lib/db'
import { season } from '~/lib/db/schema'
import type { ShareCode } from '~/lib/shares/codes'

export type SeasonRow = {
  year: number
  startWeek: number
  startShare: ShareCode
}

export async function listSeasons(): Promise<Array<SeasonRow>> {
  return db
    .select({
      year: season.year,
      startWeek: season.startWeek,
      startShare: season.startShare,
    })
    .from(season)
    .orderBy(asc(season.year))
}
```

Barrel `index.ts` becomes:

```ts
export * from './logic'
export * from './season'
```

- [ ] **Step 4: Remove the `season.changed` realtime kind**

In `src/lib/effects/realtime/types.ts`, delete the line:

```ts
  z.object({ kind: z.literal('season.changed') }),
```

In `src/hooks/useRealtimeSync.ts`, delete the case:

```ts
    case 'season.changed':
      void queryClient.invalidateQueries({ queryKey: orpc.season.key() })
      return
```

- [ ] **Step 5: Typecheck + suite**

Run: `pnpm exec tsc --noEmit`
Expected: clean (nothing imports the deleted modules; Task 2 already removed the UI consumers).

Run: `pnpm test:node`
Expected: PASS — `logic.test.ts` green; the deleted `season.test.ts` no longer runs; realtime tests unaffected (they use `user.changed`/`document.changed`).

- [ ] **Step 6: Biome + commit**

```bash
pnpm check
git add -A
git -c commit.gpgsign=false commit -m "feat(season): strip season CRUD from server surface

Router keeps only listSchedules; SeasonDomainError, the client error
mapper, and the season.changed realtime kind are gone per ADR-0019.
Era changes will arrive via data migration + deploy, so there is
nothing to push to clients.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `season_era` table, migrations, and the era read path

The schema flip. Three migrations (create / seed / drop — split to keep `drizzle-kit generate` non-interactive), `listEras()` in the service, and `listSchedules` rewired to `buildSchedules`.

**Files:**
- Modify: `src/lib/db/schema/ownership.ts` (add `seasonEra`, then remove `season`), `src/lib/services/season/season.ts`, `src/lib/orpc/procedures/season.ts`, `src/lib/shares/codes.ts`
- Create: `drizzle/0019_add_season_era.sql` (generated), `drizzle/0020_seed_season_era_anchor.sql` (custom), `drizzle/0021_drop_season_table.sql` (generated), `src/lib/services/season/season.test.ts` (fresh)

**Interfaces:**
- Consumes: `SeasonEra` and `buildSchedules` from Task 1's `logic.ts`.
- Produces: `seasonEra` pgTable export from `~/lib/db/schema`; `listEras(): Promise<Array<SeasonEra>>` from the season service; final `listSchedules` wire `Array<YearSchedule>` (assignable to the table props from Task 2).

- [ ] **Step 1: Add `seasonEra` to `src/lib/db/schema/ownership.ts` (keep `season` for now)**

Insert after the `season` table definition:

```ts
// The group's schedule convention, effective-dated (ADR-0019). Append-only:
// season year Y is governed by the row with the greatest from_year <= Y;
// start_share anchors the -3/year rotation at from_year. Rows are only ever
// inserted — via data migration, never from app code (see the ADR runbook).
// A season is 20 consecutive weeks, so week 33 is the last start that keeps
// the whole season inside one ISO year (33 + 19 = 52) — hence the CHECK.
export const seasonEra = pgTable(
  'season_era',
  {
    fromYear: integer('from_year').primaryKey(),
    startWeek: integer('start_week').notNull(),
    startShare: shareCodeEnum('start_share').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check('season_era_start_week_check', sql`${table.startWeek} BETWEEN 1 AND 33`)],
)
```

- [ ] **Step 2: Generate the create migration**

Run: `pnpm db:generate --name=add_season_era`
Expected: `drizzle/0019_add_season_era.sql` containing `CREATE TABLE "season_era" (...)` with the PK, NOT NULLs, `season_era_start_week_check`, and `created_at ... DEFAULT now()`. No prompts (nothing was removed). Read the file to confirm.

- [ ] **Step 3: Write the seed migration**

Run: `pnpm drizzle-kit generate --custom --name=seed_season_era_anchor`
Then write into the generated `drizzle/0020_seed_season_era_anchor.sql`:

```sql
-- ADR-0019: the group's standing convention — seasons start ISO week 21,
-- share J opened 2024. All displayed years derive from this anchor era.
INSERT INTO "season_era" ("from_year", "start_week", "start_share") VALUES (2024, 21, 'J');
```

- [ ] **Step 4: Write the failing service test**

Create `src/lib/services/season/season.test.ts`:

```ts
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { seasonEra } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { listEras } from './season'

setupDatabase()

test('listEras returns the seeded anchor era', async () => {
  expect(await listEras()).toEqual([{ fromYear: 2024, startWeek: 21, startShare: 'J' }])
})

test('listEras returns eras ordered by fromYear ascending', async () => {
  await db.insert(seasonEra).values({ fromYear: 2030, startWeek: 22, startShare: 'D' })
  expect((await listEras()).map((e) => e.fromYear)).toEqual([2024, 2030])
})
```

Run: `pnpm test:node src/lib/services/season/season.test.ts`
Expected: FAIL — `listEras` is not exported (`season.ts` still exports `listSeasons`).

- [ ] **Step 5: Rewrite the service and procedure, drop `season` from the schema**

`src/lib/services/season/season.ts` — full new content:

```ts
import { asc } from 'drizzle-orm'
import { db } from '~/lib/db'
import { seasonEra } from '~/lib/db/schema'
import type { SeasonEra } from './logic'

// The append-only era rows (ADR-0019), oldest first. Never written from app
// code — convention changes are data migrations (see the ADR runbook).
export async function listEras(): Promise<Array<SeasonEra>> {
  return db
    .select({
      fromYear: seasonEra.fromYear,
      startWeek: seasonEra.startWeek,
      startShare: seasonEra.startShare,
    })
    .from(seasonEra)
    .orderBy(asc(seasonEra.fromYear))
}
```

`src/lib/orpc/procedures/season.ts` — full new content:

```ts
import { protectedProcedure } from '~/lib/orpc/context'
import * as seasonService from '~/lib/services/season'

export const seasonRouter = {
  // The Disponeringslista read (ADR-0019): every season is computed from its
  // governing era — no per-year rows, no mutations, no errors. Skips
  // ownership data on purpose; the grid only needs the share letter per cell.
  listSchedules: protectedProcedure.handler(async () => {
    const eras = await seasonService.listEras()
    return seasonService.buildSchedules(eras, new Date().getFullYear())
  }),
}
```

In `src/lib/db/schema/ownership.ts`: delete the whole `season` pgTable block (and its `date` import stays — `ownershipAssignment` uses it; `integer` stays for `seasonEra`).

In `src/lib/shares/codes.ts`: delete `ANCHOR_START_SHARE` and its comment ("The reference row in the historical schedule: 2024 starts at share J.") — the seed row carries the anchor now. Also update the `YEAR_WEEK_SLIP` comment's tail: replace "Stored per-season so admins can deviate when calendar quirks demand it; this is just the default used when creating a new season after an existing one." with "The rotation continues from each era's anchor share (see ADR-0019 and `services/season/logic.ts`)."

- [ ] **Step 6: Generate the drop migration**

Run: `pnpm db:generate --name=drop_season_table`
Expected: `drizzle/0021_drop_season_table.sql` containing exactly `DROP TABLE "season" CASCADE;` (or without CASCADE — either is fine; no FKs reference `season`). No prompts (nothing was added). Read the file to confirm it drops **only** `season`.

- [ ] **Step 7: Apply migrations to the local dev DB**

Run: `pnpm db:up && pnpm db:migrate`
Expected: migrations `0019`–`0021` apply cleanly. (Tests don't need this — they run all migrations per-test — but the local dev app does.)

- [ ] **Step 8: Run the suite**

Run: `pnpm test:node`
Expected: PASS — both new `listEras` tests green (the per-test schema runs the seed migration, so the anchor row is present), `logic.test.ts` green, the rest of the suite (shares, users, documents…) green against the new migration chain.

Run: `pnpm exec tsc --noEmit`
Expected: clean — nothing references `season`, `SeasonRow`, `listSeasons`, or `ANCHOR_START_SHARE` anymore.

- [ ] **Step 9: Biome + commit**

```bash
pnpm check
git add -A
git -c commit.gpgsign=false commit -m "feat(season): season_era table replaces season (ADR-0019)

Append-only effective-dated convention rows seeded with the 2024/21/J
anchor; listSchedules computes every year from its governing era.
Migration 0021 drops the season table — destructive by design, prod
had zero rows (verified against Neon 2026-07-05).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Review checkpoint — dispatch `migration-guard` and `test-completeness`**

Dispatch the `migration-guard` agent (schema + three new migrations: named? destructive op justified? no timestamptz alters? no `betterAuth.ts` touches?) and the `test-completeness` agent (service reshaped; no `errors.ts` remains — confirm no untested error codes). Address findings before proceeding.

---

### Task 5: Prune season i18n keys

**Files:**
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: nothing new. Produces: pruned message catalogs; `en.json` stays key-complete vs `sv.json`.

- [ ] **Step 1: Delete the 27 dead keys from BOTH `messages/sv.json` and `messages/en.json`**

```
season_create_description, season_create_error, season_create_submit,
season_create_title, season_created, season_delete_confirm,
season_delete_error, season_delete_title, season_deleted,
season_disponeringslista_empty, season_edit_description,
season_edit_title, season_edit_title_year, season_error_already_exists,
season_error_not_found, season_field_start_share,
season_field_start_share_description, season_field_start_week,
season_field_start_week_description, season_field_year,
season_update_error, season_updated,
season_validation_start_share_required, season_validation_week_invalid,
season_validation_week_range, season_validation_year_invalid,
season_validation_year_range
```

Keep (still used): the 12 `season_month_*` keys, `season_disponeringslista_title`, `season_my_week`, `season_my_week_prefix`.

- [ ] **Step 2: Recompile and verify nothing references the dead keys**

Run: `pnpm i18n:compile`
Expected: compiles cleanly.

Run: `pnpm exec tsc --noEmit`
Expected: clean — a leftover `m.season_created()` call anywhere would now be a type error.

Run: `grep -rn "m\.season_" src --include="*.ts" --include="*.tsx" | grep -v paraglide | grep -vE "season_month_|season_disponeringslista_title|season_my_week"`
Expected: no output.

Run: `python3 -c "import json; sv=set(json.load(open('messages/sv.json'))); en=set(json.load(open('messages/en.json'))); print(sv^en or 'key-complete')"`
Expected: `key-complete`.

- [ ] **Step 3: Biome + commit**

```bash
pnpm check
git add messages/sv.json messages/en.json
git -c commit.gpgsign=false commit -m "chore(i18n): prune season dialog and error keys

The season create/edit/delete surface is gone (ADR-0019); only the
month labels, table title, and my-week strings remain in use.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, full verification, and final review

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation and verification only.

- [ ] **Step 1: Update `CLAUDE.md`**

1. Header line "**Architecture lives in `docs/adr/`** (ADRs 0001–0017)." → "(ADRs 0001–0019)."
2. Skill-loading router table: add a row after the Shares & ownership row:
   `| Seasons & Disponeringslista (era table, computed schedules) | docs/adr/0019-season-eras.md |`
3. "Decisions made" — the code-only-errors bullet: change "**Folder, document, user & season errors are code-only; client localizes** (… document + user + season routers added 2026-06-14)" to "**Folder, document & user errors are code-only; client localizes** (… document + user routers added 2026-06-14; the season router lost its errors entirely with ADR-0019)", and remove `season` from the `src/lib/orpc/{folder,document,user,season}ErrorMessage.ts` path list.
4. "Decisions made" — append a new bullet:
   `- **Seasons are computed from eras** (2026-07-05). The per-year \`season\` table and its CRUD (dialogs, mutations, domain errors, \`season.changed\`) are gone; an append-only \`season_era\` table (seeded 2024/21/J) fixes start week + rotation anchor per era, and \`season.listSchedules\` computes min(from_year)..currentYear+1 on read. Convention changes are one-row data migrations (runbook in the ADR). Supersedes ADR-0009 Rule 2 (now structural). See ADR-0019.`

- [ ] **Step 2: Full verification**

Run: `pnpm check:ci`
Expected: clean.

Run: `pnpm test`
Expected: PASS — both projects (`node` + `browser`).

Run: `pnpm build`
Expected: Vite build + `tsc --noEmit` succeed.

- [ ] **Step 3: Live browser pass (feature-workflow Phase 6)**

With the dev stack up (`pnpm dev:up && pnpm dev`, or against the worktree per the constraints note): sign in and check `/`:
- Years 2024, 2025, 2026, 2027 render (current year 2026 highlighted), each starting at week 21 and ending at week 40.
- Start shares read J (2024), G (2025), D (2026), A (2027).
- No create/edit/delete affordances for an admin user; page identical for a non-admin.
- Owned-share rings still highlight (requires a user with an assigned share).

- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md
git -c commit.gpgsign=false commit -m "docs: record ADR-0019 season eras in CLAUDE.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Final review checkpoint**

Dispatch the `code-reviewer` agent over the branch diff (`git diff main...HEAD`). Address or consciously dismiss findings, then hand off to `superpowers:finishing-a-development-branch` (PR title: `feat(season): compute seasons from an append-only era table`, description = the why + ADR-0019 link).

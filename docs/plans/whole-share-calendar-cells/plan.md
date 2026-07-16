# Whole-Share Calendar Cells Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-06-whole-share-calendar-cells-design.md`

**Goal:** The Disponeringslista renders each share as **one cell spanning its two weeks** (letter once, one color band, one owned-ring box) instead of two per-week cells, on both the desktop table and the mobile year cards.

**Architecture:** A pure `shareBlocksForSeason` helper in `src/lib/services/season/logic.ts` chunks each season's 20 weeks into 10 whole-share blocks; `buildSchedules` emits them as a new `blocks` field per year, which flows through `season.listSchedules` untouched (the handler returns `buildSchedules(...)` verbatim). `DisponeringslistaTable` renders the desktop share row as `<td colSpan={block.span}>` per block and the mobile month sections as one full-width row per block.

**Tech Stack:** TypeScript, Vitest (node project for logic, Browser Mode/Chromium for the component), React 19 + TanStack Start, Tailwind v4, Paraglide i18n.

## Global Constraints

- **Commits:** Conventional Commits, and always `git commit --no-gpg-sign` (signing prompts hang the session).
- **Branch:** work happens on `feat/whole-share-calendar-cells` (already created; spec is its first commit).
- **i18n:** user-facing strings only via `m.<key>()` from `~/paraglide/messages`; `messages/sv.json` is source of truth, `en.json` must stay key-complete. After editing messages outside `pnpm dev`, run `pnpm i18n:compile`.
- **No `console.*`** anywhere (ADR-0003) — not needed in this change.
- **Styling:** semantic tokens only (`bg-muted`, `text-muted-foreground`, share colors via `shareBackgroundClass`); `gap-*` not `space-y-*`; every screen responsive.
- **No schema/migration, no oRPC procedure changes** — this feature adds a field to a pure function's return value and reworks one component.
- The en dash character `–` (U+2013) is used in week ranges (`21–22`) and in the new messages — not a hyphen.

---

### Task 1: `shareBlocksForSeason` + `blocks` in the season logic

**Files:**
- Modify: `src/lib/services/season/logic.ts`
- Test: `src/lib/services/season/logic.test.ts`

**Interfaces:**
- Consumes: existing `shareForWeek`, `WEEKS_PER_SEASON`, `WEEKS_PER_SHARE`, `SHARE_CODES` (from `~/lib/shares/codes`), existing `buildSchedules`.
- Produces (later tasks rely on these exact shapes):

  ```ts
  export type ShareBlock = {
    firstWeek: number
    lastWeek: number
    shareCode: ShareCode
    span: number
  }
  // YearSchedule gains: blocks: Array<ShareBlock>
  export function shareBlocksForSeason(input: {
    startWeek: number
    startShare: ShareCode
  }): Array<ShareBlock>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/services/season/logic.test.ts` (also extend the two import lists: add `shareBlocksForSeason` to the `./logic` import; add `SHARE_CODES` and `WEEKS_PER_SEASON` to the `~/lib/shares/codes` import). The `ANCHOR_ERA` constant (`{ fromYear: 2024, startWeek: 21, startShare: 'J' }`) already exists mid-file; these tests go below it.

```ts
test('shareBlocksForSeason pairs the 2026 season into 10 whole-share blocks', () => {
  const blocks = shareBlocksForSeason({ startWeek: 21, startShare: 'D' })
  expect(blocks).toHaveLength(SHARE_CODES.length)
  expect(blocks[0]).toEqual({ firstWeek: 21, lastWeek: 22, shareCode: 'D', span: 2 })
  expect(blocks[9]).toEqual({ firstWeek: 39, lastWeek: 40, shareCode: 'C', span: 2 })
  // Blocks tile the whole season with no gaps or overlap.
  expect(blocks.reduce((sum, b) => sum + b.span, 0)).toBe(WEEKS_PER_SEASON)
  for (let i = 1; i < blocks.length; i++) {
    expect(blocks[i]?.firstWeek).toBe((blocks[i - 1]?.lastWeek ?? 0) + 1)
  }
})

test('buildSchedules emits blocks that agree with the per-week cells', () => {
  const schedules = buildSchedules([ANCHOR_ERA], 2026)
  for (const s of schedules) {
    expect(s.blocks).toHaveLength(SHARE_CODES.length)
    for (const block of s.blocks) {
      const covered = s.cells.filter((c) => c.week >= block.firstWeek && c.week <= block.lastWeek)
      expect(covered).toHaveLength(block.span)
      for (const cell of covered) {
        expect(cell.shareCode).toBe(block.shareCode)
      }
    }
  }
})

test('a block can straddle a month boundary (2027: A = w21 Maj + w22 Jun)', () => {
  const y2027 = buildSchedules([ANCHOR_ERA], 2026).find((s) => s.year === 2027)
  expect(y2027?.blocks[0]).toEqual({ firstWeek: 21, lastWeek: 22, shareCode: 'A', span: 2 })
  // The two weeks of that block fall in different calendar months.
  expect(monthForISOWeek(2027, 21)).toBe(4) // Maj
  expect(monthForISOWeek(2027, 22)).toBe(5) // Jun
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:node src/lib/services/season/logic.test.ts`
Expected: FAIL — `shareBlocksForSeason` is not exported (TS/ESM resolution error), and `s.blocks` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/services/season/logic.ts`:

Add below the `ScheduleCell` type:

```ts
// A whole-share block: the WEEKS_PER_SHARE consecutive weeks one share
// occupies (ADR-0018 — shares are indivisible, so this is the atomic
// calendar unit the UI renders).
export type ShareBlock = {
  firstWeek: number
  lastWeek: number
  shareCode: ShareCode
  span: number
}
```

Extend `YearSchedule`:

```ts
export type YearSchedule = {
  year: number
  cells: Array<ScheduleCell>
  blocks: Array<ShareBlock>
  monthBands: Array<MonthBand>
}
```

Add the pure helper next to `shareForWeek`:

```ts
// Pure: chunks the season's weeks into whole-share blocks of
// WEEKS_PER_SHARE consecutive weeks from startWeek.
export function shareBlocksForSeason(input: {
  startWeek: number
  startShare: ShareCode
}): Array<ShareBlock> {
  const blocks: Array<ShareBlock> = []
  for (let offset = 0; offset < WEEKS_PER_SEASON; offset += WEEKS_PER_SHARE) {
    const firstWeek = input.startWeek + offset
    const shareCode = shareForWeek(input, firstWeek)
    // Unreachable within the loop bounds — same backstop rationale as the
    // cells loop in buildSchedules.
    if (!shareCode) {
      throw new Error(`shareForWeek returned null for week ${firstWeek}`)
    }
    blocks.push({
      firstWeek,
      lastWeek: firstWeek + WEEKS_PER_SHARE - 1,
      shareCode,
      span: WEEKS_PER_SHARE,
    })
  }
  return blocks
}
```

In `buildSchedules`, extend the pushed object:

```ts
schedules.push({
  year,
  cells,
  blocks: shareBlocksForSeason(season),
  monthBands: monthBandsForSeason({ year, startWeek: season.startWeek }),
})
```

(`WEEKS_PER_SHARE` is already imported in this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:node src/lib/services/season/logic.test.ts`
Expected: PASS — all existing tests plus the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/season/logic.ts src/lib/services/season/logic.test.ts
git commit --no-gpg-sign -m "feat(season): compute whole-share blocks in the schedule logic"
```

---

### Task 2: i18n week-range messages

**Files:**
- Modify: `messages/sv.json` (around line 312)
- Modify: `messages/en.json` (around line 312)

**Interfaces:**
- Produces: `m.season_my_weeks({ from: number, to: number })` and `m.season_my_weeks_prefix()` for Tasks 3–4.
- Note: the old keys `season_my_week` / `season_my_week_prefix` are still referenced by the unmodified component — they are **removed in Task 4**, not here.

- [ ] **Step 1: Add the new keys**

In `messages/sv.json`, directly after `"season_my_week_prefix": "Din vecka",` (keys stay alphabetically sorted — `_` sorts before `s`, so the order is `season_my_week`, `season_my_week_prefix`, `season_my_weeks`, `season_my_weeks_prefix`):

```json
  "season_my_weeks": "Dina veckor {from}–{to}",
  "season_my_weeks_prefix": "Dina veckor",
```

In `messages/en.json`, same position:

```json
  "season_my_weeks": "Your weeks {from}–{to}",
  "season_my_weeks_prefix": "Your weeks",
```

- [ ] **Step 2: Compile and verify**

Run: `pnpm i18n:compile`
Expected: succeeds; `src/paraglide/` regenerated with the new message functions.

- [ ] **Step 3: Commit**

```bash
git add messages/sv.json messages/en.json
git commit --no-gpg-sign -m "feat(i18n): add whole-share week-range messages"
```

---

### Task 3: Desktop table — one merged cell per block (TDD)

**Files:**
- Create: `src/components/season/DisponeringslistaTable.browser.test.tsx`
- Modify: `src/components/season/DisponeringslistaTable.tsx` (the `YearBlock` share row, lines ~163-183, plus the local types)

**Interfaces:**
- Consumes: `blocks`/`ShareBlock` from Task 1 (via the `buildSchedules` fixture), `m.season_my_weeks` from Task 2.
- Produces: local `ShareBlock` type + `blocks` field on the component's local `YearSchedule` type (Task 4's mobile layout uses both); the test file that Task 4 appends to.

**Fixture notes (why these letters/weeks):** 2026 under the seeded era (2024/21/J) starts at share D, weeks 21–40 → blocks D E F G H I J A B C. 2026 month bands are Maj 21-22, Jun 23-26, Jul 27-31, Aug 32-35, Sep 36-39, Okt 40 — so block F (25–26) ends exactly at Jun's last week (divider), block I (31–32) straddles Jul/Aug (no divider), and Okt contains only the tail week of block C (39–40). Using the fixed year 2026 keeps the ISO month math deterministic regardless of wall-clock; assertions deliberately avoid `isCurrent`-dependent styling. The Vitest browser default viewport is 414×896 (mobile), so desktop tests must set `page.viewport` explicitly.

- [ ] **Step 1: Write the failing browser test**

Create `src/components/season/DisponeringslistaTable.browser.test.tsx`:

```tsx
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { DisponeringslistaTable } from '~/components/season/DisponeringslistaTable'
import { buildSchedules } from '~/lib/services/season/logic'
import type { ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'

const ERA = { fromYear: 2024, startWeek: 21, startShare: 'J' as const }
const y2026 = buildSchedules([ERA], 2026).find((s) => s.year === 2026)
if (!y2026) throw new Error('fixture: 2026 schedule missing')

const NO_SHARES: ReadonlySet<ShareCode> = new Set()

test('wide layout renders one merged cell per share', async () => {
  await page.viewport(1280, 800)
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} ownedShareCodes={NO_SHARES} />,
  )
  const shareCells = [...screen.container.querySelectorAll('td[colspan="2"]')]
  expect(shareCells.map((c) => c.textContent)).toEqual([
    'D', 'E', 'F', 'G', 'H', 'I', 'J', 'A', 'B', 'C',
  ])
  // The week-number header row (2nd table row) still has all 20 per-week
  // columns. (Structural query, not getByText — the mobile layout's week
  // texts would make text locators ambiguous.)
  const weekRow = screen.container.querySelectorAll('tr')[1]
  expect(weekRow?.querySelectorAll('td')).toHaveLength(20)
})

test('month divider stops above a straddling block', async () => {
  await page.viewport(1280, 800)
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} ownedShareCodes={NO_SHARES} />,
  )
  const cells = [...screen.container.querySelectorAll('td[colspan="2"]')]
  const cellF = cells.find((c) => c.textContent === 'F') // 25–26 ends at Jun's last week
  const cellI = cells.find((c) => c.textContent === 'I') // 31–32 straddles Jul/Aug
  expect(cellF?.className).toContain('border-r')
  expect(cellI?.className).not.toContain('border-r')
})

test('owned share renders one merged cell with a range label', async () => {
  await page.viewport(1280, 800)
  const screen = await render(
    <DisponeringslistaTable
      schedules={[y2026]}
      ownedShareCodes={new Set<ShareCode>(['C'])}
    />,
  )
  // C owns weeks 39–40 in 2026: a single cell labelled with the whole range.
  await expect
    .element(screen.getByLabelText(m.season_my_weeks({ from: 39, to: 40 })))
    .toBeVisible()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project browser src/components/season/DisponeringslistaTable.browser.test.tsx`
Expected: FAIL — `td[colspan="2"]` matches nothing (share letters currently render twice in per-week cells), and no element carries the range label.

- [ ] **Step 3: Implement the desktop share row**

In `src/components/season/DisponeringslistaTable.tsx`:

Add a `ShareBlock` type next to the existing local `Cell` type, and extend the local `YearSchedule` (this file deliberately declares its own structural types for the oRPC payload — follow that pattern, don't import from the service):

```ts
export type ShareBlock = {
  firstWeek: number
  lastWeek: number
  shareCode: ShareCode
  span: number
}

export type YearSchedule = {
  year: number
  cells: Array<Cell>
  blocks: Array<ShareBlock>
  monthBands: Array<MonthBand>
}
```

Replace the share row in `YearBlock` (the third `<tr>`, currently mapping `s.cells`) with a block-per-cell version. The month divider appears only when the block *ends* at a month end — a straddling block renders as one clean merged cell with no divider through it (spec decision 1):

```tsx
      <tr>
        {s.blocks.map((block) => {
          const isMine = ownedShareCodes.has(block.shareCode)
          return (
            <td
              key={block.firstWeek}
              colSpan={block.span}
              aria-label={
                isMine
                  ? m.season_my_weeks({ from: block.firstWeek, to: block.lastWeek })
                  : undefined
              }
              className={cn(
                'relative px-1 py-2 text-center font-medium',
                monthEndWeeks.has(block.lastWeek) && 'border-r',
                isCurrent
                  ? cn(shareBackgroundClass[block.shareCode], 'font-bold text-foreground')
                  : 'text-muted-foreground',
                isMine && OWNED_RING,
              )}
            >
              {block.shareCode}
            </td>
          )
        })}
      </tr>
```

The month-band row and week-number row stay exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project browser src/components/season/DisponeringslistaTable.browser.test.tsx`
Expected: PASS — all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/season/DisponeringslistaTable.tsx src/components/season/DisponeringslistaTable.browser.test.tsx
git commit --no-gpg-sign -m "feat(season): merge desktop share cells into whole-share blocks"
```

---

### Task 4: Mobile year cards — one row per block (TDD) + old key removal

**Files:**
- Modify: `src/components/season/DisponeringslistaTable.browser.test.tsx` (append tests)
- Modify: `src/components/season/DisponeringslistaTable.tsx` (`YearCard` + `MonthSection`)
- Modify: `messages/sv.json`, `messages/en.json` (remove the two old keys)

**Interfaces:**
- Consumes: `blocks`/`ShareBlock` on the component's `YearSchedule` (Task 3), `m.season_my_weeks_prefix` (Task 2), test fixture from Task 3's file.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Append the failing mobile tests**

Append to `src/components/season/DisponeringslistaTable.browser.test.tsx`:

```tsx
test('mobile layout lists one row per block with a week range', async () => {
  await page.viewport(390, 844)
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} ownedShareCodes={NO_SHARES} />,
  )
  await expect.element(screen.getByText('21–22')).toBeVisible()
  await expect.element(screen.getByText('39–40')).toBeVisible()
})

test('mobile layout skips a month heading that only holds a block tail', async () => {
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} ownedShareCodes={NO_SHARES} />,
  )
  // 2026's Okt band is only week 40 — the tail of the 39–40 block, whose row
  // lives under Sep. Month headings are the mobile layout's only <h3>s; the
  // exact sequence pins the block grouping (and the Okt skip) without
  // depending on CSS visibility (the browser test env loads no Tailwind).
  const headings = [...screen.container.querySelectorAll('h3')].map((h) => h.textContent)
  expect(headings).toEqual([
    m.season_month_may(),
    m.season_month_jun(),
    m.season_month_jul(),
    m.season_month_aug(),
    m.season_month_sep(),
  ])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project browser src/components/season/DisponeringslistaTable.browser.test.tsx`
Expected: the two new tests FAIL — mobile currently renders per-week rows (`21` and `22` separately, no `21–22` text) and an Okt section heading (a 6th `<h3>`, failing the 5-heading sequence). Task 3's tests still PASS.

> **Execution amendment (2026-07-06):** the heading test was originally written as a CSS-visibility assertion (`.not.toBeVisible()` on the wide layout's hidden `Okt` band). The browser-test harness deliberately loads no Tailwind CSS, so `hidden`/`lg:hidden` have no effect there — the assertion was environmentally impossible. Replaced with the structural `<h3>` sequence above (same spec requirement); real responsive visibility is covered by Task 5's live browser pass.

- [ ] **Step 3: Implement the mobile block rows**

In `src/components/season/DisponeringslistaTable.tsx`:

Replace `YearCard`'s band-mapping body — blocks belong to the month of their **first** week; a band that only holds a block tail renders nothing (spec decision 2):

```tsx
      <div className="flex flex-col">
        {schedule.monthBands.map((band) => {
          const blocks = schedule.blocks.filter(
            (b) => b.firstWeek >= band.firstWeek && b.firstWeek <= band.lastWeek,
          )
          // A band holding only the tail week of a block (e.g. a 1-week Okt
          // band after the 39–40 block) gets no section — the block's row
          // already sits under its starting month.
          if (blocks.length === 0) return null
          return (
            <MonthSection
              key={band.firstWeek}
              band={band}
              blocks={blocks}
              isCurrent={isCurrent}
              ownedShareCodes={ownedShareCodes}
            />
          )
        })}
      </div>
```

Replace `MonthSection` entirely (the 2-column week grid and the `needsPlaceholder` hack disappear — blocks are always whole):

```tsx
type MonthSectionProps = {
  band: MonthBand
  blocks: Array<ShareBlock>
  isCurrent: boolean
  ownedShareCodes: ReadonlySet<ShareCode>
}

function MonthSection({ band, blocks, isCurrent, ownedShareCodes }: MonthSectionProps) {
  return (
    <section className="border-b last:border-b-0">
      <h3 className="bg-muted/50 px-4 py-1 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
        {MONTH_LABELS[band.month]?.()}
      </h3>
      <div className="flex flex-col">
        {blocks.map((block, i) => {
          const isMine = ownedShareCodes.has(block.shareCode)
          return (
            <div
              key={block.firstWeek}
              className={cn(
                'flex items-center justify-between gap-2 px-4 py-2',
                i > 0 && 'border-t',
                isCurrent && shareBackgroundClass[block.shareCode],
                isMine && OWNED_RING,
              )}
            >
              {isMine && <span className="sr-only">{m.season_my_weeks_prefix()} </span>}
              <span
                className={cn(
                  'tabular-nums',
                  isCurrent ? 'text-foreground/80' : 'text-muted-foreground',
                )}
              >
                {block.firstWeek}–{block.lastWeek}
              </span>
              <span
                className={cn(
                  'font-semibold',
                  isCurrent ? 'font-bold text-foreground' : 'text-muted-foreground',
                )}
              >
                {block.shareCode}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

(The week range uses the en dash `–` directly in JSX. The local `Cell` type stays — the week-number header row still consumes `cells`.)

- [ ] **Step 4: Remove the obsolete i18n keys**

Both usages are now gone. Delete from `messages/sv.json`:

```json
  "season_my_week": "Din vecka {week}",
  "season_my_week_prefix": "Din vecka",
```

Delete from `messages/en.json`:

```json
  "season_my_week": "Your week {week}",
  "season_my_week_prefix": "Your week",
```

Run: `pnpm i18n:compile`
Expected: succeeds.

- [ ] **Step 5: Run the browser tests to verify they pass**

Run: `pnpm vitest run --project browser src/components/season/DisponeringslistaTable.browser.test.tsx`
Expected: PASS — all 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/season/DisponeringslistaTable.tsx src/components/season/DisponeringslistaTable.browser.test.tsx messages/sv.json messages/en.json
git commit --no-gpg-sign -m "feat(season): render mobile year cards as whole-share block rows"
```

---

### Task 5: Full verification, review, live check

**Files:** none created — verification and review only.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: both projects (node + browser) fully green.

- [ ] **Step 2: Lint/format + typecheck via build**

Run: `pnpm check && pnpm build`
Expected: Biome clean (it may rewrite Tailwind class order — if it changes files, include them in a `chore` commit or amend into the previous task's commit before pushing); build + `tsc --noEmit` succeed. A leftover `m.season_my_week` reference anywhere would fail here.

- [ ] **Step 3: Review agents (feature-workflow Phase 5)**

- `test-completeness` agent — a service file changed (`logic.ts`); confirms the new logic is covered (no new domain-error codes exist, so this should be quick).
- `code-reviewer` agent — ADR-aware review of the full branch diff.
- `migration-guard` is **not** needed (no `drizzle/` or schema changes).

Address findings or consciously dismiss them with reasons.

- [ ] **Step 4: Live visual verification (feature-workflow Phase 6)**

With `pnpm dev` running and a signed-in session, verify in a real browser (claude-in-chrome) on `http://localhost:14500/`:

- Desktop (≥1024px): every share letter appears once per year row, spanning two week columns; the current-year row shows one continuous pastel band per share; a straddling block (2027 row: A across Maj/Jun) has no divider through it while the header rows keep theirs; an owned share (if the signed-in user owns one) shows **one** ring around the whole block.
- Mobile (<1024px, e.g. 390px): month sections list `21–22 … D` rows; no half-empty grid cells; a tail-only month (2026: Okt) has no heading.
- Both light and dark themes.
- Sanity-check `/` in Swedish and English (locale toggle) for the aria-label strings (inspect an owned cell's `aria-label`).

- [ ] **Step 5: Ship**

Use superpowers:finishing-a-development-branch. PR (squash-merge) with:

- Title: `feat(season): render whole-share calendar cells in the Disponeringslista`
- Body: the *why* (per-week cells were a half-share-era leftover; ADR-0018 made shares indivisible so one share = one 2-week block), link to the spec, note the three design decisions (merged cell wins at month boundaries; mobile block rows under starting month; pairing computed in pure season logic).

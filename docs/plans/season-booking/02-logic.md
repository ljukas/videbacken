# Plan 02 — Pure booking logic (TDD)

> Part of [season-booking](./README.md). Requires plan 01 committed. Steps use checkbox syntax for tracking.

**Goal:** `src/lib/services/booking/logic.ts` — era-fed, DB-free (mirrors `services/season/logic.ts`): the active-year flip, era-derived extra blocks, nominal slot seeding, and the cycle-solver suggestion. Plus `monthBandsForRange` in the season logic.

**Fixture background (used throughout):** the seeded era is `{ fromYear: 2024, startWeek: 21, startShare: 'J' }` (migration `0020_seed_season_era_anchor.sql`; test fixture `ANCHOR_ERA` in `test/fixtures/season.ts`). Rotation is −3 shares/year, so **2026 starts at share D**: blocks are 21–22 D, 23–24 E, 25–26 F, 27–28 G, 29–30 H, 31–32 I, 33–34 J, 35–36 A, 37–38 B, 39–40 C. Extras: 19–20 and 41–42.

---

### Task 1: `monthBandsForRange` in the season logic

**Files:**
- Modify: `src/lib/services/season/logic.ts`
- Test: `src/lib/services/season/logic.test.ts`

**Interfaces:**
- Produces: `monthBandsForRange(input: { year: number; firstWeek: number; lastWeek: number }): Array<MonthBand>` — plan 04's `getActive` bands the 24-week strip with it. `monthBandsForSeason` behavior unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/services/season/logic.test.ts` (add `monthBandsForRange` to the `./logic` import list):

```ts
test('monthBandsForRange bands an arbitrary range and the season variant delegates', () => {
  const range = monthBandsForRange({ year: 2026, firstWeek: 19, lastWeek: 42 })
  expect(range.reduce((sum, b) => sum + b.span, 0)).toBe(24)
  expect(range[0]?.firstWeek).toBe(19)
  expect(range[range.length - 1]?.lastWeek).toBe(42)
  // The season slice is exactly the range variant over the season weeks.
  expect(monthBandsForSeason({ year: 2026, startWeek: 21 })).toEqual(
    monthBandsForRange({ year: 2026, firstWeek: 21, lastWeek: 40 }),
  )
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:node src/lib/services/season/logic.test.ts`
Expected: FAIL — `monthBandsForRange` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/services/season/logic.ts`, replace the body of `monthBandsForSeason` and add the range variant directly above it:

```ts
// Pure: collapses an arbitrary inclusive ISO-week range into contiguous
// same-month bands (generalizes the season variant — the booking strip
// spans the season plus both shoulder blocks, ADR-0020).
export function monthBandsForRange(input: {
  year: number
  firstWeek: number
  lastWeek: number
}): Array<MonthBand> {
  const bands: Array<MonthBand> = []
  for (let week = input.firstWeek; week <= input.lastWeek; week++) {
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

// Pure: collapses the 20 season weeks into contiguous same-month bands.
// Each band carries its calendar month (0-indexed), the inclusive week
// range, and the span (so callers can drive `<td colSpan>` directly).
export function monthBandsForSeason(input: { year: number; startWeek: number }): Array<MonthBand> {
  return monthBandsForRange({
    year: input.year,
    firstWeek: input.startWeek,
    lastWeek: input.startWeek + WEEKS_PER_SEASON - 1,
  })
}
```

- [ ] **Step 4: Run the season tests to verify they pass**

Run: `pnpm test:node src/lib/services/season/logic.test.ts`
Expected: PASS — all existing tests plus the new one (the delegation must not change any existing band output).

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/season/logic.ts src/lib/services/season/logic.test.ts
git commit --no-gpg-sign -m "refactor(season): generalize month bands to arbitrary week ranges"
```

---

### Task 2: Active year, extra blocks, nominal slots

**Files:**
- Create: `src/lib/services/booking/logic.ts`
- Create: `src/lib/services/booking/logic.test.ts`

**Interfaces:**
- Consumes: `shareBlocksForSeason` from `~/lib/services/season/logic`; `SHARE_CODES`, `ShareCode`, `WEEKS_PER_SEASON`, `WEEKS_PER_SHARE` from `~/lib/shares/codes`; `getISOWeek`, `getISOWeekYear` from `date-fns` (first use in the repo — direct dependency, v4).
- Produces (plans 03–06 rely on these exact shapes):

  ```ts
  export type BookingTarget = 'share' | 'extra_early' | 'extra_late'
  export type SlotKind = 'rotation' | 'extra'
  export type Slot = { firstWeek: number; lastWeek: number; kind: SlotKind; holder: ShareCode | null }
  export type WishInput = { shareCode: ShareCode; targetKind: BookingTarget; targetShare: ShareCode | null }
  export type ExtraBlocks = {
    early: { firstWeek: number; lastWeek: number }
    late: { firstWeek: number; lastWeek: number }
  }
  export function activeSeasonYearFor(date: Date): number
  export function extraBlocksForSeason(season: { startWeek: number }): ExtraBlocks
  export function nominalSlotsForSeason(season: { startWeek: number; startShare: ShareCode }): Array<Slot>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/services/booking/logic.test.ts`:

```ts
import { expect, test } from 'vitest'
import { activeSeasonYearFor, extraBlocksForSeason, nominalSlotsForSeason } from './logic'

// 2026 under the seeded era (2024/21/J): startShare D — see the fixture
// background in docs/plans/season-booking/02-logic.md.
const SEASON_2026 = { startWeek: 21, startShare: 'D' } as const

test('activeSeasonYearFor: mid-season dates target the ongoing season', () => {
  expect(activeSeasonYearFor(new Date('2026-07-06T12:00:00Z'))).toBe(2026)
})

test('activeSeasonYearFor: the round flips at the start of ISO week 43', () => {
  // 2026-10-18 is the Sunday of ISO week 42; 2026-10-19 the Monday of week 43.
  expect(activeSeasonYearFor(new Date('2026-10-18T12:00:00Z'))).toBe(2026)
  expect(activeSeasonYearFor(new Date('2026-10-19T12:00:00Z'))).toBe(2027)
})

test('activeSeasonYearFor: early January inside ISO week 53 of a 53-week year', () => {
  // 2026 is a 53-week ISO year (Jan 1 2026 is a Thursday). 2027-01-01 falls
  // in ISO week 53 of ISO year 2026 — >= 43, so the active season is 2027.
  // Plain getFullYear would also say 2027 here, but getISOWeekYear is what
  // keeps the pair (week, year) consistent for the >= 43 comparison.
  expect(activeSeasonYearFor(new Date('2027-01-01T12:00:00Z'))).toBe(2027)
})

test('extraBlocksForSeason derives both shoulders from the era, not constants', () => {
  expect(extraBlocksForSeason({ startWeek: 21 })).toEqual({
    early: { firstWeek: 19, lastWeek: 20 },
    late: { firstWeek: 41, lastWeek: 42 },
  })
  // A convention change (ADR-0019 runbook) moves the shoulders with it.
  expect(extraBlocksForSeason({ startWeek: 23 })).toEqual({
    early: { firstWeek: 21, lastWeek: 22 },
    late: { firstWeek: 43, lastWeek: 44 },
  })
})

test('nominalSlotsForSeason seeds 12 slots: extra + 10 rotation + extra', () => {
  const slots = nominalSlotsForSeason(SEASON_2026)
  expect(slots).toHaveLength(12)
  expect(slots[0]).toEqual({ firstWeek: 19, lastWeek: 20, kind: 'extra', holder: null })
  expect(slots[1]).toEqual({ firstWeek: 21, lastWeek: 22, kind: 'rotation', holder: 'D' })
  expect(slots[10]).toEqual({ firstWeek: 39, lastWeek: 40, kind: 'rotation', holder: 'C' })
  expect(slots[11]).toEqual({ firstWeek: 41, lastWeek: 42, kind: 'extra', holder: null })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:node src/lib/services/booking/logic.test.ts`
Expected: FAIL — module `./logic` does not exist.

- [ ] **Step 3: Implement**

Create `src/lib/services/booking/logic.ts`:

```ts
import { getISOWeek, getISOWeekYear } from 'date-fns'
import { shareBlocksForSeason } from '~/lib/services/season/logic'
import {
  SHARE_CODES,
  type ShareCode,
  WEEKS_PER_SEASON,
  WEEKS_PER_SHARE,
} from '~/lib/shares/codes'

// Pure booking-round logic (ADR-0020): era-fed, no DB — mirrors
// services/season/logic.ts. The service (booking.ts) feeds it rows.

export type BookingTarget = 'share' | 'extra_early' | 'extra_late'
export type SlotKind = 'rotation' | 'extra'

// One concrete-week slot of the 12-slot round: early extra, ten rotation
// blocks, late extra. Week numbers are stored, never derived at read time
// (ADR-0019 revisit trigger, consumed by ADR-0020).
export type Slot = {
  firstWeek: number
  lastWeek: number
  kind: SlotKind
  holder: ShareCode | null
}

export type WishInput = {
  shareCode: ShareCode
  targetKind: BookingTarget
  targetShare: ShareCode | null
}

// Deliberately a constant, not era math: deriving "the week after the late
// extra ends" needs the governing era, which needs the year — circular.
// ADR-0020 (product decision 2) fixed the flip at ISO week 43
// (= 21 + 20 + 2 under the 2024 era). Revisit with any era convention change.
const ACTIVE_FLIP_WEEK = 43

// The season year the single active round targets: year Y from the start of
// ISO week 43 of Y−1 (right after the late extra ends) until the start of
// ISO week 43 of Y. The ISO week-numbering year makes the early-January
// edge (Jan 1 falling in week 52/53 of the old year) resolve correctly.
export function activeSeasonYearFor(date: Date): number {
  const isoYear = getISOWeekYear(date)
  return getISOWeek(date) >= ACTIVE_FLIP_WEEK ? isoYear + 1 : isoYear
}

export type ExtraBlocks = {
  early: { firstWeek: number; lastWeek: number }
  late: { firstWeek: number; lastWeek: number }
}

// The two shoulder blocks, derived from the governing era so they follow a
// future convention change (week numbers 19/41 appear nowhere in code):
// one WEEKS_PER_SHARE-wide block ending just before startWeek and one
// starting just after the last rotation block.
export function extraBlocksForSeason(season: { startWeek: number }): ExtraBlocks {
  return {
    early: {
      firstWeek: season.startWeek - WEEKS_PER_SHARE,
      lastWeek: season.startWeek - 1,
    },
    late: {
      firstWeek: season.startWeek + WEEKS_PER_SEASON,
      lastWeek: season.startWeek + WEEKS_PER_SEASON + WEEKS_PER_SHARE - 1,
    },
  }
}

// The 12 seed slots: early extra (holder NULL), the ten rotation blocks
// (nominal holders), late extra (holder NULL). Ordered by firstWeek.
export function nominalSlotsForSeason(season: {
  startWeek: number
  startShare: ShareCode
}): Array<Slot> {
  const extras = extraBlocksForSeason(season)
  return [
    { ...extras.early, kind: 'extra' as const, holder: null },
    ...shareBlocksForSeason(season).map((block) => ({
      firstWeek: block.firstWeek,
      lastWeek: block.lastWeek,
      kind: 'rotation' as const,
      holder: block.shareCode,
    })),
    { ...extras.late, kind: 'extra' as const, holder: null },
  ]
}
```

- [ ] **Step 4: Run to verify the Task 2 tests pass**

Run: `pnpm test:node src/lib/services/booking/logic.test.ts`
Expected: PASS — the 5 Task-2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/booking/logic.ts src/lib/services/booking/logic.test.ts
git commit --no-gpg-sign -m "feat(booking): active-year flip, extra blocks and nominal slots"
```

---

### Task 3: `buildSuggestion` — the cycle solver + extra rules

**Files:**
- Modify: `src/lib/services/booking/logic.ts`
- Modify: `src/lib/services/booking/logic.test.ts`

**Interfaces:**
- Produces (plans 03–06 rely on these exact shapes):

  ```ts
  export type AutoExtra = {
    firstWeek: number
    lastWeek: number
    holder: ShareCode
    reason: 'adjacent' | 'sole_interest'
  }
  export type OpenExtra = { firstWeek: number; lastWeek: number; interested: Array<ShareCode> }
  export type SuggestionInput = {
    season: { startWeek: number; startShare: ShareCode }
    wishes: ReadonlyArray<WishInput>
    assignedShares: ReadonlySet<ShareCode>
  }
  export type Suggestion = {
    slots: Array<Slot>                     // the full 12-slot draft (ADR's `assignments`)
    cycles: Array<Array<ShareCode>>        // canonical: first element is the cycle's earliest share
    satisfiedShares: Array<ShareCode>      // sorted A→J
    tradeWishShares: Array<ShareCode>      // sorted A→J; the "av {total}" denominator
    autoExtras: Array<AutoExtra>
    openExtras: Array<OpenExtra>
  }
  export function buildSuggestion(input: SuggestionInput): Suggestion
  ```

- Cycle semantics: `['A', 'D', 'F']` means A→D→F→A — **each share takes the block of the share it points at** (A gets D's block, D gets F's, F gets A's). A 2-cycle `['A', 'D']` is the mutual swap A ↔ D.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/services/booking/logic.test.ts`. First extend the preamble — add `buildSuggestion` and `type WishInput` to the `./logic` import, add `import { SHARE_CODES, type ShareCode } from '~/lib/shares/codes'`, and add below `SEASON_2026`:

```ts
const ALL_ASSIGNED: ReadonlySet<ShareCode> = new Set(SHARE_CODES)

function tradeWish(shareCode: ShareCode, targetShare: ShareCode): WishInput {
  return { shareCode, targetKind: 'share', targetShare }
}

function extraWish(shareCode: ShareCode, targetKind: 'extra_early' | 'extra_late'): WishInput {
  return { shareCode, targetKind, targetShare: null }
}
```

Then append the tests:

```ts
test('buildSuggestion: a mutual wish becomes an A ↔ D swap', () => {
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [tradeWish('A', 'D'), tradeWish('D', 'A')],
    assignedShares: ALL_ASSIGNED,
  })
  expect(s.cycles).toEqual([['A', 'D']])
  expect(s.satisfiedShares).toEqual(['A', 'D'])
  // D's nominal block is 21–22; A takes it. A's is 35–36; D takes that.
  expect(s.slots.find((x) => x.firstWeek === 21)?.holder).toBe('A')
  expect(s.slots.find((x) => x.firstWeek === 35)?.holder).toBe('D')
  // Everyone else stays.
  expect(s.slots.find((x) => x.firstWeek === 23)?.holder).toBe('E')
})

test('buildSuggestion: a three-share rotation resolves as one cycle', () => {
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [tradeWish('A', 'D'), tradeWish('D', 'F'), tradeWish('F', 'A')],
    assignedShares: ALL_ASSIGNED,
  })
  expect(s.cycles).toEqual([['A', 'D', 'F']])
  expect(s.slots.find((x) => x.firstWeek === 21)?.holder).toBe('A') // D's block → A
  expect(s.slots.find((x) => x.firstWeek === 25)?.holder).toBe('D') // F's block → D
  expect(s.slots.find((x) => x.firstWeek === 35)?.holder).toBe('F') // A's block → F
})

test('buildSuggestion: overlapping cycles pick the max-coverage set', () => {
  // B is wanted by both A and C. The 4-share solution (A↔B + C↔D) must beat
  // any single 2-cycle through B.
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [
      tradeWish('A', 'B'),
      tradeWish('B', 'A'),
      tradeWish('B', 'C'),
      tradeWish('C', 'B'),
      tradeWish('C', 'D'),
      tradeWish('D', 'C'),
    ],
    assignedShares: ALL_ASSIGNED,
  })
  expect(s.cycles).toEqual([
    ['A', 'B'],
    ['C', 'D'],
  ])
  expect(s.satisfiedShares).toEqual(['A', 'B', 'C', 'D'])
})

test('buildSuggestion: equal-coverage ties break to the earliest share, deterministically', () => {
  // [A,B] and [B,C] both cover 2 shares — the cycle through A (canonical
  // enumeration order, first maximum wins) is the stable pick.
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [tradeWish('A', 'B'), tradeWish('B', 'A'), tradeWish('B', 'C'), tradeWish('C', 'B')],
    assignedShares: ALL_ASSIGNED,
  })
  expect(s.cycles).toEqual([['A', 'B']])
})

test('buildSuggestion: the post-trade first-block holder gets the early extra it marked', () => {
  // A ↔ D moves A onto the first block (21–22); A also marked 19–20. D
  // marked it too but no longer holds the adjacent block — adjacency wins,
  // nothing is left open.
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [
      tradeWish('A', 'D'),
      tradeWish('D', 'A'),
      extraWish('A', 'extra_early'),
      extraWish('D', 'extra_early'),
    ],
    assignedShares: ALL_ASSIGNED,
  })
  expect(s.autoExtras).toContainEqual({
    firstWeek: 19,
    lastWeek: 20,
    holder: 'A',
    reason: 'adjacent',
  })
  expect(s.slots.find((x) => x.firstWeek === 19)?.holder).toBe('A')
  expect(s.openExtras).toEqual([])
})

test('buildSuggestion: sole interest is auto-granted, contested extras stay open', () => {
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [
      extraWish('G', 'extra_late'),
      extraWish('A', 'extra_early'),
      extraWish('B', 'extra_early'),
    ],
    assignedShares: ALL_ASSIGNED,
  })
  // 41–42: C holds the last block (39–40) but didn't mark it; G is the only
  // interested share → auto-granted.
  expect(s.autoExtras).toContainEqual({
    firstWeek: 41,
    lastWeek: 42,
    holder: 'G',
    reason: 'sole_interest',
  })
  // 19–20: D holds 21–22 but didn't mark it; A and B contest → open, holder stays NULL.
  expect(s.openExtras).toEqual([{ firstWeek: 19, lastWeek: 20, interested: ['A', 'B'] }])
  expect(s.slots.find((x) => x.firstWeek === 19)?.holder).toBeNull()
})

test('buildSuggestion: unassigned shares are extras, not trade partners', () => {
  const assigned: ReadonlySet<ShareCode> = new Set(SHARE_CODES.filter((c) => c !== 'E'))
  const s = buildSuggestion({
    season: SEASON_2026,
    // A "trade" wish targeting unassigned E is interest in E's block, not an edge.
    wishes: [tradeWish('A', 'E')],
    assignedShares: assigned,
  })
  expect(s.cycles).toEqual([])
  // E's nominal block is 23–24; A is the sole interested share → granted.
  expect(s.autoExtras).toContainEqual({
    firstWeek: 23,
    lastWeek: 24,
    holder: 'A',
    reason: 'sole_interest',
  })
  expect(s.slots.find((x) => x.firstWeek === 23)?.holder).toBe('A')
})

test('buildSuggestion: a contested unassigned block lands in openExtras', () => {
  const assigned: ReadonlySet<ShareCode> = new Set(SHARE_CODES.filter((c) => c !== 'E'))
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [tradeWish('A', 'E'), tradeWish('B', 'E')],
    assignedShares: assigned,
  })
  expect(s.openExtras).toEqual([{ firstWeek: 23, lastWeek: 24, interested: ['A', 'B'] }])
  // Nobody moved: the slot still shows unassigned E (nobody sails it yet).
  expect(s.slots.find((x) => x.firstWeek === 23)?.holder).toBe('E')
})

test('buildSuggestion: wishes from a currently-unassigned share are ignored', () => {
  const assigned: ReadonlySet<ShareCode> = new Set(SHARE_CODES.filter((c) => c !== 'E'))
  const s = buildSuggestion({
    season: SEASON_2026,
    // Lingering rows from before E was unassigned mid-round: no edge, no interest.
    wishes: [tradeWish('E', 'A'), extraWish('E', 'extra_early')],
    assignedShares: assigned,
  })
  expect(s.cycles).toEqual([])
  expect(s.autoExtras).toEqual([])
  expect(s.openExtras).toEqual([])
})

test('buildSuggestion: tradeWishShares counts assigned shares with at least one edge', () => {
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [tradeWish('A', 'D'), tradeWish('D', 'A'), tradeWish('B', 'C')],
    assignedShares: ALL_ASSIGNED,
  })
  expect(s.tradeWishShares).toEqual(['A', 'B', 'D'])
  expect(s.satisfiedShares).toEqual(['A', 'D']) // B's wish isn't reciprocated
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:node src/lib/services/booking/logic.test.ts`
Expected: FAIL — `buildSuggestion` is not exported.

- [ ] **Step 3: Implement the solver**

Append to `src/lib/services/booking/logic.ts`:

```ts
export type AutoExtra = {
  firstWeek: number
  lastWeek: number
  holder: ShareCode
  reason: 'adjacent' | 'sole_interest'
}

export type OpenExtra = {
  firstWeek: number
  lastWeek: number
  interested: Array<ShareCode>
}

export type SuggestionInput = {
  season: { startWeek: number; startShare: ShareCode }
  wishes: ReadonlyArray<WishInput>
  // Share codes with an active ownership assignment right now. Wishes from
  // — or trade edges to — unassigned shares resolve at suggestion time
  // (ADR-0020 §Step 1).
  assignedShares: ReadonlySet<ShareCode>
}

export type Suggestion = {
  // The full 12-slot draft this suggestion produces (the ADR sketch's
  // `assignments`, concretized): applySuggestion persists exactly this.
  slots: Array<Slot>
  // Vertex-disjoint trade cycles in canonical form (first element is the
  // cycle's earliest share): ['A','D'] = A ↔ D; ['B','E','H'] = B→E→H→B,
  // each share taking the block of the share it points at.
  cycles: Array<Array<ShareCode>>
  // Shares moved by a cycle — each landed on a block it wished for.
  satisfiedShares: Array<ShareCode>
  // Assigned shares with >= 1 trade edge: the "av {total}" denominator in
  // the suggestion panel.
  tradeWishShares: Array<ShareCode>
  autoExtras: Array<AutoExtra>
  openExtras: Array<OpenExtra>
}

type CycleSearchResult = { covered: number; cycles: Array<Array<number>> }

// Max-coverage vertex-disjoint simple cycles (length >= 2), exhaustive over
// the <= 10 assigned shares via bitmask memoization. Deterministic tie-break
// (ADR-0020): for each submask, cycles through its lowest vertex are tried
// in canonical DFS order (adjacency pre-sorted A→J) before "leave it
// uncovered", and only strictly greater coverage replaces the incumbent —
// so the first maximum found wins.
function maxCoverageCycles(
  vertexCount: number,
  adjacency: ReadonlyArray<ReadonlyArray<number>>,
): Array<Array<number>> {
  const memo = new Map<number, CycleSearchResult>()

  function cyclesThrough(start: number, mask: number): Array<Array<number>> {
    const found: Array<Array<number>> = []
    const path: Array<number> = [start]
    const walk = (current: number, used: number) => {
      for (const next of adjacency[current] ?? []) {
        if (next === start) {
          if (path.length >= 2) found.push([...path])
        } else if ((mask & (1 << next)) !== 0 && (used & (1 << next)) === 0) {
          path.push(next)
          walk(next, used | (1 << next))
          path.pop()
        }
      }
    }
    walk(start, 1 << start)
    return found
  }

  function best(mask: number): CycleSearchResult {
    if (mask === 0) return { covered: 0, cycles: [] }
    const cached = memo.get(mask)
    if (cached) return cached

    // Index of the lowest set bit: every cycle found here starts at the
    // mask's smallest vertex, which keeps cycle arrays canonical.
    const lowest = 31 - Math.clz32(mask & -mask)
    let incumbent: CycleSearchResult | null = null
    for (const cycle of cyclesThrough(lowest, mask)) {
      let cycleMask = 0
      for (const v of cycle) cycleMask |= 1 << v
      const rest = best(mask & ~cycleMask)
      const covered = cycle.length + rest.covered
      if (incumbent === null || covered > incumbent.covered) {
        incumbent = { covered, cycles: [cycle, ...rest.cycles] }
      }
    }
    const dropped = best(mask & ~(1 << lowest))
    if (incumbent === null || dropped.covered > incumbent.covered) {
      incumbent = dropped
    }
    memo.set(mask, incumbent)
    return incumbent
  }

  return best((1 << vertexCount) - 1).cycles
}

export function buildSuggestion(input: SuggestionInput): Suggestion {
  const { season, assignedShares } = input
  // Wish rows from currently-unassigned shares are ignored entirely — an
  // unassigned share has no owner to sail its wishes (rows can linger when
  // a share is unassigned mid-round).
  const wishes = input.wishes.filter((w) => assignedShares.has(w.shareCode))

  // ---- Step 1: trades — max-coverage vertex-disjoint cycles --------------
  // Edge A→D iff A has a 'share' wish targeting D and D is assigned; a wish
  // targeting an unassigned share is extra-interest, not an edge.
  const vertices = SHARE_CODES.filter((code) => assignedShares.has(code))
  const indexOf = new Map(vertices.map((v, i) => [v, i]))
  const adjacency: Array<Array<number>> = vertices.map(() => [])
  for (const wish of wishes) {
    if (wish.targetKind !== 'share' || wish.targetShare === null) continue
    const from = indexOf.get(wish.shareCode)
    const to = indexOf.get(wish.targetShare)
    if (from === undefined || to === undefined) continue
    adjacency[from]?.push(to)
  }
  // Canonical A→J target order (row order from the DB is insertion order).
  for (const targets of adjacency) targets.sort((a, b) => a - b)

  const cycles = maxCoverageCycles(vertices.length, adjacency).map((cycle) =>
    cycle.map((i) => vertices[i] as ShareCode),
  )

  // Apply the trades to the nominal slots: each cycle member takes the
  // block of the share it points at.
  const slots = nominalSlotsForSeason(season)
  const slotByNominalHolder = new Map<ShareCode, Slot>()
  for (const slot of slots) {
    if (slot.kind === 'rotation' && slot.holder) slotByNominalHolder.set(slot.holder, slot)
  }
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.length; i++) {
      const taker = cycle[i] as ShareCode
      const giver = cycle[(i + 1) % cycle.length] as ShareCode
      const slot = slotByNominalHolder.get(giver)
      if (slot) slot.holder = taker
    }
  }

  const satisfiedShares = [...cycles.flat()].sort()
  const tradeWishShares = vertices.filter((v) => {
    const idx = indexOf.get(v)
    return idx !== undefined && (adjacency[idx]?.length ?? 0) > 0
  })

  // ---- Steps 2 + 3: extras ------------------------------------------------
  const autoExtras: Array<AutoExtra> = []
  const openExtras: Array<OpenExtra> = []
  const rotationSlots = slots.filter((s) => s.kind === 'rotation')

  const interestedInExtra = (target: 'extra_early' | 'extra_late'): Array<ShareCode> =>
    SHARE_CODES.filter((code) =>
      wishes.some((w) => w.shareCode === code && w.targetKind === target),
    )

  // Step 2 — adjacency: the post-trade holder of the first/last rotation
  // block gets the adjacent shoulder if it marked it; that grant trumps any
  // other interest. Otherwise step 3 — sole interest auto-grants, contested
  // stays open for manual admin assignment (no fairness algorithm).
  const resolveShoulder = (
    slot: Slot | undefined,
    adjacentHolder: ShareCode | null,
    target: 'extra_early' | 'extra_late',
  ) => {
    if (!slot) return
    const interested = interestedInExtra(target)
    if (adjacentHolder && interested.includes(adjacentHolder)) {
      slot.holder = adjacentHolder
      autoExtras.push({
        firstWeek: slot.firstWeek,
        lastWeek: slot.lastWeek,
        holder: adjacentHolder,
        reason: 'adjacent',
      })
      return
    }
    if (interested.length === 1) {
      const holder = interested[0] as ShareCode
      slot.holder = holder
      autoExtras.push({
        firstWeek: slot.firstWeek,
        lastWeek: slot.lastWeek,
        holder,
        reason: 'sole_interest',
      })
    } else if (interested.length > 1) {
      openExtras.push({ firstWeek: slot.firstWeek, lastWeek: slot.lastWeek, interested })
    }
  }
  resolveShoulder(
    slots.find((s) => s.kind === 'extra' && s.firstWeek < season.startWeek),
    rotationSlots[0]?.holder ?? null,
    'extra_early',
  )
  resolveShoulder(
    slots.find((s) => s.kind === 'extra' && s.firstWeek > season.startWeek),
    rotationSlots[rotationSlots.length - 1]?.holder ?? null,
    'extra_late',
  )

  // Step 3 (continued) — unassigned shares' blocks. Unassigned shares never
  // join cycles, so a rotation slot still holding an unassigned share is
  // exactly "an unassigned share's block". Interest = 'share' wishes
  // targeting it.
  for (const slot of rotationSlots) {
    if (!slot.holder || assignedShares.has(slot.holder)) continue
    const unassigned = slot.holder
    const interested = SHARE_CODES.filter((code) =>
      wishes.some(
        (w) => w.shareCode === code && w.targetKind === 'share' && w.targetShare === unassigned,
      ),
    )
    if (interested.length === 1) {
      const holder = interested[0] as ShareCode
      slot.holder = holder
      autoExtras.push({
        firstWeek: slot.firstWeek,
        lastWeek: slot.lastWeek,
        holder,
        reason: 'sole_interest',
      })
    } else if (interested.length > 1) {
      openExtras.push({ firstWeek: slot.firstWeek, lastWeek: slot.lastWeek, interested })
    }
  }

  return { slots, cycles, satisfiedShares, tradeWishShares, autoExtras, openExtras }
}
```

- [ ] **Step 4: Run to verify all logic tests pass**

Run: `pnpm test:node src/lib/services/booking/logic.test.ts`
Expected: PASS — all Task 2 + Task 3 tests (14 total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/booking/logic.ts src/lib/services/booking/logic.test.ts
git commit --no-gpg-sign -m "feat(booking): cycle-solver suggestion with extra allocation rules"
```

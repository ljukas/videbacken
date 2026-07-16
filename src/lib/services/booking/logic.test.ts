import { expect, test } from 'vitest'
import { SHARE_CODES, type ShareCode } from '~/lib/shares/codes'
import {
  activeSeasonYearFor,
  buildSuggestion,
  extraBlocksForSeason,
  nominalSlotsForSeason,
  type WishInput,
} from './logic'

// 2026 under the seeded era (2024/21/J): startShare D — see the fixture
// background in docs/plans/season-booking/02-logic.md.
const SEASON_2026 = { startWeek: 21, startShare: 'D' } as const

const ALL_ASSIGNED: ReadonlySet<ShareCode> = new Set(SHARE_CODES)

function tradeWish(shareCode: ShareCode, targetShare: ShareCode): WishInput {
  return { shareCode, targetKind: 'share', targetShare }
}

function extraWish(shareCode: ShareCode, targetKind: 'extra_early' | 'extra_late'): WishInput {
  return { shareCode, targetKind, targetShare: null }
}

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

test('buildSuggestion: unsatisfied trade wishes are listed with their targets', () => {
  const s = buildSuggestion({
    season: SEASON_2026,
    wishes: [tradeWish('A', 'D'), tradeWish('D', 'A'), tradeWish('B', 'E'), tradeWish('B', 'C')],
    assignedShares: ALL_ASSIGNED,
  })
  expect(s.satisfiedShares).toEqual(['A', 'D'])
  // B moved nowhere: every one of its edges surfaces, in canonical A→J
  // order (by wisher, then target) regardless of insertion order.
  expect(s.unsatisfiedTradeWishes).toEqual([
    { shareCode: 'B', targetShare: 'C' },
    { shareCode: 'B', targetShare: 'E' },
  ])
})

test('buildSuggestion: unsatisfiedTradeWishes is empty when all wishes resolve, and skips non-edges', () => {
  const allSatisfied = buildSuggestion({
    season: SEASON_2026,
    wishes: [tradeWish('A', 'D'), tradeWish('D', 'A')],
    assignedShares: ALL_ASSIGNED,
  })
  expect(allSatisfied.unsatisfiedTradeWishes).toEqual([])
  // A wish targeting an unassigned share is extra-interest, not a trade
  // edge — it must not be reported as an unsatisfied trade.
  const assigned: ReadonlySet<ShareCode> = new Set(SHARE_CODES.filter((c) => c !== 'E'))
  const nonEdge = buildSuggestion({
    season: SEASON_2026,
    wishes: [tradeWish('A', 'E')],
    assignedShares: assigned,
  })
  expect(nonEdge.unsatisfiedTradeWishes).toEqual([])
})

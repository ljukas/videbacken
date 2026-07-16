import { getISOWeek, getISOWeekYear } from 'date-fns'
import { shareBlocksForSeason } from '~/lib/services/season/logic'
import { SHARE_CODES, type ShareCode, WEEKS_PER_SEASON, WEEKS_PER_SHARE } from '~/lib/shares/codes'

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
  // The trade edges of shares no cycle moved — what the "X av Y" gap
  // consists of, in canonical A→J order (by wisher, then target).
  unsatisfiedTradeWishes: Array<{ shareCode: ShareCode; targetShare: ShareCode }>
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
  // Vertices and their adjacency lists are already canonical, so the
  // unmoved shares' edges come out A→J by wisher, then target.
  const covered = new Set(cycles.flat())
  const unsatisfiedTradeWishes = tradeWishShares
    .filter((v) => !covered.has(v))
    .flatMap((v) => {
      const idx = indexOf.get(v)
      const targets = idx === undefined ? [] : (adjacency[idx] ?? [])
      return targets.map((t) => ({ shareCode: v, targetShare: vertices[t] as ShareCode }))
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

  return {
    slots,
    cycles,
    satisfiedShares,
    tradeWishShares,
    unsatisfiedTradeWishes,
    autoExtras,
    openExtras,
  }
}

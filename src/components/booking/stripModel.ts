import type { ReactNode } from 'react'
import type { BookingTarget, Slot } from '~/lib/services/booking/logic'
import type { MonthBand, ShareBlock } from '~/lib/services/season/logic'
import type { ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'

// Client view-model for the booking strip. Pure — BookingSection derives it
// once and hands it to both layouts (ADR-0020 §UI).

export type BookingWish = {
  id: string
  shareCode: ShareCode
  targetKind: BookingTarget
  targetShare: ShareCode | null
}

// The orpc.booking.getActive payload shape (structural — server source of
// truth is procedures/booking.ts).
export type BookingData = {
  year: number
  lockedAt: Date | null
  blocks: {
    early: { firstWeek: number; lastWeek: number }
    rotation: Array<ShareBlock>
    late: { firstWeek: number; lastWeek: number }
  }
  monthBands: Array<MonthBand>
  wishes: Array<BookingWish>
  assignedShares: Array<ShareCode>
  lockedSchedule: Array<Slot> | null
}

export type WishTarget = { targetKind: BookingTarget; targetShare: ShareCode | null }

export type StripBlock = {
  firstWeek: number
  lastWeek: number
  kind: 'rotation' | 'extra'
  // The letter the cell renders: nominal share (open round), slot holder
  // (arrange preview / locked), or null (unheld extra).
  holder: ShareCode | null
  holderAssigned: boolean
  isMine: boolean
  // Wish chips are anchored to NOMINAL positions — "D's weeks" means the
  // block D holds in the nominal rotation, whatever a draft did to holders.
  wishes: Array<ShareCode>
  myWish: boolean
  target: WishTarget
}

// Arrange-mode wiring passed to both layouts: which block's holder popover is
// open, how to toggle it, and how to render the picker body (BookingSection
// owns the picker so it can dispatch setSlotHolder). The open-state carries
// the layout that owns it: both layouts render (CSS-hidden) and Radix portals
// PopoverContent out of the hidden wrapper, so keying by week alone would open
// both layouts' popovers at once — one anchored, one floating detached.
export type PopoverLayout = 'strip' | 'cards'

export type ArrangeControls = {
  popover: { week: number; layout: PopoverLayout } | null
  onPopoverChange: (popover: { week: number; layout: PopoverLayout } | null) => void
  renderHolderPicker: (block: StripBlock) => ReactNode
}

export function buildStripBlocks(
  data: BookingData,
  actingShare: ShareCode | null,
  ownedShareCodes: ReadonlySet<ShareCode>,
  // Non-null renders these concrete slots' holders (locked schedule or the
  // admin draft) instead of the nominal rotation.
  slots: Array<Slot> | null,
): Array<StripBlock> {
  const assigned = new Set(data.assignedShares)
  const nominalByWeek = new Map(data.blocks.rotation.map((b) => [b.firstWeek, b.shareCode]))
  const holderByWeek = slots ? new Map(slots.map((s) => [s.firstWeek, s.holder])) : null

  const toBlock = (input: {
    firstWeek: number
    lastWeek: number
    kind: 'rotation' | 'extra'
    target: WishTarget
  }): StripBlock => {
    const holder = holderByWeek
      ? (holderByWeek.get(input.firstWeek) ?? null)
      : input.kind === 'rotation'
        ? (nominalByWeek.get(input.firstWeek) ?? null)
        : null
    const wishes = data.wishes
      .filter(
        (w) =>
          w.targetKind === input.target.targetKind && w.targetShare === input.target.targetShare,
      )
      .map((w) => w.shareCode)
    return {
      ...input,
      holder,
      holderAssigned: holder !== null && assigned.has(holder),
      isMine: holder !== null && ownedShareCodes.has(holder),
      wishes,
      myWish: actingShare !== null && wishes.includes(actingShare),
    }
  }

  return [
    toBlock({
      ...data.blocks.early,
      kind: 'extra',
      target: { targetKind: 'extra_early', targetShare: null },
    }),
    ...data.blocks.rotation.map((b) =>
      toBlock({
        firstWeek: b.firstWeek,
        lastWeek: b.lastWeek,
        kind: 'rotation',
        target: { targetKind: 'share', targetShare: b.shareCode },
      }),
    ),
    toBlock({
      ...data.blocks.late,
      kind: 'extra',
      target: { targetKind: 'extra_late', targetShare: null },
    }),
  ]
}

// The block button's accessible name. Arrange mode announces selection;
// while wishable it announces the action; otherwise (locked, or the acting
// share's own block) it announces ownership like the Disponeringslista.
export function blockAriaLabel(
  block: StripBlock,
  input: { showWishes: boolean; actingShare: ShareCode | null; arranging: boolean },
): string | undefined {
  if (input.arranging) {
    return m.booking_arrange_block_aria({ from: block.firstWeek, to: block.lastWeek })
  }
  const ownTarget = input.actingShare !== null && block.target.targetShare === input.actingShare
  if (input.showWishes && !ownTarget) {
    return block.target.targetKind === 'share' && block.target.targetShare
      ? m.booking_wish_block_aria({
          share: block.target.targetShare,
          from: block.firstWeek,
          to: block.lastWeek,
        })
      : m.booking_wish_extra_aria({ from: block.firstWeek, to: block.lastWeek })
  }
  return block.isMine && block.holder
    ? m.season_my_weeks({ from: block.firstWeek, to: block.lastWeek, share: block.holder })
    : undefined
}

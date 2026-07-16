import { MONTH_LABELS, OWNED_RING } from '~/components/season/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import type { MonthBand } from '~/lib/services/season/logic'
import { type ShareCode, WEEKS_PER_SHARE } from '~/lib/shares/codes'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn } from '~/lib/utils'
import { type ArrangeControls, blockAriaLabel, type StripBlock } from './stripModel'
import { WishChips } from './WishChips'

type BookingStripProps = {
  monthBands: Array<MonthBand>
  blocks: Array<StripBlock>
  actingShare: ShareCode | null
  showWishes: boolean
  interactive: boolean
  onBlockClick: (block: StripBlock) => void
  selectedWeek: number | null
  arrange: ArrangeControls | null
}

export function BookingStrip({
  monthBands,
  blocks,
  actingShare,
  showWishes,
  interactive,
  onBlockClick,
  selectedWeek,
  arrange,
}: BookingStripProps) {
  const monthEndWeeks = new Set(monthBands.slice(0, -1).map((b) => b.lastWeek))
  const lastBandIdx = monthBands.length - 1
  return (
    <div className="hidden overflow-auto rounded-lg border bg-surface-raised lg:-mx-4 lg:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs uppercase tracking-wider">
            {monthBands.map((band, i) => (
              <th
                key={band.firstWeek}
                colSpan={band.span}
                className={cn(
                  'bg-muted py-1 text-center font-semibold',
                  i < lastBandIdx && 'border-r',
                )}
              >
                {MONTH_LABELS[band.month]?.()}
              </th>
            ))}
          </tr>
          <tr className="text-muted-foreground text-xs">
            {monthBands.flatMap((band) =>
              Array.from({ length: band.span }, (_, i) => {
                const week = band.firstWeek + i
                return (
                  <td
                    key={week}
                    className={cn(
                      'border-b bg-muted px-1 py-0.5 text-center font-normal tabular-nums',
                      monthEndWeeks.has(week) && 'border-r',
                    )}
                  >
                    {week}
                  </td>
                )
              }),
            )}
          </tr>
        </thead>
        <tbody>
          <tr>
            {blocks.map((block) => {
              const ownTarget = actingShare !== null && block.target.targetShare === actingShare
              const disabled = arrange ? false : !interactive || ownTarget
              // Extras and unassigned-held rotation slots are popover-assigned
              // in arrange mode; assigned rotation slots use select-then-act.
              const popoverSlot =
                arrange !== null && (block.kind === 'extra' || !block.holderAssigned)
              const cellButton = (
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={showWishes && !arrange ? block.myWish : undefined}
                  aria-label={blockAriaLabel(block, {
                    showWishes,
                    actingShare,
                    arranging: arrange !== null,
                  })}
                  onClick={() => onBlockClick(block)}
                  className={cn(
                    'flex min-h-16 w-full flex-col items-center justify-center gap-1 px-1 py-2',
                    'transition-[background-color,box-shadow,filter] duration-150 ease-out motion-reduce:transition-none',
                    block.holder
                      ? cn(shareBackgroundClass[block.holder], 'font-medium text-foreground')
                      : 'text-muted-foreground',
                    block.kind === 'extra' && !block.holder && 'border border-dashed',
                    block.isMine && OWNED_RING,
                    !block.isMine && block.myWish && !arrange && 'ring-2 ring-brand ring-inset',
                    selectedWeek === block.firstWeek && 'ring-2 ring-brand ring-inset',
                    !disabled && 'cursor-pointer hover:brightness-[0.97]',
                  )}
                >
                  <span
                    className={cn(
                      'font-semibold',
                      block.holder && !block.holderAssigned && 'opacity-50',
                    )}
                  >
                    {block.holder ?? '–'}
                  </span>
                  {showWishes && <WishChips wishes={block.wishes} actingShare={actingShare} />}
                </button>
              )
              return (
                <td
                  key={block.firstWeek}
                  colSpan={WEEKS_PER_SHARE}
                  className={cn('p-0', monthEndWeeks.has(block.lastWeek) && 'border-r')}
                >
                  {popoverSlot && arrange ? (
                    <Popover
                      open={
                        arrange.popover?.week === block.firstWeek &&
                        arrange.popover.layout === 'strip'
                      }
                      onOpenChange={(open) =>
                        arrange.onPopoverChange(
                          open ? { week: block.firstWeek, layout: 'strip' } : null,
                        )
                      }
                    >
                      <PopoverTrigger asChild>{cellButton}</PopoverTrigger>
                      <PopoverContent align="center" className="w-52 p-1.5">
                        {arrange.renderHolderPicker(block)}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    cellButton
                  )}
                </td>
              )
            })}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

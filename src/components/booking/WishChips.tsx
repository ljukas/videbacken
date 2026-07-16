import type { ShareCode } from '~/lib/shares/codes'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn } from '~/lib/utils'

type WishChipsProps = {
  wishes: Array<ShareCode>
  actingShare: ShareCode | null
}

// Per-block stack of share-letter chips showing who wished for it; the
// acting share's own chip is brand-accented (ADR-0020 §UI). Every chip
// carries a ring — a pastel chip on a pastel block otherwise loses its
// edge; a neutral outline for others keeps the brand ring the "yours"
// marker. Decorative for AT — the block button's aria-pressed/label
// carries the state. The min-h placeholder keeps block heights even
// across cells without chips.
export function WishChips({ wishes, actingShare }: WishChipsProps) {
  return (
    <span className="flex min-h-4 flex-wrap items-center justify-center gap-0.5" aria-hidden>
      {wishes.map((code) => (
        <span
          key={code}
          className={cn(
            'flex size-4 items-center justify-center rounded-full font-medium text-[10px] leading-none ring-1',
            shareBackgroundClass[code],
            code === actingShare ? 'ring-brand' : 'ring-foreground/30',
          )}
        >
          {code}
        </span>
      ))}
    </span>
  )
}

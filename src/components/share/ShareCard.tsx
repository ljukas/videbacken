import { ClockIcon, UserMinusIcon } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Button } from '~/components/ui/button'
import type { AdminShareRow } from '~/lib/orpc/procedures/share'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn, initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type Props = {
  share: AdminShareRow
  onAssign: () => void
  onUnassign: () => void
  onHistory: () => void
}

export function ShareCard({ share, onAssign, onUnassign, onHistory }: Props) {
  const owner = share.currentOwner

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border bg-surface-raised">
      <header
        className={cn(
          'flex items-baseline justify-between gap-2 px-4 py-3 text-foreground',
          shareBackgroundClass[share.shareCode],
        )}
      >
        <span className="font-semibold text-2xl tracking-tight">{share.shareCode}</span>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-4">
        {owner ? (
          <div className="flex flex-col items-center gap-2 py-2 text-center">
            <Avatar className="size-12">
              {owner.image ? (
                <AvatarImage
                  src={owner.image}
                  alt={owner.name}
                  width={48}
                  height={48}
                  blurhash={owner.imageBlurhash}
                />
              ) : null}
              <AvatarFallback>{initials(owner.name)}</AvatarFallback>
            </Avatar>
            <span className="break-words font-medium leading-tight">{owner.name}</span>
          </div>
        ) : (
          <p className="py-4 text-center text-muted-foreground text-sm">
            {m.share_card_unassigned()}
          </p>
        )}
      </div>

      <footer className="flex flex-col gap-2 border-t bg-muted/30 p-3">
        <Button size="sm" variant="default" onClick={onAssign} className="w-full">
          {owner ? m.share_card_reassign() : m.share_assign_submit()}
        </Button>
        <div className="flex gap-2">
          {owner ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={m.share_card_unassign_label()}
              onClick={onUnassign}
              className="flex-1"
            >
              <UserMinusIcon />
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            aria-label={m.share_card_history_label()}
            onClick={onHistory}
            className="flex-1"
          >
            <ClockIcon />
          </Button>
        </div>
      </footer>
    </article>
  )
}

import { useSuspenseQuery } from '@tanstack/react-query'
import { Suspense } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Badge } from '~/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Skeleton } from '~/components/ui/skeleton'
import { formatDate } from '~/lib/i18n/format'
import { orpc } from '~/lib/orpc/client'
import type { AdminHistoryEntry } from '~/lib/orpc/procedures/share'
import type { ShareCode } from '~/lib/shares/codes'
import { initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  shareCode: ShareCode | undefined
}

export function AssignmentHistorySheet({ open, onOpenChange, shareCode }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{m.share_history_title({ code: shareCode ?? '' })}</SheetTitle>
          <SheetDescription>{m.share_history_description()}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          {shareCode ? (
            <Suspense fallback={<HistoryFallback />}>
              <HistoryBody shareCode={shareCode} key={shareCode} />
            </Suspense>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function HistoryFallback() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-14 w-full rounded-md" />
      <Skeleton className="h-14 w-full rounded-md" />
      <Skeleton className="h-14 w-full rounded-md" />
    </div>
  )
}

function HistoryBody({ shareCode }: { shareCode: ShareCode }) {
  const { data: history } = useSuspenseQuery(
    orpc.share.listHistory.queryOptions({ input: { shareCode } }),
  )

  if (history.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground text-sm">{m.share_history_empty()}</p>
    )
  }

  return (
    <ol className="flex flex-col gap-3">
      {history.map((entry) => (
        <HistoryEntry key={entry.id} entry={entry} />
      ))}
    </ol>
  )
}

function HistoryEntry({ entry }: { entry: AdminHistoryEntry }) {
  return (
    <li className="flex items-center gap-3 rounded-md border bg-card p-3">
      <Avatar className="size-9">
        {entry.user?.image ? (
          <AvatarImage
            src={entry.user.image}
            alt={entry.user.name}
            width={36}
            height={36}
            blurhash={entry.user.imageBlurhash ?? undefined}
          />
        ) : null}
        <AvatarFallback>{initials(entry.user?.name ?? '?')}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">
            {entry.user?.name ?? m.share_history_unknown_user()}
          </span>
          {entry.isActive ? (
            <Badge variant="secondary">{m.share_history_active_badge()}</Badge>
          ) : null}
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatDate(entry.assignedFrom)} →{' '}
          {entry.assignedTo ? formatDate(entry.assignedTo) : m.share_history_ongoing()}
        </span>
      </div>
    </li>
  )
}

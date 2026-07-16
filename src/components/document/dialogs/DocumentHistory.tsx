import { useQuery } from '@tanstack/react-query'
import {
  FileClockIcon,
  FolderInputIcon,
  type LucideIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { formatDateTime } from '~/components/document/shared/documentHelpers'
import { Empty, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Skeleton } from '~/components/ui/skeleton'
import type { RouterOutputs } from '~/lib/orpc/client'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type HistoryEntry = RouterOutputs['document']['documentHistory'][number]

type Intent = 'neutral' | 'destructive' | 'success'

// label is a message function rather than a string: module scope evaluates
// once per process, but the active locale is per request/render.
const KIND_META: Record<string, { label: () => string; icon: LucideIcon; intent: Intent }> = {
  upload: { label: m.document_history_upload, icon: UploadIcon, intent: 'neutral' },
  rename: { label: m.document_history_rename, icon: PencilIcon, intent: 'neutral' },
  move: { label: m.document_history_move, icon: FolderInputIcon, intent: 'neutral' },
  soft_delete: { label: m.document_history_soft_delete, icon: Trash2Icon, intent: 'destructive' },
  restore: { label: m.document_history_restore, icon: RotateCcwIcon, intent: 'success' },
  hard_delete: { label: m.document_history_hard_delete, icon: Trash2Icon, intent: 'destructive' },
}

const INTENT_NODE: Record<Intent, string> = {
  neutral: 'bg-muted text-muted-foreground',
  destructive: 'bg-destructive/10 text-destructive',
  success: 'bg-success/10 text-success',
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  documentId: string
  documentName: string
}

export function DocumentHistory({ open, onOpenChange, documentId, documentName }: Props) {
  const { data, isPending } = useQuery({
    ...orpc.document.documentHistory.queryOptions({ input: { id: documentId } }),
    enabled: open,
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-4 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{m.document_history_title()}</SheetTitle>
          <SheetDescription className="truncate">{documentName}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4" aria-live="polite">
          {isPending ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : !data || data.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{m.document_history_empty()}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ol className="flex flex-col">
              {data.map((entry, index) => (
                <HistoryRow key={entry.id} entry={entry} isLast={index === data.length - 1} />
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function HistoryRow({ entry, isLast }: { entry: HistoryEntry; isLast: boolean }) {
  const meta = KIND_META[entry.kind]
  const Icon = meta?.icon ?? FileClockIcon

  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!isLast && (
        <span
          aria-hidden
          className="absolute top-9 bottom-0 left-4 w-px -translate-x-1/2 bg-border"
        />
      )}
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full',
          INTENT_NODE[meta?.intent ?? 'neutral'],
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm">{meta ? meta.label() : entry.kind}</span>
          <time
            dateTime={entry.occurredAt.toISOString()}
            className="shrink-0 text-muted-foreground text-xs"
          >
            {formatDateTime(entry.occurredAt)}
          </time>
        </div>
        <HistoryDetail entry={entry} />
        {entry.actorName ? (
          <span className="text-muted-foreground text-xs">
            {m.document_history_by({ name: entry.actorName })}
          </span>
        ) : null}
      </div>
    </li>
  )
}

// Best-effort human line from the jsonb from/to payloads. Shapes are documented
// in documentEvent.ts; unknown shapes render nothing rather than guessing.
function HistoryDetail({ entry }: { entry: HistoryEntry }) {
  if (entry.kind === 'rename') {
    const from = entry.fromValue as { name?: string } | null
    const to = entry.toValue as { name?: string } | null
    if (from?.name && to?.name) {
      return (
        <span className="text-muted-foreground text-xs">
          {from.name} → {to.name}
        </span>
      )
    }
  }
  if (entry.kind === 'move') {
    const from = entry.fromValue as { name?: string | null } | null
    const to = entry.toValue as { name?: string | null } | null
    // Pre-fix move events stored only folderId (no `name` key); without a name
    // we can't resolve a label, so skip rather than guess. null name = root.
    if (from && to && 'name' in from && 'name' in to) {
      return (
        <span className="text-muted-foreground text-xs">
          {from.name ?? m.folder_root_name()} → {to.name ?? m.folder_root_name()}
        </span>
      )
    }
  }
  return null
}

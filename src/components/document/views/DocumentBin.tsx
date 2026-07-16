import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { FolderIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  type BinEntry,
  fileTypeAppearance,
  folderParentBreadcrumb,
  formatDateTime,
  partitionBinEntries,
} from '~/components/document/shared/documentHelpers'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { orpc } from '~/lib/orpc/client'
import { documentErrorMessage } from '~/lib/orpc/documentErrorMessage'
import { folderErrorMessage } from '~/lib/orpc/folderErrorMessage'
import { optimisticRemove } from '~/lib/orpc/optimistic'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

function useBinInvalidate() {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.bin.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.folder.key() }),
    ])
  }
}

export function DocumentBin() {
  const { data: entries } = useSuspenseQuery(orpc.bin.list.queryOptions())
  const { batches, loose } = partitionBinEntries(entries)

  if (entries.length === 0) {
    return (
      <Empty className="brand-wash rounded-lg border">
        <EmptyHeader>
          <EmptyMedia
            variant="icon"
            className="size-14 rounded-full bg-brand/10 text-brand ring-1 ring-brand/20"
          >
            <Trash2Icon className="size-7" />
          </EmptyMedia>
          <EmptyTitle>{m.bin_empty_title()}</EmptyTitle>
          <EmptyDescription>{m.bin_empty_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {[...batches.entries()].map(([correlationId, items]) => (
        <BatchCard key={correlationId} correlationId={correlationId} items={items} />
      ))}
      {loose.map((entry) => (
        <LooseRow key={`${entry.kind}:${entry.id}`} entry={entry} />
      ))}
    </div>
  )
}

// A batch is one cascade soft-delete: exactly one root folder plus its
// descendants. The root is the folder entry with the shortest path (its path
// prefixes every other entry); we surface its name + location like a file row.
function batchRoot(items: Array<BinEntry>): BinEntry | null {
  const folders = items.filter((i) => i.kind === 'folder' && i.path)
  if (folders.length === 0) return null
  return folders.reduce((a, b) =>
    (a.path as string).split('/').length <= (b.path as string).split('/').length ? a : b,
  )
}

function batchContents(subfolderCount: number, documentCount: number): string {
  const parts: Array<string> = []
  if (subfolderCount > 0) {
    parts.push(
      subfolderCount === 1
        ? m.bin_subfolder_count_single({ count: subfolderCount })
        : m.bin_subfolder_count_multi({ count: subfolderCount }),
    )
  }
  if (documentCount > 0) {
    parts.push(
      documentCount === 1
        ? m.bin_document_count_single({ count: documentCount })
        : m.bin_document_count_multi({ count: documentCount }),
    )
  }
  return parts.length ? parts.join(', ') : m.bin_empty_folder()
}

function BatchCard({ correlationId, items }: { correlationId: string; items: Array<BinEntry> }) {
  const queryClient = useQueryClient()
  const invalidate = useBinInvalidate()
  const [confirmHard, setConfirmHard] = useState(false)
  const root = batchRoot(items)
  const folderCount = items.filter((i) => i.kind === 'folder').length
  const documentCount = items.filter((i) => i.kind === 'document').length
  const contents = batchContents(folderCount - 1, documentCount)
  const deletedAt = items[0]?.deletedAt

  // The whole batch leaves the bin together — drop every entry sharing this
  // correlation id before the round-trip.
  const removeBatch = () =>
    optimisticRemove(
      queryClient,
      orpc.bin.list.queryKey(),
      (e) => e.correlationId === correlationId,
    )

  const restore = useMutation(
    orpc.folder.restoreFolder.mutationOptions({
      onMutate: removeBatch,
      onSuccess: () => toast.success(m.bin_restored_toast()),
      // restoreFolder throws code-only typed errors; localize by code.
      onError: (err) =>
        toast.error(isDefinedError(err) ? folderErrorMessage(err.code) : m.bin_restore_error()),
      onSettled: invalidate,
    }),
  )
  const hardDelete = useMutation(
    orpc.bin.hardDeleteFolder.mutationOptions({
      onMutate: removeBatch,
      onSuccess: () => {
        toast.success(m.bin_folder_purged_toast())
        setConfirmHard(false)
      },
      onError: (err) =>
        toast.error(isDefinedError(err) ? folderErrorMessage(err.code) : m.bin_purge_error()),
      onSettled: invalidate,
    }),
  )

  const busy = restore.isPending || hardDelete.isPending

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-surface-raised p-4">
      <div className="flex min-w-0 items-center gap-2">
        <FolderIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-sm">
            {root?.name ?? m.bin_deleted_folder()}
          </span>
          <span className="truncate text-muted-foreground text-xs">
            {root?.path ? `${folderParentBreadcrumb(root.path)} · ${contents}` : contents}
          </span>
          {deletedAt ? (
            <span className="text-muted-foreground text-xs">{formatDateTime(deletedAt)}</span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => restore.mutate({ correlationId })}
          disabled={busy}
        >
          <RotateCcwIcon data-icon="inline-start" />
          {m.bin_restore()}
        </Button>
        {root ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.bin_purge()}
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmHard(true)}
            disabled={busy}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </div>

      {root ? (
        <AlertDialog open={confirmHard} onOpenChange={setConfirmHard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.bin_purge_confirm_title({ name: root.name })}</AlertDialogTitle>
              <AlertDialogDescription>
                {m.bin_purge_folder_confirm_description()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmHard(false)}
                disabled={hardDelete.isPending}
              >
                {m.common_cancel()}
              </Button>
              <Button
                variant="destructive"
                onClick={() => hardDelete.mutate({ id: root.id })}
                disabled={hardDelete.isPending}
              >
                {m.bin_purge()}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}

function LooseRow({ entry }: { entry: BinEntry }) {
  const queryClient = useQueryClient()
  const invalidate = useBinInvalidate()
  const [confirmHard, setConfirmHard] = useState(false)

  // Both actions remove this one entry from the bin list; drop it before the
  // round-trip. Only documents get these actions (folders restore by batch).
  const removeFromBin = () =>
    optimisticRemove(
      queryClient,
      orpc.bin.list.queryKey(),
      (e) => e.kind === entry.kind && e.id === entry.id,
    )

  const restore = useMutation(
    orpc.document.restoreDocument.mutationOptions({
      onMutate: removeFromBin,
      onSuccess: () => toast.success(m.bin_document_restored_toast()),
      onError: (err) =>
        toast.error(isDefinedError(err) ? documentErrorMessage(err.code) : m.bin_restore_error()),
      onSettled: invalidate,
    }),
  )
  const hardDelete = useMutation(
    orpc.bin.hardDeleteDocument.mutationOptions({
      onMutate: removeFromBin,
      onSuccess: () => {
        toast.success(m.bin_document_purged_toast())
        setConfirmHard(false)
      },
      onError: (err) =>
        toast.error(isDefinedError(err) ? documentErrorMessage(err.code) : m.bin_purge_error()),
      onSettled: invalidate,
    }),
  )

  const isFolder = entry.kind === 'folder'
  const appearance = isFolder
    ? null
    : fileTypeAppearance({ mime: entry.mime ?? '', extension: entry.extension })
  const Icon = appearance?.Icon ?? FolderIcon

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-surface-raised p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          aria-hidden="true"
          className={cn('size-4 shrink-0', appearance?.className ?? 'text-muted-foreground')}
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-sm">{entry.name}</span>
          <span className="text-muted-foreground text-xs">{formatDateTime(entry.deletedAt)}</span>
        </div>
        {isFolder ? <Badge variant="secondary">{m.folder_kind_label()}</Badge> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Folder restore here is rare (folders normally arrive in a batch); the
            restore-by-correlation path covers cascades. A lone folder has no
            correlation to restore, so only documents get actions. */}
        {!isFolder ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => restore.mutate({ id: entry.id })}
              disabled={restore.isPending}
            >
              <RotateCcwIcon data-icon="inline-start" />
              {m.bin_restore()}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={m.bin_purge()}
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmHard(true)}
            >
              <Trash2Icon />
            </Button>
          </>
        ) : null}
      </div>

      <AlertDialog open={confirmHard} onOpenChange={setConfirmHard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.bin_purge_confirm_title({ name: entry.name })}</AlertDialogTitle>
            <AlertDialogDescription>{m.bin_purge_confirm_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmHard(false)}
              disabled={hardDelete.isPending}
            >
              {m.common_cancel()}
            </Button>
            <Button
              variant="destructive"
              onClick={() => hardDelete.mutate({ id: entry.id })}
              disabled={hardDelete.isPending}
            >
              {m.bin_purge()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

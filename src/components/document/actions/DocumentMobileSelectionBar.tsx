import { FolderInputIcon, Trash2Icon, XIcon } from 'lucide-react'
import { BulkActionDialogs } from '~/components/document/actions/BulkActionDialogs'
import { Button } from '~/components/ui/button'
import { useDialogState } from '~/hooks/useDialogState'
import { m } from '~/paraglide/messages'

type Props = {
  selectedDocIds: Array<string>
  selectedFolderIds: Array<string>
  /** Active folder (the selection's source) — for move/delete cache scoping. */
  folderId: string | null
  /** True when the user may act on the whole selection (docs editable; folders ⇒ admin). */
  canActOnAll: boolean
  /** Leave select mode and clear the selection (also run after a move/delete). */
  exitSelectMode: () => void
}

/**
 * The mobile select-mode header: a sticky in-page bar (the touch counterpart of
 * the desktop floating pill). Left ✕ exits select mode; the right side holds the
 * bulk Move / Delete actions. Single-item actions stay on each card's ⋮ menu.
 */
export function DocumentMobileSelectionBar({
  selectedDocIds,
  selectedFolderIds,
  folderId,
  canActOnAll,
  exitSelectMode,
}: Props) {
  const dialog = useDialogState<'move' | 'delete'>()
  const count = selectedDocIds.length + selectedFolderIds.length

  return (
    // Sticks below the global mobile header (h-12) on phones; that header is
    // hidden from `md` up, where this bar sticks to the top instead.
    <div className="sticky top-12 z-20 flex items-center gap-2 border-b bg-surface-page py-2 md:top-0">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={m.document_selection_exit()}
        onClick={exitSelectMode}
      >
        <XIcon />
      </Button>
      <span aria-live="polite" className="flex-1 font-medium text-sm">
        {m.document_selection_count({ count })}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={m.document_action_move()}
        disabled={!canActOnAll}
        onClick={() => dialog.show('move')}
      >
        <FolderInputIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={m.document_action_delete()}
        disabled={!canActOnAll}
        onClick={() => dialog.show('delete')}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2Icon />
      </Button>

      <BulkActionDialogs
        active={dialog.active}
        onClose={dialog.close}
        selectedDocIds={selectedDocIds}
        selectedFolderIds={selectedFolderIds}
        folderId={folderId}
        clearSelection={exitSelectMode}
      />
    </div>
  )
}

import { FolderInputIcon, Trash2Icon, XIcon } from 'lucide-react'
import { BulkActionDialogs } from '~/components/document/actions/BulkActionDialogs'
import { Button } from '~/components/ui/button'
import { useDialogState } from '~/hooks/useDialogState'
import { m } from '~/paraglide/messages'

type Props = {
  /** Selected document ids. */
  selectedDocIds: Array<string>
  /** Selected folder ids (admin-only). */
  selectedFolderIds: Array<string>
  /** Active folder (the selection's source) — for move/delete cache scoping. */
  folderId: string | null
  /** True when the user may act on the whole selection (docs editable; folders ⇒ admin). */
  canActOnAll: boolean
  clearSelection: () => void
}

/**
 * Bulk-action bar shown while items are selected: the keyboard-accessible,
 * discoverable parallel to right-click and drag. Flytta / Ta bort act on the
 * whole mixed selection (files and folders together); Avmarkera clears it.
 * Renders nothing when nothing is selected.
 */
export function DocumentSelectionBar({
  selectedDocIds,
  selectedFolderIds,
  folderId,
  canActOnAll,
  clearSelection,
}: Props) {
  const dialog = useDialogState<'move' | 'delete'>()
  const count = selectedDocIds.length + selectedFolderIds.length
  if (count === 0) return null

  return (
    // Floating pill, fixed to the viewport bottom-centre, so showing/hiding it
    // never shifts the table layout. Slides in on mount.
    <div className="fade-in slide-in-from-bottom-4 fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 animate-in items-center gap-3 rounded-full border bg-card py-2 pr-2 pl-4 shadow-lg duration-150">
      <span aria-live="polite" className="font-medium text-sm">
        {m.document_selection_count({ count })}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!canActOnAll}
          onClick={() => dialog.show('move')}
        >
          <FolderInputIcon data-icon="inline-start" />
          {m.document_action_move()}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canActOnAll}
          onClick={() => dialog.show('delete')}
          className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2Icon data-icon="inline-start" />
          {m.document_action_delete()}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.document_selection_clear()}
          onClick={clearSelection}
        >
          <XIcon />
        </Button>
      </div>

      <BulkActionDialogs
        active={dialog.active}
        onClose={dialog.close}
        selectedDocIds={selectedDocIds}
        selectedFolderIds={selectedFolderIds}
        folderId={folderId}
        clearSelection={clearSelection}
      />
    </div>
  )
}

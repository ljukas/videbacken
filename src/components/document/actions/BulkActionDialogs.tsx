import { DeleteDocumentsDialog } from '~/components/document/dialogs/DeleteDocumentsDialog'
import { DeleteItemsDialog } from '~/components/document/dialogs/DeleteItemsDialog'
import { MoveDialog } from '~/components/document/dialogs/MoveDialog'

type Props = {
  /** Which bulk dialog is open, or null for none. */
  active: 'move' | 'delete' | null
  onClose: () => void
  selectedDocIds: Array<string>
  selectedFolderIds: Array<string>
  /** Active folder (the selection's source) — for move/delete cache scoping. */
  folderId: string | null
  /** Cleared after a successful move/delete. */
  clearSelection: () => void
}

/**
 * The Move / Delete dialogs for a bulk selection of files and folders, shared by
 * the desktop floating selection pill and the mobile select-mode bar. Picks the
 * mixed (files + folders) or doc-only dialog variant by whether any folders are
 * selected. Mounted only while a dialog is open.
 */
export function BulkActionDialogs({
  active,
  onClose,
  selectedDocIds,
  selectedFolderIds,
  folderId,
  clearSelection,
}: Props) {
  const count = selectedDocIds.length + selectedFolderIds.length
  const hasFolders = selectedFolderIds.length > 0

  return (
    <>
      {active === 'move' ? (
        hasFolders ? (
          <MoveDialog
            open
            onOpenChange={onClose}
            target={{
              kind: 'items',
              documentIds: selectedDocIds,
              folderIds: selectedFolderIds,
              sourceFolderId: folderId,
              count,
              onMoved: clearSelection,
            }}
          />
        ) : (
          <MoveDialog
            open
            onOpenChange={onClose}
            target={{
              kind: 'documents',
              ids: selectedDocIds,
              folderId,
              count,
              onMoved: clearSelection,
            }}
          />
        )
      ) : null}
      {active === 'delete' ? (
        hasFolders ? (
          <DeleteItemsDialog
            open
            onOpenChange={onClose}
            documentIds={selectedDocIds}
            folderIds={selectedFolderIds}
            sourceFolderId={folderId}
            onDeleted={clearSelection}
          />
        ) : (
          <DeleteDocumentsDialog
            open
            onOpenChange={onClose}
            ids={selectedDocIds}
            folderId={folderId}
            onDeleted={clearSelection}
          />
        )
      ) : null}
    </>
  )
}

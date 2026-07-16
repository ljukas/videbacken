import { DeleteDocumentsDialog } from '~/components/document/dialogs/DeleteDocumentsDialog'
import { DeleteItemsDialog } from '~/components/document/dialogs/DeleteItemsDialog'
import { DocumentHistory } from '~/components/document/dialogs/DocumentHistory'
import { MoveDialog } from '~/components/document/dialogs/MoveDialog'
import { RenameDocumentDialog } from '~/components/document/dialogs/RenameDocumentDialog'
import type { DocumentRow } from '~/components/document/shared/documentHelpers'

type RowDialog = 'rename' | 'move' | 'history' | 'delete'

// Mounted only while open so the dialogs' queries (MoveDialog's folder tree,
// DocumentHistory's events) don't subscribe behind every row.
export function DocumentRowDialogs({
  active,
  onClose,
  doc,
  name,
  isMulti,
  actingDocIds,
  actingFolderIds,
  clearSelection,
}: {
  active: RowDialog | null
  onClose: () => void
  doc: DocumentRow
  name: string
  isMulti: boolean
  actingDocIds: Array<string>
  actingFolderIds: Array<string>
  clearSelection: () => void
}) {
  return (
    <>
      {active === 'rename' ? (
        <RenameDocumentDialog
          open
          onOpenChange={onClose}
          document={{
            id: doc.id,
            name: doc.name,
            extension: doc.extension,
            folderId: doc.folderId,
          }}
        />
      ) : null}
      {active === 'move' ? (
        isMulti && actingFolderIds.length > 0 ? (
          // Mixed selection — move folders + docs together.
          <MoveDialog
            open
            onOpenChange={onClose}
            target={{
              kind: 'items',
              documentIds: actingDocIds,
              folderIds: actingFolderIds,
              sourceFolderId: doc.folderId,
              count: actingDocIds.length + actingFolderIds.length,
              onMoved: clearSelection,
            }}
          />
        ) : isMulti ? (
          <MoveDialog
            open
            onOpenChange={onClose}
            target={{
              kind: 'documents',
              ids: actingDocIds,
              folderId: doc.folderId,
              count: actingDocIds.length,
              onMoved: clearSelection,
            }}
          />
        ) : (
          <MoveDialog
            open
            onOpenChange={onClose}
            target={{ kind: 'document', id: doc.id, name, folderId: doc.folderId }}
          />
        )
      ) : null}
      {active === 'history' ? (
        <DocumentHistory open onOpenChange={onClose} documentId={doc.id} documentName={name} />
      ) : null}
      {active === 'delete' ? (
        actingFolderIds.length > 0 ? (
          <DeleteItemsDialog
            open
            onOpenChange={onClose}
            documentIds={actingDocIds}
            folderIds={actingFolderIds}
            sourceFolderId={doc.folderId}
            onDeleted={clearSelection}
          />
        ) : (
          <DeleteDocumentsDialog
            open
            onOpenChange={onClose}
            ids={actingDocIds}
            folderId={doc.folderId}
            name={isMulti ? undefined : name}
            onDeleted={isMulti ? clearSelection : undefined}
          />
        )
      ) : null}
    </>
  )
}

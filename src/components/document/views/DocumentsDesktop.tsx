import { DndContext, DragOverlay } from '@dnd-kit/core'
import { FolderIcon, FolderPlusIcon, UploadIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { DocumentSelectionBar } from '~/components/document/actions/DocumentSelectionBar'
import { CreateFolderDialog } from '~/components/document/dialogs/CreateFolderDialog'
import { DocumentThumbnail } from '~/components/document/shared/DocumentThumbnail'
import { type CurrentUser, documentDisplayName } from '~/components/document/shared/documentHelpers'
import { FolderBreadcrumb } from '~/components/document/shared/FolderBreadcrumb'
import { DocumentTable } from '~/components/document/table/DocumentTable'
import {
  DocumentUpload,
  type DocumentUploadHandle,
} from '~/components/document/upload/DocumentUpload'
import { PageContainer } from '~/components/layout/PageContainer'
import { Button } from '~/components/ui/button'
import { useDocumentDnd } from '~/hooks/useDocumentDnd'
import { useDocumentSelection } from '~/hooks/useDocumentSelection'
import { useDocumentsData } from '~/hooks/useDocumentsData'
import { m } from '~/paraglide/messages'

type Props = {
  /** Resolved folder id from the URL, or null for the virtual root. */
  activeFolderId: string | null
  currentUser: CurrentUser
  /** Document id to scroll to + flash (command-palette `?focus`), or null. */
  focusedDocId: string | null
}

/**
 * The pointer (mouse) documents library: an OS-style table with click-to-select
 * (Cmd/Ctrl-toggle, Shift-range), a right-click context menu, double-click to
 * open, and drag-and-drop moves. The touch tree (`DocumentsMobile`) is a
 * separate component; `DocumentsView` picks between them by pointer type.
 */
export function DocumentsDesktop({ activeFolderId, currentUser, focusedDocId }: Props) {
  const { folders, visibleDocuments } = useDocumentsData(activeFolderId)
  const {
    isAdmin,
    selected,
    setSelected,
    selectedDocIds,
    selectedFolderIds,
    canActOnAll,
    clearSelection,
  } = useDocumentSelection({ visibleDocuments, folders, activeFolderId, currentUser })

  const uploadRef = useRef<DocumentUploadHandle>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const { dndContextProps, activeDoc, activeFolder, activeCount, dropAnimation } = useDocumentDnd({
    activeFolderId,
    visibleDocuments,
    folders,
    selectedDocIds,
    selectedFolderIds,
    isAdmin,
    clearSelection,
  })

  return (
    <DndContext {...dndContextProps}>
      <PageContainer width="full" fill className="gap-4">
        <header className="flex flex-col gap-2">
          <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
            {m.nav_documents()}
          </h1>
          <p className="max-w-2xl text-muted-foreground text-sm">
            {m.document_page_description_desktop()}
          </p>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <FolderBreadcrumb folders={folders} activeFolderId={activeFolderId} />
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <FolderPlusIcon data-icon="inline-start" />
              {m.folder_create_title()}
            </Button>
            <Button onClick={() => uploadRef.current?.open()}>
              <UploadIcon data-icon="inline-start" />
              {m.upload_button()}
            </Button>
          </div>
        </div>

        <DocumentUpload
          ref={uploadRef}
          folderId={activeFolderId}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <DocumentSelectionBar
              selectedDocIds={selectedDocIds}
              selectedFolderIds={selectedFolderIds}
              folderId={activeFolderId}
              canActOnAll={canActOnAll}
              clearSelection={clearSelection}
            />
            <DocumentTable
              documents={visibleDocuments}
              currentUser={currentUser}
              folders={folders}
              activeFolderId={activeFolderId}
              focusedDocId={focusedDocId}
              isAdmin={isAdmin}
              selected={selected}
              setSelected={setSelected}
              selectedDocIds={selectedDocIds}
              selectedFolderIds={selectedFolderIds}
              canActOnAll={canActOnAll}
              clearSelection={clearSelection}
              onUpload={() => uploadRef.current?.open()}
            />
          </div>
        </DocumentUpload>
      </PageContainer>

      {createOpen ? (
        <CreateFolderDialog
          open
          onOpenChange={() => setCreateOpen(false)}
          parentId={activeFolderId}
        />
      ) : null}

      {/* Portaled drag ghost — follows the pointer and isn't clipped by the
          table's overflow container the way the source row would be. A group
          drag shows a count badge. */}
      <DragOverlay dropAnimation={dropAnimation}>
        {activeDoc ? (
          <div
            data-drag-card
            className="relative flex max-w-xs items-center gap-3 rounded-lg border bg-card p-2 shadow-lg"
          >
            <DocumentThumbnail
              id={activeDoc.id}
              mime={activeDoc.mime}
              extension={activeDoc.extension}
              blurhash={activeDoc.blurhash}
              thumbnailPathname={activeDoc.thumbnailPathname}
              className="size-9 shrink-0"
            />
            <span className="truncate font-medium text-sm">{documentDisplayName(activeDoc)}</span>
            {activeCount > 1 ? (
              <span
                aria-hidden="true"
                className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-selected font-medium text-selected-foreground text-xs tabular-nums shadow-sm"
              >
                {activeCount}
              </span>
            ) : null}
          </div>
        ) : activeFolder ? (
          <div
            data-drag-card
            className="relative flex max-w-xs items-center gap-3 rounded-lg border bg-card p-2 shadow-lg"
          >
            <div className="flex size-9 shrink-0 items-center justify-center">
              <FolderIcon aria-hidden="true" className="size-5 text-muted-foreground" />
            </div>
            <span className="truncate font-medium text-sm">{activeFolder.name}</span>
            {activeCount > 1 ? (
              <span
                aria-hidden="true"
                className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-selected font-medium text-selected-foreground text-xs tabular-nums shadow-sm"
              >
                {activeCount}
              </span>
            ) : null}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

import { FileIcon, FolderOpenIcon, FolderPlusIcon, UploadIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DocumentMobileSelectionBar } from '~/components/document/actions/DocumentMobileSelectionBar'
import { DocumentCard } from '~/components/document/card/DocumentCard'
import { FolderCard, FolderUpCard } from '~/components/document/card/FolderCard'
import { CreateFolderDialog } from '~/components/document/dialogs/CreateFolderDialog'
import {
  type CurrentUser,
  seldocKey,
  selfolderKey,
} from '~/components/document/shared/documentHelpers'
import { FolderBreadcrumb } from '~/components/document/shared/FolderBreadcrumb'
import {
  DocumentUpload,
  type DocumentUploadHandle,
} from '~/components/document/upload/DocumentUpload'
import { PageContainer } from '~/components/layout/PageContainer'
import { Button } from '~/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
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
 * The touch documents library (Google-Drive style): a single scrollable card
 * list, no drag-and-drop. Tap opens a file / enters a folder; long-press enters
 * select mode, where tap toggles selection and a sticky bar offers bulk Move /
 * Delete. Single-item actions live on each card's ⋮ menu. `DocumentsView` picks
 * this tree on coarse (touch) pointers; the mouse tree is `DocumentsDesktop`.
 */
export function DocumentsMobile({ activeFolderId, currentUser, focusedDocId }: Props) {
  const { folders, visibleDocuments } = useDocumentsData(activeFolderId)
  const { isAdmin, selected, setSelected, selectedDocIds, selectedFolderIds, canActOnAll } =
    useDocumentSelection({ visibleDocuments, folders, activeFolderId, currentUser })

  const uploadRef = useRef<DocumentUploadHandle>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)

  // Leave select mode whenever the selection empties — whether the user
  // deselected the last item or it was pruned by a move/delete/realtime update.
  useEffect(() => {
    if (selectMode && selected.size === 0) setSelectMode(false)
  }, [selectMode, selected])

  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelected(new Set())
  }, [setSelected])

  // Long-press selects the item and enters select mode.
  const enterSelect = useCallback(
    (key: string) => {
      setSelectMode(true)
      setSelected(new Set(selected).add(key))
    },
    [selected, setSelected],
  )

  // Tap in select mode toggles membership; the effect above auto-exits at zero.
  const toggle = useCallback(
    (key: string) => {
      const next = new Set(selected)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      setSelected(next)
    },
    [selected, setSelected],
  )

  // Folders pinned above documents, sorted A→Z (sv) — mobile has no column sort.
  const childFolders = folders
    .filter((f) => f.parentId === activeFolderId)
    .toSorted((a, b) => a.name.localeCompare(b.name, 'sv'))
  const showUp = activeFolderId !== null
  const activeFolder = activeFolderId ? folders.find((f) => f.id === activeFolderId) : null
  const parentId = activeFolder?.parentId ?? null
  const parent = parentId ? (folders.find((f) => f.id === parentId) ?? null) : null

  const hasAnyRow = showUp || childFolders.length > 0 || visibleDocuments.length > 0

  return (
    <PageContainer width="full" className="gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.nav_documents()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.document_page_description_mobile()}</p>
      </header>

      {/* The breadcrumb/actions row and the select-mode bar swap in place — same
          slot, similar height — so toggling select mode doesn't reflow the list
          (which made the selection highlights flicker). */}
      {selectMode ? (
        <DocumentMobileSelectionBar
          selectedDocIds={selectedDocIds}
          selectedFolderIds={selectedFolderIds}
          folderId={activeFolderId}
          canActOnAll={canActOnAll}
          exitSelectMode={exitSelectMode}
        />
      ) : (
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
          <FolderBreadcrumb folders={folders} activeFolderId={activeFolderId} />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              <FolderPlusIcon data-icon="inline-start" />
              {m.folder_create_title()}
            </Button>
            <Button size="sm" onClick={() => uploadRef.current?.open()}>
              <UploadIcon data-icon="inline-start" />
              {m.upload_button_short()}
            </Button>
          </div>
        </div>
      )}

      <DocumentUpload ref={uploadRef} folderId={activeFolderId}>
        {!hasAnyRow ? (
          <Empty className="brand-wash rounded-lg border">
            <EmptyHeader>
              <EmptyMedia
                variant="icon"
                className="size-14 rounded-full bg-brand/10 text-brand ring-1 ring-brand/20"
              >
                <FileIcon className="size-7" />
              </EmptyMedia>
              <EmptyTitle>{m.document_table_empty()}</EmptyTitle>
              <EmptyDescription>{m.document_empty_description()}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => uploadRef.current?.open()}>
                <UploadIcon data-icon="inline-start" />
                {m.upload_button_short()}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {showUp ? <FolderUpCard parent={parent} selectMode={selectMode} /> : null}
            {childFolders.map((folder) => (
              <FolderCard
                key={folder.id}
                folder={folder}
                isAdmin={isAdmin}
                selectMode={selectMode}
                isSelected={selected.has(selfolderKey(folder.id))}
                onToggle={() => toggle(selfolderKey(folder.id))}
                onEnterSelect={() => enterSelect(selfolderKey(folder.id))}
              />
            ))}
            {visibleDocuments.length === 0 && showUp ? (
              // No files in this subfolder — branded medallion, whether or not
              // subfolders sit above.
              <Empty className="brand-wash rounded-lg border">
                <EmptyHeader>
                  <EmptyMedia
                    variant="icon"
                    className="size-14 rounded-full bg-brand/10 text-brand ring-1 ring-brand/20"
                  >
                    <FolderOpenIcon className="size-7" />
                  </EmptyMedia>
                  <EmptyTitle>{m.document_folder_empty_title()}</EmptyTitle>
                  <EmptyDescription>{m.document_folder_empty_description()}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              visibleDocuments.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  currentUser={currentUser}
                  selectMode={selectMode}
                  isFocused={doc.id === focusedDocId}
                  isSelected={selected.has(seldocKey(doc.id))}
                  onActivate={() =>
                    window.open(`/api/files/view/${doc.id}`, '_blank', 'noopener,noreferrer')
                  }
                  onToggle={() => toggle(seldocKey(doc.id))}
                  onEnterSelect={() => enterSelect(seldocKey(doc.id))}
                />
              ))
            )}
          </div>
        )}
      </DocumentUpload>

      {createOpen ? (
        <CreateFolderDialog
          open
          onOpenChange={() => setCreateOpen(false)}
          parentId={activeFolderId}
        />
      ) : null}
    </PageContainer>
  )
}

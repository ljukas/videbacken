import {
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { FileIcon, FolderOpenIcon, UploadIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import {
  type CurrentUser,
  type DocumentRow,
  type FolderRow,
  seldocKey,
  selfolderKey,
} from '~/components/document/shared/documentHelpers'
import { DocumentTableHeader } from '~/components/document/table/DocumentTableHeader'
import { DocumentTablePagination } from '~/components/document/table/DocumentTablePagination'
import { DocumentTableRow } from '~/components/document/table/DocumentTableRow'
import { columns } from '~/components/document/table/documentColumns'
import { FolderTableRow, FolderUpRow } from '~/components/document/table/FolderTableRow'
import { Button } from '~/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
import { Table, TableBody, TableCell, TableRow } from '~/components/ui/table'
import { useRowSelection } from '~/hooks/useRowSelection'
import { m } from '~/paraglide/messages'

type Props = {
  documents: Array<DocumentRow>
  currentUser: CurrentUser
  /** All active folders (the flat tree), for rendering child + up rows. */
  folders: Array<FolderRow>
  /** Resolved folder id from the URL, or null for the virtual root. */
  activeFolderId: string | null
  /** Document id to scroll to + flash (command-palette `?focus`), or null. */
  focusedDocId: string | null
  isAdmin: boolean
  /** The selection Set of composite keys (`seldoc:`/`selfolder:`), owned by DocumentsView. */
  selected: Set<string>
  setSelected: (next: Set<string>) => void
  /** Selected document ids, derived from `selected`. */
  selectedDocIds: Array<string>
  /** Selected folder ids, derived from `selected` (admin-only). */
  selectedFolderIds: Array<string>
  /** True when the user may act on the whole selection (docs editable; folders ⇒ admin). */
  canActOnAll: boolean
  clearSelection: () => void
  /** Opens the upload picker from the true-root empty-state CTA. */
  onUpload?: () => void
}

export function DocumentTable({
  documents,
  currentUser,
  folders,
  activeFolderId,
  focusedDocId,
  isAdmin,
  selected,
  setSelected,
  selectedDocIds,
  selectedFolderIds,
  canActOnAll,
  clearSelection,
  onUpload,
}: Props) {
  const table = useReactTable({
    data: documents,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: 20, pageIndex: 0 },
      sorting: [{ id: 'uploadedAt', desc: true }],
    },
  })

  const rows = table.getRowModel().rows

  // Folders are pinned above the (sorted, paginated) file rows like a regular
  // OS file browser — they live outside the table model. Sorted by name (sv
  // locale); toggling the Namn column flips their direction too, so the whole
  // list reads as one A→Z / Z→A. Other column sorts leave folders A→Z. An "up
  // one level" row leads when inside a folder.
  const nameSort = table.getColumn('name')?.getIsSorted()
  const childFolders = folders
    .filter((f) => f.parentId === activeFolderId)
    .toSorted((a, b) => a.name.localeCompare(b.name, 'sv') * (nameSort === 'desc' ? -1 : 1))
  const showUp = activeFolderId !== null

  // The visible order (folders pinned above the sorted+paginated file rows)
  // drives shift-range selection, so the range spans folders→files uniformly.
  // Folder keys only join the shared selection for admins; non-admins keep a
  // cosmetic single-folder highlight (`cosmeticFolderId`) that never enters the
  // Set, the bar, or dnd.
  const orderedKeys = useMemo(
    () => [
      ...(isAdmin ? childFolders.map((f) => selfolderKey(f.id)) : []),
      ...rows.map((r) => seldocKey(r.original.id)),
    ],
    [isAdmin, childFolders, rows],
  )
  const [cosmeticFolderId, setCosmeticFolderId] = useState<string | null>(null)
  // Selecting docs clears the non-admin cosmetic folder highlight (no-op for
  // admins, whose folders live in the Set); keeps the two mutually exclusive.
  const setDocSelection = useCallback(
    (next: Set<string>) => {
      setCosmeticFolderId(null)
      setSelected(next)
    },
    [setSelected],
  )
  const { onRowClick } = useRowSelection({
    orderedIds: orderedKeys,
    selected,
    setSelected: setDocSelection,
  })
  const selectRow = (key: string) => setDocSelection(new Set([key]))
  const selectionCount = selectedDocIds.length + selectedFolderIds.length
  const activeFolder = activeFolderId ? folders.find((f) => f.id === activeFolderId) : null
  const parentId = activeFolder?.parentId ?? null
  const parent = parentId ? (folders.find((f) => f.id === parentId) ?? null) : null

  const hasAnyRow = showUp || childFolders.length > 0 || documents.length > 0

  // A truly empty root (no folders, no files): the full empty-state card. Inside
  // a folder we always render the table so the "up one level" row stays reachable.
  if (!hasAnyRow) {
    return (
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
        {onUpload ? (
          <EmptyContent>
            <Button onClick={onUpload}>
              <UploadIcon data-icon="inline-start" />
              {m.upload_button()}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    )
  }

  return (
    // `md:-mx-4` lets the table (and its pagination) break out wider than the
    // page's `md:px-8` so it uses more of the panel — the header/toolbar above
    // keep the roomier reading margin (Linear-style). Mobile stays aligned.
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:-mx-4">
      <Table className="table-fixed" containerClassName="min-h-0">
        <DocumentTableHeader table={table} />
        <TableBody>
          {showUp ? (
            <FolderUpRow parentId={parentId} parent={parent} onClear={clearSelection} />
          ) : null}
          {childFolders.map((folder) => (
            <FolderTableRow
              key={folder.id}
              folder={folder}
              isAdmin={isAdmin}
              isSelected={
                isAdmin ? selected.has(selfolderKey(folder.id)) : cosmeticFolderId === folder.id
              }
              onSelect={(mods) => {
                if (isAdmin) onRowClick(selfolderKey(folder.id), mods)
                else {
                  setSelected(new Set())
                  setCosmeticFolderId(folder.id)
                }
              }}
            />
          ))}
          {documents.length === 0 ? (
            // At root, folders are present here (the truly-empty root is handled
            // above), so show nothing. Inside a subfolder, surface the branded
            // empty-folder card.
            showUp ? (
              <TableRow className="hover:[--row-bg:transparent]">
                <TableCell colSpan={6} className="p-0">
                  <Empty className="brand-wash border-0">
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
                </TableCell>
              </TableRow>
            ) : null
          ) : (
            rows.map((row) => (
              <DocumentTableRow
                key={row.original.id}
                row={row}
                currentUser={currentUser}
                isFocused={row.original.id === focusedDocId}
                isSelected={selected.has(seldocKey(row.original.id))}
                selectedDocIds={selectedDocIds}
                selectedFolderIds={selectedFolderIds}
                selectionCount={selectionCount}
                canActOnAll={canActOnAll}
                onRowClick={onRowClick}
                selectRow={selectRow}
                clearSelection={clearSelection}
              />
            ))
          )}
        </TableBody>
      </Table>

      {documents.length > 0 ? (
        <DocumentTablePagination table={table} total={documents.length} />
      ) : null}
    </div>
  )
}

import { useDraggable } from '@dnd-kit/core'
import type { Row } from '@tanstack/react-table'
import { MoreVerticalIcon } from 'lucide-react'
import { useCallback } from 'react'
import { DocumentRowDialogs } from '~/components/document/actions/DocumentRowDialogs'
import { DocumentThumbnail } from '~/components/document/shared/DocumentThumbnail'
import {
  buildDocActions,
  DocumentMenuItems,
  type MenuComponents,
} from '~/components/document/shared/documentActions'
import {
  type CurrentUser,
  type DocumentRow,
  documentDisplayName,
  documentDragId,
  fileKindLabel,
  formatSize,
  seldocKey,
} from '~/components/document/shared/documentHelpers'
import { RemoteOriginBadge } from '~/components/document/shared/RemoteOriginBadge'
import {
  DATE_CELL,
  KIND_CELL,
  OWNER_CELL,
  SIZE_CELL,
} from '~/components/document/table/documentColumns'
import { Button } from '~/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '~/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { RowActions } from '~/components/ui/row-actions'
import { TableCell, TableRow } from '~/components/ui/table'
import { useDialogState } from '~/hooks/useDialogState'
import { useScrollIntoViewOnce } from '~/hooks/useScrollIntoViewOnce'
import { formatDate } from '~/lib/i18n/format'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// The same action list renders into the `⋮` dropdown and the right-click
// context menu by passing the matching radix primitive set.
const dropdownComponents: MenuComponents = {
  Item: DropdownMenuItem,
  Group: DropdownMenuGroup,
  Separator: DropdownMenuSeparator,
}
const contextComponents: MenuComponents = {
  Item: ContextMenuItem,
  Group: ContextMenuGroup,
  Separator: ContextMenuSeparator,
}

// Interactive controls inside the row (thumbnail link, ⋮ trigger) and the
// portaled menu content must not toggle row selection or start a drag. Menus
// portal out in the DOM but are React children of the row, so their item clicks
// still bubble (React replays along the React tree) — swallow pointer/click on
// all of them before they reach the row's handlers.
const swallow = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
}

export function DocumentTableRow({
  row,
  currentUser,
  isFocused,
  isSelected,
  selectedDocIds,
  selectedFolderIds,
  selectionCount,
  canActOnAll,
  onRowClick,
  selectRow,
  clearSelection,
}: {
  row: Row<DocumentRow>
  currentUser: CurrentUser
  isFocused: boolean
  isSelected: boolean
  selectedDocIds: Array<string>
  selectedFolderIds: Array<string>
  selectionCount: number
  canActOnAll: boolean
  onRowClick: (
    key: string,
    mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => void
  selectRow: (key: string) => void
  clearSelection: () => void
}) {
  const doc = row.original
  const dialog = useDialogState<'rename' | 'move' | 'history' | 'delete'>()
  const canEdit = doc.ownerId === currentUser.id || currentUser.role === 'admin'
  const name = documentDisplayName(doc)
  const kind = fileKindLabel(doc)

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: documentDragId(doc.id),
    data: { documentId: doc.id },
  })

  // Scroll this row into view when the command palette navigated here (`?focus`).
  const focusRef = useScrollIntoViewOnce<HTMLTableRowElement>(isFocused)
  // Merge dnd-kit's draggable ref with the focus-scroll ref. Memoized so React
  // doesn't detach/reattach (and dnd-kit doesn't re-measure) on every render.
  const setRowRef = useCallback(
    (node: HTMLTableRowElement | null) => {
      setNodeRef(node)
      focusRef.current = node
    },
    [setNodeRef, focusRef],
  )

  const openFile = () => window.open(`/api/files/view/${doc.id}`, '_blank', 'noopener,noreferrer')

  // Whether the menu/actions act on the whole (mixed) selection — this row is
  // part of a multi-selection — or just this row. Folders only ever appear in
  // `selectedFolderIds` for admins (folder ops are admin-only).
  const isMulti = isSelected && selectionCount > 1
  const actingDocIds = isMulti ? selectedDocIds : [doc.id]
  const actingFolderIds = isMulti ? selectedFolderIds : []
  const actingCanEdit = isMulti ? canActOnAll : canEdit

  // The `⋮` dropdown always acts on this one row; the right-click menu acts on
  // the whole selection when this row is part of it.
  const dropdownGroups = buildDocActions({
    isMulti: false,
    canEdit,
    downloadHref: `/api/files/download/${doc.id}`,
    onHistory: () => dialog.show('history'),
    onRename: () => dialog.show('rename'),
    onMove: () => dialog.show('move'),
    onDelete: () => dialog.show('delete'),
  })
  const contextGroups = buildDocActions({
    isMulti,
    canEdit: actingCanEdit,
    downloadHref: isMulti ? undefined : `/api/files/download/${doc.id}`,
    onHistory: isMulti ? undefined : () => dialog.show('history'),
    onRename: isMulti ? undefined : () => dialog.show('rename'),
    onMove: () => dialog.show('move'),
    onDelete: () => dialog.show('delete'),
  })

  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          // Right-clicking an unselected row selects just it (OS behavior); a
          // selected row keeps the multi-selection so the menu acts on all.
          if (open && !isSelected) selectRow(seldocKey(doc.id))
        }}
      >
        <ContextMenuTrigger asChild>
          <TableRow
            ref={setRowRef}
            {...attributes}
            {...listeners}
            tabIndex={0}
            aria-selected={isSelected}
            onClick={(e) => {
              if (e.detail > 1) return // part of a double-click
              onRowClick(seldocKey(doc.id), e)
            }}
            onDoubleClick={openFile}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                openFile()
              } else if (e.key === ' ') {
                e.preventDefault()
                onRowClick(seldocKey(doc.id), e)
              } else if (e.key === 'Escape') {
                clearSelection()
              }
            }}
            className={cn(
              'group/row cursor-default select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              // Linear-style washed selection: a light blue fill (normal text on
              // top), driven via `--row-bg` (painted + rounded by the cells, and
              // merged across adjacent selected rows). Holds through hover and an
              // open ⋮ menu so the fill doesn't flip back to grey.
              isSelected &&
                '[--row-bg:var(--selected-wash)] hover:[--row-bg:var(--selected-wash)] has-aria-expanded:[--row-bg:var(--selected-wash)]',
              isDragging && 'opacity-50',
              isFocused && 'doc-focus-flash',
            )}
          >
            <TableCell>
              <div className="flex min-w-0 items-center gap-3">
                <a
                  href={`/api/files/view/${doc.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={m.document_open_label({ name })}
                  {...swallow}
                  className="shrink-0 rounded-md outline-none ring-1 ring-transparent transition-all duration-200 hover:shadow-md hover:ring-ring/50 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <DocumentThumbnail
                    id={doc.id}
                    mime={doc.mime}
                    extension={doc.extension}
                    blurhash={doc.blurhash}
                    thumbnailPathname={doc.thumbnailPathname}
                    className="size-9"
                  />
                </a>
                <div className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium" title={name}>
                      {name}
                    </span>
                    {doc.isRemoteOrigin ? <RemoteOriginBadge /> : null}
                  </span>
                  {/* Typ + Ägare fold in here until they become columns at `lg`. */}
                  <span className={cn('truncate text-xs lg:hidden', 'text-muted-foreground')}>
                    {`${kind} • ${doc.ownerName}`}
                  </span>
                  {/* Uppladdad + Storlek fold in here until they become columns at `md`. */}
                  <span
                    className={cn(
                      'truncate text-xs tabular-nums md:hidden',
                      'text-muted-foreground',
                    )}
                  >
                    {`${formatDate(doc.uploadedAt)} • ${formatSize(doc.sizeBytes)}`}
                  </span>
                </div>
              </div>
            </TableCell>

            <TableCell className={cn(KIND_CELL, 'truncate', 'text-muted-foreground')} title={kind}>
              {kind}
            </TableCell>
            <TableCell className={cn(DATE_CELL, 'tabular-nums', 'text-muted-foreground')}>
              {formatDate(doc.uploadedAt)}
            </TableCell>
            <TableCell className={cn(OWNER_CELL, 'truncate', 'text-muted-foreground')}>
              {doc.ownerName}
            </TableCell>
            <TableCell
              className={cn(SIZE_CELL, 'text-right tabular-nums', 'text-muted-foreground')}
            >
              {formatSize(doc.sizeBytes)}
            </TableCell>

            <TableCell className="pl-0 text-right">
              <RowActions>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={m.document_actions_label()}
                      {...swallow}
                    >
                      <MoreVerticalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" {...swallow}>
                    <DocumentMenuItems groups={dropdownGroups} components={dropdownComponents} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </RowActions>
            </TableCell>
          </TableRow>
        </ContextMenuTrigger>
        <ContextMenuContent {...swallow}>
          <DocumentMenuItems groups={contextGroups} components={contextComponents} />
        </ContextMenuContent>
      </ContextMenu>

      <DocumentRowDialogs
        active={dialog.active}
        onClose={dialog.close}
        doc={doc}
        name={name}
        isMulti={isMulti}
        actingDocIds={actingDocIds}
        actingFolderIds={actingFolderIds}
        clearSelection={clearSelection}
      />
    </>
  )
}

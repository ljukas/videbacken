import { CircleCheckIcon, CircleIcon, MoreVerticalIcon } from 'lucide-react'
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
  fileKindLabel,
  formatSize,
} from '~/components/document/shared/documentHelpers'
import { RemoteOriginBadge } from '~/components/document/shared/RemoteOriginBadge'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { useDialogState } from '~/hooks/useDialogState'
import { useLongPress } from '~/hooks/useLongPress'
import { useScrollIntoViewOnce } from '~/hooks/useScrollIntoViewOnce'
import { formatDate } from '~/lib/i18n/format'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

const dropdownComponents: MenuComponents = {
  Item: DropdownMenuItem,
  Group: DropdownMenuGroup,
  Separator: DropdownMenuSeparator,
}

// The ⋮ trigger and its menu content must not start a long-press or toggle the
// card. The menu portals out in the DOM but is a React child of the card, so its
// item clicks still bubble (React replays along the React tree) — swallow the
// pointer/click on both before they reach the card's handlers.
const swallow = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
}

/**
 * A document as a touch card (the mobile counterpart of `DocumentTableRow`).
 * Tap opens the file; long-press enters select mode and selects it. In select
 * mode tap toggles its membership and a checkbox replaces the ⋮ menu. The ⋮
 * (outside select mode) reuses the shared action list + row dialogs.
 */
export function DocumentCard({
  doc,
  currentUser,
  selectMode,
  isFocused,
  isSelected,
  onActivate,
  onToggle,
  onEnterSelect,
}: {
  doc: DocumentRow
  currentUser: CurrentUser
  selectMode: boolean
  isFocused: boolean
  isSelected: boolean
  /** Tap when not in select mode → open the file. */
  onActivate: () => void
  /** Tap when in select mode → toggle this card. */
  onToggle: () => void
  /** Long-press → enter select mode and select this card. */
  onEnterSelect: () => void
}) {
  const dialog = useDialogState<'rename' | 'move' | 'history' | 'delete'>()
  const canEdit = doc.ownerId === currentUser.id || currentUser.role === 'admin'
  const name = documentDisplayName(doc)
  const kind = fileKindLabel(doc)

  const { longPressHandlers, didLongPress } = useLongPress(onEnterSelect)

  // Scroll this card into view when the command palette navigated here (`?focus`).
  const focusRef = useScrollIntoViewOnce<HTMLDivElement>(isFocused)

  // The ⋮ acts on this one document only (single-item actions).
  const groups = buildDocActions({
    isMulti: false,
    canEdit,
    downloadHref: `/api/files/download/${doc.id}`,
    onHistory: () => dialog.show('history'),
    onRename: () => dialog.show('rename'),
    onMove: () => dialog.show('move'),
    onDelete: () => dialog.show('delete'),
  })

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a div carries the tap + long-press gesture; a native button would fight the nested ⋮ menu and select checkbox. */}
      <div
        ref={focusRef}
        {...longPressHandlers}
        role="button"
        tabIndex={0}
        aria-pressed={selectMode ? isSelected : undefined}
        onClick={() => {
          if (didLongPress()) return // long-press already handled this press
          if (selectMode) onToggle()
          else onActivate()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (selectMode) onToggle()
            else onActivate()
          }
        }}
        className={cn(
          'flex select-none items-center gap-3 rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isSelected
            ? 'bg-selected text-selected-foreground'
            : 'bg-surface-raised hover:bg-muted/50 active:bg-muted',
          isFocused && 'doc-focus-flash',
        )}
      >
        <DocumentThumbnail
          id={doc.id}
          mime={doc.mime}
          extension={doc.extension}
          blurhash={doc.blurhash}
          thumbnailPathname={doc.thumbnailPathname}
          className="size-10 shrink-0"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium" title={name}>
              {name}
            </span>
            {doc.isRemoteOrigin ? <RemoteOriginBadge /> : null}
          </span>
          <span
            className={cn(
              'truncate text-xs',
              isSelected ? 'text-selected-foreground/80' : 'text-muted-foreground',
            )}
          >
            {`${kind} • ${doc.ownerName}`}
          </span>
          <span
            className={cn(
              'truncate text-xs tabular-nums',
              isSelected ? 'text-selected-foreground/80' : 'text-muted-foreground',
            )}
          >
            {`${formatDate(doc.uploadedAt)} • ${formatSize(doc.sizeBytes)}`}
          </span>
        </div>

        {selectMode ? (
          isSelected ? (
            <CircleCheckIcon aria-hidden="true" className="size-5 shrink-0" />
          ) : (
            <CircleIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          )
        ) : (
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
              <DocumentMenuItems groups={groups} components={dropdownComponents} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <DocumentRowDialogs
        active={dialog.active}
        onClose={dialog.close}
        doc={doc}
        name={name}
        isMulti={false}
        actingDocIds={[doc.id]}
        actingFolderIds={[]}
        clearSelection={() => {}}
      />
    </>
  )
}

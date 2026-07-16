import { useNavigate } from '@tanstack/react-router'
import { CircleCheckIcon, CircleIcon, FolderIcon, FolderUpIcon } from 'lucide-react'
import { FolderActions } from '~/components/document/actions/FolderActions'
import { type FolderRow, folderPathToSplat } from '~/components/document/shared/documentHelpers'
import { useLongPress } from '~/hooks/useLongPress'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

const CARD =
  'flex select-none items-center gap-3 rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring'
const ICON_TILE = 'flex size-10 shrink-0 items-center justify-center'

// The ⋮ trigger must not start a long-press or toggle the card.
const swallow = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
}

/**
 * A child folder as a touch card (mobile counterpart of `FolderTableRow`). Tap
 * enters the folder; long-press enters select mode and selects it (admins only
 * — folder ops are admin-only). In select mode tap toggles its membership and a
 * checkbox replaces the ⋮ menu; non-selectable folders dim and ignore taps.
 */
export function FolderCard({
  folder,
  isAdmin,
  selectMode,
  isSelected,
  onToggle,
  onEnterSelect,
}: {
  folder: FolderRow
  isAdmin: boolean
  selectMode: boolean
  isSelected: boolean
  /** Tap when in select mode → toggle (admins only). */
  onToggle: () => void
  /** Long-press → enter select mode and select (admins only). */
  onEnterSelect: () => void
}) {
  const navigate = useNavigate()
  const open = () =>
    navigate({ to: '/documents/$', params: { _splat: folderPathToSplat(folder.path) } })

  const { longPressHandlers, didLongPress } = useLongPress(onEnterSelect)
  // Folders are only selectable by admins (folder move/delete are admin-only).
  const selectable = isAdmin
  const inert = selectMode && !selectable

  return (
    // biome-ignore lint/a11y/useSemanticElements: a div carries the tap + long-press gesture; a native button would fight the nested ⋮ menu.
    <div
      {...(selectable ? longPressHandlers : {})}
      role="button"
      tabIndex={inert ? -1 : 0}
      aria-pressed={selectMode && selectable ? isSelected : undefined}
      onClick={() => {
        if (didLongPress()) return
        if (selectMode) {
          if (selectable) onToggle()
        } else open()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (selectMode) {
            if (selectable) onToggle()
          } else open()
        }
      }}
      className={cn(
        CARD,
        isSelected
          ? 'bg-selected text-selected-foreground'
          : 'bg-surface-raised hover:bg-muted/50 active:bg-muted',
        inert && 'opacity-50',
      )}
    >
      <div className={ICON_TILE}>
        <FolderIcon
          aria-hidden="true"
          className={cn(
            'size-5',
            isSelected ? 'text-selected-foreground' : 'text-muted-foreground',
          )}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={folder.name}>
          {folder.name}
        </span>
        <span
          className={cn(
            'truncate text-xs',
            isSelected ? 'text-selected-foreground/80' : 'text-muted-foreground',
          )}
        >
          {m.folder_kind_label()}
        </span>
      </div>

      {selectMode ? (
        selectable ? (
          isSelected ? (
            <CircleCheckIcon aria-hidden="true" className="size-5 shrink-0" />
          ) : (
            <CircleIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          )
        ) : null
      ) : (
        <span {...swallow} className="shrink-0">
          <FolderActions folderId={folder.id} folderName={folder.name} isAdmin={isAdmin} />
        </span>
      )}
    </div>
  )
}

/**
 * The leading "up one level" card: tap steps to the active folder's parent (or
 * the root). Never selectable; in select mode it dims and ignores taps.
 */
export function FolderUpCard({
  parent,
  selectMode,
}: {
  parent: FolderRow | null
  selectMode: boolean
}) {
  const navigate = useNavigate()
  const destinationName = parent?.name ?? m.folder_root_name()
  const goUp = () =>
    parent
      ? navigate({ to: '/documents/$', params: { _splat: folderPathToSplat(parent.path) } })
      : navigate({ to: '/documents' })

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches the sibling folder/document cards' gesture container.
    <div
      role="button"
      tabIndex={selectMode ? -1 : 0}
      aria-label={m.folder_up_one_level({ name: destinationName })}
      onClick={() => {
        if (!selectMode) goUp()
      }}
      onKeyDown={(e) => {
        if (!selectMode && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          goUp()
        }
      }}
      className={cn(
        CARD,
        'bg-surface-raised hover:bg-muted/50 active:bg-muted',
        selectMode && 'opacity-50',
      )}
    >
      <div className={ICON_TILE}>
        <FolderUpIcon aria-hidden="true" className="size-5 text-muted-foreground" />
      </div>
      <span className="font-medium">..</span>
    </div>
  )
}

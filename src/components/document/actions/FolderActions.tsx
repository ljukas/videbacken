import {
  FolderInputIcon,
  FolderPlusIcon,
  MoreVerticalIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react'
import { CreateFolderDialog } from '~/components/document/dialogs/CreateFolderDialog'
import { DeleteFolderDialog } from '~/components/document/dialogs/DeleteFolderDialog'
import { MoveDialog } from '~/components/document/dialogs/MoveDialog'
import { RenameFolderDialog } from '~/components/document/dialogs/RenameFolderDialog'
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
import { m } from '~/paraglide/messages'

type Props = {
  // null id/name = the virtual root: only "new folder here" applies.
  folderId: string | null
  folderName: string | null
  isAdmin: boolean
  triggerClassName?: string
}

// The ⋮ trigger and its menu content must not select or navigate the enclosing
// folder row/card. The menu portals out in the DOM but is a React child of the
// row, so its item clicks still bubble (React replays along the React tree) —
// swallow the pointer/click on both so this stays self-contained at every
// call site (`FolderTableRow` has no wrapping guard of its own).
const swallow = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
}

export function FolderActions({ folderId, folderName, isAdmin, triggerClassName }: Props) {
  const dialog = useDialogState<'create' | 'rename' | 'move' | 'delete'>()
  const isRoot = folderId === null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.folder_actions_label()}
            className={triggerClassName}
            {...swallow}
          >
            <MoreVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" {...swallow}>
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => dialog.show('create')}>
              <FolderPlusIcon data-icon="inline-start" />
              {m.folder_create_here()}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {!isRoot && isAdmin ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => dialog.show('rename')}>
                  <PencilIcon data-icon="inline-start" />
                  {m.document_action_rename()}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => dialog.show('move')}>
                  <FolderInputIcon data-icon="inline-start" />
                  {m.document_action_move()}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => dialog.show('delete')}>
                  <Trash2Icon data-icon="inline-start" />
                  {m.document_action_delete()}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mounted only while open — otherwise every tree node would hold a live
          MoveDialog folder-tree subscription. */}
      {dialog.active === 'create' ? (
        <CreateFolderDialog open onOpenChange={dialog.close} parentId={folderId} />
      ) : null}
      {!isRoot && folderName !== null ? (
        <>
          {dialog.active === 'rename' ? (
            <RenameFolderDialog
              open
              onOpenChange={dialog.close}
              folder={{ id: folderId, name: folderName }}
            />
          ) : null}
          {dialog.active === 'move' ? (
            <MoveDialog
              open
              onOpenChange={dialog.close}
              target={{ kind: 'folder', id: folderId, name: folderName }}
            />
          ) : null}
          {dialog.active === 'delete' ? (
            <DeleteFolderDialog
              open
              onOpenChange={dialog.close}
              folder={{ id: folderId, name: folderName }}
            />
          ) : null}
        </>
      ) : null}
    </>
  )
}

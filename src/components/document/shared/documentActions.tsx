import {
  DownloadIcon,
  FolderInputIcon,
  HistoryIcon,
  type LucideIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react'
import { Fragment } from 'react'
import { m } from '~/paraglide/messages'

// Single source of truth for the document row actions, rendered identically by
// the `⋮` dropdown and the right-click context menu. Radix DropdownMenu and
// ContextMenu expose structurally identical Item/Group/Separator primitives, so
// the same descriptor list renders into either by passing the matching
// primitive set as `components`.

type DocActionItem = {
  key: string
  label: string
  icon: LucideIcon
  /** Renders the item as an `<a>` (download). Mutually exclusive with onSelect. */
  href?: string
  onSelect?: () => void
  variant?: 'default' | 'destructive'
  disabled?: boolean
}

type DocActionGroup = { key: string; items: Array<DocActionItem> }

/**
 * Build the action groups for a document row. `isMulti` (the row is part of a
 * multi-selection) collapses to the bulk-safe subset — Flytta + Ta bort —
 * dropping per-file actions (Ladda ner, Historik, Byt namn). `canEdit` gates the
 * mutating actions; for a multi-selection it must mean "every selected doc".
 */
export function buildDocActions(opts: {
  isMulti: boolean
  canEdit: boolean
  downloadHref?: string
  onHistory?: () => void
  onRename?: () => void
  onMove: () => void
  onDelete: () => void
}): Array<DocActionGroup> {
  if (opts.isMulti) {
    return [
      {
        key: 'edit',
        items: [
          {
            key: 'move',
            label: m.document_action_move_to(),
            icon: FolderInputIcon,
            onSelect: opts.onMove,
            disabled: !opts.canEdit,
          },
          {
            key: 'delete',
            label: m.document_action_delete(),
            icon: Trash2Icon,
            variant: 'destructive',
            onSelect: opts.onDelete,
            disabled: !opts.canEdit,
          },
        ],
      },
    ]
  }

  const view: Array<DocActionItem> = []
  if (opts.downloadHref) {
    view.push({
      key: 'download',
      label: m.document_action_download(),
      icon: DownloadIcon,
      href: opts.downloadHref,
    })
  }
  if (opts.onHistory) {
    view.push({
      key: 'history',
      label: m.document_history_title(),
      icon: HistoryIcon,
      onSelect: opts.onHistory,
    })
  }

  const groups: Array<DocActionGroup> = [{ key: 'view', items: view }]
  if (opts.canEdit) {
    groups.push({
      key: 'edit',
      items: [
        {
          key: 'rename',
          label: m.document_action_rename(),
          icon: PencilIcon,
          onSelect: opts.onRename,
        },
        {
          key: 'move',
          label: m.document_action_move_to(),
          icon: FolderInputIcon,
          onSelect: opts.onMove,
        },
        {
          key: 'delete',
          label: m.document_action_delete(),
          icon: Trash2Icon,
          variant: 'destructive',
          onSelect: opts.onDelete,
        },
      ],
    })
  }
  return groups
}

// Minimal shape both DropdownMenuItem and ContextMenuItem satisfy.
type MenuItemProps = {
  asChild?: boolean
  variant?: 'default' | 'destructive'
  disabled?: boolean
  onSelect?: (event: Event) => void
  children?: React.ReactNode
}

export type MenuComponents = {
  Item: React.ComponentType<MenuItemProps>
  Group: React.ComponentType<{ children?: React.ReactNode }>
  Separator: React.ComponentType<Record<string, never>>
}

/** Render action groups into a passed-in menu primitive set (dropdown or context). */
export function DocumentMenuItems({
  groups,
  components,
}: {
  groups: Array<DocActionGroup>
  components: MenuComponents
}) {
  const { Item, Group, Separator } = components
  return groups
    .filter((group) => group.items.length > 0)
    .map((group, index) => (
      <Fragment key={group.key}>
        {index > 0 ? <Separator /> : null}
        <Group>
          {group.items.map((action) => {
            const Icon = action.icon
            if (action.href) {
              return (
                <Item key={action.key} asChild>
                  <a href={action.href}>
                    <Icon data-icon="inline-start" />
                    {action.label}
                  </a>
                </Item>
              )
            }
            return (
              <Item
                key={action.key}
                variant={action.variant}
                disabled={action.disabled}
                onSelect={() => action.onSelect?.()}
              >
                <Icon data-icon="inline-start" />
                {action.label}
              </Item>
            )
          })}
        </Group>
      </Fragment>
    ))
}

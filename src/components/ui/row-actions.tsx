import type * as React from 'react'
import { cn } from '~/lib/utils'

/**
 * Hover-reveal host for a table row's trailing actions (the `⋮` menu). Declare
 * `group/row` on the enclosing `<TableRow>`; the actions then hide on desktop
 * until the row is hovered, keyboard focus enters the row, or the menu is open.
 *
 * The `md:` guard is the a11y keystone: on touch (`<md`, no hover) the control
 * stays fully visible. Mirrors `SidebarMenuAction showOnHover` (sidebar.tsx).
 */
export function RowActions({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      data-slot="row-actions"
      className={cn(
        'flex justify-end opacity-100 transition-opacity',
        // hide-until-interaction only where hover exists; revealed on row hover,
        // keyboard focus anywhere in the row, or while the menu is open.
        'md:opacity-0 group-hover/row:md:opacity-100 group-focus-within/row:md:opacity-100 has-aria-expanded:md:opacity-100',
        className,
      )}
    >
      {children}
    </div>
  )
}

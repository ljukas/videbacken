import { Command as CommandPrimitive } from 'cmdk'
import { CheckIcon, SearchIcon } from 'lucide-react'
import type * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { InputGroup, InputGroupAddon } from '~/components/ui/input-group'
import { Spinner } from '~/components/ui/spinner'
import { cn } from '~/lib/utils'

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn('top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0', className)}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  loading = false,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & { loading?: boolean }) {
  return (
    <div data-slot="command-input-wrapper" className="p-1">
      <InputGroup
        className={cn(
          // default field chrome: short height, rounded, subtle border/bg, no shadow
          'h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!',
          // larger sizing when shown inside the command dialog
          'in-data-[slot=dialog-content]:h-11!',
        )}
      >
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            // full-width borderless text input
            'w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
            // larger text when shown inside the command dialog
            'in-data-[slot=dialog-content]:text-base',
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="in-data-[slot=dialog-content]:size-5 size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
        {loading ? (
          <InputGroupAddon align="inline-end">
            <Spinner className="in-data-[slot=dialog-content]:size-5 size-4 opacity-50" />
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        // scrollable list region: hidden scrollbar, capped height, vertical scroll
        'no-scrollbar max-h-72 scroll-py-1 overflow-y-auto overflow-x-hidden outline-none',
        // taller cap when shown inside the command dialog
        'in-data-[slot=dialog-content]:max-h-96',
        className,
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn(
        // centered empty-state text
        'py-6 text-center text-sm',
        // larger text when shown inside the command dialog
        'in-data-[slot=dialog-content]:text-base',
        className,
      )}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        // group container
        'overflow-hidden p-1 text-foreground',
        // style cmdk's internal group heading element (all depths)
        '**:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground **:[[cmdk-group-heading]]:text-xs',
        // larger heading text when shown inside the command dialog
        'in-data-[slot=dialog-content]:**:[[cmdk-group-heading]]:text-sm',
        className,
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  // We intentionally omit shadcn's default `data-selected:[&_svg]:text-foreground`
  // override. Lucide icons stroke with `currentColor`, so an uncolored icon already
  // follows the item's `data-selected:text-foreground` via inheritance — the override
  // was redundant for those and only clobbered icons that set their own color (e.g.
  // the file-type icons in CommandPalette). Leaving it out lets colored icons keep
  // their color when selected, with no extra rule.
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // default layout: row, centered, non-selectable, default cursor
        'group/command-item relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden',
        // selected/disabled states
        'data-[disabled=true]:pointer-events-none data-selected:bg-muted data-selected:text-foreground data-[disabled=true]:opacity-50',
        // icons: non-interactive, never shrink, default size unless icon sets its own
        "[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        // larger sizing/spacing when shown inside the command dialog
        "in-data-[slot=dialog-content]:gap-3 in-data-[slot=dialog-content]:rounded-lg! in-data-[slot=dialog-content]:px-3 in-data-[slot=dialog-content]:py-2.5 in-data-[slot=dialog-content]:text-base in-data-[slot=dialog-content]:[&_svg:not([class*='size-'])]:size-5",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        'ml-auto text-muted-foreground text-xs tracking-widest group-data-selected/command-item:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
}

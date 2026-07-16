'use client'

import type { VariantProps } from 'class-variance-authority'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import * as React from 'react'
import { toggleVariants } from '~/components/ui/toggle'
import { cn } from '~/lib/utils'

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: 'horizontal' | 'vertical'
  }
>({
  size: 'default',
  variant: 'default',
  spacing: 0,
  orientation: 'horizontal',
})

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  orientation = 'horizontal',
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: 'horizontal' | 'vertical'
  }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-orientation={orientation}
      style={{ '--gap': spacing } as React.CSSProperties}
      className={cn(
        // layout: horizontal row by default, gap from the --gap css var
        'group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg',
        // vertical orientation: stack and stretch items
        'data-vertical:flex-col data-vertical:items-stretch',
        // smaller outer radius for small size
        'data-[size=sm]:rounded-[min(var(--radius-md),10px)]',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size, spacing, orientation }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        // base: don't shrink in the row; lift focused item above neighbors
        'shrink-0 focus:z-10 focus-visible:z-10',
        // joined mode (spacing=0): remove radius + inter-item borders, round only the outer corners
        'group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2',
        // joined mode, vertical: drop top border on inner items, restore it + top radius on the first
        'group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0',
        'group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t',
        'group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-lg group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-lg',
        // joined mode, horizontal: drop left border on inner items, restore it + left radius on the first
        'group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0',
        'group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l',
        'group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-lg group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-lg',
        // joined mode padding when an inline icon is present
        'group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5',
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem }

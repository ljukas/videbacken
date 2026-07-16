import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '~/lib/utils'

const buttonVariants = cva(
  [
    // base: inline flex, no-wrap, rounded, medium small text
    'group/button inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg border border-transparent bg-clip-padding font-medium text-sm outline-none transition-all',
    // focus ring
    'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
    // press: nudge down 1px, but not for menu/popover triggers
    'active:not-aria-[haspopup]:translate-y-px',
    // disabled
    'disabled:pointer-events-none disabled:opacity-50',
    // invalid state (aria-invalid + dark overrides)
    'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
    // icons: default 1rem unless explicitly sized; non-interactive, no shrink
    "[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        outline:
          'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 dark:hover:bg-destructive/30',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        // default: tighter padding on the side that holds an inline icon
        default:
          'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: [
          // size + spacing + extra-small text
          'h-6 gap-1 px-2 text-xs',
          // radius: clamped small radius, but square corners inside a button-group
          'in-data-[slot=button-group]:rounded-lg rounded-[min(var(--radius-md),10px)]',
          // padding: tighter on the side that holds an inline icon
          'has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
          // smaller default icon size
          "[&_svg:not([class*='size-'])]:size-3",
        ],
        sm: [
          // size + spacing + slightly-smaller text
          'h-7 gap-1 px-2.5 text-[0.8rem]',
          // radius: clamped small radius, but square corners inside a button-group
          'in-data-[slot=button-group]:rounded-lg rounded-[min(var(--radius-md),12px)]',
          // padding: tighter on the side that holds an inline icon
          'has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
          // smaller default icon size
          "[&_svg:not([class*='size-'])]:size-3.5",
        ],
        // large: tighter padding on the side that holds an inline icon
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        // xl: comfortable marquee size (login, empty-state CTAs); larger text,
        // softer corner + roomier padding, tighter on the inline-icon side
        xl: 'h-11 gap-2 rounded-xl px-5 text-base has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4',
        icon: 'size-8',
        // icon-xs: square; clamped radius, but square corners inside a button-group; smaller icon
        'icon-xs':
          "size-6 in-data-[slot=button-group]:rounded-lg rounded-[min(var(--radius-md),10px)] [&_svg:not([class*='size-'])]:size-3",
        // icon-sm: square; clamped radius, but square corners inside a button-group
        'icon-sm':
          'size-7 in-data-[slot=button-group]:rounded-lg rounded-[min(var(--radius-md),12px)]',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

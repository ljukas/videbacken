import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '~/lib/utils'

const alertVariants = cva(
  [
    // base box: full-width grid card with border + padding
    'group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm',
    // when an icon is present, switch to an [icon | content] two-column grid
    'has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2',
    // when an action slot is present, reserve room for it in the corner
    'has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18',
    // icons: size any child <svg> lacking an explicit size- class to 1rem, span both rows, nudge down, inherit color
    "*:[svg:not([class*='size-'])]:size-4 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
  ],
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        // destructive: red text; dim the description and keep icons at current color
        destructive:
          'bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        // title text; shift to the content column when the alert has an icon
        'font-medium group-has-[>svg]/alert:col-start-2',
        // links inside the title: underlined, foreground color on hover
        '[&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        // muted body text; balanced wrapping on small screens, pretty wrapping from md up
        'text-balance text-muted-foreground text-sm md:text-pretty',
        // links inside the description: underlined, foreground color on hover
        '[&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground',
        // space between stacked paragraphs (skip the last)
        '[&_p:not(:last-child)]:mb-4',
        className,
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="alert-action" className={cn('absolute top-2 right-2', className)} {...props} />
  )
}

export { Alert, AlertAction, AlertDescription, AlertTitle }

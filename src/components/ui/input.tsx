import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '~/lib/utils'

const inputVariants = cva(
  [
    // base box: shape, border, background, outline reset, transitions
    'w-full min-w-0 rounded-lg border border-input bg-transparent outline-none transition-colors',
    // style the native file-picker button
    'file:inline-flex file:h-6 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm',
    // placeholder text + focus ring
    'placeholder:text-muted-foreground/60 focus-visible:border-brand focus-visible:ring-1 focus-visible:ring-brand',
    // disabled state
    'disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50',
    // invalid state (aria-invalid): thin destructive edge, matching the focus weight
    'aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/50',
    // dark base background + dark disabled background
    'dark:bg-input/30 dark:disabled:bg-input/80',
  ],
  {
    variants: {
      size: {
        // dense app default: 16px on mobile (no iOS zoom), 14px from md up
        default: 'h-8 px-2.5 py-1 text-base md:text-sm',
        // comfortable marquee size (login); softer corner, stays 16px throughout
        xl: 'h-11 rounded-xl px-3.5 text-base',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
)

function Input({
  className,
  type,
  size,
  ...props
}: Omit<React.ComponentProps<'input'>, 'size'> & VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  )
}

export { Input, inputVariants }

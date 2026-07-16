import type * as React from 'react'

import { cn } from '~/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // base box: auto-grow to fit content + layout, shape, border, background, spacing, text, outline, transition
        'field-sizing-content flex min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none transition-colors',
        // placeholder color + keyboard focus ring
        'placeholder:text-muted-foreground focus-visible:border-brand focus-visible:ring-1 focus-visible:ring-brand',
        // disabled state
        'disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50',
        // invalid state (aria-invalid): thin destructive edge, matching the focus weight
        'aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/50',
        // responsive text size + dark base background/disabled
        'md:text-sm dark:bg-input/30 dark:disabled:bg-input/80',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }

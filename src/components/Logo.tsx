import type * as React from 'react'
import { cn } from '~/lib/utils'

/**
 * The brand mark: a placeholder "V" lettermark in `--brand`, centered in its
 * box. Same geometry as `public/favicon.svg`. Size the whole mark via
 * `className` (e.g. `size-7`); the mark fills the box. Labelled "Videbacken" by
 * default; pass `decorative` when an adjacent text label already names it (as in
 * `Wordmark`). Swap this out for real brand art later — it's a stand-in.
 */
export function LogoMark({
  className,
  decorative = false,
  ...props
}: React.ComponentProps<'span'> & { decorative?: boolean }) {
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': 'Videbacken' }
  return (
    <span className={cn('inline-flex aspect-square text-brand', className)} {...a11y} {...props}>
      <svg viewBox="0 0 32 32" className="size-full" fill="currentColor" aria-hidden="true">
        <path d="M4 3L16 29L28 3L22 3L16 18L10 3Z" />
      </svg>
    </span>
  )
}

/** The mark + the "Videbacken" wordmark, set in the heading face. */
export function Wordmark({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex items-center gap-1.5', className)} {...props}>
      <LogoMark decorative className="size-7 shrink-0" />
      {/* The word hides when an enclosing sidebar collapses to the icon rail; the
          class is inert anywhere there is no `[data-collapsible=icon]` group (e.g. login). */}
      <span className="truncate font-heading font-semibold text-lg tracking-tight group-data-[collapsible=icon]:hidden">
        Videbacken
      </span>
    </div>
  )
}

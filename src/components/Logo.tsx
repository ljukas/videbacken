import type * as React from 'react'
import { cn } from '~/lib/utils'

/**
 * The brand mark: a single off-center, wind-filled sail in `--brand`, centered in
 * its box. Same geometry as `public/favicon.svg`. Size the whole mark via
 * `className` (e.g. `size-7`); the sail fills the box. Labelled "Oceanview" by
 * default; pass `decorative` when an adjacent text label already names it (as in
 * `Wordmark`).
 */
export function LogoMark({
  className,
  decorative = false,
  ...props
}: React.ComponentProps<'span'> & { decorative?: boolean }) {
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': 'Oceanview' }
  return (
    <span className={cn('inline-flex aspect-square text-brand', className)} {...a11y} {...props}>
      <svg viewBox="0 0 32 32" className="size-full" fill="currentColor" aria-hidden="true">
        <path d="M11 2L7 30Q15 28.5 25 27.5Q23.5 11 11 2Z" />
      </svg>
    </span>
  )
}

/** The mark + the "Oceanview" wordmark, set in the heading face. */
export function Wordmark({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex items-center gap-1.5', className)} {...props}>
      {/* The sail is a triangle (visual mass in its lower third) centered in a
          square box, so geometric centering reads slightly low next to the
          cap-height text; nudge it up a hair to optically center the lockup. */}
      <LogoMark decorative className="size-7 shrink-0 -translate-y-px" />
      {/* The word hides when an enclosing sidebar collapses to the icon rail; the
          class is inert anywhere there is no `[data-collapsible=icon]` group (e.g. login). */}
      <span className="truncate font-heading font-semibold text-lg tracking-tight group-data-[collapsible=icon]:hidden">
        Oceanview
      </span>
    </div>
  )
}

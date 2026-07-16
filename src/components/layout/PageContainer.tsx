import type * as React from 'react'
import { cn } from '~/lib/utils'

const widths = {
  default: 'max-w-5xl', // card grids, lists, mixed content
  prose: 'max-w-2xl', // forms, settings, reading
  full: 'max-w-none', // data tables + document grid (full-bleed)
} as const

/**
 * Shared page wrapper: centers content, constrains width, and owns the page
 * padding once (replacing per-route `flex flex-col gap-6 p-4 md:p-8`).
 *
 * Lives inside `SidebarInset`, which is a fixed-height flex column — so
 * PageContainer is the page's scroll owner. Three modes:
 * - default: the whole page scrolls inside the panel (forms, lists, reading).
 * - `fill`: the container is a fixed-height flex column that clips; a child
 *   owns the scroll (Linear-style data-table screens, where the chrome stays
 *   put and only the table body scrolls). Give that child `flex-1 min-h-0
 *   overflow-auto`.
 * - `fill="lg"`: fill from the `lg` breakpoint up, default below — for
 *   screens whose lg layout is a scroll-inside table but whose narrow layout
 *   is a card list that wants natural page scroll (Calendar). An inner
 *   scroller below lg would sit inside the page padding and draw its
 *   scrollbar next to the content instead of at the panel edge.
 *
 * The scroll/clip lives on the full-width outer element so the scrollbar sits
 * at the panel edge, not at the centered `max-w-*` edge.
 */
export function PageContainer({
  className,
  width = 'default',
  fill = false,
  children,
  ...props
}: React.ComponentProps<'div'> & { width?: keyof typeof widths; fill?: boolean | 'lg' }) {
  return (
    <div
      data-slot="page-container"
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        fill === true && 'overflow-hidden',
        fill === 'lg' && 'overflow-y-auto lg:overflow-hidden',
        fill === false && 'overflow-y-auto',
      )}
      {...props}
    >
      <div
        className={cn(
          'mx-auto flex w-full flex-col gap-6 px-4 py-6 md:px-8 md:py-10',
          widths[width],
          fill === true && 'min-h-0 flex-1',
          fill === 'lg' && 'lg:min-h-0 lg:flex-1',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}

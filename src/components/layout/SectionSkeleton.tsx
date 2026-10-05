import { useHydrated } from '@tanstack/react-router'
import { Skeleton } from 'boneyard-js/react'
import type * as React from 'react'
import { useLayoutEffect, useState } from 'react'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
// The captured bones (and the boneyard runtime) load with the first route that
// shows a skeleton, not with the entry chunk.
import '~/bones/registry'

// Set by the boneyard CLI while it captures; the section must be wrapped then
// so the CLI finds it by name, even though it isn't loading.
const capturing = () =>
  typeof window !== 'undefined' &&
  (window as { __BONEYARD_BUILD?: boolean }).__BONEYARD_BUILD === true

/**
 * A section's loading state (ADR-0025 §3–4), the only place pages meet boneyard.
 * Loading shows the bones captured for `name` (`bun run bones:capture`), or a
 * plain block if none are captured yet. Only after hydration: a server-rendered
 * failed read has no skeleton, so the first client render mustn't have one either.
 * Not loading renders the children as-is, with no wrapper, so a section that
 * renders nothing leaves no gap in the page's flex layout.
 */
export function SectionSkeleton({
  name,
  loading,
  className,
  fallbackHeight = '8rem',
  children,
}: {
  name: string
  loading: boolean
  className?: string
  /** The fallback block's height until bones are captured. */
  fallbackHeight?: string
  children: React.ReactNode
}) {
  const hydrated = useHydrated()
  const showLoading = loading && hydrated
  if (!showLoading && !capturing()) return <>{children}</>
  // The loading -> loaded flip remounts the children; fine, since firstLoadPending
  // only goes false once data exists, so it is one-way per key.
  // boneyard scales its bones to the wrapper's measured height. While loading,
  // render no children (a section's no-data render is shorter than its loaded
  // one, so hidden children would squash the bones): the empty wrapper reserves
  // the captured height instead. (The CLI's capture renders the children itself.)
  const content = showLoading && !capturing() ? null : children
  return (
    <>
      <Skeleton
        name={name}
        loading={showLoading}
        select="viewport"
        // Clipped: a capture's bones can run a few px past the section's edge.
        className={cn('overflow-hidden', className)}
        fallback={<FallbackBlock height={fallbackHeight} />}
      >
        {content}
      </Skeleton>
      {showLoading && (
        <span role="status" className="sr-only">
          {m.common_loading()}
        </span>
      )}
    </>
  )
}

// The block for a section without captured bones. boneyard renders the fallback
// on its own first render even when bones exist (it hasn't read the viewport
// width yet) and measures the wrapper then; a visible block would become the
// height every bone is scaled to. So the block appears only after mounting:
// that measurement sees an empty wrapper, and the bones keep their own height.
function FallbackBlock({ height }: { height: string }) {
  const [mounted, setMounted] = useState(false)
  useLayoutEffect(() => setMounted(true), [])
  if (!mounted) return null
  return (
    <div
      data-section-skeleton-fallback
      className="rounded-lg bg-foreground/8 motion-safe:animate-pulse"
      style={{ height }}
    />
  )
}

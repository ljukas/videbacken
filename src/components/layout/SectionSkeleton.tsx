import { useHydrated } from '@tanstack/react-router'
import { Skeleton } from 'boneyard-js/react'
import type * as React from 'react'

// Set by the boneyard CLI while it captures; the section must be wrapped then
// so the CLI finds it by name, even though it isn't loading.
const capturing = () =>
  typeof window !== 'undefined' &&
  (window as { __BONEYARD_BUILD?: boolean }).__BONEYARD_BUILD === true

/**
 * A section's loading state (ADR-0024 §3–4), the only place pages meet boneyard.
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
  return (
    <Skeleton
      name={name}
      loading={showLoading}
      select="viewport"
      className={className}
      fallback={
        <div
          data-section-skeleton-fallback
          className="rounded-lg bg-muted"
          style={{ height: fallbackHeight }}
        />
      }
    >
      {children}
    </Skeleton>
  )
}

import { useHydrated } from '@tanstack/react-router'
import type { ResponsiveBones } from 'boneyard-js'
import { Skeleton } from 'boneyard-js/react'
import type * as React from 'react'
import { useLayoutEffect, useState } from 'react'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import boneyardConfig from '../../../boneyard.config.json'

/** A `*.bones.json` capture as imported: per breakpoint, its name and geometry. */
export type CapturedBones = { breakpoints: Record<string, { name: string }> }

type Source =
  /** A captured section: the default import of `~/bones/<name>.bones.json`. */
  | { bones: CapturedBones; name?: never }
  /** A section not captured yet: the name `bun run bones:capture` captures it by. */
  | { name: string; bones?: never }

// A capture names every breakpoint after itself (test/sectionSkeletonBones.test.ts).
const captureName = (bones: CapturedBones) => Object.values(bones.breakpoints)[0]?.name ?? ''

// Set by the boneyard CLI while it captures; the section must be wrapped then
// so the CLI finds it by name, even though it isn't loading.
const capturing = () =>
  typeof window !== 'undefined' &&
  (window as { __BONEYARD_BUILD?: boolean }).__BONEYARD_BUILD === true

/**
 * A section's loading state (ADR-0025 §3–4), the only place pages meet boneyard.
 * Loading shows the section's captured `bones` (`bun run bones:capture`), or, for
 * a section not captured yet (`name` only), a plain block. Each route imports its
 * sections' bones (`bones={…}`), so a page carries only its own (ADR-0025 §4).
 * Only after hydration: a server-rendered failed read has no skeleton, so the
 * first client render mustn't have one either.
 * Not loading renders the children as-is, with no wrapper, so a section that
 * renders nothing leaves no gap in the page's flex layout.
 */
export function SectionSkeleton(
  props: Source & {
    loading: boolean
    className?: string
    /** The fallback block's height until bones are captured. */
    fallbackHeight?: string
    /** Elements the capture leaves out of the bones (e.g. admin-only controls). */
    excludeSelectors?: string[]
    children: React.ReactNode
  },
) {
  const { loading, className, fallbackHeight = '8rem', excludeSelectors, children } = props
  const name = props.bones ? captureName(props.bones) : props.name
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
        // The JSON's inferred number[][] isn't boneyard's bone tuple type.
        initialBones={props.bones as unknown as ResponsiveBones | undefined}
        loading={showLoading}
        select="viewport"
        // Clipped: a capture's bones can run a few px past the section's edge.
        className={cn('overflow-hidden', className)}
        fallback={<FallbackBlock height={fallbackHeight} />}
        snapshotConfig={excludeSelectors ? { excludeSelectors } : undefined}
        // The capture config's look, here since no registry configures boneyard. Only these
        // three reach Skeleton as props: boneyard reads speed, shimmerColor, darkShimmerColor
        // and shimmerAngle from its global config only, so adding them to boneyard.config.json
        // does nothing without a configureBoneyard call. Change the cast if `animate` changes.
        color={boneyardConfig.color}
        darkColor={boneyardConfig.darkColor}
        animate={boneyardConfig.animate as 'pulse'}
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

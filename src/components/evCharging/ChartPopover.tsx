import { Tooltip, useTooltip, useTooltipInPortal } from '@visx/tooltip'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'

// Tooltip sits above the mark so a fingertip doesn't cover it.
const OFFSET_TOP = -34
// Near the wrapper's top edge there's no room above: drop below the mark instead.
const OFFSET_BELOW = 24

type Bounds = ReturnType<typeof useTooltipInPortal>['containerBounds']

export function useChartPopover<T>({ followScroll = false }: { followScroll?: boolean } = {}) {
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<T>()
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The tooltip renders in a portal on document.body, positioned from the chart
  // wrapper's bounds, so an overflow-hidden ancestor can't clip it; ChartPopover
  // keeps it inside the window.
  // No `scroll: true`: that attaches a window scroll listener at mount which
  // re-renders the host on every scroll frame. Bounds are measured once per open.
  // Only the measuring is used: its TooltipInPortal renders through visx's
  // Portal, which builds its node in render() and removes it on unmount, so
  // StrictMode's dev-time unmount/remount leaves the tooltip in a detached
  // node — open, but never on screen. ChartPopover portals with React's own
  // createPortal instead.
  const { containerRef, containerBounds, forceRefreshBounds } = useTooltipInPortal({
    detectBounds: false,
  })
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      containerRef(node)
    },
    [containerRef],
  )
  // Stable callbacks: the heatmap's 168 cells close over `show`/`hide`.
  const show = useCallback(
    (data: T, left: number, top: number) => {
      // Re-measure the wrapper so the portal position reflects the current scroll.
      forceRefreshBounds()
      showTooltip({ tooltipData: data, tooltipLeft: left, tooltipTop: top })
    },
    [showTooltip, forceRefreshBounds],
  )
  const hide = useCallback(() => hideTooltip(), [hideTooltip])

  // Spread on each mark. pointerdown covers touch taps (a tap's pointerenter is
  // followed by pointerleave on lift, which would otherwise close the popover).
  const markProps = useCallback(
    (data: T, left: number, top: number) => {
      const open = () => show(data, left, top)
      return { onPointerEnter: open, onPointerDown: open }
    },
    [show],
  )

  // Spread on the chart root; touch keeps the popover open until a tap outside / Escape.
  const containerProps = useMemo(
    () => ({
      ref: setRoot,
      onPointerLeave: (e: React.PointerEvent) => {
        if (e.pointerType !== 'touch') hide()
      },
    }),
    [hide, setRoot],
  )

  // The portalled tooltip is pointer-events-none, so a tap never targets it and
  // can't count as "outside" the chart.
  // followScroll: while open, any scroll (the page or an inner container)
  // re-measures the wrapper once a frame, so the portalled tooltip stays on
  // its mark. Off by default; the pill charts don't follow an inner scroll
  // container yet (a follow-up).
  useEffect(() => {
    if (!followScroll || !tooltipOpen) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => forceRefreshBounds())
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [followScroll, tooltipOpen, forceRefreshBounds])

  useEffect(() => {
    if (!tooltipOpen) return
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return
      hide()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [tooltipOpen, hide])

  return useMemo(
    () => ({
      open: tooltipOpen,
      data: tooltipData,
      left: tooltipLeft,
      top: tooltipTop,
      show,
      hide,
      markProps,
      containerProps,
      containerBounds,
    }),
    [
      tooltipOpen,
      tooltipData,
      tooltipLeft,
      tooltipTop,
      show,
      hide,
      markProps,
      containerProps,
      containerBounds,
    ],
  )
}

// Gap kept between the tooltip and the window edge.
const EDGE = 8

// Nudge the tooltip back inside the window. visx's own `detectBounds` compares
// page coordinates with the viewport size, so it misplaces the tooltip once the
// page is scrolled; measuring the real rect sidesteps that.
// A tooltip placed above the mark that would leave the top of the window drops
// below the mark instead of being shifted over it.
function keepInWindow(el: HTMLDivElement | null, above: boolean) {
  if (!el) return
  el.style.transform = ''
  const r = el.getBoundingClientRect()
  const dx = Math.max(EDGE - r.left, 0) + Math.min(window.innerWidth - EDGE - r.right, 0)
  let dy = 0
  if (above && r.top < EDGE) dy = OFFSET_BELOW - OFFSET_TOP
  dy += Math.max(EDGE - (r.top + dy), 0) + Math.min(window.innerHeight - EDGE - (r.bottom + dy), 0)
  if (dx || dy) el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`
}

// Gap between a card and the point it describes.
const CARD_GAP = 8

// A card is centred over its point, its bottom CARD_GAP above it; with no room
// above, it drops below the point. Then it's nudged inside the window, as
// keepInWindow does for the pill.
function placeCard(el: HTMLDivElement | null) {
  if (!el) return
  // Its own width, not the space left right of the point: an absolutely
  // placed box shrinks to fit that, so near the right edge every row would
  // wrap. Inline, because visx drops `style` on an unstyled Tooltip.
  el.style.width = 'max-content'
  // …capped at a readable width: a long hint wraps rather than spanning the page.
  el.style.maxWidth = `min(calc(100vw - ${2 * EDGE}px), 22rem)`
  el.style.transform = ''
  const r = el.getBoundingClientRect() // its top-left corner sits on the point
  let dx = -r.width / 2
  let dy = -r.height - CARD_GAP
  if (r.top + dy < EDGE) dy = CARD_GAP
  dx += Math.max(EDGE - (r.left + dx), 0) + Math.min(window.innerWidth - EDGE - (r.right + dx), 0)
  dy += Math.max(EDGE - (r.top + dy), 0) + Math.min(window.innerHeight - EDGE - (r.bottom + dy), 0)
  el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`
}

// `left`/`top` are in the chart wrapper's coordinates (the element carrying
// `containerProps`), converted to page coordinates from its measured bounds.
// `dataKey` re-mounts the tooltip when its content changes. `variant` picks
// the look: the dark one-line pill above a mark (heatmap, calendar, session
// chart), or the bar charts' card of rows, centred above its category.
export function ChartPopover({
  state,
  dataKey,
  variant = 'pill',
  className,
  children,
}: {
  state: { open: boolean; left?: number; top?: number; containerBounds: Bounds }
  dataKey?: string
  variant?: 'pill' | 'card'
  /** Card variant: classes merged over the card's. */
  className?: string
  children: React.ReactNode
}) {
  const bounds = state.containerBounds
  // Rendered (closed) during SSR too, where there is no window.
  const hasWindow = typeof window !== 'undefined'
  const pageLeft = (state.left ?? 0) + bounds.left + (hasWindow ? window.scrollX : 0)
  const pageTop = (state.top ?? 0) + bounds.top + (hasWindow ? window.scrollY : 0)
  // A new callback identity per position makes React re-run it, so the clamp
  // follows the mark as the pointer moves (and the wrapper, once re-measured).
  const above = (state.top ?? 0) >= -OFFSET_TOP
  // biome-ignore lint/correctness/useExhaustiveDependencies: the position is the re-run trigger
  const clampRef = useCallback(
    (el: HTMLDivElement | null) => (variant === 'card' ? placeCard(el) : keepInWindow(el, above)),
    [pageLeft, pageTop, above, variant],
  )
  if (!state.open) return null
  if (variant === 'card') {
    return createPortal(
      <Tooltip
        key={dataKey}
        {...({ ref: clampRef } as object)}
        unstyled
        applyPositionStyle
        left={pageLeft}
        top={pageTop}
        offsetLeft={0}
        offsetTop={0}
        data-slot="chart-tooltip"
        className={cn(
          'pointer-events-none z-50 grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-foreground text-xs shadow-xl',
          className,
        )}
      >
        {children}
      </Tooltip>,
      document.body,
    )
  }
  return createPortal(
    <Tooltip
      key={dataKey}
      // React 19 passes `ref` as a prop; visx's Tooltip spreads it onto its
      // div, its prop types just don't declare it.
      {...({ ref: clampRef } as object)}
      unstyled
      applyPositionStyle
      left={pageLeft}
      top={pageTop}
      offsetLeft={0}
      offsetTop={above ? OFFSET_TOP : OFFSET_BELOW}
      className="pointer-events-none z-10 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-background text-xs shadow-md"
    >
      {children}
    </Tooltip>,
    document.body,
  )
}

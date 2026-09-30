import { useTooltip, useTooltipInPortal } from '@visx/tooltip'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'

// Tooltip sits above the mark so a fingertip doesn't cover it.
const OFFSET_TOP = -34
// Near the wrapper's top edge there's no room above: drop below the mark instead.
const OFFSET_BELOW = 24

type PortalTooltip = ReturnType<typeof useTooltipInPortal>['TooltipInPortal']

export function useChartPopover<T>() {
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<T>()
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The tooltip renders in a portal on document.body, positioned from the chart
  // wrapper's bounds, so an overflow-hidden ancestor can't clip it; ChartPopover
  // keeps it inside the window.
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: false,
    scroll: true,
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
    (data: T, left: number, top: number) =>
      showTooltip({ tooltipData: data, tooltipLeft: left, tooltipTop: top }),
    [showTooltip],
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
      TooltipInPortal,
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
      TooltipInPortal,
    ],
  )
}

// Gap kept between the tooltip and the window edge.
const EDGE = 8

// Nudge the tooltip back inside the window. visx's own `detectBounds` compares
// page coordinates with the viewport size, so it misplaces the tooltip once the
// page is scrolled; measuring the real rect sidesteps that.
function keepInWindow(el: HTMLDivElement | null) {
  if (!el) return
  el.style.transform = ''
  const r = el.getBoundingClientRect()
  const dx = Math.max(EDGE - r.left, 0) + Math.min(window.innerWidth - EDGE - r.right, 0)
  const dy = Math.max(EDGE - r.top, 0) + Math.min(window.innerHeight - EDGE - r.bottom, 0)
  if (dx || dy) el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`
}

// `left`/`top` are in the chart wrapper's coordinates (the element carrying
// `containerProps`); the portal converts them to page coordinates. `dataKey`
// re-mounts the tooltip when its content changes.
export function ChartPopover({
  state,
  dataKey,
  children,
}: {
  state: { open: boolean; left?: number; top?: number; TooltipInPortal: PortalTooltip }
  dataKey?: string
  children: React.ReactNode
}) {
  // A new callback identity per position makes React re-run it, so the clamp
  // follows the mark as the pointer moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: left/top are the re-run triggers
  const clampRef = useCallback(keepInWindow, [state.left, state.top])
  if (!state.open) return null
  const { TooltipInPortal } = state
  return (
    <TooltipInPortal
      key={dataKey}
      // React 19 forwards `ref` as a prop through visx's wrapper to its div; its
      // prop types just don't declare it.
      {...({ ref: clampRef } as object)}
      unstyled
      applyPositionStyle
      detectBounds={false}
      left={state.left}
      top={state.top}
      offsetLeft={0}
      offsetTop={(state.top ?? 0) < -OFFSET_TOP ? OFFSET_BELOW : OFFSET_TOP}
      className="pointer-events-none z-10 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-background text-xs shadow-md"
    >
      {children}
    </TooltipInPortal>
  )
}

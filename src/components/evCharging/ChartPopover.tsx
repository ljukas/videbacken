import { TooltipWithBounds, useTooltip } from '@visx/tooltip'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'

// Tooltip sits above the mark so a fingertip doesn't cover it.
const OFFSET_TOP = -34

export function useChartPopover<T>() {
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<T>()
  const rootRef = useRef<HTMLDivElement | null>(null)
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
      ref: rootRef,
      onPointerLeave: (e: React.PointerEvent) => {
        if (e.pointerType !== 'touch') hide()
      },
    }),
    [hide],
  )

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
    }),
    [tooltipOpen, tooltipData, tooltipLeft, tooltipTop, show, hide, markProps, containerProps],
  )
}

// Positioned relative to the nearest `relative` ancestor (the chart wrapper).
// `dataKey` re-mounts the tooltip when its content changes so the left/right
// flip measures the current text width.
export function ChartPopover({
  state,
  dataKey,
  children,
}: {
  state: { open: boolean; left?: number; top?: number }
  dataKey?: string
  children: React.ReactNode
}) {
  if (!state.open) return null
  return (
    <TooltipWithBounds
      key={dataKey}
      unstyled
      applyPositionStyle
      left={state.left}
      top={state.top}
      offsetTop={OFFSET_TOP}
      className="pointer-events-none z-10 rounded-md bg-foreground px-2 py-1 text-background text-xs shadow-md"
    >
      {children}
    </TooltipWithBounds>
  )
}
